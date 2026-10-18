-- UNO scoreboard room backend.
--
-- Prerequisites: Authentication -> Providers -> Anonymous sign-ins must be
-- enabled; clients call these RPCs as anonymous Supabase users.
--
-- All writes go through cmd_* functions: each one replays-or-compares the
-- room version, takes the room row lock, mutates, and appends room_events.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.rooms (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  version             bigint not null default 1,
  round_seq           int not null default 0,
  seat_seq            int not null default 0,
  creation_request_id uuid unique,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  constraint rooms_code_format
    check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$')
);

create table public.players (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  seat       int not null,
  created_at timestamptz not null default now(),
  unique (room_id, id),
  unique (room_id, seat)
);

create table public.rounds (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  seq        int not null,
  created_at timestamptz not null default now(),
  unique (room_id, id),
  unique (room_id, seq)
);

create table public.scores (
  room_id    uuid not null,
  round_id   uuid not null,
  player_id  uuid not null,
  value      numeric(6,2),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (room_id, round_id, player_id),
  foreign key (room_id, round_id)
    references public.rounds(room_id, id) on delete cascade,
  foreign key (room_id, player_id)
    references public.players(room_id, id) on delete cascade
);

create table public.room_members (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  player_id  uuid,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id),
  foreign key (room_id, player_id)
    references public.players(room_id, id) on delete set null (player_id)
);

create table public.room_events (
  room_id         uuid not null references public.rooms(id) on delete cascade,
  version         bigint not null,
  request_id      uuid not null,
  actor_user_id   uuid,
  actor_player_id uuid,
  type            text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  primary key (room_id, version),
  unique (room_id, request_id)
);

create index players_room_seat_idx  on public.players (room_id, seat);
create index rounds_room_seq_idx    on public.rounds (room_id, seq);
create index room_members_user_idx  on public.room_members (user_id);
create index room_events_created_idx on public.room_events (room_id, created_at desc);
create index rooms_last_seen_idx    on public.rooms (last_seen_at);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.random_room_code()
returns text
language plpgsql volatile
set search_path = public
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  result   text := '';
begin
  for i in 1..5 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- security definer so RLS policies can call it without recursing into
-- room_members' own policy.
create or replace function public.is_member(p_room_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_members m
     where m.room_id = p_room_id
       and m.user_id = auth.uid()
  );
$$;

-- Every command starts here. Returns a replay payload when this request_id has
-- already been applied, otherwise bumps the version (and optional counters)
-- and returns null. The UPDATE holds the room row lock until commit, so all
-- writes for a room are serialized.
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

  select e.* into v_ev
    from public.room_events e
   where e.room_id = v_room_id
     and e.request_id = p_request_id;

  if v_ev.version is not null then
    return jsonb_build_object('version', v_ev.version, 'replayed', true);
  end if;

  if not public.is_member(v_room_id) then
    raise exception 'not_a_member' using errcode = '42501';
  end if;

  update public.rooms
     set version      = version + 1,
         round_seq    = round_seq + case when p_bump_round_seq then 1 else 0 end,
         seat_seq     = seat_seq  + case when p_bump_seat_seq  then 1 else 0 end,
         last_seen_at = now()
   where id = v_room_id
     and version = p_base_version;

  if not found then
    -- a concurrent attempt of this same request may have just committed
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

create or replace function public._current_player(p_room_id uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.player_id
    from public.room_members m
   where m.room_id = p_room_id
     and m.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Room lifecycle
-- ---------------------------------------------------------------------------

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
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 20 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select * into v_room from public.rooms where creation_request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'code', v_room.code,
      'version', v_room.version,
      'playerId', public._current_player(v_room.id),
      'replayed', true
    );
  end if;

  loop
    v_try := v_try + 1;
    begin
      insert into public.rooms (code, seat_seq, creation_request_id)
      values (public.random_room_code(), 1, p_request_id)
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
  v_uid    uuid := auth.uid();
  v_room   public.rooms%rowtype;
  v_player public.players%rowtype;
  v_ev     public.room_events%rowtype;
begin
  if v_uid is null then
    raise exception 'auth_required' using errcode = '42501';
  end if;
  if p_player_id is null and (p_name is null or char_length(btrim(p_name)) not between 1 and 20) then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  select * into v_room
    from public.rooms
   where code = upper(btrim(p_code))
     for update;

  if not found then
    raise exception 'room_not_found' using errcode = 'P0002';
  end if;

  if p_player_id is not null then
    select * into v_player
      from public.players
     where id = p_player_id
       and room_id = v_room.id;

    if not found then
      raise exception 'player_not_found' using errcode = 'P0002';
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

  return jsonb_build_object(
    'code', v_room.code,
    'version', v_room.version,
    'playerId', v_player.id,
    'name', v_player.name
  );
end;
$$;

create or replace function public.get_room(p_code text)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_player  uuid;
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

  v_player := public._current_player(v_room_id);

  return jsonb_build_object(
    'code', (select code from public.rooms where id = v_room_id),
    'version', (select version from public.rooms where id = v_room_id),
    'me', v_player,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'seat', p.seat) order by p.seat)
        from public.players p
       where p.room_id = v_room_id
    ), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'seq', r.seq,
               'scores', coalesce((
                 select jsonb_object_agg(s.player_id, s.value)
                   from public.scores s
                  where s.round_id = r.id
               ), '{}'::jsonb)
             ) order by r.seq)
        from public.rounds r
       where r.room_id = v_room_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

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

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'player.added',
     jsonb_build_object('playerId', v_player.id, 'name', v_player.name, 'seat', v_player.seat));

  return jsonb_build_object('version', v_room.version, 'playerId', v_player.id);
end;
$$;

create or replace function public.cmd_delete_player(
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
  v_payload jsonb;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  select jsonb_build_object(
           'player', to_jsonb(p),
           'scores', coalesce((
             select jsonb_agg(to_jsonb(s))
               from public.scores s
              where s.player_id = p.id
           ), '[]'::jsonb)
         )
    into v_payload
    from public.players p
   where p.id = p_player_id
     and p.room_id = v_room.id;

  delete from public.players
   where id = p_player_id
     and room_id = v_room.id;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'player.deleted',
     coalesce(v_payload, '{}'::jsonb));

  return jsonb_build_object('version', v_room.version);
end;
$$;

create or replace function public.cmd_add_round(
  p_code text,
  p_round_id uuid,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_room   public.rooms%rowtype;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id, true, false);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  insert into public.rounds (id, room_id, seq)
  values (p_round_id, v_room.id, v_room.round_seq)
  on conflict (id) do nothing;

  -- Participant snapshot: only players present at round creation can win it.
  insert into public.scores (room_id, round_id, player_id)
  select v_room.id, p_round_id, p.id
    from public.players p
   where p.room_id = v_room.id
  on conflict do nothing;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'round.added',
     jsonb_build_object('roundId', p_round_id, 'seq', v_room.round_seq));

  return jsonb_build_object('version', v_room.version, 'roundId', p_round_id);
end;
$$;

create or replace function public.cmd_delete_round(
  p_code text,
  p_round_id uuid,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay  jsonb;
  v_room    public.rooms%rowtype;
  v_payload jsonb;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  select jsonb_build_object(
           'round', to_jsonb(r),
           'scores', coalesce((
             select jsonb_agg(to_jsonb(s))
               from public.scores s
              where s.round_id = r.id
           ), '[]'::jsonb)
         )
    into v_payload
    from public.rounds r
   where r.id = p_round_id
     and r.room_id = v_room.id;

  delete from public.rounds
   where id = p_round_id
     and room_id = v_room.id;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'round.deleted',
     coalesce(v_payload, '{}'::jsonb));

  return jsonb_build_object('version', v_room.version);
end;
$$;

create or replace function public.cmd_set_score(
  p_code text,
  p_round_id uuid,
  p_player_id uuid,
  p_value numeric,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay jsonb;
  v_room   public.rooms%rowtype;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  if not exists (
    select 1 from public.rounds r
     where r.id = p_round_id and r.room_id = v_room.id
  ) then
    raise exception 'round_not_found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.players p
     where p.id = p_player_id and p.room_id = v_room.id
  ) then
    raise exception 'player_not_found' using errcode = 'P0002';
  end if;

  insert into public.scores (room_id, round_id, player_id, value, updated_at, updated_by)
  values (v_room.id, p_round_id, p_player_id, p_value, now(), public._current_player(v_room.id))
  on conflict (room_id, round_id, player_id)
  do update set value      = excluded.value,
                updated_at = now(),
                updated_by = excluded.updated_by;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), public._current_player(v_room.id),
     'score.set',
     jsonb_build_object('roundId', p_round_id, 'playerId', p_player_id, 'value', p_value));

  return jsonb_build_object('version', v_room.version);
end;
$$;

create or replace function public.cmd_reset_room(
  p_code text,
  p_base_version bigint,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_replay  jsonb;
  v_room    public.rooms%rowtype;
  v_payload jsonb;
begin
  v_replay := public._begin_write(p_code, p_base_version, p_request_id);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_room from public.rooms where code = upper(btrim(p_code));

  v_payload := jsonb_build_object(
    'players', coalesce((select jsonb_agg(to_jsonb(p)) from public.players p where p.room_id = v_room.id), '[]'::jsonb),
    'rounds',  coalesce((select jsonb_agg(to_jsonb(r)) from public.rounds  r where r.room_id = v_room.id), '[]'::jsonb),
    'scores',  coalesce((select jsonb_agg(to_jsonb(s)) from public.scores  s where s.room_id = v_room.id), '[]'::jsonb)
  );

  delete from public.scores  where room_id = v_room.id;
  delete from public.rounds  where room_id = v_room.id;
  delete from public.players where room_id = v_room.id;

  update public.rooms
     set round_seq = 0, seat_seq = 0
   where id = v_room.id;

  insert into public.room_events
    (room_id, version, request_id, actor_user_id, actor_player_id, type, payload)
  values
    (v_room.id, v_room.version, p_request_id, auth.uid(), null, 'room.reset', v_payload);

  return jsonb_build_object('version', v_room.version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.rooms        enable row level security;
alter table public.players      enable row level security;
alter table public.rounds       enable row level security;
alter table public.scores       enable row level security;
alter table public.room_members enable row level security;
alter table public.room_events  enable row level security;

create policy rooms_select on public.rooms
  for select to authenticated using (public.is_member(id));

create policy players_select on public.players
  for select to authenticated using (public.is_member(room_id));

create policy rounds_select on public.rounds
  for select to authenticated using (public.is_member(room_id));

create policy scores_select on public.scores
  for select to authenticated using (public.is_member(room_id));

create policy room_events_select on public.room_events
  for select to authenticated using (public.is_member(room_id));

create policy room_members_select on public.room_members
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime: clients watch rooms.version and refetch the snapshot
-- ---------------------------------------------------------------------------

-- Realtime filters on UPDATE events are matched against the old record, which
-- only carries the primary key unless the replica identity is full.
alter table public.rooms replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'rooms'
     ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: reads via RLS, writes only through security-definer RPCs
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;

  foreach fn in array array[
    'public.create_room(text, uuid)',
    'public.join_room(text, text, uuid, uuid)',
    'public.get_room(text)',
    'public.cmd_add_player(text, uuid, text, bigint, uuid)',
    'public.cmd_delete_player(text, uuid, bigint, uuid)',
    'public.cmd_add_round(text, uuid, bigint, uuid)',
    'public.cmd_delete_round(text, uuid, bigint, uuid)',
    'public.cmd_set_score(text, uuid, uuid, numeric, bigint, uuid)',
    'public.cmd_reset_room(text, bigint, uuid)',
    'public._begin_write(text, bigint, uuid, boolean, boolean)',
    'public.random_room_code()'
  ] loop
    execute format('revoke all on function %s from public', fn);
  end loop;

  foreach fn in array array[
    'public.create_room(text, uuid)',
    'public.join_room(text, text, uuid, uuid)',
    'public.get_room(text)',
    'public.cmd_add_player(text, uuid, text, bigint, uuid)',
    'public.cmd_delete_player(text, uuid, bigint, uuid)',
    'public.cmd_add_round(text, uuid, bigint, uuid)',
    'public.cmd_delete_round(text, uuid, bigint, uuid)',
    'public.cmd_set_score(text, uuid, uuid, numeric, bigint, uuid)',
    'public.cmd_reset_room(text, bigint, uuid)'
  ] loop
    execute format('grant execute on function %s to authenticated', fn);
  end loop;

  execute 'revoke insert, update, delete on public.rooms, public.players, public.rounds, public.scores, public.room_members, public.room_events from anon, authenticated';
end;
$$;

-- Keep the internal auth helper executable by the roles that evaluate RLS.
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public._current_player(uuid) to authenticated;
