import { useEffect, useState } from 'react';
import { clear, getEntries, subscribe } from './api/debugLog';

export default function LogPanel() {
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
    : 'Idle';

  return (
    <div className="log-panel" onClick={() => setExpanded((e) => !e)}>
      <div className="log-status">
        <span className="log-dot" aria-hidden="true" />
        <span className="log-message">{status}</span>
        <span className="log-chevron" aria-hidden="true">
          {expanded ? '▾' : '▴'}
        </span>
      </div>
      {expanded && (
        <div className="log-list" onClick={(ev) => ev.stopPropagation()}>
          {entries.length === 0 ? (
            <div className="log-empty">No logs yet.</div>
          ) : (
            entries.map((e, i) => (
              <div key={i} className="log-row">
                <span className="log-time">{e.t}</span>
                <span>{e.message}</span>
                {e.data !== undefined && (
                  <span className="log-data"> {JSON.stringify(e.data)}</span>
                )}
              </div>
            ))
          )}
          <button
            className="log-clear"
            onClick={(ev) => {
              ev.stopPropagation();
              clear();
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
