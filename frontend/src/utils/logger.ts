type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
  /** local = this browser session; server = row from API */
  origin?: 'local' | 'server';
  /** Correlates with API X-Request-ID / server logs */
  requestId?: string;
}

const STORAGE_KEY = 'app_logs';
const MAX_ENTRIES = 500;

let entries: LogEntry[] = [];
let nextId = 1;
let listeners: Array<() => void> = [];

/** Cached copy for `useSyncExternalStore` — must be stable between mutations or React re-renders forever. */
let entriesSnapshotCache: LogEntry[] | null = null;

function invalidateEntriesSnapshot() {
  entriesSnapshotCache = null;
}

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
  invalidateEntriesSnapshot();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full — trim older half and retry
    entries = entries.slice(Math.floor(entries.length / 2));
    invalidateEntriesSnapshot();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* give up */ }
  }
}

function push(level: LogLevel, source: string, message: string, data?: unknown, extra?: Partial<LogEntry>) {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data: data !== undefined ? sanitize(data) : undefined,
    origin: 'local',
    ...extra,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  invalidateEntriesSnapshot();
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

  /** Returns a stable array reference until the next log mutation (required for `useSyncExternalStore`). */
  getEntries: (): LogEntry[] => {
    if (entriesSnapshotCache === null) {
      entriesSnapshotCache = [...entries];
    }
    return entriesSnapshotCache;
  },

  clear: () => {
    entries = [];
    nextId = 1;
    invalidateEntriesSnapshot();
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
      const ref = e.requestId ? ` [ref:${e.requestId}]` : '';
      return `[${e.timestamp}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}${ref}${d}`;
    }).join('\n'),
};

export default appLogger;
export type { LogEntry };
