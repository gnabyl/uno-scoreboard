// Lightweight in-memory log for development. Modules push messages here and
// the dev-only LogPanel subscribes to show live progress (model fetch, session
// creation, inference, etc.).

const listeners = new Set();
const entries = [];

function notify() {
  for (const fn of listeners) fn();
}

export function log(message, data) {
  entries.push({
    t: new Date().toLocaleTimeString(),
    message,
    data,
  });
  if (entries.length > 200) entries.shift();
  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.debug('[model]', message, data === undefined ? '' : data);
  }
  notify();
}

/**
 * Append a progress line, or update the last one in place when it has the
 * same `key`. Used for ticking progress (download %, elapsed time) so the
 * log isn't flooded with one line per update.
 */
export function progress(key, message, data) {
  const last = entries[entries.length - 1];
  if (last && last.key === key) {
    last.message = message;
    last.data = data;
    last.t = new Date().toLocaleTimeString();
  } else {
    entries.push({ t: new Date().toLocaleTimeString(), key, message, data });
    if (entries.length > 200) entries.shift();
  }
  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.debug('[model]', message, data === undefined ? '' : data);
  }
  notify();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getEntries() {
  return entries;
}

export function clear() {
  entries.length = 0;
  notify();
}
