import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { recognizeCards } from '../api-helper/cardRecognition';
import { preloadModel, type Detection } from '../api-helper/localModel';
import LogPanel from './LogPanel';
import ScanPreview from './ScanPreview';
import { computeScore, scoreForCard } from '../lib/unoScoring';
import { buildScoreboard } from '../lib/scoreboard';
import { addPlayer, addRound, deletePlayer, deleteRound, setScore } from '../api-helper/rooms';
import { describeRoomError } from '../lib/roomCode';
import { useTranslation } from '../i18n';
import { fitWithin } from '../lib/photo';
import { BTN_ACCENT, BTN_GHOST, BTN_PRIMARY, ErrorNotice, INPUT } from './ui';
import type { RoomSnapshot } from '../api-helper/rooms';
import { Modal } from './modal';

const PLAYER_COLORS = ['bg-brand-red', 'bg-brand-orange', 'bg-brand-teal', 'bg-brand-blue'];

const SCORE_FIELD =
  'w-[60px] rounded-[10px] border border-edge bg-deep p-2 text-center text-base font-semibold outline-none sm:w-20 sm:p-2.5';
const SCORE_INPUT = `${SCORE_FIELD} transition placeholder:font-normal placeholder:text-[#3a4356] focus:border-accent focus:shadow-[0_0_0_3px_rgba(76,154,255,0.18)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

const CAMERA_BTN =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px] border border-edge bg-raised text-lg leading-none text-muted transition enabled:hover:border-accent enabled:hover:bg-accent/10 enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 sm:h-[38px] sm:w-[38px] sm:text-base';

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
    if (draft.trim() === '') {
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
  detections?: Detection[];
  imageWidth?: number;
  imageHeight?: number;
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
  const [showBoxes, setShowBoxes] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  // The size of the frame the camera delivers. The preview takes this ratio,
  // so it shows what the camera really sees instead of a cropped 4:3 slice.
  const [streamSize, setStreamSize] = useState<{ width: number; height: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const preloadStartedRef = useRef(false);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTargetRef = useRef<{ roundId: string; playerId: string } | null>(null);
  // The preview URL of the scan that is on screen, so it can be revoked.
  const previewUrlRef = useRef<string | null>(null);
  // Bumped whenever the camera is (re)started or stopped, so a stream that
  // arrives late - after the permission prompt was dismissed - is discarded
  // instead of being attached to the wrong view.
  const cameraTokenRef = useRef(0);

  // Add player modal
  const [newPlayerName, setNewPlayerName] = useState<string>('');
  const [addPlayerModalOpen, setAddPlayerModalOpen] = useState<boolean>(false);
  const [addPlayerError, setAddPlayerError] = useState<string | null>(null);

  // Release the camera and the preview when the component goes away.
  useEffect(() => {
    return () => {
      cameraTokenRef.current += 1;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  // Warm up the detector so the first scan doesn't wait on the model download.
  useEffect(() => {
    if (preloadStartedRef.current) return;
    preloadStartedRef.current = true;
    preloadModel()
      .then(() => setModelReady(true))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runMutation = async (action: () => any, onError?: (message: string) => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
      return true;
    } catch (err) {
      const message = describeRoomError(err, t);
      if (onError) onError(message);
      else setError(message);
      await onRefresh();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleRemovePlayer = (id: string) => {
    const target = players.find((p) => p.id === id);
    if (target && !window.confirm(t('board.removePlayerConfirm', { name: target.name }))) {
      return;
    }
    runMutation(() => deletePlayer(code, id, version));
  };

  const openAddPlayer = () => {
    setNewPlayerName('');
    setAddPlayerError(null);
    setAddPlayerModalOpen(true);
  };

  const closeAddPlayer = () => {
    setAddPlayerModalOpen(false);
    setNewPlayerName('');
    setAddPlayerError(null);
  };

  const handleAddPlayer = async (name: string) => {
    setAddPlayerError(null);
    const ok = await runMutation(() => addPlayer(code, name, version), setAddPlayerError);
    if (ok) closeAddPlayer();
  };

  const handleAddPlayerSubmit = (event: FormEvent) => {
    event.preventDefault();
    const name = newPlayerName.trim();
    if (!name) return;
    handleAddPlayer(name);
  };

  const handleAddRound = () => {
    runMutation(() => addRound(code, version));
  };

  const handleRemoveRound = (id: string) => {
    if (!window.confirm(t('board.removeRoundConfirm'))) return;
    runMutation(() => deleteRound(code, id, version));
  };

  const handleSetScore = (roundId: string, playerId: string, value: string) => {
    const round = rounds.find((r) => r.id === roundId);
    const previous = round ? round.scores[playerId] : undefined;

    runMutation(() =>
      setScore(code, {
        roundId,
        playerId,
        value,
        baseVersion: version,
        previousValue: previous,
      }),
    );
  };

  const scoreboard = useMemo(() => buildScoreboard(players, rounds), [players, rounds]);
  const roundSummaries = scoreboard.byRound;
  const totals = scoreboard.totals;
  const isWinner = (playerId: string) => scoreboard.leaderIds.includes(playerId);

  // ---------- Photo scanning ----------
  const attachVideo = (node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(() => {});
    }
  };

  /**
   * Opens the native camera app.
   *
   * This is only a fallback: the native camera runs in another app, and
   * Android Chrome reloads the tab when that app closes - the OS kills the
   * renderer while the camera is in the foreground, and the page comes back
   * reloaded (crbug.com/chromium/409357263). The in-page camera keeps the
   * tab alive, so it is the one that is used.
   */
  const openNativeCamera = (roundId: string, playerId: string) => {
    pendingTargetRef.current = { roundId, playerId };
    const input = mobileInputRef.current;
    if (!input) return;
    // Clear the selection so the same photo can be taken again.
    input.value = '';
    input.click();
  };

  const startCamera = async (roundId: string, playerId: string) => {
    setCameraError(null);
    setStreamSize(null);
    setScan({ roundId, playerId, status: 'capturing' });

    const token = ++cameraTokenRef.current;

    if (!navigator.mediaDevices?.getUserMedia) {
      // No in-page camera at all: the native one is all there is.
      openNativeCamera(roundId, playerId);
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch {
      // The in-page camera needs a permission the user may have refused.
      // The native camera app needs none, so it is the fallback.
      setCameraError(t('board.cameraError'));
      openNativeCamera(roundId, playerId);
      return;
    }

    // The scan may have been closed while the permission prompt was up.
    if (token !== cameraTokenRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;
    // The <video> element may still be on its way; when it mounts it picks
    // the stream up from streamRef.
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  };

  const stopCamera = () => {
    // Any stream that is still on its way is no longer wanted.
    cameraTokenRef.current += 1;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !scan) return;

    // The frame is scaled down before it is encoded: a full-size frame is
    // far more pixels than the detector needs, and holding them is what gets
    // a phone's browser killed.
    const size = fitWithin(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, size.width, size.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], 'uno-cards.jpg', { type: 'image/jpeg' });
        recognizeFileFor(file, scan.roundId, scan.playerId);
      },
      'image/jpeg',
      0.9,
    );
  };

  /** Points the preview at a new photo and frees the previous one. */
  const setPreview = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const previous = previewUrlRef.current;
    previewUrlRef.current = url;
    if (previous) URL.revokeObjectURL(previous);
    return url;
  };

  const recognizeFileFor = async (file: File, roundId: string, playerId: string) => {
    stopCamera();
    setShowBoxes(false);
    setScan({ roundId, playerId, status: 'loading' });

    try {
      const result = await recognizeCards(file);
      // The preview shows the photo the detector actually read, not the
      // full-resolution original.
      const previewUrl = setPreview(result.image ?? file);
      setScan((prev) =>
        prev
          ? {
              ...prev,
              status: 'done',
              previewUrl,
              cards: result.cards,
              detections: result.detections,
              imageWidth: result.width,
              imageHeight: result.height,
              score: -computeScore(result.cards),
            }
          : prev,
      );
    } catch (err) {
      setScan((prev) =>
        prev
          ? { ...prev, status: 'error', error: err.message || t('board.recognitionFailed') }
          : prev,
      );
    }
  };

  const openCamera = (roundId: string, playerId: string) => {
    startCamera(roundId, playerId);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    if (file && scan) recognizeFileFor(file, scan.roundId, scan.playerId);
  };

  const handleNativeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    // Clear the selection so the same photo can be taken again.
    event.target.value = '';
    const target = pendingTargetRef.current;
    pendingTargetRef.current = null;
    if (file && target) recognizeFileFor(file, target.roundId, target.playerId);
  };

  const applyScannedScore = () => {
    if (!scan || scan.status !== 'done') return;
    handleSetScore(scan.roundId, scan.playerId, String(scan.score));
    closeScan();
  };

  const closeScan = () => {
    stopCamera();
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setScan(null);
  };

  const cardCount = scan?.cards?.length ?? 0;

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
              <div className="rounded-2xl border border-edge bg-panel p-4 shadow-panel">
                <h2 className="m-0 text-sm font-bold text-muted">{t('board.players')}</h2>
                <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
                  {players.map((p, pi) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-3 rounded-xl border border-edge-soft bg-deep px-3 py-2"
                    >
                      <span className="flex w-4 shrink-0 items-center justify-center">
                        {p.id !== me && (
                          <button
                            className="rounded border-none bg-transparent p-0 text-sm leading-none text-[#ff4d4d] transition hover:text-[#ff6b6b]"
                            title={t('board.removePlayer', { name: p.name })}
                            aria-label={t('board.removePlayer', { name: p.name })}
                            disabled={busy}
                            onClick={() => handleRemovePlayer(p.id)}
                          >
                            ×
                          </button>
                        )}
                      </span>
                      <span
                        className={`h-3 w-3 shrink-0 rounded-full ${PLAYER_COLORS[pi % 4]}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{p.name}</span>
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-3 text-center text-xs text-faint">{t('board.noRounds')}</p>
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
                            {winnerName && (
                              <span className="truncate text-[#7dff9a]">
                                {t('board.roundWon', { name: winnerName })}
                              </span>
                            )}
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
                                        className="rounded border-none bg-transparent p-0 text-sm leading-none text-[#ff4d4d] transition hover:text-[#ff6b6b]"
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
                                    label={t('board.scoreLabel', {
                                      name: p.name,
                                      n: roundIndex + 1,
                                    })}
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

            <div className="mt-3 flex justify-center gap-3">
              <button
                className={BTN_ACCENT}
                onClick={handleAddRound}
                disabled={players.length === 0 || busy}
              >
                {t('board.newRound')}
              </button>
              <button className={BTN_ACCENT} disabled={busy} onClick={openAddPlayer}>
                {t('board.newPlayer')}
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

      {/* Fallback for browsers without an in-page camera. It is kept in the
          layout (just off-screen) rather than display:none, because a hidden
          input is what makes the browser reload the page when the camera
          app closes. */}
      <input
        ref={mobileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="pointer-events-none absolute left-[-9999px] top-0 h-px w-px opacity-0"
        onChange={handleNativeFile}
      />

      <Modal isVisible={addPlayerModalOpen} onClose={closeAddPlayer} labelledBy="new-player-title">
        <h2 id="new-player-title" className="m-0 mb-4 text-lg font-bold text-white">
          {t('board.addPlayerTitle')}
        </h2>
        <form onSubmit={handleAddPlayerSubmit}>
          <label htmlFor="new-player-name" className="sr-only">
            {t('board.newPlayerName')}
          </label>
          <input
            id="new-player-name"
            type="text"
            value={newPlayerName}
            maxLength={20}
            autoComplete="off"
            autoFocus
            placeholder={t('board.newPlayerName')}
            className={INPUT}
            onChange={(event) => setNewPlayerName(event.target.value)}
          />
          {addPlayerError && (
            <div className="mt-3">
              <ErrorNotice>{addPlayerError}</ErrorNotice>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-3">
            <button type="button" className={BTN_GHOST} onClick={closeAddPlayer}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={BTN_ACCENT}
              disabled={newPlayerName.trim() === '' || busy}
            >
              {t('common.add')}
            </button>
          </div>
        </form>
      </Modal>

      {scan && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(5,8,14,0.7)] p-2.5 backdrop-blur-sm sm:p-5"
          onClick={closeScan}
        >
          <div
            className="relative flex max-h-[92dvh] w-full max-w-none flex-col overflow-y-auto rounded-[14px] border border-edge bg-panel p-4 shadow-modal sm:max-w-[min(96vw,1400px)] sm:rounded-[18px] sm:p-6"
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
                {/* The box takes the ratio the camera delivers, so the whole
                    frame is visible - not a cropped, zoomed-in slice of it.
                    The width is capped by the height as well, so the buttons
                    below stay on screen. */}
                <div
                  className="mx-auto overflow-hidden rounded-xl border border-edge bg-black"
                  style={{
                    aspectRatio: streamSize
                      ? `${streamSize.width} / ${streamSize.height}`
                      : '4 / 3',
                    width: streamSize
                      ? `min(100%, 620px, calc(45vh * ${streamSize.width} / ${streamSize.height}))`
                      : undefined,
                  }}
                >
                  <video
                    ref={attachVideo}
                    onLoadedMetadata={(event) => {
                      const video = event.currentTarget;
                      if (video.videoWidth && video.videoHeight) {
                        setStreamSize({ width: video.videoWidth, height: video.videoHeight });
                      }
                    }}
                    className="h-full w-full object-contain"
                    playsInline
                    muted
                  />
                </div>
                {cameraError ? (
                  <p className="m-0 text-center text-sm text-[#ffb3b3]">{cameraError}</p>
                ) : (
                  <p className="m-0 text-center text-sm text-muted">
                    {modelReady ? t('board.aim') : t('board.loadingDetector')}
                  </p>
                )}
                <div className="flex justify-between gap-2.5 max-sm:flex-wrap [&>button]:flex-1 max-sm:[&>button]:min-h-12 max-sm:[&>button]:text-[15px]">
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
              <div className="flex flex-col gap-3">
                <h3 className="m-0 shrink-0 text-[17px] font-bold text-white">
                  {t('board.detectedCardsCount', { count: cardCount })}
                </h3>
                {/* The photo keeps its own shape and is capped by the screen,
                    the list scrolls in its own box: together they fit the
                    modal, so it does not spill out of it. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-1">
                    {scan.previewUrl && (
                      <>
                        <ScanPreview
                          url={scan.previewUrl}
                          width={scan.imageWidth ?? 0}
                          height={scan.imageHeight ?? 0}
                          label={t(
                            cardCount === 1 ? 'board.cardCountSingular' : 'board.cardCountPlural',
                            { count: cardCount },
                          )}
                          detections={scan.detections ?? []}
                          showBoxes={showBoxes}
                          alt={t('board.capturedAlt')}
                        />
                        <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-sm text-muted">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 accent-accent"
                            checked={showBoxes}
                            onChange={(event) => setShowBoxes(event.target.checked)}
                          />
                          {t('board.showBoxes')}
                        </label>
                      </>
                    )}
                  </div>
                  <div className="max-h-[28vh] min-w-0 overflow-y-auto sm:max-h-[45vh] sm:w-[min(320px,40%)] sm:shrink-0">
                    {scan.cards && scan.cards.length > 0 ? (
                      <ul className="mb-3.5 list-none p-0">
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
                  </div>
                </div>
                {/* The score and the buttons stay pinned to the bottom, so
                    they are reachable however long the list is. */}
                <div className="flex shrink-0 items-center justify-between gap-3">
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
                        prev ? { ...prev, score: Number(event.target.value) } : prev,
                      )
                    }
                  />
                </div>
                <div className="flex shrink-0 justify-end gap-2.5">
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
