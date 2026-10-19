import { ensureSession, supabase } from './supabase';

/** A player in a room, as returned by the get_room RPC. */
export interface RoomPlayer {
  id: string;
  name: string;
  seat?: number;
}

/** One round of scores, keyed by player id. */
export interface RoomRound {
  id: string;
  seq?: number;
  scores: Record<string, any>;
}

/** Full room snapshot returned by the get_room RPC. */
export interface RoomSnapshot {
  version: number | string;
  me: string | null;
  players: RoomPlayer[];
  rounds: RoomRound[];
  [key: string]: any;
}

/** Pre-join view returned by the peek_room RPC: only unclaimed players. */
export interface PeekedRoom {
  code: string;
  version: number | string;
  players: RoomPlayer[];
}

export class RoomApiError extends Error {
  code: string | null;
  details: any;
  status: number | null;

  constructor(
    message: string,
    {
      code = null,
      details = null,
      status = null,
    }: { code?: string | null; details?: any; status?: number | null } = {},
  ) {
    super(message);
    this.name = 'RoomApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export class VersionConflictError extends RoomApiError {
  currentVersion: number | null;

  constructor(currentVersion: number | null) {
    super('The room changed since you loaded it.', { code: 'version_conflict' });
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

export class ScoreConflictError extends RoomApiError {
  currentValue: number | null;
  snapshot: RoomSnapshot;

  constructor(currentValue: number | null, snapshot: RoomSnapshot) {
    super('Another player changed this score.', { code: 'score_conflict' });
    this.name = 'ScoreConflictError';
    this.currentValue = currentValue;
    this.snapshot = snapshot;
  }
}

export function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toRoomError(error: any): RoomApiError {
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

async function call(name: string, params: Record<string, any>): Promise<any> {
  await ensureSession();
  const { data, error } = await supabase!.rpc(name, params);
  if (error) throw toRoomError(error);
  return data;
}

const asVersion = (data: any): number => Number(data?.version);

export async function createRoom(name: string): Promise<any> {
  return call('create_room', {
    p_name: name,
    p_request_id: requestId(),
  });
}

const ROOM_CODE_ALPHABET = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export function normalizeRoomCode(value: unknown): string {
  const code = String(value ?? '')
    .trim()
    .toUpperCase();
  if (!ROOM_CODE_ALPHABET.test(code)) {
    throw new RoomApiError('Room codes are 8 characters.', { code: 'invalid_code' });
  }
  return code;
}

/**
 * Join by picking an existing player (playerId) or creating one (name).
 * Returns the room snapshot alongside the resolved player id.
 */
export async function joinRoom(
  code: string,
  { name = null, playerId = null }: { name?: string | null; playerId?: string | null } = {},
): Promise<any> {
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
  if (joined?.error === 'player_taken') {
    throw new RoomApiError('That player is already taken.', { code: 'player_taken' });
  }
  return joined;
}

/** Lists the unclaimed players in a room before joining. */
export async function peekRoom(code: string): Promise<PeekedRoom> {
  return call('peek_room', { p_code: normalizeRoomCode(code) });
}

/** Releases this device's claim on its player; scores are untouched. */
export async function leaveRoom(code: string): Promise<void> {
  await call('leave_room', { p_code: normalizeRoomCode(code) });
}

export async function getRoom(code: string): Promise<RoomSnapshot> {
  return call('get_room', { p_code: normalizeRoomCode(code) });
}

export async function addPlayer(
  code: string,
  name: string,
  baseVersion: number,
): Promise<{ version: number; playerId: string }> {
  const data = await call('cmd_add_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: requestId(),
    p_name: name,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return { version: asVersion(data), playerId: data.playerId };
}

export async function deletePlayer(
  code: string,
  playerId: string,
  baseVersion: number,
): Promise<number> {
  const data = await call('cmd_delete_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: playerId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function kickPlayer(
  code: string,
  playerId: string,
  baseVersion: number,
): Promise<number> {
  const data = await call('cmd_kick_player', {
    p_code: normalizeRoomCode(code),
    p_player_id: playerId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function addRound(
  code: string,
  baseVersion: number,
  roundId: string = requestId(),
): Promise<{ version: number; roundId: string }> {
  const data = await call('cmd_add_round', {
    p_code: normalizeRoomCode(code),
    p_round_id: roundId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return { version: asVersion(data), roundId: data.roundId };
}

export async function deleteRound(
  code: string,
  roundId: string,
  baseVersion: number,
): Promise<number> {
  const data = await call('cmd_delete_round', {
    p_code: normalizeRoomCode(code),
    p_round_id: roundId,
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

export async function resetRoom(code: string, baseVersion: number): Promise<number> {
  const data = await call('cmd_reset_room', {
    p_code: normalizeRoomCode(code),
    p_base_version: baseVersion,
    p_request_id: requestId(),
  });
  return asVersion(data);
}

const numericValue = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function readCell(
  snapshot: RoomSnapshot,
  roundId: string,
  playerId: string,
): number | null | undefined {
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
  code: string,
  {
    roundId,
    playerId,
    value,
    baseVersion,
    previousValue,
  }: {
    roundId: string;
    playerId: string;
    value: string | number | null;
    baseVersion: number;
    previousValue?: number | string | null;
  },
): Promise<number> {
  const id = requestId();
  const room = normalizeRoomCode(code);
  const write = (version: number) =>
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
    return asVersion(await write(Number(snapshot.version)));
  }
}

/**
 * Subscribes to room version changes. `onVersion(null)` means "refetch now" -
 * emitted on subscribe so a reconnect cannot leave the UI stale.
 */
export function subscribeToRoom(
  code: string,
  {
    onVersion,
    onStatus,
  }: {
    onVersion?: (version: number | null) => void;
    onStatus?: (status: string) => void;
  } = {},
): () => void {
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
      (payload: any) => {
        const version = payload?.new?.version;
        if (version !== undefined && version !== null) onVersion?.(Number(version));
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onVersion?.(null);
      onStatus?.(status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
