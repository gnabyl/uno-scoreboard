import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getRoom,
  joinRoom,
  normalizeRoomCode,
  subscribeToRoom,
  type RoomSnapshot,
} from '../api/rooms';
import RoomBoard from '../RoomBoard';
import { describeRoomError } from '../lib/roomCode';
import { useTranslation } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import {
  BTN_ACCENT,
  BTN_GHOST,
  BTN_PRIMARY,
  CARD,
  ErrorNotice,
  INPUT,
  Logo,
} from '../components/ui';

export default function RoomPage() {
  const { code: routeCode } = useParams();
  const t = useTranslation();

  const code = useMemo(() => {
    try {
      return normalizeRoomCode(routeCode);
    } catch {
      return null;
    }
  }, [routeCode]);

  const [status, setStatus] = useState('loading');
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
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
        setError(describeRoomError(err, t));
        setStatus('error');
      }
    }
  }, [code, t]);

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

  const handleJoin = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('error.enterName'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await joinRoom(code, { name: trimmed });
      await refresh();
    } catch (err) {
      setError(describeRoomError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const shareUrl = code ? `${window.location.origin}/r/${code}` : '';

  const copyText = async (text: string | null, kind: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setError(
        t('error.copyFailed', {
          what: t(kind === 'code' ? 'common.code' : 'common.link'),
        })
      );
    }
  };

  const copyCode = () => copyText(code, 'code');
  const copyLink = () => copyText(shareUrl, 'link');

  let content;

  if (status === 'invalid') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px] text-center`}>
        <h2 className="m-0 text-xl font-bold text-white">{t('room.invalid.title')}</h2>
        <p className="mt-2 text-sm text-muted">
          {t('room.invalid.bodyBefore')}{' '}
          <span className="font-mono">/r/ABCDEFGH</span> {t('room.invalid.bodyAfter')}
        </p>
        <Link className={`${BTN_PRIMARY} mt-5 inline-block no-underline`} to="/">
          {t('common.backToStart')}
        </Link>
      </section>
    );
  } else if (status === 'loading') {
    content = (
      <div className="flex flex-1 items-center justify-center py-16 text-muted">
        <div
          className="h-10 w-10 animate-spin rounded-full border-4 border-edge border-t-accent [animation-duration:0.8s]"
          aria-label={t('room.loading')}
        />
      </div>
    );
  } else if (status === 'missing') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px] text-center`}>
        <h2 className="m-0 text-xl font-bold text-white">{t('room.missing.title')}</h2>
        <p className="mt-2 text-sm text-muted">
          {t('room.missing.bodyBefore')}{' '}
          <span className="font-mono text-fg">{code}</span>
          {t('room.missing.bodyAfter')}
        </p>
        <Link className={`${BTN_PRIMARY} mt-5 inline-block no-underline`} to="/">
          {t('common.backToStart')}
        </Link>
      </section>
    );
  } else if (status === 'error') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px]`}>
        <h2 className="m-0 text-xl font-bold text-white">{t('room.error.title')}</h2>
        <div className="mt-3">
          <ErrorNotice>{error}</ErrorNotice>
        </div>
        <div className="mt-4 flex gap-2.5">
          <button className={BTN_PRIMARY} onClick={refresh}>
            {t('common.tryAgain')}
          </button>
          <Link className={`${BTN_GHOST} no-underline`} to="/">
            {t('common.backToStart')}
          </Link>
        </div>
      </section>
    );
  } else if (status === 'join' || (status === 'member' && !snapshot?.me)) {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px]`}>
        <h2 className="m-0 text-xl font-bold text-white">
          {t('room.join.title', { code: code ?? '' })}
        </h2>
        <p className="mt-2 text-sm text-muted">{t('room.join.description')}</p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={handleJoin}>
          <label className="sr-only" htmlFor="room-name">
            {t('common.yourName')}
          </label>
          <input
            id="room-name"
            className={INPUT}
            placeholder={t('common.yourName')}
            value={name}
            maxLength={20}
            autoComplete="off"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button className={BTN_ACCENT} type="submit" disabled={busy}>
            {busy ? t('room.join.joining') : t('room.join.submit')}
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
        <div className="mb-3">
          <ErrorNotice>{error}</ErrorNotice>
        </div>

        <RoomBoard code={code} snapshot={snapshot} onRefresh={refresh} />
      </>
    );
  }

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[720px] flex-col overflow-hidden px-4 py-4 sm:px-6 sm:py-6">
      <header className="mb-4 flex shrink-0 items-center gap-3">
        <Logo />
        <div className="min-w-0 flex-1">
          <Link
            to="/"
            className="block truncate text-xl font-extrabold tracking-[-0.4px] text-white no-underline sm:text-2xl"
          >
            {t('app.title')}
          </Link>
          {code && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-mono text-xs font-bold tracking-[0.14em] text-muted sm:text-sm">
                {code}
              </span>
              <button
                className="rounded border-none bg-transparent p-0 text-[11px] font-semibold text-accent hover:underline"
                onClick={copyCode}
              >
                {copied === 'code' ? t('common.copied') : t('room.copyCode')}
              </button>
              <button
                className="rounded border-none bg-transparent p-0 text-[11px] font-semibold text-accent hover:underline"
                onClick={copyLink}
              >
                {copied === 'link' ? t('common.copied') : t('room.copyLink')}
              </button>
            </div>
          )}
        </div>
        <LanguageSwitcher />
        <Link
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#5a2a2a] bg-transparent text-[#ff4d4d] no-underline transition hover:border-[#ff4d4d] hover:bg-[#2a1416] hover:text-[#ff6b6b] focus:outline-none focus-visible:border-[#ff4d4d] sm:h-10 sm:w-10"
          to="/"
          title={t('room.leave')}
          aria-label={t('room.leave')}
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </Link>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">{content}</main>
    </div>
  );
}
