-- Late joiners did not play in rounds created before they were added. Give
-- them an explicit 0 in those rounds so every player has a score row for
-- every round they were present for. An explicit 0 is a normal score (only a
-- blank cell marks the round winner), so this cannot make them win.

create or replace function public.cmd_add_player(
  p_code text,
  p_player_id uuid,
  p_name text,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_room   public.rooms%rowtype;
  v_player public.players%rowtype;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 20 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  v_replay := public._begin_write(p_code, p_base_version, p_request_id, false, true);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  insert into public.players (id, room_id, name, seat)
  values (p_player_id, v_room.id, btrim(p_name), v_room.seat_seq)
  on conflict (id) do nothing;

  select * into v_player
    from public.players
   where id = p_player_id and room_id = v_room.id;

  -- Rounds created before this player: they score 0 for those rounds.
  insert into public.scores (room_id, round_id, player_id, value)
  select v_room.id, r.id, v_player.id, 0
    from public.rounds r
   where r.room_id = v_room.id
  on conflict do nothing;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'player.added',
     jsonb_build_object('playerId', v_player.id, 'name', v_player.name, 'seat', v_player.seat));

  return jsonb_build_object('version', v_room.version, 'playerId', v_player.id);
end;
$$;

-- Backfill rooms that already contain late joiners. Existing scores win over
-- the inserted 0, so explicitly entered values are never overwritten.
insert into public.scores (room_id, round_id, player_id, value)
select p.room_id, r.id, p.id, 0
  from public.players p
  join public.rounds r
    on r.room_id = p.room_id
   and r.created_at < p.created_at
on conflict do nothing;
