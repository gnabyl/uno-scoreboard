import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, normalizeRoomCode } from '../api/rooms';
import { describeRoomError, parseRoomCode } from '../lib/roomCode';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { BTN_ACCENT, BTN_PRIMARY, CARD, ErrorNotice, INPUT, Logo } from '../components/ui';

export default function LandingPage() {
  const navigate = useNavigate();
  const t = useTranslation();
  const [hostName, setHostName] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleHost = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = hostName.trim();
    if (!name) {
      setError(t('error.enterName'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const room = await createRoom(name);
      navigate(`/r/${room.code}`);
    } catch (err) {
      setError(describeRoomError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      navigate(`/r/${normalizeRoomCode(parseRoomCode(joinInput))}`);
      setError(null);
    } catch {
      setError(t('landing.join.invalid'));
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[960px] flex-col px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex items-center gap-3 sm:mb-12 sm:gap-[18px]">
        <Logo />
        <div>
          <h1 className="m-0 text-2xl font-extrabold tracking-[-0.5px] text-white sm:text-[30px]">
            {t('app.title')}
          </h1>
        </div>
        <LanguageSwitcher className="ml-auto" />
      </header>

      <main className="flex flex-1 flex-col justify-center">
        <div className="mb-6 text-center sm:mb-9">
          <h2 className="m-0 text-[26px] font-extrabold tracking-[-0.4px] text-white sm:text-[34px]">
            {t('landing.heading')}
          </h2>
          <p className="mx-auto mt-2 max-w-[520px] text-sm text-muted sm:text-base">
            {t('landing.subheading')}
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
                {t('landing.host.heading')}
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted">{t('landing.host.description')}</p>
            <form className="flex flex-col gap-3" onSubmit={handleHost}>
              <label className="sr-only" htmlFor="host-name">
                {t('common.yourName')}
              </label>
              <input
                id="host-name"
                className={INPUT}
                placeholder={t('common.yourName')}
                value={hostName}
                maxLength={20}
                autoComplete="off"
                onChange={(event) => setHostName(event.target.value)}
              />
              <button className={BTN_ACCENT} type="submit" disabled={busy}>
                {busy ? t('landing.host.creating') : t('landing.host.submit')}
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
                {t('landing.join.heading')}
              </h3>
            </div>
            <p className="mb-4 text-sm text-muted">{t('landing.join.description')}</p>
            <form className="flex flex-col gap-3" onSubmit={handleJoin}>
              <label className="sr-only" htmlFor="join-code">
                {t('landing.join.label')}
              </label>
              <input
                id="join-code"
                className={INPUT}
                placeholder={t('landing.join.placeholder')}
                value={joinInput}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => setJoinInput(event.target.value)}
              />
              <button className={BTN_PRIMARY} type="submit" disabled={!joinInput.trim()}>
                {t('landing.join.submit')}
              </button>
            </form>
          </section>
        </div>

        <div className="mt-4">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
      </main>

      <footer className="mt-8 text-center text-xs text-faint">{t('landing.footer')}</footer>
    </div>
  );
}
