-- Per-room write throttle. room_events already records every mutation, so it
-- doubles as the counter. Limits are deliberately generous: a full 8-player
-- round is ~9 writes, so this only trips on sustained abuse.

create or replace function public._begin_write(
  p_code text,
  p_base_version bigint,
  p_request_id uuid,
  p_bump_round_seq boolean default false,
  p_bump_seat_seq  boolean default false
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_room_id     uuid;
  v_ev          public.room_events%rowtype;
  v_writes_min  int;
  v_writes_hour int;
begin
  select r.id into v_room_id
    from public.rooms r
   where r.code = upper(btrim(p_code));

  if v_room_id is null then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  if not public.is_member(v_room_id) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  -- Replays are free: a retry must not be throttled or double-charged.
  select e.* into v_ev
    from public.room_events e
   where e.room_id = v_room_id
     and e.request_id = p_request_id;

  if v_ev.version is not null then
    return jsonb_build_object('version', v_ev.version, 'replayed', true);
  end if;

  select count(*) filter (where e.created_at > now() - interval '1 minute'),
         count(*) filter (where e.created_at > now() - interval '1 hour')
    into v_writes_min, v_writes_hour
    from public.room_events e
   where e.room_id = v_room_id;

  if v_writes_min >= 120 or v_writes_hour >= 600 then
    raise exception 'rate_limited'
      using errcode = 'PT429', detail = 'room_write_limit';
  end if;

  update public.rooms
     set version      = version + 1,
         round_seq    = round_seq + case when p_bump_round_seq then 1 else 0 end,
         seat_seq     = seat_seq  + case when p_bump_seat_seq  then 1 else 0 end,
         last_seen_at = now()
   where id = v_room_id
     and version = p_base_version;

  if not found then
    select e.* into v_ev
      from public.room_events e
     where e.room_id = v_room_id
       and e.request_id = p_request_id;

    if v_ev.version is not null then
      return jsonb_build_object('version', v_ev.version, 'replayed', true);
    end if;

    raise exception 'version_conflict'
      using errcode = 'PT409',
            detail  = (select version::text from public.rooms where id = v_room_id);
  end if;

  return null;
end;
$$;
