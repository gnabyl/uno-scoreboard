import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { recognizeCards } from './api/cardRecognition';
import { preloadModel } from './api/localModel';
import LogPanel from './LogPanel';
import { computeScore, scoreForCard } from './unoScoring';

const STORAGE_KEY = 'uno-scoreboard-v1';

const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        players: Array.isArray(parsed.players) ? parsed.players : [],
        rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
      };
    }
  } catch (err) {
    // Ignore corrupted storage and start fresh.
  }
  return { players: [], rounds: [] };
}

async function annotatePreview(file, detections, width, height) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Just a card count overlay — no per-card boxes or labels.
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

function App() {
  const initial = useMemo(loadState, []);
  const [players, setPlayers] = useState(initial.players);
  const [rounds, setRounds] = useState(initial.rounds);
  const [newPlayer, setNewPlayer] = useState('');

  // Scan modal state. `null` means the modal is closed.
  const [scan, setScan] = useState(null);
  const [cameraError, setCameraError] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [modelReady, setModelReady] = useState(false);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const preloadStartedRef = useRef(false);

  const pushToast = useCallback((message, type = 'info') => {
    const id = uid();
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Persist the scoreboard so scores survive a refresh.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ players, rounds }));
  }, [players, rounds]);

  // Stop the camera if the component unmounts while it is running.
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Warm up the detector on mount so the first scan doesn't wait on the
  // model download / session creation.
  useEffect(() => {
    if (preloadStartedRef.current) return;
    preloadStartedRef.current = true;
    pushToast('Loading card detector…', 'info');
    preloadModel()
      .then(() => {
        setModelReady(true);
        pushToast('Card detector ready', 'success');
      })
      .catch(() => pushToast('Card detector failed to load', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addPlayer = () => {
    const name = newPlayer.trim();
    if (!name) return;
    const player = { id: uid(), name };
    setPlayers((prev) => [...prev, player]);
    setRounds((prev) =>
      prev.map((round) => ({
        ...round,
        scores: { ...round.scores, [player.id]: '' },
      }))
    );
    setNewPlayer('');
  };

  const removePlayer = (id) => {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    setRounds((prev) =>
      prev.map((round) => {
        const next = { ...round.scores };
        delete next[id];
        return { ...round, scores: next };
      })
    );
  };

  const renamePlayer = (id, name) => {
    setPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p))
    );
  };

  const addRound = () => {
    const scores = {};
    players.forEach((p) => {
      scores[p.id] = '';
    });
    setRounds((prev) => [...prev, { id: uid(), scores }]);
  };

  const removeRound = (id) => {
    setRounds((prev) => prev.filter((r) => r.id !== id));
  };

  const setScore = (roundId, playerId, value) => {
    setRounds((prev) =>
      prev.map((round) =>
        round.id === roundId
          ? { ...round, scores: { ...round.scores, [playerId]: value } }
          : round
      )
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
        if (raw === '' || raw == null || Number.isNaN(value)) {
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
      // The round winner (the only player with no score) gains the absolute
      // sum of everyone else's penalties.
      if (summary.winner) result[summary.winner] += Math.abs(summary.sum);
    });
    return result;
  }, [players, rounds, roundSummaries]);

  const hasData = rounds.some((round) =>
    players.some((p) => {
      const value = round.scores[p.id];
      return value !== '' && value != null && !Number.isNaN(parseFloat(value));
    })
  );

  const maxTotal = hasData
    ? Math.max(...players.map((p) => totals[p.id]))
    : null;

  const resetAll = () => {
    if (
      window.confirm('Reset the scoreboard? This clears all players and rounds.')
    ) {
      setPlayers([]);
      setRounds([]);
    }
  };

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
    } catch (err) {
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
        recognizeFile(file);
      },
      'image/jpeg',
      0.9
    );
  };

  const recognizeFile = async (file) => {
    if (!scan) return;
    stopCamera();
    const previewUrl = URL.createObjectURL(file);
    setScan((prev) => (prev ? { ...prev, previewUrl, status: 'loading' } : prev));

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

  const handleFileChange = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) recognizeFile(file);
  };

  const applyScannedScore = () => {
    if (!scan || scan.status !== 'done') return;
    // Cards left in hand are a penalty; scan.score is already negative.
    setScore(scan.roundId, scan.playerId, String(scan.score));
    closeScan();
  };

  const closeScan = () => {
    stopCamera();
    if (scan && scan.previewUrl) URL.revokeObjectURL(scan.previewUrl);
    setScan(null);
  };

  return (
    <div className="App">
      <header className="app-header">
        <div className="logo-badge" aria-hidden="true">
          🃏
        </div>
        <div>
          <h1>UNO Scoreboard</h1>
          <p>Scan the cards left in hand each round. Highest total wins.</p>
        </div>
      </header>

      <section className="controls">
        <div className="add-player">
          <input
            type="text"
            placeholder="Player name"
            value={newPlayer}
            maxLength={20}
            onChange={(e) => setNewPlayer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPlayer();
            }}
          />
          <button className="btn btn-primary" onClick={addPlayer}>
            + Add player
          </button>
        </div>
        <div className="actions">
          <button
            className="btn btn-accent"
            onClick={addRound}
            disabled={players.length === 0}
          >
            + New round
          </button>
          <button className="btn btn-ghost" onClick={resetAll}>
            Reset
          </button>
        </div>
      </section>

      {players.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon" aria-hidden="true">
            🎴
          </span>
          <h2>No players yet</h2>
          <p>Add the players sitting around the table to start the scoreboard.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="scoreboard">
            <thead>
              <tr>
                <th className="round-col">Round</th>
                {players.map((p, i) => (
                  <th key={p.id} className={`player-col color-${i % 4}`}>
                    <div className="player-head">
                      <input
                        className="player-name"
                        value={p.name}
                        maxLength={20}
                        aria-label="Player name"
                        onChange={(e) => renamePlayer(p.id, e.target.value)}
                      />
                      <button
                        className="remove-btn"
                        title="Remove player"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => removePlayer(p.id)}
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
                  <td className="no-rounds" colSpan={players.length + 1}>
                    No rounds yet — press “+ New round” to start scoring.
                  </td>
                </tr>
              ) : (
                rounds.map((round, roundIndex) => (
                  <tr key={round.id}>
                    <td className="round-col">
                      <div className="round-label">
                        <span>Round {roundIndex + 1}</span>
                        <button
                          className="remove-btn"
                          title="Remove round"
                          aria-label={`Remove round ${roundIndex + 1}`}
                          onClick={() => removeRound(round.id)}
                        >
                          ×
                        </button>
                      </div>
                    </td>
                    {players.map((p) => {
                      const summary = roundSummaries[round.id];
                      const isRoundWinner = summary.winner === p.id;
                      return (
                        <td key={p.id}>
                          <div className="cell">
                            {isRoundWinner ? (
                              <span
                                className="score-input winner-score"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: '#7dff9a',
                                  fontWeight: 700,
                                }}
                              >
                                {Math.abs(summary.sum)}
                              </span>
                            ) : (
                              <input
                                className="score-input"
                                type="number"
                                step="1"
                                inputMode="numeric"
                                placeholder="—"
                                aria-label={`${p.name} round ${roundIndex + 1} score`}
                                value={round.scores[p.id] ?? ''}
                                onChange={(e) =>
                                  setScore(round.id, p.id, e.target.value)
                                }
                              />
                            )}
                            <button
                              className="camera-btn"
                              title={
                                modelReady
                                  ? `Scan ${p.name}'s cards`
                                  : 'Detector still loading…'
                              }
                              aria-label={`Scan ${p.name}'s cards for round ${
                                roundIndex + 1
                              }`}
                              disabled={!modelReady}
                              onClick={() => startCamera(round.id, p.id)}
                            >
                              📷
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
              <tr className="totals-row">
                <td className="round-col">Total</td>
                {players.map((p) => (
                  <td key={p.id} className={isWinner(p.id) ? 'winner' : ''}>
                    <div className="total-cell">
                      <span>{totals[p.id]}</span>
                      {isWinner(p.id) && (
                        <span className="crown" aria-label="Leading player">
                          👑
                        </span>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden-file-input"
        onChange={handleFileChange}
      />

      {scan && (
        <div className="scan-overlay" onClick={closeScan}>
          <div
            className="scan-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Card scan"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="scan-close"
              onClick={closeScan}
              aria-label="Close"
            >
              ×
            </button>

            {scan.status === 'capturing' && (
              <div className="scan-camera">
                <video ref={attachVideo} className="camera-preview" playsInline muted />
                {cameraError ? (
                  <p className="camera-error">{cameraError}</p>
                ) : (
                  <p className="camera-hint">
                    {modelReady
                      ? 'Aim at the cards, then capture.'
                      : 'Loading card detector…'}
                  </p>
                )}
                <div className="camera-actions">
                  <button className="btn btn-ghost" onClick={closeScan}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-ghost"
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
                    className="btn btn-accent shutter-btn"
                    onClick={capturePhoto}
                    disabled={!!cameraError || !modelReady}
                  >
                    <span className="shutter-icon" aria-hidden="true">
                      ⏺
                    </span>
                    Capture
                  </button>
                </div>
              </div>
            )}

            {scan.status === 'loading' && (
              <div className="scan-loading">
                <div className="spinner" />
                <p>Recognizing cards…</p>
              </div>
            )}

            {scan.status === 'error' && (
              <div className="scan-error">
                <span className="scan-error-icon" aria-hidden="true">
                  ⚠️
                </span>
                <p>{scan.error}</p>
                <button
                  className="btn btn-primary"
                  onClick={() => startCamera(scan.roundId, scan.playerId)}
                >
                  Try again
                </button>
              </div>
            )}

            {scan.status === 'done' && (
              <div className="scan-done">
                <h3>Detected cards</h3>
                {scan.previewUrl && (
                  <img
                    className="scan-preview"
                    src={scan.annotatedPreview || scan.previewUrl}
                    alt="Captured cards"
                  />
                )}
                {scan.cards && scan.cards.length > 0 ? (
                  <ul className="scan-cards">
                    {scan.cards.map((card, i) => (
                      <li key={i}>
                        <span className="card-name">{card}</span>
                        <span className="card-points">−{scoreForCard(card)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="scan-none">
                    No cards were detected. Try taking the photo again.
                  </p>
                )}
                <div className="scan-total">
                  <label htmlFor="scan-score">Total score</label>
                  <input
                    id="scan-score"
                    type="number"
                    step="1"
                    value={scan.score}
                    onChange={(e) =>
                      setScan((prev) =>
                        prev ? { ...prev, score: Number(e.target.value) } : prev
                      )
                    }
                  />
                </div>
                <div className="scan-actions">
                  <button className="btn btn-ghost" onClick={closeScan}>
                    Cancel
                  </button>
                  <button className="btn btn-accent" onClick={applyScannedScore}>
                    Apply score
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`} role="status">
              {t.message}
            </div>
          ))}
        </div>
      )}

      {process.env.NODE_ENV === 'development' && <LogPanel />}
    </div>
  );
}

export default App;
