import { useEffect, useState } from 'react';
import { clear, getEntries, subscribe } from './api/debugLog';

const panelStyle = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 9999,
  background: 'rgba(17, 17, 17, 0.92)',
  color: '#e6e6e6',
  font: '12px/1.4 "SF Mono", Consolas, Menlo, monospace',
  borderTop: '1px solid #333',
  padding: '8px 12px',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 4,
};

const clearButtonStyle = {
  background: 'none',
  border: 'none',
  color: '#7db8ff',
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

const listStyle = { maxHeight: 160, overflowY: 'auto' };
const rowStyle = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
const timeStyle = { color: '#888', marginRight: 6 };

export default function LogPanel() {
  const [entries, setEntries] = useState(getEntries());

  useEffect(() => {
    const update = () => setEntries([...getEntries()]);
    const unsubscribe = subscribe(update);
    return unsubscribe;
  }, []);

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span>📡 Model log</span>
        <button style={clearButtonStyle} onClick={clear}>
          Clear
        </button>
      </div>
      <div style={listStyle}>
        {entries.length === 0 ? (
          <div>No logs yet — run a scan to see model fetch / inference.</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} style={rowStyle}>
              <span style={timeStyle}>{e.t}</span>
              <span>{e.message}</span>
              {e.data !== undefined ? (
                <span style={{ color: '#9aa' }}> {JSON.stringify(e.data)}</span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
