import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, getUserMessage } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import { getSocket } from '../realtime/socket';
import {
  Loader2, LogOut, ChefHat, Clock, UtensilsCrossed,
  ShoppingBag, Truck, Play, CheckCircle2, RefreshCw, AlertTriangle
} from 'lucide-react';

/* ── types ── */
type KdsLine = {
  product_title: string;
  variant_sku_suffix?: string;
  quantity: number;
  modifiers?: string[];
  children?: KdsLine[];
};
type KitchenStatus = 'placed' | 'preparing' | 'ready';
type KdsOrder = {
  id: number;
  created_at: string;
  order_type?: string | null;
  order_snapshot?: Record<string, unknown> | null;
  table_name?: string | null;
  kitchen_status: KitchenStatus;
  /** Lines shown on the ticket card (deal shows as one line). */
  items?: KdsLine[];
  /** Expanded lines for queue totals (deal components, not the deal parent). */
  prep_lines?: KdsLine[];
  modifications?: { type: string; description: string; timestamp: string }[];
  is_modified?: boolean;
  modified_at?: string | null;
};

type FilterTab = 'placed' | 'preparing' | 'ready';

function normalizeKitchenStatus(s: string | null | undefined): KitchenStatus {
  const v = String(s ?? '')
    .trim()
    .toLowerCase();
  if (v === 'preparing' || v === 'ready') return v;
  return 'placed';
}

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

/** Stable key: same dish + variant + modifier set aggregates together (e.g. two 1× Burger orders → 2× Burger). */
function lineAggregateKey(line: KdsLine): string {
  const vk = String(line.variant_sku_suffix ?? '').trim();
  const mods = [...(line.modifiers ?? [])].map(m => String(m).trim()).filter(Boolean).sort();
  return `${line.product_title}\0${vk}\0${mods.join('\x1f')}`;
}

type CollectiveLine = {
  quantity: number;
  product_title: string;
  variant_sku_suffix?: string;
  modifiers: string[];
};

/** Reused context so repeated KOTs do not leak AudioContext instances. */
let kotAudioContext: AudioContext | null = null;

function getKotAudioContext(): AudioContext | null {
  try {
    if (typeof window === 'undefined') return null;
    if (!kotAudioContext) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      kotAudioContext = new Ctor();
    }
    return kotAudioContext;
  } catch {
    return null;
  }
}

/** Short kitchen bell / double-tone so cooks notice a new ticket (respects autoplay until user has interacted). */
function playKotAlertSound(): void {
  const ctx = getKotAudioContext();
  if (!ctx) return;
  const start = () => {
    const t0 = ctx.currentTime;
    const ding = (freq: number, offset: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + offset);
      gain.gain.setValueAtTime(0, t0 + offset);
      gain.gain.linearRampToValueAtTime(0.18, t0 + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + duration + 0.05);
    };
    ding(784, 0, 0.22);
    ding(1046.5, 0.18, 0.28);
  };
  if (ctx.state === 'suspended') {
    void ctx.resume().then(start).catch(() => {});
  } else {
    start();
  }
}

function aggregateCollectiveLines(orders: KdsOrder[]): CollectiveLine[] {
  const map = new Map<string, CollectiveLine>();
  for (const order of orders) {
    const source = order.prep_lines != null ? order.prep_lines : order.items ?? [];
    for (const line of source) {
      const q = Math.max(0, Math.floor(Number(line.quantity) || 0));
      if (q <= 0) continue;
      const key = lineAggregateKey(line);
      const mods = [...(line.modifiers ?? [])].map(m => String(m).trim()).filter(Boolean).sort();
      const vk = String(line.variant_sku_suffix ?? '').trim();
      const prev = map.get(key);
      if (prev) {
        prev.quantity += q;
      } else {
        map.set(key, {
          quantity: q,
          product_title: line.product_title || 'Unknown',
          variant_sku_suffix: vk || undefined,
          modifiers: mods,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (b.quantity !== a.quantity) return b.quantity - a.quantity;
    return a.product_title.localeCompare(b.product_title, undefined, { sensitivity: 'base' });
  });
}

function HeaderClock() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono font-bold text-neutral-700 text-sm">
      {clock.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
    </span>
  );
}

const OrderCard = memo(function OrderCard({
  order,
  isBusy,
  onUpdateStatus,
}: {
  order: KdsOrder;
  isBusy: boolean;
  onUpdateStatus: (id: number, status: KitchenStatus) => void;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ks = normalizeKitchenStatus(order.kitchen_status);

  useEffect(() => {
    if (ks === 'ready') return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ks]);

  const priority = getPriorityColor(ks, order.created_at, nowMs);
  const otCfg = getOrderTypeConfig(order.order_type);
  const OtIcon = otCfg.icon;
  const lines = order.items ?? [];
  const snap = order.order_snapshot || {};
  const tableName = order.table_name || (snap as Record<string, string>).table_name;
  const customerName = (snap as Record<string, string>).customer_name;

  let cardBg = 'bg-white/80 border-white/60';
  let timerColor = 'text-neutral-700';

  if (order.is_modified) {
    cardBg = 'bg-orange-100/95 border-orange-400 ring-2 ring-orange-400/45';
    timerColor = 'text-orange-700';
  } else if (priority === 'yellow') {
    cardBg = 'bg-amber-100/90 border-amber-300 ring-1 ring-amber-400/50';
    timerColor = 'text-amber-700';
  } else if (priority === 'red') {
    cardBg = 'bg-red-100/90 border-red-400 ring-2 ring-red-500/50';
    timerColor = 'text-red-700';
  }

  return (
    <div
      className={`flex flex-col relative rounded-[18px] overflow-hidden border transition-all h-[460px] ${cardBg} ${priority === 'white' ? otCfg.bgClass : ''}`}
      style={{ animation: '0.3s ease-out 0s 1 normal forwards running kds-pop' }}
    >
      {/* Subtle stripe across top */}
      <div className={`absolute top-0 left-0 right-0 h-1.5 z-10 ${priority === 'white' ? 'bg-white' : priority === 'yellow' ? 'bg-amber-500' : 'bg-red-600'}`} />

      {/* Card Header */}
      <div className="px-5 pt-6 pb-3 flex justify-between items-start border-b border-black/5 shrink-0">
        <div className="min-w-0 pr-2">
          <span className="text-3xl font-black text-neutral-900 tracking-tight leading-none block truncate">#{order.id}</span>
          <div className={`mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-bold text-[10px] uppercase tracking-wider ${otCfg.pillColor}`}>
            <OtIcon className="w-3 h-3 shrink-0" strokeWidth={2.5} />
            <span className="truncate">{otCfg.label}</span>
          </div>
          {order.is_modified && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-bold text-[10px] uppercase tracking-wider bg-orange-100 text-orange-900 border-orange-300">
              <AlertTriangle className="w-3 h-3 shrink-0 text-orange-700" />
              <span>Order Modified</span>
            </div>
          )}
        </div>
        <div className="text-right flex flex-col items-end shrink-0">
          <span className="text-xs font-bold text-neutral-500 block">
            {formatReceivedTime(order.created_at)}
          </span>
          {ks !== 'ready' && (
            <div className={`mt-1 flex items-center justify-end gap-1.5 font-mono font-black text-xl tracking-tight ${timerColor}`}>
              <Clock className="w-4 h-4" strokeWidth={3} />
              <span>{formatElapsed(order.created_at, nowMs)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Card Meta (Table / Customer) */}
      {(tableName || customerName) && (
        <div className="px-5 py-2.5 bg-black/5 flex flex-col gap-0.5 border-b border-black/5 shrink-0">
          {tableName && <div className="text-[13px] text-neutral-600 flex gap-2"><span className="font-bold uppercase text-[11px] opacity-70 mt-0.5">Table</span> <strong className="text-neutral-900 font-black truncate">{tableName}</strong></div>}
          {customerName && <div className="text-[13px] text-neutral-600 flex gap-2"><span className="font-bold uppercase text-[11px] opacity-70 mt-0.5">Cust</span> <strong className="text-neutral-900 font-black truncate">{customerName}</strong></div>}
        </div>
      )}

      {/* Items list */}
      <div className="flex-1 px-5 py-4 flex flex-col gap-3 overflow-y-auto custom-scrollbar">
        {lines.map((line, idx) => (
          <div key={idx} className="flex gap-3 items-start">
            <div className="min-w-[36px] h-9 rounded-[8px] shrink-0 flex items-center justify-center bg-white border border-black/5 font-black text-[15px] text-neutral-900">
              {line.quantity}×
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <span className="block text-[15px] font-bold text-neutral-900 leading-tight">{line.product_title}</span>
              {line.variant_sku_suffix && <span className="block text-[13px] font-semibold text-neutral-500 mt-0.5">{line.variant_sku_suffix}</span>}
              {line.modifiers && line.modifiers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {line.modifiers.map((m, mi) => (
                    <span key={mi} className="text-[11px] font-bold px-2 py-0.5 rounded flex items-center bg-white/60 border border-white text-neutral-700">
                      {m}
                    </span>
                  ))}
                </div>
              )}
              {line.children && line.children.length > 0 && (
                <div className="mt-2 space-y-1.5 rounded-[11px] bg-black/5 px-3 py-2">
                  {line.children.map((child, childIndex) => (
                    <div key={`${idx}-${childIndex}`} className="flex items-start gap-2 text-[12px] font-semibold text-neutral-700">
                      <span className="shrink-0 text-neutral-500">{child.quantity}×</span>
                      <div className="min-w-0">
                        <span className="block truncate">{child.product_title}</span>
                        {child.variant_sku_suffix && (
                          <span className="block text-[11px] text-neutral-500">{child.variant_sku_suffix}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Modifications Alert */}
        {order.modifications && order.modifications.length > 0 && (
          <div className="mt-3 rounded-[11px] bg-amber-500/15 border border-amber-500/30 p-3">
            <div className="flex items-center gap-1.5 mb-2 font-bold text-amber-900 text-[11px] uppercase tracking-wider">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              Modifications
            </div>
            <ul className="space-y-1.5">
              {order.modifications.map((mod, i: number) => (
                <li key={i} className="flex gap-2 items-start text-sm font-semibold text-amber-950 bg-white/40 border border-white/50 rounded-[8px] p-2.5">
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
      <div className="px-5 pb-5 pt-2 shrink-0">
        {ks === 'placed' && (
          <button
            disabled={isBusy}
            onClick={() => onUpdateStatus(order.id, 'preparing')}
            className="w-full py-3.5 rounded-[11px] font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 bg-brand-700 text-white hover:bg-brand-600 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-4 h-4 fill-white" />
            {isBusy ? 'Wait...' : 'Start Preparing'}
          </button>
        )}
        {ks === 'preparing' && (
          <button
            disabled={isBusy}
            onClick={() => onUpdateStatus(order.id, 'ready')}
            className="w-full py-3.5 rounded-[11px] font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 bg-emerald-600 text-white hover:bg-emerald-500 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed border border-emerald-500"
          >
            <CheckCircle2 className="w-4 h-4" />
            {isBusy ? 'Wait...' : 'Order Ready'}
          </button>
        )}
        {ks === 'ready' && (
          <div className="w-full py-3.5 rounded-[11px] font-black text-sm uppercase tracking-wider flex items-center justify-center gap-2 bg-neutral-100 text-neutral-400 border border-neutral-200">
            <CheckCircle2 className="w-4 h-4" />
            Ready
          </div>
        )}
      </div>
    </div>
  );
});

export default function KitchenKds() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('placed');
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  /** After first successful kitchen fetch, tracks sale IDs so we only ding on genuinely new KOTs. */
  const priorKitchenSaleIdsRef = useRef<Set<number> | null>(null);

  const terminalBranchId = getTerminalBranchIdString(parseUserFromStorage());

  useEffect(() => {
    const primeAudio = () => {
      const ctx = getKotAudioContext();
      if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', primeAudio, { passive: true, once: true });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const url = terminalBranchId ? `/orders/kitchen?branch_id=${terminalBranchId}` : '/orders/kitchen';
      const data = await get<{ orders?: KdsOrder[] }>(url);
      const fetched = data.orders ?? [];
      const currentIds = new Set(fetched.map(o => o.id));
      const prior = priorKitchenSaleIdsRef.current;
      if (prior === null) {
        priorKitchenSaleIdsRef.current = currentIds;
      } else {
        let hasNewKot = false;
        for (const id of currentIds) {
          if (!prior.has(id)) {
            hasNewKot = true;
            break;
          }
        }
        if (hasNewKot) {
          playKotAlertSound();
        }
        priorKitchenSaleIdsRef.current = currentIds;
      }
      setOrders(fetched);
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setLoading(false);
    }
  }, [terminalBranchId]);

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
    const previousOrders = orders;
    setOrders(prev => prev.map(order => (
      order.id === saleId ? { ...order, kitchen_status: newStatus } : order
    )));
    try {
      await patch(`/orders/${saleId}/kitchen-status`, { kitchen_status: newStatus });
      await load();
    } catch (e) {
      setOrders(previousOrders);
      setError(getUserMessage(e));
    } finally {
      setBusyIds(s => { const n = new Set(s); n.delete(saleId); return n; });
    }
  }, [load, orders]);

  const filtered = orders.filter(o => {
    const ks = normalizeKitchenStatus(o.kitchen_status);
    if (activeTab === 'placed') return ks === 'placed';
    if (activeTab === 'preparing') return ks === 'preparing';
    return ks === 'ready';
  });
  
  const tabCounts: Record<FilterTab, number> = {
    placed: orders.filter(o => normalizeKitchenStatus(o.kitchen_status) === 'placed').length,
    preparing: orders.filter(o => normalizeKitchenStatus(o.kitchen_status) === 'preparing').length,
    ready: orders.filter(o => normalizeKitchenStatus(o.kitchen_status) === 'ready').length
  };

  const collectiveLines = useMemo(() => aggregateCollectiveLines(filtered), [filtered]);

  return (
    <div className="flex flex-col h-screen min-h-0 bg-neutral-50/50 text-neutral-900 font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-white/60 border-b border-white/40 shrink-0 z-10">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3 text-2xl font-black text-neutral-800 tracking-tight">
            <div className="w-10 h-10 rounded-[11px] bg-brand-700 flex items-center justify-center text-white">
              <ChefHat className="w-6 h-6" />
            </div>
            <span>Kitchen Display</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-neutral-100/80 border border-neutral-200">
            <Clock className="w-4 h-4 text-neutral-500" />
            <HeaderClock />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="w-11 h-11 flex items-center justify-center rounded-[11px] bg-white border border-neutral-200 text-neutral-600 hover:text-brand-600 hover:bg-brand-50 hover:border-brand-200 transition-all active:scale-95" onClick={() => void load()} title="Refresh">
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            className="w-11 h-11 flex items-center justify-center rounded-[11px] bg-white border border-neutral-200 text-neutral-600 hover:text-red-600 hover:bg-red-50 hover:border-red-200 transition-all active:scale-95"
            onClick={() => { localStorage.removeItem('auth_token'); localStorage.removeItem('user'); navigate('/login', { replace: true }); }}
            title="Log out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex items-center gap-3 px-6 py-3 bg-white/30 shrink-0 border-b border-white/40 z-[1]">
        {(['placed', 'preparing', 'ready'] as const).map(tabKey => {
          const isActive = activeTab === tabKey;
          const labels: Record<string, string> = { placed: 'NEW QUEUE', preparing: 'PREPARING', ready: 'READY' };
          return (
            <button
              key={tabKey}
              onClick={() => setActiveTab(tabKey)}
              className={`flex items-center gap-2.5 px-6 py-2.5 rounded-[11px] font-bold text-[13px] transition-all tracking-wide ${
                isActive
                  ? 'bg-white border text-brand-800 border-white ring-1 ring-black/5'
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

      {error && <div className="m-6 mb-0 p-4 rounded-[11px] bg-red-50 border border-red-200 text-red-800 font-semibold">{error}</div>}

      {/* Collective queue totals — sums items across all tickets in this tab */}
      {!loading && filtered.length > 0 && collectiveLines.length > 0 && (
        <div className="shrink-0 px-6 pt-4 pb-0">
          <div className="rounded-[18px] border border-white/60 bg-white/70 px-5 py-4 ring-1 ring-black/5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
              <span className="text-[11px] font-black uppercase tracking-widest text-neutral-500">Queue totals</span>
              <span className="text-[11px] font-semibold text-neutral-400">
                {activeTab === 'placed' && 'New queue'}
                {activeTab === 'preparing' && 'In prep'}
                {activeTab === 'ready' && 'Ready to serve'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {collectiveLines.map((row, i) => (
                <div
                  key={`${row.product_title}-${row.variant_sku_suffix ?? ''}-${row.modifiers.join(',')}-${i}`}
                  className="inline-flex items-center gap-2 rounded-[11px] border border-brand-200/80 bg-brand-50 px-3.5 py-2"
                >
                  <span className="min-w-[2.25rem] text-center font-black text-lg tabular-nums text-brand-900 leading-none">
                    {row.quantity}×
                  </span>
                  <span className="font-bold text-[15px] text-neutral-900 leading-tight">
                    {row.product_title}
                    {row.variant_sku_suffix ? (
                      <span className="font-semibold text-neutral-500"> · {row.variant_sku_suffix}</span>
                    ) : null}
                  </span>
                  {row.modifiers.length > 0 && (
                    <span className="text-[11px] font-bold text-neutral-600 max-w-[min(100%,14rem)] truncate" title={row.modifiers.join(', ')}>
                      + {row.modifiers.join(', ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

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
            {filtered.map(order => (
              <OrderCard
                key={order.id}
                order={order}
                isBusy={busyIds.has(order.id)}
                onUpdateStatus={updateStatus}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes kds-pop {
          from { transform: scale(0.96); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: rgba(0,0,0,0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background-color: rgba(0,0,0,0.2);
        }
      `}</style>
    </div>
  );
}
