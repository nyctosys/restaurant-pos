/**
 * Kitchen Display (KOT / KDS) — live queue of open dine-in tickets with line items.
 * Uses the same canvas, liquid glass, brand, and gold tokens as the rest of the POS.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, getUserMessage } from '../api';
import { Loader2, LogOut } from 'lucide-react';

const numFont = "font-['Space_Grotesk',ui-monospace,monospace]";

type KdsLine = {
  product_title: string;
  variant_sku_suffix?: string;
  quantity: number;
};

type KdsOrder = {
  id: number;
  created_at: string;
  table_name?: string | null;
  items?: KdsLine[];
};

function formatElapsedShort(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function minutesSince(iso: string, nowMs: number): number {
  const t = new Date(iso).getTime();
  return Math.max(0, (nowMs - t) / 60000);
}

export default function KitchenKds() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setElapsedTick] = useState(0);
  const [clock, setClock] = useState(() => new Date());

  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;

  const nowMs = Date.now();

  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setElapsedTick(x => x + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const q =
        user?.role === 'owner'
          ? `?branch_id=${activeBranchId}&include_items=1`
          : `?include_items=1`;
      const data = await get<{ sales?: KdsOrder[] }>(`/orders/active${q}`);
      setOrders(data.sales ?? []);
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setLoading(false);
    }
  }, [user?.branch_id, user?.role]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => void load(), 12000);
    return () => window.clearInterval(id);
  }, [load]);

  const tableLabel = (o: KdsOrder) => o.table_name?.trim() || '—';

  return (
    <div
      className={`h-full min-h-0 flex flex-col antialiased text-neutral-900 dark:text-neutral-100 selection:bg-brand-200/50 dark:selection:bg-brand-500/25`}
    >
      <header className="shrink-0 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 border-b border-white/25 dark:border-white/10">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400 mb-0.5">
            Station
          </p>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-brand-900 dark:text-brand-50 truncate">
            Kitchen
          </h1>
          <p className="text-[11px] text-neutral-600 dark:text-neutral-400 mt-1 max-w-prose leading-snug">
            Open KOT queue · Fired when front sends Generate KOT · Elapsed time from ticket start
          </p>
        </div>
        <div className="flex items-baseline justify-between sm:justify-end gap-6 sm:gap-10 shrink-0">
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400 mb-0.5">
              Time
            </p>
            <p className={`text-2xl sm:text-3xl font-medium tabular-nums tracking-tight text-brand-900 dark:text-brand-50 ${numFont}`}>
              {clock.toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
              })}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400 mb-0.5">
              Queue
            </p>
            <p className={`text-2xl sm:text-3xl font-medium tabular-nums text-gold-600 dark:text-gold-400 ${numFont}`}>
              {orders.length}{' '}
              <span className="text-sm font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                active
              </span>
            </p>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-xl text-sm border border-red-200 bg-red-50 text-red-800 dark:bg-red-950/50 dark:border-red-800/50 dark:text-red-200 flex flex-wrap items-center gap-2">
          <span className="flex-1 min-w-0">{error}</span>
          <button
            type="button"
            className="shrink-0 underline font-semibold text-red-700 dark:text-red-100"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto page-padding">
        {loading && orders.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-24 text-neutral-500 dark:text-neutral-400">
            <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden />
            <span className="text-sm">Loading tickets…</span>
          </div>
        ) : orders.length === 0 ? (
          <div className="h-full min-h-[40vh] flex flex-col items-center justify-center text-center px-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-neutral-500 dark:text-neutral-400 mb-3">
              Line clear
            </p>
            <p className="text-lg sm:text-xl font-medium text-brand-800 dark:text-brand-100 max-w-md leading-relaxed">
              All orders cleared
            </p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-3 max-w-sm leading-relaxed">
              When the POS sends a kitchen ticket, it appears here with table, elapsed time, and every line to fire.
            </p>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-min">
            {orders.map(o => {
              const ageMin = minutesSince(o.created_at, nowMs);
              const rush = ageMin >= 10;
              const lines = o.items ?? [];
              return (
                <li
                  key={o.id}
                  className={`relative rounded-xl overflow-hidden flex flex-col min-h-[140px] glass-card border transition-shadow ${
                    rush
                      ? 'border-gold-400/60 shadow-lg shadow-gold-500/15 ring-1 ring-gold-500/25 dark:border-gold-500/35'
                      : 'border-white/25 dark:border-white/10'
                  }`}
                >
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${
                      rush ? 'bg-gold-500' : 'bg-transparent'
                    }`}
                    aria-hidden
                  />
                  <div className="flex items-start justify-between gap-3 px-3 pt-3 pb-2 border-b border-white/20 dark:border-white/10">
                    <div className="min-w-0 flex-1 pl-1">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400 mb-0.5">
                        Table
                      </p>
                      <p className={`text-2xl font-semibold leading-none truncate tabular-nums text-brand-900 dark:text-brand-50 ${numFont}`}>
                        {tableLabel(o)}
                      </p>
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1.5">
                        Order <span className={`text-neutral-700 dark:text-neutral-300 tabular-nums ${numFont}`}>#{o.id}</span>
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400 mb-0.5">
                        Elapsed
                      </p>
                      <p
                        className={`text-lg font-medium tabular-nums ${numFont} ${
                          rush ? 'text-gold-600 dark:text-gold-400' : 'text-neutral-800 dark:text-neutral-200'
                        }`}
                      >
                        {formatElapsedShort(o.created_at, nowMs)}
                      </p>
                      {rush && (
                        <span className="inline-block mt-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gold-100/95 text-gold-900 border border-gold-400/60 dark:bg-gold-900/45 dark:text-gold-100 dark:border-gold-600/50">
                          Rush
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="px-3 py-2.5 flex-1 space-y-2 pl-4">
                    {lines.length === 0 ? (
                      <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">No lines (refresh)</p>
                    ) : (
                      lines.map((line, idx) => (
                        <div key={`${o.id}-${idx}-${line.product_title}`} className="flex gap-2 items-start">
                          <span
                            className={`shrink-0 min-w-[2rem] text-center text-xs font-bold tabular-nums px-1.5 py-0.5 rounded-full bg-brand-100/95 text-brand-900 border border-brand-200/70 dark:bg-brand-900/40 dark:text-brand-100 dark:border-brand-700/50 ${numFont}`}
                          >
                            {line.quantity}×
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight text-neutral-900 dark:text-neutral-100">
                              {line.product_title}
                            </p>
                            {line.variant_sku_suffix ? (
                              <p className="text-[11px] text-neutral-600 dark:text-neutral-400 mt-0.5 leading-snug">
                                {line.variant_sku_suffix}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-400 border-t border-white/15 bg-white/5 dark:bg-black/15">
                    {lines.length} line{lines.length === 1 ? '' : 's'} · kitchen display
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="shrink-0 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-[10px] text-neutral-500 dark:text-neutral-400 border-t border-white/25 dark:border-white/10 bg-white/5 dark:bg-black/10">
        <span>Auto-refresh ~12s · Elapsed updates every second</span>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void load()}
            className="font-semibold uppercase tracking-wide text-brand-800 dark:text-brand-200 hover:text-brand-950 dark:hover:text-white transition-colors"
          >
            Refresh now
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.removeItem('auth_token');
              localStorage.removeItem('user');
              navigate('/login', { replace: true });
            }}
            className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-brand-800 dark:text-brand-200 hover:text-brand-950 dark:hover:text-white transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden />
            Log out
          </button>
        </div>
      </footer>
    </div>
  );
}
