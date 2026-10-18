-- Rate-limit room creation per identity. Counting committed rooms instead of
-- attempts means only successful creates consume the budget.

alter table public.rooms add column created_by uuid;
create index rooms_created_by_idx on public.rooms (created_by, created_at desc);

create or replace function public.create_room(
  p_name text,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_room   public.rooms%rowtype;
  v_player public.players%rowtype;
  v_try    int := 0;
  v_hour   int;
  v_day    int;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 20 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  -- Replay before the limiter: a retry of a create that already succeeded must
  -- return that room even when the identity is now over budget.
  select * into v_room from public.rooms where creation_request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'code', v_room.code,
      'version', v_room.version,
      'playerId', public._current_player(v_room.id),
      'replayed', true
    );
  end if;

  -- Serialize creates per identity so concurrent requests cannot both pass the
  -- count check.
  perform pg_advisory_xact_lock(hashtextextended('create:' || v_uid::text, 0));

  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '1 day')
    into v_hour, v_day
    from public.rooms
   where created_by = v_uid;

  if v_hour >= 10 or v_day >= 30 then
    raise exception 'rate_limited'
      using errcode = 'PT429', detail = 'too_many_rooms';
  end if;

  loop
    v_try := v_try + 1;
    begin
      insert into public.rooms (code, seat_seq, creation_request_id, created_by)
      values (public.random_room_code(), 1, p_request_id, v_uid)
      returning * into v_room;
      exit;
    exception when unique_violation then
      select * into v_room from public.rooms where creation_request_id = p_request_id;
      if found then
        return jsonb_build_object(
          'code', v_room.code,
          'version', v_room.version,
          'playerId', public._current_player(v_room.id),
          'replayed', true
        );
      end if;
      if v_try >= 25 then
        raise exception 'room_code_exhausted' using errcode = 'P0001';
      end if;
    end;
  end loop;

  insert into public.players (room_id, name, seat)
  values (v_room.id, btrim(p_name), 1)
  returning * into v_player;

  insert into public.room_members (room_id, user_id, player_id)
  values (v_room.id, v_uid, v_player.id);

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, v_uid, v_player.id, 'room.created',
     jsonb_build_object('code', v_room.code, 'playerId', v_player.id, 'name', v_player.name));

  return jsonb_build_object('code', v_room.code, 'version', v_room.version, 'playerId', v_player.id);
end;
$$;
