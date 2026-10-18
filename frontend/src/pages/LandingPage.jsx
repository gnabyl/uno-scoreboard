import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, normalizeRoomCode } from '../api/rooms';
import { describeRoomError, parseRoomCode } from '../lib/roomCode';
import {
  BTN_ACCENT,
  BTN_PRIMARY,
  CARD,
  ErrorNotice,
  INPUT,
  Logo,
} from '../components/ui';

export default function LandingPage() {
  const navigate = useNavigate();
  const [hostName, setHostName] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleHost = async (event) => {
    event.preventDefault();
    const name = hostName.trim();
    if (!name) {
      setError('Enter your name first.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const room = await createRoom(name);
      navigate(`/r/${room.code}`);
    } catch (err) {
      setError(describeRoomError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = (event) => {
    event.preventDefault();
    try {
      navigate(`/r/${normalizeRoomCode(parseRoomCode(joinInput))}`);
      setError(null);
    } catch {
      setError('Enter the 8-character room code or paste the room link.');
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[960px] flex-col px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex items-center gap-3 sm:mb-12 sm:gap-[18px]">
        <Logo />
        <div>
          <h1 className="m-0 text-2xl font-extrabold tracking-[-0.5px] text-white sm:text-[30px]">
            UNO Scoreboard
          </h1>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            Scan the cards left in hand each round. Highest total wins.
          </p>
        </div>
      </header>

      <main className="flex flex-1 flex-col justify-center">
        <div className="mb-6 text-center sm:mb-9">
          <h2 className="m-0 text-[26px] font-extrabold tracking-[-0.4px] text-white sm:text-[34px]">
            Start a game or join one
          </h2>
          <p className="mx-auto mt-2 max-w-[520px] text-sm text-muted sm:text-base">
            One shared board for the whole table. No accounts — everyone can edit
            any score.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 sm:gap-5">
          <section className={CARD} aria-labelledby="host-heading">
            <div className="mb-3 flex items-center gap-3">
              <span
                className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-violet to-accent text-lg"
                aria-hidden="true"
              >
                🎲
              </span>
              <h3 id="host-heading" className="m-0 text-lg font-bold text-white">
                Host a game
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted">
              Create a room and share the link. You'll get an 8-character code.
            </p>
            <form className="flex flex-col gap-3" onSubmit={handleHost}>
              <label className="sr-only" htmlFor="host-name">
                Your name
              </label>
              <input
                id="host-name"
                className={INPUT}
                placeholder="Your name"
                value={hostName}
                maxLength={20}
                autoComplete="off"
                onChange={(event) => setHostName(event.target.value)}
              />
              <button className={BTN_ACCENT} type="submit" disabled={busy}>
                {busy ? 'Creating room…' : 'Create room'}
              </button>
            </form>
          </section>

          <section className={CARD} aria-labelledby="join-heading">
            <div className="mb-3 flex items-center gap-3">
              <span
                className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand-teal to-brand-blue text-lg"
                aria-hidden="true"
              >
                🔗
              </span>
              <h3 id="join-heading" className="m-0 text-lg font-bold text-white">
                Join a game
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted">
              Open the link someone shared with you, or type the room code.
            </p>
            <form className="flex flex-col gap-3" onSubmit={handleJoin}>
              <label className="sr-only" htmlFor="join-code">
                Room code or link
              </label>
              <input
                id="join-code"
                className={INPUT}
                placeholder="ABCDEFGH or room link"
                value={joinInput}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => setJoinInput(event.target.value)}
              />
              <button className={BTN_PRIMARY} type="submit" disabled={!joinInput.trim()}>
                Join room
              </button>
            </form>
          </section>
        </div>

        <div className="mt-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      </main>

      <footer className="mt-8 text-center text-xs text-faint">
        Scores sync across every device in the room.
      </footer>
    </div>
  );
}
