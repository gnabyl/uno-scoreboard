import { useEffect, useMemo, useRef, useState } from 'react';
import { recognizeCards } from './api/cardRecognition';
import { preloadModel } from './api/localModel';
import LogPanel from './LogPanel';
import { computeScore, scoreForCard } from './unoScoring';
import {
  addPlayer,
  addRound,
  deletePlayer,
  deleteRound,
  resetRoom,
  setScore,
} from './api/rooms';
import { describeRoomError } from './lib/roomCode';
import { BTN_ACCENT, BTN_GHOST, BTN_PRIMARY, ErrorNotice, INPUT } from './components/ui';

const IS_TOUCH = (() => {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia) return window.matchMedia('(pointer: coarse)').matches;
  return 'ontouchstart' in window;
})();

const PLAYER_COLORS = [
  'before:bg-brand-red',
  'before:bg-brand-orange',
  'before:bg-brand-teal',
  'before:bg-brand-blue',
];

const CELL = 'px-2 py-2.5 text-center sm:px-3.5 sm:py-3';

const REMOVE_BTN =
  'rounded-md border-none bg-transparent p-1 text-xl leading-none text-faint opacity-0 transition hover:bg-[rgba(255,107,107,0.12)] hover:text-[#ff6b6b] max-sm:opacity-100 sm:p-0.5 sm:px-1.5 sm:text-lg';

const SCORE_FIELD =
  'w-[60px] rounded-[10px] border border-edge bg-deep p-2 text-center text-base font-semibold outline-none sm:w-20 sm:p-2.5';
const SCORE_INPUT = `${SCORE_FIELD} transition placeholder:font-normal placeholder:text-[#3a4356] focus:border-accent focus:shadow-[0_0_0_3px_rgba(76,154,255,0.18)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`;

const CAMERA_BTN =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[10px] border border-edge bg-raised text-lg leading-none text-muted transition enabled:hover:border-accent enabled:hover:bg-accent/10 enabled:hover:text-accent disabled:cursor-not-allowed disabled:opacity-45 sm:h-[38px] sm:w-[38px] sm:text-base';

async function annotatePreview(file, detections, width, height) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const count = detections.length;
    const fontSize = Math.max(28, Math.round(height / 16));
    ctx.font = `700 ${fontSize}px sans-serif`;
    const label = `${count} card${count === 1 ? '' : 's'}`;
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

const cellString = (value) => (value === null || value === undefined ? '' : String(value));

function ScoreCell({ value, label, onCommit, busy }) {
  const [draft, setDraft] = useState(cellString(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(cellString(value));
  }, [value]);

  const commit = () => {
    focusedRef.current = false;
    if (draft !== cellString(value)) onCommit(draft);
  };

  const isNegative = parseFloat(draft) < 0;

  return (
    <input
      className={`${SCORE_INPUT} ${isNegative ? 'text-[#ff4d4d]' : 'text-white'}`}
      type="number"
      step="1"
      inputMode="numeric"
      placeholder="—"
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

export default function RoomBoard({ code, snapshot, onRefresh }) {
  const players = snapshot.players;
  const rounds = snapshot.rounds;
  const version = Number(snapshot.version) || 0;
  const me = snapshot.me;

  const [newPlayer, setNewPlayer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Scan modal state. `null` means the modal is closed.
  const [scan, setScan] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [modelReady, setModelReady] = useState(false);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const preloadStartedRef = useRef(false);
  const mobileInputRef = useRef(null);
  const pendingTargetRef = useRef(null);

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
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runMutation = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (err) {
      setError(describeRoomError(err));
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAddPlayer = () => {
    const name = newPlayer.trim();
    if (!name) return;
    runMutation(async () => {
      await addPlayer(code, name, version);
      setNewPlayer('');
    });
  };

  const handleRemovePlayer = (id) => {
    const target = players.find((p) => p.id === id);
    if (
      target &&
      !window.confirm(`Remove ${target.name}? They will be kicked and their scores removed.`)
    ) {
      return;
    }
    runMutation(() => deletePlayer(code, id, version));
  };

  const handleAddRound = () => {
    runMutation(() => addRound(code, version));
  };

  const handleRemoveRound = (id) => {
    if (!window.confirm('Remove this round?')) return;
    runMutation(() => deleteRound(code, id, version));
  };

  const handleReset = () => {
    if (
      window.confirm('Reset the scoreboard? This clears all players and rounds.')
    ) {
      runMutation(() => resetRoom(code, version));
    }
  };

  const handleSetScore = (roundId, playerId, value) => {
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

  const roundSummaries = useMemo(() => {
    const map = {};
    rounds.forEach((round) => {
      let sum = 0;
      let winner = null;
      let multiple = false;
      players.forEach((p) => {
        const raw = round.scores[p.id];
        const value = parseFloat(raw);
        if (raw === null || raw === undefined || raw === '' || Number.isNaN(value)) {
          if (winner === null) winner = p.id;
          else if (winner !== p.id) multiple = true;
        } else {
          sum += value;
        }
      });
      map[round.id] = { sum, winner: multiple ? null : winner };
    });
    return map;
  }, [rounds, players]);

  const totals = useMemo(() => {
    const result = {};
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
  const isWinner = (playerId) =>
    hasData && players.length > 1 && totals[playerId] === maxTotal;

  // ---------- Photo scanning ----------
  const attachVideo = (node) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(() => {});
    }
  };

  const startCamera = async (roundId, playerId) => {
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
        videoRef.current.play().catch(() => {});
      }
    } catch {
      setCameraError(
        'Could not access the camera. Please allow camera access, or use “Upload image”.'
      );
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

  const recognizeFileFor = async (file, roundId, playerId) => {
    stopCamera();
    const previewUrl = URL.createObjectURL(file);
    setScan({ roundId, playerId, previewUrl, status: 'loading' });

    try {
      const result = await recognizeCards(file);
      const annotatedPreview = await annotatePreview(
        file,
        result.detections,
        result.width,
        result.height
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
          ? { ...prev, status: 'error', error: err.message || 'Recognition failed.' }
          : prev
      );
    }
  };

  const openCamera = (roundId, playerId) => {
    if (IS_TOUCH) {
      pendingTargetRef.current = { roundId, playerId };
      if (mobileInputRef.current) mobileInputRef.current.click();
    } else {
      startCamera(roundId, playerId);
    }
  };

  const handleFileChange = (event) => {
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
    <div className="flex min-w-0 flex-1 flex-col">
      <section className="mb-4 flex shrink-0 flex-col items-stretch gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-1 gap-2.5 sm:min-w-[260px]">
          <input
            type="text"
            placeholder="Player name"
            value={newPlayer}
            maxLength={20}
            className={INPUT}
            onChange={(event) => setNewPlayer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAddPlayer();
            }}
          />
          <button className={BTN_PRIMARY} onClick={handleAddPlayer} disabled={busy}>
            + Add player
          </button>
        </div>
        <div className="flex gap-2.5">
          <button
            className={`${BTN_ACCENT} flex-1 sm:flex-none`}
            onClick={handleAddRound}
            disabled={players.length === 0 || busy}
          >
            + New round
          </button>
          <button className={`${BTN_GHOST} flex-1 sm:flex-none`} onClick={handleReset} disabled={busy}>
            Reset
          </button>
        </div>
      </section>

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
          <h2 className="mb-2 text-2xl font-bold text-white">No players yet</h2>
          <p className="m-0 text-muted">
            Add the players sitting around the table to start the scoreboard.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-[18px] border border-edge-soft bg-panel shadow-panel">
          <table className="w-full min-w-[520px] border-separate border-spacing-0 max-sm:min-w-[440px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 w-[84px] border-b border-edge bg-raised px-2 py-2.5 text-left text-xs font-semibold text-muted sm:w-[120px] sm:px-3.5 sm:py-3 sm:text-[13px]">
                  Round
                </th>
                {players.map((p, i) => (
                  <th
                    key={p.id}
                    className={`group/player sticky top-0 z-10 border-b border-l border-edge bg-raised px-2 py-2.5 text-center before:block before:mx-auto before:mb-2 before:h-1 before:w-[26px] before:rounded-full before:content-[''] sm:px-3.5 sm:before:mb-2.5 sm:before:h-[5px] sm:before:w-[34px] ${PLAYER_COLORS[i % 4]}`}
                  >
                    <div className="relative mx-auto w-full max-w-[80px] sm:max-w-[120px]">
                      <span className="block truncate px-0.5 py-1 text-center text-[13px] font-bold text-white sm:text-sm">
                        {p.name}
                      </span>
                      {p.id === me && (
                        <span className="block text-[10px] font-semibold uppercase tracking-wide text-accent">
                          you
                        </span>
                      )}
                      <button
                        className={`${REMOVE_BTN} absolute left-full top-1/2 -translate-y-1/2 group-hover/player:opacity-100`}
                        title={`Remove ${p.name}`}
                        aria-label={`Remove ${p.name}`}
                        disabled={busy}
                        onClick={() => handleRemovePlayer(p.id)}
                      >
                        ×
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rounds.length === 0 ? (
                <tr>
                  <td
                    className={`${CELL} !px-4 !py-10 text-sm text-faint`}
                    colSpan={players.length + 1}
                  >
                    No rounds yet — press “+ New round” to start scoring.
                  </td>
                </tr>
              ) : (
                rounds.map((round, roundIndex) => (
                  <tr key={round.id} className="hover:bg-white/[0.02]">
                    <td className="w-[84px] border-t border-edge-soft px-2 py-2.5 text-left text-xs font-semibold text-muted sm:w-[120px] sm:px-3.5 sm:py-3 sm:text-[13px]">
                      <div className="group/round flex items-center gap-2">
                        <button
                          className={`${REMOVE_BTN} group-hover/round:opacity-100`}
                          title="Remove round"
                          aria-label={`Remove round ${roundIndex + 1}`}
                          disabled={busy}
                          onClick={() => handleRemoveRound(round.id)}
                        >
                          ×
                        </button>
                        <span>{roundIndex + 1}</span>
                      </div>
                    </td>
                    {players.map((p) => {
                      const summary = roundSummaries[round.id];
                      const isRoundWinner = summary.winner === p.id;
                      const raw = round.scores[p.id];
                      return (
                        <td key={p.id} className={`${CELL} border-t border-edge-soft`}>
                          <div className="flex items-center justify-center gap-2">
                            {isRoundWinner ? (
                              <span
                                className={`${SCORE_FIELD} inline-flex items-center justify-center font-bold text-[#7dff9a]`}
                              >
                                {Math.abs(summary.sum)}
                              </span>
                            ) : (
                              <ScoreCell
                                value={raw}
                                label={`${p.name} round ${roundIndex + 1} score`}
                                busy={busy}
                                onCommit={(value) => handleSetScore(round.id, p.id, value)}
                              />
                            )}
                            <button
                              className={CAMERA_BTN}
                              title={
                                modelReady ? `Scan ${p.name}'s cards` : 'Detector still loading…'
                              }
                              aria-label={`Scan ${p.name}'s cards for round ${roundIndex + 1}`}
                              disabled={!modelReady}
                              onClick={() => openCamera(round.id, p.id)}
                            >
                              <span className="block -translate-y-[0.22em]" aria-hidden="true">
                                📷
                              </span>
                            </button>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky bottom-0 w-[84px] border-t-2 border-edge bg-raised px-2 py-3.5 text-left text-base font-extrabold text-white sm:w-[120px] sm:px-3.5">
                  Total
                </td>
                {players.map((p) => {
                  const winner = isWinner(p.id);
                  const total = totals[p.id];
                  const totalColor = winner
                    ? 'text-[#4ad0b9]'
                    : total < 0
                      ? 'text-[#ff4d4d]'
                      : '';
                  return (
                    <td
                      key={p.id}
                      className={`sticky bottom-0 border-t-2 border-edge px-2 py-3.5 text-center text-base font-extrabold text-white sm:px-3.5 ${
                        winner ? 'bg-[rgba(42,157,143,1)]' : 'bg-raised'
                      }`}
                    >
                      <div className={`flex items-center justify-center gap-1.5 ${totalColor}`}>
                        <span>{total}</span>
                        {winner && (
                          <span className="text-[15px]" aria-label="Leading player">
                            👑
                          </span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
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
            aria-label="Card scan"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="absolute right-3 top-3 cursor-pointer rounded-lg border-none bg-transparent px-2 py-1 text-[22px] leading-none text-faint hover:bg-edge hover:text-white"
              onClick={closeScan}
              aria-label="Close"
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
                    {modelReady ? 'Aim at the cards, then capture.' : 'Loading card detector…'}
                  </p>
                )}
                <div className="flex justify-between gap-2.5 max-sm:flex-wrap max-sm:[&>button]:min-h-12 max-sm:[&>button]:text-[15px] [&>button]:flex-1">
                  <button className={BTN_GHOST} onClick={closeScan}>
                    Cancel
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
                    Upload image
                  </button>
                  <button
                    className={`${BTN_ACCENT} flex items-center justify-center gap-2`}
                    onClick={capturePhoto}
                    disabled={!!cameraError || !modelReady}
                  >
                    <span className="text-base leading-none" aria-hidden="true">
                      ⏺
                    </span>
                    Capture
                  </button>
                </div>
              </div>
            )}

            {scan.status === 'loading' && (
              <div className="flex flex-col items-center gap-4 py-6 text-muted">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-edge border-t-accent [animation-duration:0.8s]" />
                <p className="m-0">Recognizing cards…</p>
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
                  Try again
                </button>
              </div>
            )}

            {scan.status === 'done' && (
              <div>
                <h3 className="mb-3.5 text-[17px] font-bold text-white">Detected cards</h3>
                {scan.previewUrl && (
                  <img
                    className="mb-3.5 max-h-[260px] w-full rounded-xl border border-edge bg-deep object-contain"
                    src={scan.annotatedPreview || scan.previewUrl}
                    alt="Captured cards"
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
                  <p className="mb-3.5 text-sm text-faint">
                    No cards were detected. Try taking the photo again.
                  </p>
                )}
                <div className="mb-[18px] flex items-center justify-between gap-3">
                  <label className="text-sm font-semibold text-muted" htmlFor="scan-score">
                    Total score
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
                    Cancel
                  </button>
                  <button className={BTN_ACCENT} onClick={applyScannedScore}>
                    Apply score
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
