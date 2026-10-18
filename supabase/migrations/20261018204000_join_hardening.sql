-- 8-character room codes + per-identity join rate limiting.

alter table public.rooms drop constraint rooms_code_format;
alter table public.rooms add constraint rooms_code_format
  check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$');

create or replace function public.random_room_code()
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result   text := '';
begin
  for i in 1..8 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

create table public.join_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  code         text,
  success      boolean not null default false,
  attempted_at timestamptz not null default now()
);

create index join_attempts_user_time_idx on public.join_attempts (user_id, attempted_at desc);
create index join_attempts_time_idx      on public.join_attempts (attempted_at);

alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

-- Failed joins return { error } instead of raising, so the attempt is still
-- recorded (an exception would roll the row back and defeat the limiter).
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

  insert into public.room_members (room_id, user_id, player_id)
  values (v_room.id, v_uid, v_player.id)
  on conflict (room_id, user_id)
  do update set player_id = excluded.player_id;

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
