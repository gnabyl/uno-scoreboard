import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { recognizeCards } from './api/cardRecognition';
import { preloadModel } from './api/localModel';
import LogPanel from './LogPanel';
import { computeScore, scoreForCard } from './unoScoring';
import {
  addRound,
  deletePlayer,
  deleteRound,
  setScore,
} from './api/rooms';
import { describeRoomError } from './lib/roomCode';
import { useTranslation } from './i18n';
import { BTN_ACCENT, BTN_GHOST, BTN_PRIMARY, ErrorNotice } from './components/ui';
import type { RoomSnapshot } from './api/rooms';

const IS_TOUCH = (() => {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
  return 'ontouchstart' in window;
})();

const PLAYER_COLORS = [
  'bg-brand-red',
  'bg-brand-orange',
  'bg-brand-teal',
  'bg-brand-blue',
];

const SCORE_FIELD =
  'w-[60px] rounded-[10px] border border-edge bg-deep p-2 text-center text-base font-semibold outline-none sm:w-20 sm:p-2.5';
const SCORE_INPUT = `${SCORE_FIELD} transition placeholder:font-normal placeholder:text-[#3a4356] focus:border-accent focus:shadow-[0_0_0_3px_rgba(76,154,255,0.18)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

const CAMERA_BTN =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px] border border-edge bg-raised text-lg leading-none text-muted transition enabled:hover:border-accent enabled:hover:bg-accent/10 enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 sm:h-[38px] sm:w-[38px] sm:text-base';

async function annotatePreview(
  file: Blob,
  width: number,
  height: number,
  label: string
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const fontSize = Math.max(28, Math.round(height / 16));
    ctx.font = `700 ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(15, 21, 33, 0.85)';
    ctx.fillRect(8, 8, textWidth + 16, fontSize + 12);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, 16, 8 + fontSize + 2);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

const cellString = (value: number | string | null | undefined) =>
  value === null || value === undefined ? '' : String(value);

interface ScoreCellProps {
  value: number | string | null;
  label: string;
  onCommit: (value: string) => void;
  busy?: boolean;
}

function ScoreCell({ value, label, onCommit, busy }: ScoreCellProps) {
  const [draft, setDraft] = useState(cellString(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(cellString(value));
  }, [value]);

  const commit = () => {
    focusedRef.current = false;
    if (draft.trim() === "") {
      if (draft !== cellString(value)) onCommit(draft);
      return;
    }

    const num = Number(draft);

    if (!Number.isFinite(num)) return;

    const negativeValue = String(-Math.abs(num));

    setDraft(negativeValue);

    if (negativeValue !== cellString(value)) {
      onCommit(negativeValue);
    }
  };

  const isNegative = parseFloat(draft) < 0;

  return (
    <input
      className={`${SCORE_INPUT} ${isNegative ? 'text-[#ff4d4d]' : 'text-white'}`}
      type="number"
      step="1"
      inputMode="numeric"
      placeholder="-"
      aria-label={label}
      value={draft}
      disabled={busy}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

/** Scan modal state. `null` means the modal is closed. */
interface ScanState {
  roundId: string;
  playerId: string;
  status: 'capturing' | 'loading' | 'done' | 'error';
  previewUrl?: string;
  cards?: string[];
  annotatedPreview?: string;
  score?: number;
  error?: string;
}

export default function RoomBoard({
  code,
  snapshot,
  onRefresh,
}: {
  code: string;
  snapshot: RoomSnapshot;
  onRefresh: () => void | Promise<void>;
}) {
  const t = useTranslation();
  const players = snapshot.players;
  const rounds = snapshot.rounds;
  const version = Number(snapshot.version) || 0;
  const me = snapshot.me;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Collapse state: only the newest round stays open by default.
  const [collapsed, setCollapsed] = useState(() => {
    const ids = rounds.map((r) => r.id);
    return new Set(ids.slice(0, -1));
  });
  const prevRoundIdsRef = useRef<string[]>([]);

  useEffect(() => {
    const ids = rounds.map((r) => r.id);
    const prev = prevRoundIdsRef.current;
    const hasNew = ids.length !== prev.length || ids.some((id) => !prev.includes(id));
    prevRoundIdsRef.current = ids;
    if (hasNew && ids.length > 0) {
      setCollapsed(new Set(ids.slice(0, -1)));
    }
  }, [rounds]);

  const toggleRound = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Scan modal state.
  const [scan, setScan] = useState<ScanState | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const preloadStartedRef = useRef(false);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTargetRef = useRef<{ roundId: string; playerId: string } | null>(null);

  // Stop the camera if the component unmounts while it is running.
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Warm up the detector so the first scan doesn't wait on the model download.
  useEffect(() => {
    if (preloadStartedRef.current) return;
    preloadStartedRef.current = true;
    preloadModel()
      .then(() => setModelReady(true))
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runMutation = async (action: () => any) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (err) {
      setError(describeRoomError(err, t));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRemovePlayer = (id: string) => {
    const target = players.find((p) => p.id === id);
    if (
      target &&
      !window.confirm(t('board.removePlayerConfirm', { name: target.name }))
    ) {
      return;
    }
    runMutation(() => deletePlayer(code, id, version));
  };

  const handleAddRound = () => {
    runMutation(() => addRound(code, version));
  };

  const handleRemoveRound = (id: string) => {
    if (!window.confirm(t('board.removeRoundConfirm'))) return;
    runMutation(() => deleteRound(code, id, version));
  };

  const handleSetScore = (roundId: string, playerId: string, value: string) => {
    const previous = (() => {
      const round = rounds.find((r) => r.id === roundId);
      if (!round || !Object.prototype.hasOwnProperty.call(round.scores, playerId)) {
        return undefined;
      }
      return round.scores[playerId];
    })();

    runMutation(() =>
      setScore(code, {
        roundId,
        playerId,
        value,
        baseVersion: version,
        previousValue: previous,
      })
    );
  };

  const roundSummaries = useMemo<Record<string, { sum: number; winner: string | null }>>(
    () => {
      const map: Record<string, { sum: number; winner: string | null }> = {};
      rounds.forEach((round) => {
        let sum = 0;
        let winner: string | null = null;
        let multiple = false;
        players.forEach((p) => {
          const raw = round.scores[p.id];
          const value = parseFloat(raw);
          if (raw === null || raw === undefined || raw === '' || Number.isNaN(value) || value === 0) {
            if (winner === null) winner = p.id;
            else if (winner !== p.id) multiple = true;
          } else {
            sum += value;
          }
        });
        map[round.id] = { sum, winner: multiple ? null : winner };
      });
      return map;
    },
    [rounds, players]
  );

  const totals = useMemo<Record<string, number>>(() => {
    const result: Record<string, number> = {};
    players.forEach((p) => {
      result[p.id] = 0;
    });
    rounds.forEach((round) => {
      const summary = roundSummaries[round.id];
      players.forEach((p) => {
        const value = parseFloat(round.scores[p.id]);
        if (!Number.isNaN(value)) result[p.id] += value;
      });
      if (summary.winner) result[summary.winner] += Math.abs(summary.sum);
    });
    return result;
  }, [players, rounds, roundSummaries]);

  const hasData = rounds.some((round) =>
    players.some((p) => {
      const value = round.scores[p.id];
      return value !== null && value !== undefined && value !== '' && !Number.isNaN(parseFloat(value));
    })
  );

  const maxTotal = hasData ? Math.max(...players.map((p) => totals[p.id])) : null;
  const isWinner = (playerId: string) =>
    hasData && players.length > 1 && totals[playerId] === maxTotal;

  // ---------- Photo scanning ----------
  const attachVideo = (node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(() => { });
    }
  };

  const startCamera = async (roundId: string, playerId: string) => {
    setCameraError(null);
    setScan({ roundId, playerId, status: 'capturing' });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => { });
      }
    } catch {
      setCameraError(t('board.cameraError'));
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], 'uno-cards.jpg', { type: 'image/jpeg' });
        recognizeFileFor(file, scan.roundId, scan.playerId);
      },
      'image/jpeg',
      0.9
    );
  };

  const recognizeFileFor = async (file: File, roundId: string, playerId: string) => {
    stopCamera();
    const previewUrl = URL.createObjectURL(file);
    setScan({ roundId, playerId, previewUrl, status: 'loading' });

    try {
      const result = await recognizeCards(file);
      const count = result.detections.length;
      const annotatedPreview = await annotatePreview(
        file,
        result.width,
        result.height,
        t(count === 1 ? 'board.cardCountSingular' : 'board.cardCountPlural', { count })
      );
      setScan((prev) =>
        prev
          ? {
            ...prev,
            status: 'done',
            cards: result.cards,
            annotatedPreview,
            score: -computeScore(result.cards),
          }
          : prev
      );
    } catch (err) {
      setScan((prev) =>
        prev
          ? { ...prev, status: 'error', error: err.message || t('board.recognitionFailed') }
          : prev
      );
    }
  };

  const openCamera = (roundId: string, playerId: string) => {
    if (IS_TOUCH) {
      pendingTargetRef.current = { roundId, playerId };
      if (mobileInputRef.current) mobileInputRef.current.click();
    } else {
      startCamera(roundId, playerId);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    if (file && scan) recognizeFileFor(file, scan.roundId, scan.playerId);
  };

  const handleNativeFile = (event) => {
    const file = event.target.files && event.target.files[0];
    const target = pendingTargetRef.current;
    if (file && target) recognizeFileFor(file, target.roundId, target.playerId);
  };

  const applyScannedScore = () => {
    if (!scan || scan.status !== 'done') return;
    handleSetScore(scan.roundId, scan.playerId, String(scan.score));
    closeScan();
  };

  const closeScan = () => {
    stopCamera();
    if (scan && scan.previewUrl) URL.revokeObjectURL(scan.previewUrl);
    setScan(null);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {error && (
        <div className="mb-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      )}

      {players.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto rounded-[20px] border border-dashed border-edge bg-panel px-6 py-16 text-center">
          <span className="mb-3 block text-[44px]" aria-hidden="true">
            🎴
          </span>
          <h2 className="mb-2 text-2xl font-bold text-white">{t('board.noPlayers.title')}</h2>
          <p className="m-0 text-muted">{t('board.noPlayers.body')}</p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto pb-10">
            {rounds.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-edge bg-panel px-5 py-10 text-center text-sm text-faint">
                {t('board.noRounds')}
              </div>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-3 p-0">
                {rounds.map((round, roundIndex) => {
                  const summary = roundSummaries[round.id];
                  const isCollapsed = collapsed.has(round.id);
                  const isLastRound = roundIndex === rounds.length - 1;
                  const winnerName = summary.winner
                    ? players.find((p) => p.id === summary.winner)?.name
                    : null;
                  const anyScored = players.some((p) => {
                    const v = round.scores[p.id];
                    return v !== null && v !== undefined && v !== '';
                  });
                  return (
                    <li
                      key={round.id}
                      className="rounded-2xl border border-edge bg-panel shadow-panel"
                    >
                      <div className="flex items-center">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center justify-between gap-3 border-none bg-transparent px-4 py-3 text-left"
                          onClick={() => toggleRound(round.id)}
                          aria-expanded={!isCollapsed}
                        >
                          <span className="text-sm font-bold text-muted">
                            {t('board.round', { n: roundIndex + 1 })}
                          </span>
                          <span className="flex min-w-0 items-center gap-2 text-xs">
                            {winnerName ? (
                              <span className="truncate text-[#7dff9a]">
                                {t('board.roundWon', { name: winnerName })}
                              </span>
                            ) : anyScored ? (
                              <span className="text-faint">Σ {summary.sum}</span>
                            ) : null}
                            <span className="text-faint" aria-hidden="true">
                              {isCollapsed ? '▸' : '▾'}
                            </span>
                          </span>
                        </button>
                        <button
                          className="mr-3 rounded border-none bg-transparent p-0 text-lg leading-none text-faint transition hover:text-[#ff6b6b]"
                          title={t('board.removeRoundTitle')}
                          aria-label={t('board.removeRound', { n: roundIndex + 1 })}
                          disabled={busy}
                          onClick={() => handleRemoveRound(round.id)}
                        >
                          ×
                        </button>
                      </div>
                      {!isCollapsed && (
                        <ul className="m-0 flex list-none flex-col gap-2 border-t border-edge-soft p-4 pt-3">
                          {players.map((p, pi) => {
                            const isRoundWinner = summary.winner === p.id;
                            const raw = round.scores[p.id];
                            return (
                              <li
                                key={p.id}
                                className="flex items-center gap-3 rounded-xl border border-edge-soft bg-deep px-3 py-2"
                              >
                                {isLastRound && (
                                  <span className="flex w-4 shrink-0 items-center justify-center">
                                    {p.id !== me && (
                                      <button
                                        className="rounded border-none bg-transparent p-0 text-sm leading-none text-faint opacity-70 transition hover:text-[#ff6b6b]"
                                        title={t('board.removePlayer', { name: p.name })}
                                        aria-label={t('board.removePlayer', { name: p.name })}
                                        disabled={busy}
                                        onClick={() => handleRemovePlayer(p.id)}
                                      >
                                        ×
                                      </button>
                                    )}
                                  </span>
                                )}
                                <span
                                  className={`h-3 w-3 shrink-0 rounded-full ${PLAYER_COLORS[pi % 4]}`}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                                  {p.name}
                                </span>
                                {isLastRound && (
                                  <span
                                    className="flex shrink-0 items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-xs font-bold tabular-nums"
                                    title={t('board.currentScore')}
                                  >
                                    <span className={isWinner(p.id) ? 'text-[#7dff9a]' : 'text-fg'}>
                                      {totals[p.id]}
                                    </span>
                                    {isWinner(p.id) && (
                                      <span
                                        className="text-[13px] leading-none"
                                        aria-label={t('board.leadingPlayer')}
                                      >
                                        👑
                                      </span>
                                    )}
                                  </span>
                                )}
                                {isRoundWinner ? (
                                  <span
                                    className={`${SCORE_FIELD} inline-flex items-center justify-center font-bold text-[#7dff9a]`}
                                  >
                                    {Math.abs(summary.sum)}
                                  </span>
                                ) : (
                                  <ScoreCell
                                    value={raw}
                                    label={t('board.scoreLabel', { name: p.name, n: roundIndex + 1 })}
                                    busy={busy}
                                    onCommit={(value) => handleSetScore(round.id, p.id, value)}
                                  />
                                )}
                                <button
                                  className={CAMERA_BTN}
                                  title={
                                    modelReady
                                      ? t('board.scanTitle', { name: p.name })
                                      : t('board.detectorLoading')
                                  }
                                  aria-label={t('board.scanAria', {
                                    name: p.name,
                                    n: roundIndex + 1,
                                  })}
                                  disabled={!modelReady}
                                  onClick={() => openCamera(round.id, p.id)}
                                >
                                  <span className="block -translate-y-[0.22em]" aria-hidden="true">
                                    📷
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="mt-3 flex justify-center">
              <button
                className={BTN_ACCENT}
                onClick={handleAddRound}
                disabled={players.length === 0 || busy}
              >
                {t('board.newRound')}
              </button>
            </div>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />

      <input
        ref={mobileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleNativeFile}
      />

      {scan && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(5,8,14,0.7)] p-2.5 backdrop-blur-sm sm:p-5"
          onClick={closeScan}
        >
          <div
            className="relative max-h-[96vh] w-full max-w-none overflow-y-auto rounded-[14px] border border-edge bg-panel p-4 shadow-modal sm:max-h-[90vh] sm:max-w-[420px] sm:rounded-[18px] sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-label={t('board.scanDialog')}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="absolute right-3 top-3 cursor-pointer rounded-lg border-none bg-transparent px-2 py-1 text-[22px] leading-none text-faint hover:bg-edge hover:text-white"
              onClick={closeScan}
              aria-label={t('common.close')}
            >
              ×
            </button>

            {scan.status === 'capturing' && (
              <div className="flex flex-col gap-3.5">
                <video
                  ref={attachVideo}
                  className="aspect-[4/3] w-full rounded-xl border border-edge bg-black object-cover"
                  playsInline
                  muted
                />
                {cameraError ? (
                  <p className="m-0 text-center text-sm text-[#ffb3b3]">{cameraError}</p>
                ) : (
                  <p className="m-0 text-center text-sm text-muted">
                    {modelReady ? t('board.aim') : t('board.loadingDetector')}
                  </p>
                )}
                <div className="flex justify-between gap-2.5 max-sm:flex-wrap max-sm:[&>button]:min-h-12 max-sm:[&>button]:text-[15px] [&>button]:flex-1">
                  <button className={BTN_GHOST} onClick={closeScan}>
                    {t('common.cancel')}
                  </button>
                  <button
                    className={BTN_GHOST}
                    disabled={!modelReady}
                    onClick={() => {
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                        fileInputRef.current.click();
                      }
                    }}
                  >
                    {t('board.uploadImage')}
                  </button>
                  <button
                    className={`${BTN_ACCENT} flex items-center justify-center gap-2`}
                    onClick={capturePhoto}
                    disabled={!!cameraError || !modelReady}
                  >
                    <span className="text-base leading-none" aria-hidden="true">
                      ⏺
                    </span>
                    {t('board.capture')}
                  </button>
                </div>
              </div>
            )}

            {scan.status === 'loading' && (
              <div className="flex flex-col items-center gap-4 py-6 text-muted">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-edge border-t-accent [animation-duration:0.8s]" />
                <p className="m-0">{t('board.recognizing')}</p>
              </div>
            )}

            {scan.status === 'error' && (
              <div className="flex flex-col items-center gap-3 py-3 text-center text-muted">
                <span className="text-[32px]" aria-hidden="true">
                  ⚠️
                </span>
                <p className="m-0">{scan.error}</p>
                <button
                  className={BTN_PRIMARY}
                  onClick={() => startCamera(scan.roundId, scan.playerId)}
                >
                  {t('common.tryAgain')}
                </button>
              </div>
            )}

            {scan.status === 'done' && (
              <div>
                <h3 className="mb-3.5 text-[17px] font-bold text-white">
                  {t('board.detectedCards')}
                </h3>
                {scan.previewUrl && (
                  <img
                    className="mb-3.5 max-h-[260px] w-full rounded-xl border border-edge bg-deep object-contain"
                    src={scan.annotatedPreview || scan.previewUrl}
                    alt={t('board.capturedAlt')}
                  />
                )}
                {scan.cards && scan.cards.length > 0 ? (
                  <ul className="mb-3.5 max-h-[180px] list-none overflow-y-auto p-0">
                    {scan.cards.map((card, i) => (
                      <li
                        key={i}
                        className="mb-1.5 flex items-center justify-between rounded-[10px] border border-edge-soft bg-deep px-3 py-2.5"
                      >
                        <span className="text-sm text-fg">{card}</span>
                        <span className="text-sm font-bold text-[#ff4d4d]">
                          −{scoreForCard(card)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-3.5 text-sm text-faint">{t('board.noCards')}</p>
                )}
                <div className="mb-[18px] flex items-center justify-between gap-3">
                  <label className="text-sm font-semibold text-muted" htmlFor="scan-score">
                    {t('board.totalScore')}
                  </label>
                  <input
                    id="scan-score"
                    type="number"
                    step="1"
                    className="w-[100px] rounded-[10px] border border-edge bg-deep p-2.5 text-center text-base font-bold text-[#ff4d4d] outline-none focus:border-accent"
                    value={scan.score}
                    onChange={(event) =>
                      setScan((prev) =>
                        prev ? { ...prev, score: Number(event.target.value) } : prev
                      )
                    }
                  />
                </div>
                <div className="flex justify-end gap-2.5">
                  <button className={BTN_GHOST} onClick={closeScan}>
                    {t('common.cancel')}
                  </button>
                  <button className={BTN_ACCENT} onClick={applyScannedScore}>
                    {t('board.applyScore')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <LogPanel />
    </div>
  );
}
