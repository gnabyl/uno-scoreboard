import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getRoom,
  joinRoom,
  normalizeRoomCode,
  subscribeToRoom,
} from '../api/rooms';
import { describeRoomError } from '../lib/roomCode';
import {
  BTN_ACCENT,
  BTN_GHOST,
  BTN_PRIMARY,
  CARD,
  ErrorNotice,
  INPUT,
  Logo,
} from '../components/ui';

const PLAYER_DOTS = [
  'bg-brand-red',
  'bg-brand-orange',
  'bg-brand-teal',
  'bg-brand-blue',
];

export default function RoomPage() {
  const { code: routeCode } = useParams();

  const code = useMemo(() => {
    try {
      return normalizeRoomCode(routeCode);
    } catch {
      return null;
    }
  }, [routeCode]);

  const [status, setStatus] = useState('loading');
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const versionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!code) {
      setStatus('invalid');
      return;
    }

    try {
      const room = await getRoom(code);
      versionRef.current = Number(room.version) || 0;
      setSnapshot(room);
      setError(null);
      setStatus('member');
    } catch (err) {
      if (err?.code === 'not_a_member') {
        setStatus('join');
      } else if (err?.code === 'not_found') {
        setStatus('missing');
      } else {
        setError(describeRoomError(err));
        setStatus('error');
      }
    }
  }, [code]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status !== 'member' || !code) return undefined;

    return subscribeToRoom(code, {
      onVersion: (version) => {
        if (version === null || version > versionRef.current) refresh();
      },
    });
  }, [code, status, refresh]);

  const handleJoin = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter your name first.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await joinRoom(code, { name: trimmed });
      await refresh();
    } catch (err) {
      setError(describeRoomError(err));
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = code ? `${window.location.origin}/r/${code}` : '';

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy the link. Select it manually.');
    }
  };

  let content;

  if (status === 'invalid') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px] text-center`}>
        <h2 className="m-0 text-xl font-bold text-white">That link doesn't look right</h2>
        <p className="mt-2 text-sm text-muted">
          Room links look like <span className="font-mono">/r/ABCDEFGH</span> — eight
          characters, no 0, O, 1, I or L.
        </p>
        <Link className={`${BTN_PRIMARY} mt-5 inline-block no-underline`} to="/">
          Back to start
        </Link>
      </section>
    );
  } else if (status === 'loading') {
    content = (
      <div className="flex flex-1 items-center justify-center py-16 text-muted">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-edge border-t-accent [animation-duration:0.8s]"
          aria-label="Loading room"
        />
      </div>
    );
  } else if (status === 'missing') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px] text-center`}>
        <h2 className="m-0 text-xl font-bold text-white">Room not found</h2>
        <p className="mt-2 text-sm text-muted">
          There is no room with code <span className="font-mono text-fg">{code}</span>.
          Check the link, or host a new game.
        </p>
        <Link className={`${BTN_PRIMARY} mt-5 inline-block no-underline`} to="/">
          Back to start
        </Link>
      </section>
    );
  } else if (status === 'error') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px]`}>
        <h2 className="m-0 text-xl font-bold text-white">Couldn't open the room</h2>
        <div className="mt-3">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
        <div className="mt-4 flex gap-2.5">
          <button className={BTN_PRIMARY} onClick={refresh}>
            Try again
          </button>
          <Link className={`${BTN_GHOST} no-underline`} to="/">
            Back to start
          </Link>
        </div>
      </section>
    );
  } else if (status === 'join' || (status === 'member' && !snapshot?.me)) {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px]`}>
        <h2 className="m-0 text-xl font-bold text-white">Join room {code}</h2>
        <p className="mt-2 text-sm text-muted">
          Enter your name. Everyone in the room can edit every score.
        </p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleJoin}>
          <label className="sr-only" htmlFor="room-name">
            Your name
          </label>
          <input
            id="room-name"
            className={INPUT}
            placeholder="Your name"
            value={name}
            maxLength={20}
            autoComplete="off"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button className={BTN_ACCENT} type="submit" disabled={busy}>
            {busy ? 'Joining…' : 'Join room'}
          </button>
        </form>
        <div className="mt-3">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      </section>
    );
  } else {
    content = (
      <>
        <section className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                Room code
              </p>
              <p className="m-0 mt-1 font-mono text-2xl font-extrabold tracking-[0.18em] text-white">
                {code}
              </p>
            </div>
            <button className={BTN_PRIMARY} onClick={copyLink}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          <p className="m-0 mt-3 break-all rounded-lg border border-edge-soft bg-deep px-3 py-2 font-mono text-xs text-muted">
            {shareUrl}
          </p>
        </section>

        <section className={`${CARD} mt-4`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-lg font-bold text-white">Players</h2>
            <span className="text-sm text-muted">{snapshot.players.length}</span>
          </div>
          {snapshot.players.length === 0 ? (
            <p className="m-0 mt-3 text-sm text-faint">No players yet.</p>
          ) : (
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
              {snapshot.players.map((player, index) => (
                <li
                  key={player.id}
                  className="flex items-center gap-2 rounded-full border border-edge bg-raised px-3 py-1.5 text-sm text-fg"
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      PLAYER_DOTS[index % PLAYER_DOTS.length]
                    }`}
                    aria-hidden="true"
                  />
                  {player.name}
                  {player.id === snapshot.me && (
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">
                      you
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="mt-3">
          <ErrorNotice>{error}</ErrorNotice>
        </div>

        <section className="mt-4 rounded-2xl border border-dashed border-edge bg-panel px-5 py-10 text-center">
          <span className="text-[34px]" aria-hidden="true">
            🎴
          </span>
          <h2 className="mb-1 mt-2 text-lg font-bold text-white">Board coming next</h2>
          <p className="m-0 text-sm text-muted">
            The room, players and live sync are wired up. Round scoring is the next
            feature.
          </p>
        </section>
      </>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex items-center gap-3">
        <Logo />
        <div className="min-w-0 flex-1">
          <Link
            to="/"
            className="text-xl font-extrabold tracking-[-0.4px] text-white no-underline sm:text-2xl"
          >
            UNO Scoreboard
          </Link>
          <p className="m-0 mt-0.5 font-mono text-xs text-muted sm:text-sm">
            Room {code ?? '—'}
          </p>
        </div>
        <Link className={`${BTN_GHOST} no-underline`} to="/">
          Leave
        </Link>
      </header>

      <main className="flex flex-1 flex-col">{content}</main>
    </div>
  );
}
