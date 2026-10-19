import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getRoom,
  joinRoom,
  leaveRoom,
  normalizeRoomCode,
  peekRoom,
  subscribeToRoom,
  type RoomPlayer,
  type RoomSnapshot,
} from '../api-helper/rooms';
import RoomBoard from '../components/RoomBoard';
import { describeRoomError } from '../lib/roomCode';
import { buildScoreboard } from '../lib/scoreboard';
import { exportScoreboardPng } from '../lib/scoreboardPng';
import { useI18n } from '../i18n';
import { HeaderMenu } from '../components/HeaderMenu';
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
  const { t, language } = useI18n();
  const navigate = useNavigate();

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
  const [roster, setRoster] = useState<RoomPlayer[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const versionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!code) {
      setStatus('invalid');
      return;
    }

    const loadRoster = async () => {
      const peeked = await peekRoom(code);
      setRoster(peeked.players);
      setPickedId((current) =>
        current && peeked.players.some((player) => player.id === current) ? current : null,
      );
      setStatus('join');
    };

    try {
      const room = await getRoom(code);
      versionRef.current = Number(room.version) || 0;
      setSnapshot(room);

      if (!room.me) {
        await loadRoster();
        return;
      }

      setError(null);
      setStatus('member');
    } catch (err) {
      if (err?.code === 'not_a_member') {
        try {
          await loadRoster();
        } catch (peekErr) {
          if (peekErr?.code === 'not_found') {
            setStatus('missing');
          } else {
            setError(describeRoomError(peekErr, t));
            setStatus('error');
          }
        }
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

  const joinAs = async (params: { name?: string; playerId?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await joinRoom(code, params);
      await refresh();
    } catch (err) {
      setError(describeRoomError(err, t));
      // A name can be claimed between peeking and joining; re-peek so it
      // disappears from the list.
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleJoinPicked = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pickedId) return;
    await joinAs({ playerId: pickedId });
  };

  const handleJoinNewName = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('error.enterName'));
      return;
    }

    await joinAs({ name: trimmed });
  };

  const handleLeave = async () => {
    try {
      if (code) await leaveRoom(code);
    } catch {
      // Still leave locally if the release request fails.
    } finally {
      navigate('/');
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
        }),
      );
    }
  };

  const copyCode = () => copyText(code, 'code');
  const copyLink = () => copyText(shareUrl, 'link');

  const handleExportPng = useCallback(async () => {
    if (!snapshot || exporting) return;

    setExporting(true);
    setError(null);
    try {
      const date = new Date();
      const generated = t('export.generated', {
        date: date.toLocaleDateString(language, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }),
      });

      await exportScoreboardPng({
        scoreboard: buildScoreboard(snapshot.players, snapshot.rounds),
        code: code ?? '',
        title: t('app.title'),
        generated,
        footer: t('export.footer', { code: code ?? '' }),
        labels: { round: t('export.round'), total: t('export.total') },
      });
    } catch {
      setError(t('room.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [code, exporting, language, snapshot, t]);

  let content;

  if (status === 'invalid') {
    content = (
      <section className={`${CARD} mx-auto w-full max-w-[440px] text-center`}>
        <h2 className="m-0 text-xl font-bold text-white">{t('room.invalid.title')}</h2>
        <p className="mt-2 text-sm text-muted">
          {t('room.invalid.bodyBefore')} <span className="font-mono">/r/ABCDEFGH</span>{' '}
          {t('room.invalid.bodyAfter')}
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
          {t('room.missing.bodyBefore')} <span className="font-mono text-fg">{code}</span>
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
      <section className={`${CARD} mx-auto flex w-full max-w-[440px] flex-col`}>
        <h2 className="m-0 text-xl font-bold text-white">
          {t('room.join.title', { code: code ?? '' })}
        </h2>
        <p className="mt-2 text-sm text-muted">{t('room.join.description')}</p>

        {roster.length > 0 ? (
          <form className="mt-4 flex flex-col gap-3" onSubmit={handleJoinPicked}>
            <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-faint">
              {t('room.join.choose')}
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {roster.map((player) => {
                const selected = pickedId === player.id;
                return (
                  <li key={player.id}>
                    <button
                      type="button"
                      className={`w-full rounded-xl border px-3.5 py-3 text-left text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${
                        selected
                          ? 'border-accent bg-accent/15 text-white'
                          : 'border-edge bg-deep text-fg hover:border-accent/70'
                      }`}
                      aria-pressed={selected}
                      disabled={busy}
                      onClick={() => {
                        setPickedId(player.id);
                        setError(null);
                      }}
                    >
                      {player.name}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button className={BTN_ACCENT} type="submit" disabled={!pickedId || busy}>
              {busy ? t('room.join.joining') : t('room.join.submit')}
            </button>
            <button
              type="button"
              className="self-start border-none bg-transparent p-0 text-xs font-semibold text-muted underline-offset-2 hover:text-white hover:underline"
              disabled={busy}
              onClick={refresh}
            >
              {t('room.join.refresh')}
            </button>
          </form>
        ) : (
          <div className="mt-4">
            <p className="m-0 text-sm text-faint">{t('room.join.noOpenNames')}</p>
            <button
              type="button"
              className="mt-2 border-none bg-transparent p-0 text-xs font-semibold text-muted underline-offset-2 hover:text-white hover:underline"
              disabled={busy}
              onClick={refresh}
            >
              {t('room.join.refresh')}
            </button>
          </div>
        )}

        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-edge" aria-hidden="true" />
          <h3 className="m-0 text-[11px] font-bold uppercase tracking-[0.08em] text-faint">
            {t('room.join.newNameHeading')}
          </h3>
          <span className="h-px flex-1 bg-edge" aria-hidden="true" />
        </div>

        <form className="flex flex-col gap-3" onSubmit={handleJoinNewName}>
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
            autoFocus={roster.length === 0}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          <button className={BTN_GHOST} type="submit" disabled={busy || !name.trim()}>
            {busy ? t('room.join.joining') : t('room.join.newNameSubmit')}
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
            <div className="mt-1 truncate font-mono text-xs font-bold tracking-[0.14em] text-muted sm:text-sm">
              {code}
            </div>
          )}
        </div>
        <HeaderMenu
          code={code}
          copied={copied}
          onCopyCode={copyCode}
          onCopyLink={copyLink}
          onExportPng={snapshot && snapshot.players.length > 0 ? handleExportPng : undefined}
          exporting={exporting}
          onLeave={handleLeave}
        />
      </header>

      <main className="flex min-h-0 flex-1 flex-col">{content}</main>
    </div>
  );
}
