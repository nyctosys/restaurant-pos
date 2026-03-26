type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

const STORAGE_KEY = 'app_logs';
const MAX_ENTRIES = 500;

let entries: LogEntry[] = [];
let nextId = 1;
let listeners: Array<() => void> = [];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      entries = JSON.parse(raw);
      nextId = entries.length > 0 ? entries[entries.length - 1].id + 1 : 1;
    }
  } catch {
    entries = [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full — trim older half and retry
    entries = entries.slice(Math.floor(entries.length / 2));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* give up */ }
  }
}

function push(level: LogLevel, source: string, message: string, data?: unknown) {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data: data !== undefined ? sanitize(data) : undefined,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  persist();
  listeners.forEach(fn => fn());
}

function sanitize(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s && s.length > 2000) return s.substring(0, 2000) + '…';
    return JSON.parse(s);
  } catch {
    return String(v);
  }
}

load();

const appLogger = {
  info:  (source: string, message: string, data?: unknown) => push('info', source, message, data),
  warn:  (source: string, message: string, data?: unknown) => push('warn', source, message, data),
  error: (source: string, message: string, data?: unknown) => push('error', source, message, data),

  getEntries: () => [...entries],

  clear: () => {
    entries = [];
    nextId = 1;
    persist();
    listeners.forEach(fn => fn());
  },

  subscribe: (fn: () => void) => {
    listeners.push(fn);
    return () => { listeners = listeners.filter(l => l !== fn); };
  },

  exportText: () =>
    entries.map(e => {
      const d = e.data !== undefined ? ' | ' + JSON.stringify(e.data) : '';
      return `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}${d}`;
    }).join('\n'),
};

export default appLogger;
export type { LogEntry };
