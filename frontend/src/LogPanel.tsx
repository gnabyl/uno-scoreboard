import { useEffect, useState } from 'react';
import { clear, getEntries, subscribe } from './api/debugLog';
import { useTranslation } from './i18n';

export default function LogPanel() {
  const t = useTranslation();
  const [entries, setEntries] = useState(getEntries());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const update = () => setEntries([...getEntries()]);
    const unsubscribe = subscribe(update);
    return unsubscribe;
  }, []);

  const latest = entries[entries.length - 1];
  const status = latest
    ? `${latest.message}${
        latest.data !== undefined ? ' ' + JSON.stringify(latest.data) : ''
      }`
    : t('log.idle');

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[9999] cursor-pointer select-none border-t border-[#333] bg-[rgba(17,17,17,0.94)] font-mono text-xs leading-[1.4] text-[#e6e6e6]"
      onClick={() => setExpanded((e) => !e)}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="h-2 w-2 flex-shrink-0 rounded-full bg-accent" aria-hidden="true" />
        <span className="flex-1 truncate">{status}</span>
        <span className="flex-shrink-0 text-[#888]" aria-hidden="true">
          {expanded ? '▾' : '▴'}
        </span>
      </div>
      {expanded && (
        <div
          className="max-h-[180px] overflow-y-auto border-t border-[#2a2a2a] px-3 py-2"
          onClick={(ev) => ev.stopPropagation()}
        >
          {entries.length === 0 ? (
            <div className="text-[#777]">{t('log.empty')}</div>
          ) : (
            entries.map((e, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                <span className="mr-1.5 text-[#888]">{e.t}</span>
                <span>{e.message}</span>
                {e.data !== undefined && (
                  <span className="text-[#9aa]"> {JSON.stringify(e.data)}</span>
                )}
              </div>
            ))
          )}
          <button
            className="mt-1.5 cursor-pointer border-none bg-transparent p-0 text-xs text-[#7db8ff]"
            onClick={(ev) => {
              ev.stopPropagation();
              clear();
            }}
          >
            {t('log.clear')}
          </button>
        </div>
      )}
    </div>
  );
}
