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
