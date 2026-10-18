-- Kick: remove a player from the room and revoke access for every device
-- bound to that player. Unlike cmd_delete_player (board cleanup only), this
-- also deletes the room_members rows, so the kicked device(s) lose membership
-- and see the "join" screen again. The player's scores cascade away.

create or replace function public.cmd_kick_player(
  p_code text,
  p_player_id uuid,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay  jsonb;
  v_room    public.rooms%rowtype;
  v_actor   uuid;
  v_payload jsonb;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));
  v_actor := public._current_player(v_room.id);

  select jsonb_build_object(
           'player', to_jsonb(p),
           'scores', coalesce((
             select jsonb_agg(to_jsonb(s))
               from public.scores s
              where s.player_id = p.id
           ), '[]'::jsonb),
           'members', coalesce((
             select jsonb_agg(to_jsonb(m))
               from public.room_members m
              where m.room_id = p.room_id
                and m.player_id = p.id
           ), '[]'::jsonb)
         )
    into v_payload
    from public.players p
   where p.id = p_player_id
     and p.room_id = v_room.id;

  if v_payload is null then
    raise exception 'player_not_found' using errcode = 'P0002';
  end if;

  -- Revoke membership first, then remove the player (scores cascade).
  delete from public.room_members
   where room_id = v_room.id
     and player_id = p_player_id;

  delete from public.players
   where id = p_player_id
     and room_id = v_room.id;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), v_actor,
     'player.kicked', v_payload);

  return jsonb_build_object('version', v_room.version);
end;
$$;

revoke execute on function public.cmd_kick_player(text, uuid, bigint, uuid) from anon;
grant execute on function public.cmd_kick_player(text, uuid, bigint, uuid) to authenticated;
