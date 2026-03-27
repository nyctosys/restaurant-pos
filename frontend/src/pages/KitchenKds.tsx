/**
 * Kitchen Display System (KDS) — live order queue for all order types.
 * Pure Glassmorphism Aesthetic on a Light, Clean Background.
 * Differentiated per-type color schemes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, patch, getUserMessage } from '../api';
import {
  Loader2, LogOut, ChefHat, Clock, UtensilsCrossed,
  ShoppingBag, Truck, RotateCcw, Play, CheckCircle2, RefreshCw, AlertTriangle
} from 'lucide-react';

/* ── types ── */
type KdsLine = { product_title: string; variant_sku_suffix?: string; quantity: number };
type KitchenStatus = 'placed' | 'accepted' | 'preparing' | 'ready' | 'served';
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

/* ── order type config ── */
const ORDER_TYPE_CONFIG: Record<string, { label: string; cls: string; accent: string; icon: typeof UtensilsCrossed }> = {
  dine_in:  { label: 'Dine-In',  cls: 'type-dine-in',  accent: '#a04000', icon: UtensilsCrossed },
  takeaway: { label: 'Takeaway', cls: 'type-takeaway', accent: '#0d9488', icon: ShoppingBag },
  delivery: { label: 'Delivery', cls: 'type-delivery', accent: '#7c3aed', icon: Truck },
};
function getOrderTypeConfig(t?: string | null) {
  return ORDER_TYPE_CONFIG[t || ''] || { label: t || 'Order', cls: 'type-other', accent: '#666', icon: ShoppingBag };
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
      // The KDS only shows active orders, so include_completed is not needed here.
      // If a 'completed' tab were added, this logic would need to be updated.
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
  useEffect(() => { const id = setInterval(() => void load(), 8000); return () => clearInterval(id); }, [load]);

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
    if (activeTab === 'placed') return o.kitchen_status === 'placed' || o.kitchen_status === 'accepted';
    if (activeTab === 'preparing') return o.kitchen_status === 'preparing';
    return o.kitchen_status === 'ready';
  });
  
  const tabCounts: Record<FilterTab, number> = {
    placed: orders.filter(o => o.kitchen_status === 'placed' || o.kitchen_status === 'accepted').length,
    preparing: orders.filter(o => o.kitchen_status === 'preparing').length,
    ready: orders.filter(o => o.kitchen_status === 'ready').length
  };

  return (
    <div className="kds-root">
      <header className="kds-header">
        <div className="kds-header-left">
          <div className="kds-brand">
            <ChefHat size={28} />
            <span>Kitchen Display</span>
          </div>
          <div className="kds-stats">
            <div className="kds-stat">
              <Clock size={16} />
              <span className="kds-clock">
                {clock.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </span>
            </div>
          </div>
        </div>
        <div className="kds-header-right">
          <button className="kds-btn-icon" onClick={() => void load()} title="Refresh">
            <RefreshCw size={20} />
          </button>
          <button
            className="kds-btn-icon"
            onClick={() => { localStorage.removeItem('auth_token'); localStorage.removeItem('user'); navigate('/login', { replace: true }); }}
            title="Log out"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      <nav className="kds-tabs">
        <button className={`kds-tab ${activeTab === 'placed' ? 'kds-tab-active' : ''}`} onClick={() => setActiveTab('placed')}>
          NEW QUEUE <span className="kds-tab-count">{tabCounts.placed}</span>
        </button>
        <button className={`kds-tab ${activeTab === 'preparing' ? 'kds-tab-active' : ''}`} onClick={() => setActiveTab('preparing')}>
          PREPARING <span className="kds-tab-count">{tabCounts.preparing}</span>
        </button>
        <button className={`kds-tab ${activeTab === 'ready' ? 'kds-tab-active' : ''}`} onClick={() => setActiveTab('ready')}>
          READY <span className="kds-tab-count">{tabCounts.ready}</span>
        </button>
      </nav>

      {error && <div className="kds-error">{error}</div>}

      <div className="kds-grid-wrap">
        {loading && orders.length === 0 ? (
          <div className="kds-empty">
            <Loader2 className="kds-spin" size={32} />
            <span>Loading orders...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="kds-empty">
            <UtensilsCrossed size={48} style={{opacity: 0.2}} />
            <p className="kds-empty-title">Queue is empty</p>
          </div>
        ) : (
          <div className="kds-grid">
            {filtered.map(order => {
              const age = minutesSince(order.created_at, nowMs);
              const urgency = age >= 10 ? 'rush' : age >= 5 ? 'warning' : 'normal';
              const otCfg = getOrderTypeConfig(order.order_type);
              const OtIcon = otCfg.icon;
              const lines = order.items ?? [];
              const isBusy = busyIds.has(order.id);
              const snap = order.order_snapshot || {};
              const tableName = order.table_name || (snap as Record<string, string>).table_name;
              const customerName = (snap as Record<string, string>).customer_name;

              return (
                <div key={order.id} className={`kds-card ${otCfg.cls} kds-urgency-${urgency}`}>
                  <div className={`kds-card-stripe kds-stripe-${urgency}`} />
                  <div className="kds-card-header">
                    <div className="kds-card-header-main">
                      <span className="kds-order-id">#{order.id}</span>
                      <div className="kds-type-pill">
                        <OtIcon size={12} />
                        <span>{otCfg.label}</span>
                      </div>
                    </div>
                    <div className="kds-card-header-timer">
                      <span className="kds-received-time">{formatReceivedTime(order.created_at)}</span>
                      <div className={`kds-elapsed-timer theme-urgency-${urgency}`}>
                        <Clock size={16} />
                        <span>{formatElapsed(order.created_at, nowMs)}</span>
                      </div>
                    </div>
                  </div>

                  {(tableName || customerName) && (
                    <div className="kds-card-meta">
                      {tableName && <div className="kds-meta-row"><span>TABLE:</span> <strong>{tableName}</strong></div>}
                      {customerName && <div className="kds-meta-row"><span>CUST:</span> <strong>{customerName}</strong></div>}
                    </div>
                  )}

                  <div className="kds-items-list">
                    {lines.map((line, idx) => (
                      <div key={idx} className="kds-item-row">
                        <span className="kds-item-qty">{line.quantity}×</span>
                        <div className="kds-item-details">
                          <span className="kds-item-name">{line.product_title}</span>
                          {line.variant_sku_suffix && <span className="kds-item-variant">{line.variant_sku_suffix}</span>}
                        </div>
                      </div>
                    ))}
                    {order.modifications && order.modifications.length > 0 && (
                  <div className="mt-3.5 rounded-xl bg-amber-500/15 border border-amber-500/30 backdrop-blur-md p-3 shadow-inner">
                    <div className="flex items-center gap-1.5 mb-2 font-bold text-amber-900 text-[11px] uppercase tracking-wider">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                      MODIFIED:
                    </div>
                    <ul className="space-y-1.5">
                      {order.modifications.map((mod: any, i: number) => (
                        <li key={i} className="flex gap-2 items-start text-sm font-semibold text-amber-950 bg-white/40 border border-white/50 rounded-lg p-2.5 shadow-sm">
                          <span className="shrink-0 text-amber-700 font-black mt-0.5">
                            {mod.type === 'add' ? '+' : mod.type === 'remove' ? '-' : '•'}
                          </span>
                          <div className="flex flex-col leading-tight">
                            <span>{mod.description}</span>
                            <span className="text-[10px] text-amber-700/80 font-medium mt-0.5">
                              {new Date(mod.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}  </div>

                  <div className="kds-card-actions">
                    {order.kitchen_status === 'placed' && (
                      <button className="btn-action btn-start" disabled={isBusy} onClick={() => updateStatus(order.id, 'accepted')}>
                        <CheckCircle2 size={18} /> {isBusy ? 'Wait...' : 'ACCEPT'}
                      </button>
                    )}
                    {order.kitchen_status === 'accepted' && (
                      <button className="btn-action btn-start" disabled={isBusy} onClick={() => updateStatus(order.id, 'preparing')}>
                        <Play size={18} /> {isBusy ? 'Wait...' : 'START PREPARING'}
                      </button>
                    )}
                    {order.kitchen_status === 'preparing' && (
                      <button className="btn-action btn-ready" disabled={isBusy} onClick={() => updateStatus(order.id, 'ready')}>
                        <CheckCircle2 size={18} /> {isBusy ? 'Wait...' : 'MARK READY'}
                      </button>
                    )}
                    {order.kitchen_status === 'ready' && (
                      <button className="btn-action btn-ready" style={{backgroundColor: '#4f46e5'}} disabled={isBusy} onClick={() => updateStatus(order.id, 'served')}>
                        <CheckCircle2 size={18} /> {isBusy ? 'Wait...' : 'SERVE'}
                      </button>
                    )}
                    {(order.kitchen_status === 'preparing' || order.kitchen_status === 'ready') && (
                      <button className="btn-action btn-recall" style={{marginTop: 8}} disabled={isBusy} onClick={() => updateStatus(order.id, order.kitchen_status === 'ready' ? 'preparing' : 'accepted')}>
                        <RotateCcw size={18} /> RECALL
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
        :root {
          --kds-bg: #f3f4f6;
          --kds-card-bg: rgba(255, 255, 255, 0.7);
          --kds-glass-border: rgba(0, 0, 0, 0.08);
          --kds-text-primary: #111827;
          --kds-text-secondary: #4b5563;
          --kds-accent-gold: #b45309;
          --kds-blur: blur(20px);
          
          /* Type specific colors (Light variants) */
          --color-dine-bg: rgba(254, 243, 199, 0.6);
          --color-dine-accent: #92400e;
          --color-takeaway-bg: rgba(204, 251, 241, 0.6);
          --color-takeaway-accent: #0f766e;
          --color-delivery-bg: rgba(237, 233, 254, 0.6);
          --color-delivery-accent: #6d28d9;
        }

        .kds-root {
          height: 100vh; display: flex; flex-direction: column;
          background: linear-gradient(135deg, #f9fafb 0%, #e5e7eb 100%);
          color: var(--kds-text-primary);
          font-family: 'Outfit', 'Inter', sans-serif;
          overflow: hidden;
        }

        /* Header */
        .kds-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 32px;
          background: rgba(255, 255, 255, 0.6);
          backdrop-filter: var(--kds-blur);
          border-bottom: 1px solid var(--kds-glass-border);
          flex-shrink: 0;
        }
        .kds-header-left { display: flex; align-items: center; gap: 40px; }
        .kds-brand {
          display: flex; align-items: center; gap: 12px;
          font-size: 20px; font-weight: 800; color: #1f2937;
        }
        .kds-stat {
          display: flex; align-items: center; gap: 8px;
          font-size: 15px; font-weight: 700; color: var(--kds-text-secondary);
          background: rgba(0, 0, 0, 0.04); padding: 6px 16px; border-radius: 99px;
        }
        .kds-btn-icon {
          width: 40px; height: 40px; border-radius: 12px; border: 1px solid var(--kds-glass-border);
          background: rgba(255,255,255,0.8); color: #374151;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; transition: all 0.2s;
        }
        .kds-btn-icon:hover { background: #fff; transform: translateY(-1px); }

        /* Navigation */
        .kds-tabs {
          display: flex; gap: 12px; padding: 12px 32px;
          background: rgba(255, 255, 255, 0.3); flex-shrink: 0;
          border-bottom: 1px solid var(--kds-glass-border);
        }
        .kds-tab {
          padding: 10px 24px; border-radius: 14px; border: 1px solid transparent;
          background: transparent; color: var(--kds-text-secondary);
          font-size: 14px; font-weight: 800; cursor: pointer; transition: all 0.2s;
          display: flex; align-items: center; gap: 10px;
        }
        .kds-tab-active {
          background: white !important; color: #111827 !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.05);
          border-color: var(--kds-glass-border) !important;
        }
        .kds-tab-count {
          background: rgba(0,0,0,0.08); padding: 2px 8px; border-radius: 6px; font-size: 12px;
        }

        /* Grid */
        .kds-grid-wrap { flex: 1; overflow-y: auto; padding: 24px 32px; }
        .kds-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 24px; align-content: start;
        }

        /* Card System */
        .kds-card {
          position: relative; border-radius: 20px; overflow: hidden;
          background: var(--kds-card-bg); border: 1px solid var(--kds-glass-border);
          display: flex; flex-direction: column; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          backdrop-filter: var(--kds-blur);
          box-shadow: 0 10px 25px rgba(0,0,0,0.03);
          animation: kds-pop 0.3s ease-out;
        }
        @keyframes kds-pop { from { transform: scale(0.98); opacity: 0; } }
        .kds-card:hover { transform: translateY(-4px); box-shadow: 0 15px 35px rgba(0,0,0,0.06); }

        /* Categorical Differentiation */
        .type-dine-in { background-color: var(--color-dine-bg); }
        .type-dine-in .kds-type-pill { background: #fef3c7; color: #92400e; }
        .type-dine-in .btn-start { background: #d97706; color: #fff; }

        .type-takeaway { background-color: var(--color-takeaway-bg); }
        .type-takeaway .kds-type-pill { background: #ccfbf1; color: #0f766e; }
        .type-takeaway .btn-start { background: #0d9488; color: #fff; }

        .type-delivery { background-color: var(--color-delivery-bg); }
        .type-delivery .kds-type-pill { background: #ede9fe; color: #6d28d9; }
        .type-delivery .btn-start { background: #7c3aed; color: #fff; }

        /* Card Header */
        .kds-card-header {
          padding: 20px; display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 1px solid rgba(0,0,0,0.05);
        }
        .kds-order-id { font-size: 28px; font-weight: 900; letter-spacing: -1px; color: #111; }
        .kds-type-pill {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 800;
          text-transform: uppercase; margin-top: 6px;
        }
        .kds-received-time { display: block; font-size: 12px; font-weight: 700; color: #6b7280; text-align: right; }
        .kds-elapsed-timer {
          display: flex; align-items: center; gap: 6px; justify-content: flex-end;
          font-size: 18px; font-weight: 800; margin-top: 4px;
        }
        .theme-urgency-rush { color: #dc2626; animation: rush-glow 1s infinite alternate; }
        @keyframes rush-glow { from { opacity: 1; } to { opacity: 0.6; } }

        /* Meta Content */
        .kds-card-meta { padding: 8px 20px; background: rgba(0,0,0,0.02); display: flex; flex-direction: column; gap: 2px; }
        .kds-meta-row { font-size: 12px; color: #4b5563; display: flex; gap: 8px; }
        .kds-meta-row strong { color: #111; }

        /* Items List */
        .kds-items-list { padding: 16px 20px; flex: 1; display: flex; flex-direction: column; gap: 10px; }
        .kds-item-row { display: flex; gap: 12px; align-items: flex-start; }
        .kds-item-qty {
          min-width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
          font-size: 14px; font-weight: 800; border-radius: 8px;
          background: white; border: 1px solid rgba(0,0,0,0.05);
        }
        .kds-item-details { flex: 1; }
        .kds-item-name { display: block; font-size: 15px; font-weight: 700; color: #1a1a1a; line-height: 1.2; }
        .kds-item-variant { font-size: 12px; color: #6b7280; }

        /* Actions */
        .kds-card-actions { padding: 0 20px 20px; }
        .btn-action {
          width: 100%; height: 48px; border-radius: 12px; border: none;
          font-size: 14px; font-weight: 800; cursor: pointer;
          display: flex; align-items: center; justify-content: center; gap: 10px;
          transition: all 0.2s; text-transform: uppercase;
        }
        .btn-ready { background: #16a34a; color: #fff; }
        .btn-ready:hover { background: #15803d; }
        .btn-recall { background: #f3f4f6; color: #4b5563; border: 1px solid #e5e7eb; }

        /* Modifications */
        .kds-modifications { margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(0,0,0,0.1); display: flex; flex-direction: column; gap: 6px; }
        .kds-mods-title { font-size: 11px; font-weight: 800; color: #6b7280; letter-spacing: 0.5px; }
        .kds-mod-row { display: flex; gap: 8px; font-size: 13px; font-weight: 600; padding: 6px 10px; border-radius: 6px; }
        .kds-mod-add { background: rgba(34, 197, 94, 0.15); color: #15803d; }
        .kds-mod-remove { background: rgba(239, 68, 68, 0.15); color: #b91c1c; text-decoration: line-through; }
        .kds-mod-update { background: rgba(245, 158, 11, 0.15); color: #b45309; }
        .kds-mod-time { font-size: 11px; opacity: 0.7; font-weight: 700; }

        .kds-card-stripe { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; }
        .kds-stripe-warning { background: #f59e0b; }
        .kds-stripe-rush { background: #dc2626; box-shadow: 0 0 10px rgba(220, 38, 38, 0.4); }

        .kds-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
