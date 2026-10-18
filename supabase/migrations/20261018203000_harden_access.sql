-- Hardening: Supabase's default privileges grant EXECUTE on new functions to
-- both anon and authenticated, so revoking from PUBLIC is not enough.

revoke execute on function public.create_room(text, uuid) from anon;
revoke execute on function public.join_room(text, text, uuid, uuid) from anon;
revoke execute on function public.get_room(text) from anon;
revoke execute on function public.cmd_add_player(text, uuid, text, bigint, uuid) from anon;
revoke execute on function public.cmd_delete_player(text, uuid, bigint, uuid) from anon;
revoke execute on function public.cmd_add_round(text, uuid, bigint, uuid) from anon;
revoke execute on function public.cmd_delete_round(text, uuid, bigint, uuid) from anon;
revoke execute on function public.cmd_set_score(text, uuid, uuid, numeric, bigint, uuid) from anon;
revoke execute on function public.cmd_reset_room(text, bigint, uuid) from anon;
revoke execute on function public._begin_write(text, bigint, uuid, boolean, boolean) from anon;
revoke execute on function public._current_player(uuid) from anon;
revoke execute on function public.is_member(uuid) from anon;
revoke execute on function public.random_room_code() from anon;

-- Membership is checked before the idempotency lookup so a non-member can
-- never learn whether a request_id exists or what version it produced.
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
  v_room_id uuid;
  v_ev      public.room_events%rowtype;
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

  select e.* into v_ev
    from public.room_events e
   where e.room_id = v_room_id
     and e.request_id = p_request_id;

  if v_ev.version is not null then
    return jsonb_build_object('version', v_ev.version, 'replayed', true);
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

-- numeric accepts NaN/Infinity; both would corrupt client-side totals.
alter table public.scores
  add constraint scores_value_range
  check (value is null or value between -999 and 999);
