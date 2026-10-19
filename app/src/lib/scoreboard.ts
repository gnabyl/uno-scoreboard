import type { RoomPlayer, RoomRound } from '../api-helper/rooms';

/** One round's derived values, keyed by round id in {@link Scoreboard.byRound}. */
export interface RoundSummary {
  id: string;
  /** Sum of the numeric scores in the round (winners are blank, so excluded). */
  sum: number;
  /** Player left blank, when exactly one player is blank. */
  winner: string | null;
}

/**
 * One cell of the score grid.
 *
 * `value` is the score the player wrote down; `null` means the cell is blank.
 * A blank cell on a round with a winner is the winner marker, so it is rendered
 * as the points gained (`abs(sum)`) instead of a blank.
 */
export interface ScoreboardCell {
  value: number | null;
  winner: boolean;
}

/** One row of the score grid: a round, or the totals band. */
export interface ScoreboardRow {
  id: string;
  /** Round number (1-based) for round rows. */
  index: number;
  cells: ScoreboardCell[];
}

export interface ScoreboardPlayer {
  id: string;
  name: string;
  total: number;
  /** Highest total, when the board has data and more than one player. */
  leader: boolean;
}

export interface Scoreboard {
  /** Rows in round order. */
  rows: ScoreboardRow[];
  /** Lookup by round id, for the on-screen board. */
  byRound: Record<string, RoundSummary>;
  /** Totals keyed by player id, for the on-screen board. */
  totals: Record<string, number>;
  /** One entry per player, in seat order. */
  players: ScoreboardPlayer[];
  /** False when every cell is blank or an explicit 0. */
  hasData: boolean;
  /** Ids of the leading player(s); empty when there is no meaningful leader. */
  leaderIds: string[];
}

const toNumber = (raw: unknown): number | null => {
  const value = parseFloat(String(raw));
  return Number.isNaN(value) ? null : value;
};

const isBlank = (raw: unknown): boolean =>
  raw === null || raw === undefined || raw === '' || Number.isNaN(parseFloat(String(raw)));

/**
 * Derives everything the board and the PNG export need from a room snapshot.
 *
 * Being the single implementation of the scoring rules means the exported image
 * can never disagree with what is on screen.
 */
export function buildScoreboard(players: RoomPlayer[], rounds: RoomRound[]): Scoreboard {
  const byRound: Record<string, RoundSummary> = {};
  const totals: Record<string, number> = {};
  const playerTotals: Record<string, number> = {};

  players.forEach((player) => {
    totals[player.id] = 0;
    playerTotals[player.id] = 0;
  });

  const rows: ScoreboardRow[] = rounds.map((round, roundIndex) => {
    let sum = 0;
    let winner: string | null = null;
    let multipleBlanks = false;

    players.forEach((player) => {
      const raw = round.scores?.[player.id];
      if (isBlank(raw)) {
        // A round winner is the player left blank. An explicit 0 is a score,
        // not a winner marker. More than one blank is ambiguous, so there is
        // no winner for that round.
        if (winner === null) winner = player.id;
        else if (winner !== player.id) multipleBlanks = true;
      } else {
        sum += parseFloat(String(raw));
      }
    });

    if (multipleBlanks) winner = null;

    const summary: RoundSummary = { id: round.id, sum, winner };
    byRound[round.id] = summary;

    const cells = players.map<ScoreboardCell>((player) => {
      const raw = round.scores?.[player.id];
      const value = toNumber(raw);
      if (!isBlank(raw)) {
        playerTotals[player.id] += value as number;
        return { value, winner: false };
      }
      return { value, winner: winner === player.id };
    });

    return { id: round.id, index: roundIndex + 1, cells };
  });

  players.forEach((player) => {
    rounds.forEach((round) => {
      const entry = byRound[round.id];
      if (entry.winner === player.id) playerTotals[player.id] += Math.abs(entry.sum);
    });
    totals[player.id] = playerTotals[player.id];
  });

  const hasData = rounds.some((round) =>
    players.some((player) => {
      const value = toNumber(round.scores?.[player.id]);
      // Explicit 0 rows are used for late joiners, so they must not count as
      // score data on their own.
      return value !== null && value !== 0;
    }),
  );

  const maxTotal = hasData ? Math.max(...players.map((p) => totals[p.id])) : null;
  const leaderIds =
    hasData && players.length > 1
      ? players.filter((p) => totals[p.id] === maxTotal).map((p) => p.id)
      : [];

  return {
    rows,
    byRound,
    totals,
    players: players.map((player) => ({
      id: player.id,
      name: player.name,
      total: totals[player.id],
      leader: leaderIds.includes(player.id),
    })),
    hasData,
    leaderIds,
  };
}
