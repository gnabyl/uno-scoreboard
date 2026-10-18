import { ensureSession, supabase } from './supabase';

export class RoomApiError extends Error {
  constructor(message, { code = null, details = null, status = null } = {}) {
    super(message);
    this.name = 'RoomApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export class VersionConflictError extends RoomApiError {
  constructor(currentVersion) {
    super('The room changed since you loaded it.', { code: 'version_conflict' });
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

export class ScoreConflictError extends RoomApiError {
  constructor(currentValue, snapshot) {
    super('Another player changed this score.', { code: 'score_conflict' });
    this.name = 'ScoreConflictError';
    this.currentValue = currentValue;
    this.snapshot = snapshot;
  }
}

export function requestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toRoomError(error) {
  const code = error?.code ?? null;
  const details = error?.details ?? null;

  if (code === 'PT409') {
    const version = Number(details);
    return new VersionConflictError(Number.isFinite(version) ? version : null);
  }
  if (code === 'P0002' || error?.status === 404) {
    return new RoomApiError(error.message || 'Not found.', { code: 'not_found', details });
  }
  if (code === '42501') {
    return new RoomApiError(error.message || 'Not a member of this room.', {
      code: 'not_a_member',
      details,
    });
  }
  if (code === 'PT429') {
    return new RoomApiError('Too many attempts. Try again in a minute.', {
      code: 'rate_limited',
      details,
    });
  }
  return new RoomApiError(error?.message || 'Request failed.', {
    code,
    details,
    status: error?.status ?? null,
  });
}

async function call(name, params) {
  await ensureSession();
  const { data, error } = await supabase.rpc(name, params);
  if (error) throw toRoomError(error);
  return data;
}

const asVersion = (data) => Number(data?.version);

export async function createRoom(name) {
  return call('create_room', {
    p_name: name,
    p_request_id: requestId(),
  });
}

const ROOM_CODE_ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export function normalizeRoomCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!ROOM_CODE_ALPHABET.test(code)) {
    throw new RoomApiError('Room codes are 8 characters.', { code: 'invalid_code' });
  }
  return code;
}

/**
 * Join by picking an existing player (playerId) or creating one (name).
 * Returns the room snapshot alongside the resolved player id.
 */
export async function joinRoom(code, { name = null, playerId = null } = {}) {
  const joined = await call('join_room', {
    p_code: normalizeRoomCode(code),
    p_name: name,
    p_player_id: playerId,
    p_request_id: name && !playerId ? requestId() : null,
  });
  // Failed joins come back as data (not errors) so they can be rate-limited.
  if (joined?.error === 'room_not_found') {
    throw new RoomApiError('Room not found.', { code: 'not_found' });
  }
  if (joined?.error === 'player_not_found') {
    throw new RoomApiError('That player no longer exists.', { code: 'not_found' });
  }
  return joined;
}

export async function getRoom(code) {
  return call('get_room', { p_code: normalizeRoomCode(code) });
}

export async function addPlayer(code, name, baseVersion) {
  const data = await call('cmd_add_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: requestId(),
    p_name: name,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return { version: asVersion(data), playerId: data.playerId };
}

export async function deletePlayer(code, playerId, baseVersion) {
  const data = await call('cmd_delete_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: playerId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function kickPlayer(code, playerId, baseVersion) {
  const data = await call('cmd_kick_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: playerId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function addRound(code, baseVersion, roundId = requestId()) {
  const data = await call('cmd_add_round', {
    p_code: normalizeRoomCode(code),
    p_round_id: roundId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return { version: asVersion(data), roundId: data.roundId };
}

export async function deleteRound(code, roundId, baseVersion) {
  const data = await call('cmd_delete_round', {
    p_code: normalizeRoomCode(code),
    p_round_id: roundId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function resetRoom(code, baseVersion) {
  const data = await call('cmd_reset_room', {
    p_code: normalizeRoomCode(code),
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

const numericValue = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function readCell(snapshot, roundId, playerId) {
  const round = snapshot?.rounds?.find((r) => r.id === roundId);
  if (!round || !Object.prototype.hasOwnProperty.call(round.scores, playerId)) {
    return undefined;
  }
  const value = round.scores[playerId];
  return value === null ? null : Number(value);
}

/**
 * Writes one cell. On a version conflict the snapshot is refetched; the write
 * is retried automatically only when this exact cell is unchanged, so an
 * unrelated edit elsewhere in the room never blocks the user.
 */
export async function setScore(
  code,
  { roundId, playerId, value, baseVersion, previousValue }
) {
  const id = requestId();
  const room = normalizeRoomCode(code);
  const write = (version) =>
    call('cmd_set_score', {
      p_code: room,
      p_round_id: roundId,
      p_player_id: playerId,
      p_value: numericValue(value),
      p_base_version: version,
      p_request_id: id,
    });

  try {
    return asVersion(await write(baseVersion));
  } catch (err) {
    if (!(err instanceof VersionConflictError)) throw err;

    const snapshot = await getRoom(room);
    const currentValue = readCell(snapshot, roundId, playerId);
    const expected = numericValue(previousValue);

    if (currentValue === undefined || currentValue !== expected) {
      throw new ScoreConflictError(currentValue, snapshot);
    }
    return asVersion(await write(snapshot.version));
  }
}

/**
 * Subscribes to room version changes. `onVersion(null)` means "refetch now" —
 * emitted on subscribe so a reconnect cannot leave the UI stale.
 */
export function subscribeToRoom(code, { onVersion, onStatus } = {}) {
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`room:${code}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'rooms',
        filter: `code=eq.${code}`,
      },
      (payload) => {
        const version = payload?.new?.version;
        if (version !== undefined && version !== null) onVersion?.(Number(version));
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onVersion?.(null);
      onStatus?.(status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
