-- Join by picking an existing player, with one claim per player.
--
-- A player row is the scoreboard entry; a room_members row is the device that
-- currently controls it. Until now several users could claim the same player.
-- The partial unique index below makes that impossible, and join_room reports
-- `player_taken` instead of raising so the attempt still counts against the
-- join rate limit.

-- Dedupe legacy claims first: keep the earliest member for each player and
-- detach the rest. Detached members land on the join screen again.
with ranked as (
  select room_id,
         user_id,
         row_number() over (
           partition by room_id, player_id
           order by joined_at, user_id
         ) as rn
    from public.room_members
   where player_id is not null
)
update public.room_members m
   set player_id = null
  from ranked r
 where m.room_id = r.room_id
   and m.user_id = r.user_id
   and r.rn > 1;

create unique index room_members_claim_idx
  on public.room_members (room_id, player_id)
  where player_id is not null;

-- Pre-join view of a room: the caller is not a member yet, so get_room cannot
-- be used. Only unclaimed players are returned; a name disappears from the
-- list as soon as someone claims it.
create or replace function public.peek_room(p_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_room_id uuid;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select r.id into v_room_id
    from public.rooms r
   where r.code = upper(btrim(p_code));

  if v_room_id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'code', (select code from public.rooms where id = v_room_id),
    'version', (select version from public.rooms where id = v_room_id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'seat', p.seat) order by p.seat)
        from public.players p
       where p.room_id = v_room_id
         and not exists (
           select 1
             from public.room_members m
            where m.room_id = p.room_id
              and m.player_id = p.id
         )
    ), '[]'::jsonb)
  );
end;
$$;

-- Releasing a claim leaves the player, rounds and scores untouched; only the
-- device binding is removed, so someone else can pick that name.
create or replace function public.leave_room(p_code text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_room_id uuid;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;

  select r.id into v_room_id
    from public.rooms r
   where r.code = upper(btrim(p_code));

  if v_room_id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  delete from public.room_members
   where room_id = v_room_id
     and user_id = v_uid;

  return jsonb_build_object('ok', true);
end;
$$;

-- Same signature as before. The p_player_id branch now checks the claim and
-- the unique index catches the race between the check and the insert.
create or replace function public.join_room(
  p_code text,
  p_name text default null,
  p_player_id uuid default null,
  p_request_id uuid default null
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_room    public.rooms%rowtype;
  v_player  public.players%rowtype;
  v_ev      public.room_events%rowtype;
  v_attempt bigint;
  v_minute  int;
  v_hour    int;
  v_existing boolean := false;
  v_code    text := upper(btrim(p_code));
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_player_id is null and (p_name is null or char_length(btrim(p_name)) not between 1 and 20) then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  select count(*) filter (where a.attempted_at > now() - interval '1 minute'),
         count(*) filter (where a.attempted_at > now() - interval '1 hour')
    into v_minute, v_hour
    from public.join_attempts a
   where a.user_id = v_uid;

  if v_minute >= 10 or v_hour >= 50 then
    raise exception 'rate_limited'
      using errcode = 'PT429', detail = 'too_many_join_attempts';
  end if;

  insert into public.join_attempts (user_id, code)
  values (v_uid, left(v_code, 16))
  returning id into v_attempt;

  select * into v_room
    from public.rooms
   where code = v_code
     for update;

  if not found then
    return jsonb_build_object('error', 'room_not_found');
  end if;

  if p_player_id is not null then
    select * into v_player
      from public.players
     where id = p_player_id
       and room_id = v_room.id;

    if not found then
      return jsonb_build_object('error', 'player_not_found');
    end if;

    if exists (
      select 1
        from public.room_members m
       where m.room_id = v_room.id
         and m.player_id = p_player_id
         and m.user_id <> v_uid
    ) then
      return jsonb_build_object('error', 'player_taken');
    end if;
  else
    if p_request_id is not null then
      select e.* into v_ev
        from public.room_events e
       where e.room_id = v_room.id
         and e.request_id = p_request_id;
    end if;

    if v_ev.version is not null then
      select * into v_player
        from public.players
       where id = (v_ev.payload ->> 'playerId')::uuid;
    else
      -- Typing the name of an existing player claims that player instead of
      -- creating a duplicate. This is also how a taken name is rejected when
      -- the client only saw the new-name form.
      select * into v_player
        from public.players
       where room_id = v_room.id
         and lower(btrim(name)) = lower(btrim(p_name))
       order by seat
       limit 1;

      v_existing := found;

      if v_existing then
        if exists (
          select 1
            from public.room_members m
           where m.room_id = v_room.id
             and m.player_id = v_player.id
             and m.user_id <> v_uid
        ) then
          return jsonb_build_object('error', 'player_taken');
        end if;
      else
        update public.rooms
           set version = version + 1, seat_seq = seat_seq + 1, last_seen_at = now()
         where id = v_room.id
        returning * into v_room;

        insert into public.players (room_id, name, seat)
        values (v_room.id, btrim(p_name), v_room.seat_seq)
        returning * into v_player;

        insert into public.room_events
          (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
        values
          (v_room.id, v_room.version, coalesce(p_request_id, gen_random_uuid()), v_uid, v_player.id,
           'player.added',
           jsonb_build_object('playerId', v_player.id, 'name', v_player.name, 'seat', v_player.seat));
      end if;
    end if;
  end if;

  begin
    insert into public.room_members (room_id, user_id, player_id)
    values (v_room.id, v_uid, v_player.id)
    on conflict (room_id, user_id)
    do update set player_id = excluded.player_id;
  exception when unique_violation then
    -- Another user claimed this player between the check and the insert.
    return jsonb_build_object('error', 'player_taken');
  end;

  update public.join_attempts set success = true where id = v_attempt;

  if random() < 0.02 then
    delete from public.join_attempts where attempted_at < now() - interval '1 day';
  end if;

  return jsonb_build_object(
    'code', v_room.code,
    'version', v_room.version,
    'playerId', v_player.id,
    'name', v_player.name
  );
end;
$$;

-- Supabase grants EXECUTE on new functions to anon by default; close that.
revoke execute on function public.peek_room(text) from public;
revoke execute on function public.peek_room(text) from anon;
grant execute on function public.peek_room(text) to authenticated;

revoke execute on function public.leave_room(text) from public;
revoke execute on function public.leave_room(text) from anon;
grant execute on function public.leave_room(text) to authenticated;
