import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, getUserMessage } from '../api';
import { getSocket } from '../realtime/socket';
import {
  Loader2, LogOut, ChefHat, Clock, UtensilsCrossed,
  ShoppingBag, Truck, Play, CheckCircle2, RefreshCw, AlertTriangle
} from 'lucide-react';

/* ── types ── */
type KdsLine = { product_title: string; variant_sku_suffix?: string; quantity: number; modifiers?: string[] };
type KitchenStatus = 'placed' | 'preparing' | 'ready';
type KdsOrder = {
  id: number;
  created_at: string;
  order_type?: string | null;
  order_snapshot?: Record<string, unknown> | null;
  table_name?: string | null;
  kitchen_status: KitchenStatus;
  items?: KdsLine[];
  modifications?: { type: string; description: string; timestamp: string }[];
};

type FilterTab = 'placed' | 'preparing' | 'ready';

/* ── helpers ── */
function formatReceivedTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return '—'; }
}

function formatElapsed(iso: string, nowMs: number): string {
  const sec = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function minutesSince(iso: string, nowMs: number): number {
  return Math.max(0, (nowMs - new Date(iso).getTime()) / 60000);
}

function getPriorityColor(status: KitchenStatus, createdAtIso: string, nowMs: number): 'white' | 'yellow' | 'red' {
  if (status !== 'placed') return 'white';
  const age = minutesSince(createdAtIso, nowMs);
  if (age >= 15) return 'red';
  if (age >= 10) return 'yellow';
  return 'white';
}

/* ── order type config ── */
const ORDER_TYPE_CONFIG: Record<string, { label: string; pillColor: string; bgClass: string; icon: typeof UtensilsCrossed }> = {
  dine_in:  { label: 'Dine-In', pillColor: 'bg-amber-100 text-amber-900 border-amber-200', bgClass: 'bg-orange-50/40', icon: UtensilsCrossed },
  takeaway: { label: 'Takeaway', pillColor: 'bg-teal-100 text-teal-900 border-teal-200', bgClass: 'bg-teal-50/40', icon: ShoppingBag },
  delivery: { label: 'Delivery', pillColor: 'bg-purple-100 text-purple-900 border-purple-200', bgClass: 'bg-purple-50/40', icon: Truck },
};
function getOrderTypeConfig(t?: string | null) {
  return ORDER_TYPE_CONFIG[t || ''] || { label: t || 'Order', pillColor: 'bg-neutral-100 text-neutral-700 border-neutral-200', bgClass: 'bg-neutral-50/40', icon: ShoppingBag };
}

export default function KitchenKds() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('placed');
  const [, setTick] = useState(0);
  const [clock, setClock] = useState(() => new Date());
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const prevMetricsRef = useRef({ newCount: 0, modsCount: 0 });

  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const nowMs = Date.now();

  useEffect(() => {
    const id = setInterval(() => { setClock(new Date()); setTick(x => x + 1); }, 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') || user?.branch_id || '1';
      const url = `/orders/kitchen?branch_id=${activeBranchId}`;
      const data = await get<{ orders?: KdsOrder[] }>(url);
      const fetched = data.orders ?? [];
      const newCount = fetched.filter(o => o.kitchen_status === 'placed').length;
      const modsCount = fetched.reduce((sum, o) => sum + (o.modifications?.length || 0), 0);
      
      const prev = prevMetricsRef.current;
      if ((newCount > prev.newCount && prev.newCount >= 0) || (modsCount > prev.modsCount && prev.modsCount >= 0)) {
        try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=').play(); } catch {}
      }
      prevMetricsRef.current = { newCount, modsCount };
      setOrders(fetched);
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setLoading(false);
    }
  }, [user?.branch_id, user?.role]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const s = getSocket();
    const onAny = () => void load();
    s.on('ORDER_CREATED', onAny);
    s.on('ORDER_UPDATED', onAny);
    s.on('ORDER_STATUS_CHANGED', onAny);
    return () => {
      s.off('ORDER_CREATED', onAny);
      s.off('ORDER_UPDATED', onAny);
      s.off('ORDER_STATUS_CHANGED', onAny);
    };
  }, [load]);

  const updateStatus = useCallback(async (saleId: number, newStatus: KitchenStatus) => {
    setBusyIds(s => new Set(s).add(saleId));
    try {
      await patch(`/orders/${saleId}/kitchen-status`, { kitchen_status: newStatus });
      await load();
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setBusyIds(s => { const n = new Set(s); n.delete(saleId); return n; });
    }
  }, [load]);

  const filtered = orders.filter(o => {
    if (activeTab === 'placed') return o.kitchen_status === 'placed';
    if (activeTab === 'preparing') return o.kitchen_status === 'preparing';
    return o.kitchen_status === 'ready';
  });
  
  const tabCounts: Record<FilterTab, number> = {
    placed: orders.filter(o => o.kitchen_status === 'placed').length,
    preparing: orders.filter(o => o.kitchen_status === 'preparing').length,
    ready: orders.filter(o => o.kitchen_status === 'ready').length
  };

  return (
    <div className="flex flex-col h-screen min-h-0 bg-neutral-50/50 text-neutral-900 font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-white/60 backdrop-blur-md border-b border-white/40 shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3 text-2xl font-black text-neutral-800 tracking-tight">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 flex items-center justify-center text-white shadow-brand-900/20 shadow-lg">
              <ChefHat className="w-6 h-6" />
            </div>
            <span>Kitchen Display</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-neutral-100/80 border border-neutral-200">
            <Clock className="w-4 h-4 text-neutral-500" />
            <span className="font-mono font-bold text-neutral-700 text-sm">
              {clock.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="w-11 h-11 flex items-center justify-center rounded-xl bg-white border border-neutral-200 text-neutral-600 hover:text-brand-600 hover:bg-brand-50 hover:border-brand-200 transition-all shadow-sm active:scale-95" onClick={() => void load()} title="Refresh">
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            className="w-11 h-11 flex items-center justify-center rounded-xl bg-white border border-neutral-200 text-neutral-600 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-all shadow-sm active:scale-95"
            onClick={() => { localStorage.removeItem('auth_token'); localStorage.removeItem('user'); navigate('/login', { replace: true }); }}
            title="Log out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex items-center gap-3 px-6 py-3 bg-white/30 shrink-0 border-b border-white/40 shadow-[0_4px_12px_rgba(0,0,0,0.02)] z-[1]">
        {(['placed', 'preparing', 'ready'] as const).map(tabKey => {
          const isActive = activeTab === tabKey;
          const labels: Record<string, string> = { placed: 'NEW QUEUE', preparing: 'PREPARING', ready: 'READY' };
          return (
            <button
              key={tabKey}
              onClick={() => setActiveTab(tabKey)}
              className={`flex items-center gap-2.5 px-6 py-2.5 rounded-xl font-bold text-[13px] transition-all tracking-wide ${
                isActive
                  ? 'bg-white border text-brand-800 border-white shadow-sm ring-1 ring-black/5'
                  : 'bg-transparent text-neutral-500 border border-transparent hover:bg-white/40'
              }`}
            >
              {labels[tabKey]}
              <span className={`px-2 py-0.5 rounded-md text-[11px] font-black leading-none flex items-center justify-center ${
                isActive ? 'bg-brand-100/80 text-brand-800' : 'bg-black/5 text-neutral-600'
              }`}>
                {tabCounts[tabKey]}
              </span>
            </button>
          );
        })}
      </nav>

      {error && <div className="m-6 mb-0 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 font-semibold shadow-sm">{error}</div>}

      {/* Grid view */}
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        {loading && orders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-neutral-400 gap-3">
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="font-semibold text-lg">Loading orders...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-neutral-400 opacity-60">
            <UtensilsCrossed className="w-16 h-16 mb-4" />
            <p className="text-xl font-bold">Queue is empty</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-6 items-start">
            {filtered.map(order => {
              const priority = getPriorityColor(order.kitchen_status, order.created_at, nowMs);
              const otCfg = getOrderTypeConfig(order.order_type);
              const OtIcon = otCfg.icon;
              const lines = order.items ?? [];
              const isBusy = busyIds.has(order.id);
              const snap = order.order_snapshot || {};
              const tableName = order.table_name || (snap as Record<string, string>).table_name;
              const customerName = (snap as Record<string, string>).customer_name;

              // Compute dynamic card classes
              // Default state builds upon glassmorphism, priority states use bold solid/translucent aesthetics.
              let cardBg = 'bg-white/80 border-white/60 shadow-black/5';
              let timerColor = 'text-neutral-700';

              if (priority === 'yellow') {
                cardBg = 'bg-amber-100/90 border-amber-300 shadow-amber-900/10 shadow-lg ring-1 ring-amber-400/50';
                timerColor = 'text-amber-700';
              } else if (priority === 'red') {
                cardBg = 'bg-red-100/90 border-red-400 shadow-red-900/15 shadow-xl ring-2 ring-red-500/50';
                timerColor = 'text-red-700';
              }

              return (
                <div
                  key={order.id}
                  className={`flex flex-col relative rounded-2xl overflow-hidden backdrop-blur-md border transition-all ${cardBg} ${priority === 'white' ? otCfg.bgClass : ''}`}
                  style={{ animation: '0.3s ease-out 0s 1 normal forwards running kds-pop' }}
                >
                  {/* Subtle stripe across top */}
                  <div className={`absolute top-0 left-0 right-0 h-1.5 z-10 ${priority === 'white' ? 'bg-gradient-to-r from-white to-white/50' : priority === 'yellow' ? 'bg-amber-500' : 'bg-red-600'}`} />

                  {/* Card Header */}
                  <div className="px-5 pt-6 pb-3 flex justify-between items-start border-b border-black/5">
                    <div>
                      <span className="text-3xl font-black text-neutral-900 tracking-tight leading-none block">#{order.id}</span>
                      <div className={`mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-bold text-[10px] uppercase tracking-wider ${otCfg.pillColor}`}>
                        <OtIcon className="w-3 h-3" strokeWidth={2.5} />
                        <span>{otCfg.label}</span>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end">
                      <span className="text-xs font-bold text-neutral-500 block">
                        {formatReceivedTime(order.created_at)}
                      </span>
                      <div className={`mt-1 flex items-center justify-end gap-1.5 font-mono font-black text-xl tracking-tight ${timerColor}`}>
                        <Clock className="w-4 h-4" strokeWidth={3} />
                        <span>{formatElapsed(order.created_at, nowMs)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Meta (Table / Customer) */}
                  {(tableName || customerName) && (
                    <div className="px-5 py-2.5 bg-black/5 flex flex-col gap-0.5 border-b border-black/5">
                      {tableName && <div className="text-[13px] text-neutral-600 flex gap-2"><span className="font-bold uppercase text-[11px] opacity-70 mt-0.5">Table</span> <strong className="text-neutral-900 font-black">{tableName}</strong></div>}
                      {customerName && <div className="text-[13px] text-neutral-600 flex gap-2"><span className="font-bold uppercase text-[11px] opacity-70 mt-0.5">Cust</span> <strong className="text-neutral-900 font-black">{customerName}</strong></div>}
                    </div>
                  )}

                  {/* Items list */}
                  <div className="flex-1 px-5 py-4 flex flex-col gap-3">
                    {lines.map((line, idx) => (
                      <div key={idx} className="flex gap-3 items-start">
                        <div className="min-w-[36px] h-9 rounded-lg shrink-0 flex items-center justify-center bg-white border border-black/5 font-black text-[15px] text-neutral-900 shadow-sm">
                          {line.quantity}×
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <span className="block text-[15px] font-bold text-neutral-900 leading-tight">{line.product_title}</span>
                          {line.variant_sku_suffix && <span className="block text-[13px] font-semibold text-neutral-500 mt-0.5">{line.variant_sku_suffix}</span>}
                          {line.modifiers && line.modifiers.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {line.modifiers.map((m, mi) => (
                                <span key={mi} className="text-[11px] font-bold px-2 py-0.5 rounded flex items-center bg-white/60 border border-white text-neutral-700 shadow-sm">
                                  {m}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Modifications Alert */}
                    {order.modifications && order.modifications.length > 0 && (
                      <div className="mt-3 rounded-xl bg-amber-500/15 border border-amber-500/30 backdrop-blur-md p-3 shadow-inner">
                        <div className="flex items-center gap-1.5 mb-2 font-bold text-amber-900 text-[11px] uppercase tracking-wider">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                          Modifications
                        </div>
                        <ul className="space-y-1.5">
                          {order.modifications.map((mod: any, i: number) => (
                            <li key={i} className="flex gap-2 items-start text-sm font-semibold text-amber-950 bg-white/40 border border-white/50 rounded-lg p-2.5 shadow-sm">
                              <span className="shrink-0 text-amber-700 font-black mt-0.5">
                                {mod.type === 'add' ? '+' : mod.type === 'remove' ? '-' : '•'}
                              </span>
                              <div className="flex flex-col leading-tight">
                                <span>{mod.description}</span>
                                <span className="text-[10px] text-amber-700/80 font-bold mt-0.5">
                                  {new Date(mod.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="px-5 pb-5 pt-2">
                    {order.kitchen_status === 'placed' && (
                      <button
                        disabled={isBusy}
                        onClick={() => updateStatus(order.id, 'preparing')}
                        className="w-full py-3.5 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 bg-brand-700 text-white hover:bg-brand-600 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-4 h-4 fill-white" />
                        {isBusy ? 'Wait...' : 'Start Preparing'}
                      </button>
                    )}
                    {order.kitchen_status === 'preparing' && (
                      <button
                        disabled={isBusy}
                        onClick={() => updateStatus(order.id, 'ready')}
                        className="w-full py-3.5 rounded-xl font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 bg-emerald-600 text-white hover:bg-emerald-500 transition-all shadow-sm active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed border border-emerald-500"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        {isBusy ? 'Wait...' : 'Order Ready'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes kds-pop {
          from { transform: scale(0.96); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
