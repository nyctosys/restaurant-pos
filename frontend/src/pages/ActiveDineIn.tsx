import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw, UtensilsCrossed, Pencil, CreditCard, Ban, ChefHat, CheckCircle2, Bell, X } from 'lucide-react';
import { get, post, getUserMessage } from '../api';
import { getSocket } from '../realtime/socket';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import { formatCurrency } from '../utils/formatCurrency';
import { showConfirm } from '../components/ConfirmDialog';

type ActiveSaleLine = {
  id: number;
  product_title: string;
  variant_sku_suffix?: string;
  quantity: number;
  is_deal?: boolean;
  modifiers?: string[];
  children?: ActiveSaleLine[];
};

type ActiveSale = {
  id: number;
  branch_id: number;
  total_amount: number;
  created_at: string;
  status: string;
  order_type: string | null;
  kitchen_status: 'placed' | 'preparing' | 'ready' | null;
  table_name?: string | null;
  order_snapshot?: { table_name?: string; customer_name?: string; rider_name?: string } | null;
  items?: ActiveSaleLine[];
};

function ModifierPills({ modifiers }: { modifiers?: string[] }) {
  if (!modifiers || modifiers.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {modifiers.map((mod, idx) => (
        <span
          key={`${mod}-${idx}`}
          className="text-[10px] px-1.5 py-0.5 rounded-sm bg-brand-50 text-brand-800 border border-brand-100"
        >
          + {mod}
        </span>
      ))}
    </div>
  );
}

export default function ActiveDineIn() {
  const navigate = useNavigate();
  const [sales, setSales] = useState<ActiveSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payModalSale, setPayModalSale] = useState<ActiveSale | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'Card' | 'Cash' | 'Online Transfer'>('Card');
  const [paySubmitting, setPaySubmitting] = useState(false);
  const [readyAlerts, setReadyAlerts] = useState<{ id: string; sale_id: number; label: string }[]>([]);

  const terminalBranchId = getTerminalBranchIdString(parseUserFromStorage());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = terminalBranchId
        ? `?branch_id=${terminalBranchId}&include_items=1`
        : '?include_items=1';
      const data = await get<{ sales?: ActiveSale[] }>(`/orders/active${q}`);
      setSales(data.sales ?? []);
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setLoading(false);
    }
  }, [terminalBranchId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Real-time: update kitchen_status on ORDER_STATUS_CHANGED without full reload
  useEffect(() => {
    const s = getSocket();
    const onStatusChanged = (payload: { sale_id?: number; kitchen_status?: string }) => {
      if (!payload?.sale_id) return;
      setSales(prev =>
        prev.map(sale =>
          sale.id === payload.sale_id
            ? { ...sale, kitchen_status: (payload.kitchen_status as ActiveSale['kitchen_status']) ?? sale.kitchen_status }
            : sale
        )
      );
    };
    const onOrderReady = (payload: { sale_id?: number; table_name?: string | null }) => {
      if (!payload?.sale_id) return;
      const label = payload.table_name
        ? `Table ${payload.table_name} · #${payload.sale_id}`
        : `Order #${payload.sale_id}`;
      const alertId = `${Date.now()}_${payload.sale_id}`;
      setReadyAlerts(prev => [{ id: alertId, sale_id: payload.sale_id!, label }, ...prev]);
      // Auto-dismiss after 60 s
      setTimeout(() => setReadyAlerts(prev => prev.filter(a => a.id !== alertId)), 60_000);
      // Also refresh the card to show 'Ready' badge
      void load();
    };
    s.on('ORDER_STATUS_CHANGED', onStatusChanged);
    s.on('order_ready', onOrderReady);
    return () => {
      s.off('ORDER_STATUS_CHANGED', onStatusChanged);
      s.off('order_ready', onOrderReady);
    };
  }, [sales, load]);


  const orderLabel = (s: ActiveSale) => {
    const ot = s.order_type || '';
    if (ot === 'takeaway') return 'Takeaway';
    if (ot === 'delivery') {
      const name = (s.order_snapshot as { customer_name?: string } | null | undefined)?.customer_name?.trim();
      return name ? `Delivery · ${name}` : 'Delivery';
    }
    return s.table_name || s.order_snapshot?.table_name || '—';
  };

  const orderKindLabel = (s: ActiveSale) => {
    const ot = s.order_type || '';
    if (ot === 'takeaway') return 'Takeaway';
    if (ot === 'delivery') return 'Delivery';
    return 'Table';
  };

  const deliveryRiderLabel = (s: ActiveSale) => {
    if ((s.order_type || '') !== 'delivery') return '';
    return (s.order_snapshot?.rider_name || '').trim();
  };

  const openPay = (s: ActiveSale) => {
    setPayModalSale(s);
    setPaymentMethod('Card');
  };

  const finalizePayment = async () => {
    if (!payModalSale) return;
    setPaySubmitting(true);
    try {
      const data = await post<{ print_success?: boolean; printSuccess?: boolean }>(
        `/orders/${payModalSale.id}/finalize`,
        {
          payment_method: paymentMethod,
          discount: null,
        }
      );
      const ok = data?.print_success !== false;
      setPayModalSale(null);
      await load();
      if (!ok) {
        setError('Payment saved, but the receipt printer reported an error.');
      }
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setPaySubmitting(false);
    }
  };

  const handleVoid = async (s: ActiveSale) => {
    const ok = await showConfirm({
      title: 'Void open order?',
      message: `Cancel order #${s.id} (${orderLabel(s)}) and restore stock?`,
      confirmLabel: 'Void order',
      cancelLabel: 'Keep',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await post(`/orders/${s.id}/cancel-open`, null);
      await load();
    } catch (e) {
      setError(getUserMessage(e));
    }
  };

  const goModify = (s: ActiveSale) => {
    navigate(`/dashboard?editOrder=${s.id}`);
  };

  return (
    <div className="flex flex-col h-full min-h-0 page-padding">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-12 h-12 rounded-2xl bg-brand-100/80 border border-brand-200 flex items-center justify-center shrink-0">
            <UtensilsCrossed className="w-6 h-6 text-brand-800" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-neutral-900 truncate">Open orders</h1>
            <p className="text-sm text-neutral-500">Unpaid KOT tabs (dine-in, takeaway, delivery) — pay or edit on Order.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl glass-card text-sm font-semibold text-brand-800 hover:bg-white/50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 text-red-800 text-sm border border-red-200 shrink-0">
          {error}
          <button type="button" className="ml-2 underline font-medium" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* ORDER READY alerts — sticky top banner */}
      {readyAlerts.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 shrink-0">
          {readyAlerts.map(alert => (
            <div
              key={alert.id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-600 text-white shadow-lg border border-emerald-400"
              role="alert"
            >
              <Bell className="w-5 h-5 shrink-0 animate-bounce" />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm">Order Ready — {alert.label}</p>
                <p className="text-xs text-emerald-100">Kitchen has finished preparing this order.</p>
              </div>
              <button
                type="button"
                onClick={() => setReadyAlerts(prev => prev.filter(a => a.id !== alert.id))}
                className="p-1 rounded-md hover:bg-emerald-500 transition-colors shrink-0"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {loading && sales.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-neutral-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : sales.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 gap-2 py-16">
          <UtensilsCrossed className="w-14 h-14 opacity-40" />
          <p className="text-lg font-medium text-neutral-500">No open orders</p>
          <p className="text-sm text-neutral-400">Send a KOT from Order (any order type) to open a tab.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 items-stretch">
            {sales.map(s => (
              <li
                key={s.id}
                className="glass-card rounded-2xl p-4 flex flex-col gap-3 border border-white/40 h-full min-h-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">{orderKindLabel(s)}</p>
                    <p className="text-xl font-bold text-neutral-900">{orderLabel(s)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs font-mono text-neutral-400">#{s.id}</span>
                    {/* Kitchen status badge */}
                    {s.kitchen_status === 'ready' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                        <CheckCircle2 className="w-3 h-3" /> Ready
                      </span>
                    )}
                    {s.kitchen_status === 'preparing' && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                        <ChefHat className="w-3 h-3" /> Preparing
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-sm text-neutral-600">
                  {deliveryRiderLabel(s) && (
                    <p className="mb-1 text-xs font-semibold text-brand-700">Rider: {deliveryRiderLabel(s)}</p>
                  )}
                  <span className="text-neutral-500">Subtotal </span>
                  <span className="font-semibold text-neutral-900">{formatCurrency(s.total_amount)}</span>
                </div>
                <p className="text-xs text-neutral-400">
                  {new Date(s.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
                {s.items && s.items.length > 0 && (
                  <div className="rounded-xl bg-white/35 border border-white/40 px-3 py-2.5 space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
                      Items to prepare
                    </p>
                    <div className="space-y-2 max-h-[min(40vh,320px)] overflow-y-auto pr-0.5">
                      {s.items.map((line, idx) => (
                        <div
                          key={`${s.id}-${line.id}-${idx}`}
                          className="border-b border-black/5 pb-2 last:border-0 last:pb-0"
                        >
                          <div className="flex gap-2 items-start">
                            <span className="shrink-0 min-w-[2rem] text-center text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-900">
                              {line.quantity}x
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-semibold text-neutral-900 leading-tight">
                                {line.product_title}{' '}
                                {line.is_deal && (
                                  <span className="text-[10px] font-bold text-amber-700">(DEAL)</span>
                                )}
                              </p>
                              {line.variant_sku_suffix && (
                                <p className="text-[11px] text-neutral-500 mt-0.5">{line.variant_sku_suffix}</p>
                              )}
                              <ModifierPills modifiers={line.modifiers} />
                            </div>
                          </div>

                          {line.children && line.children.length > 0 && (
                            <div className="pl-8 mt-2 space-y-1.5">
                              {line.children.map((child, childIdx) => (
                                <div key={`${line.id}-${child.id}-${childIdx}`} className="space-y-1">
                                  <div className="flex gap-2 items-start">
                                    <span className="shrink-0 text-[10px] font-bold text-neutral-500">
                                      {child.quantity}x
                                    </span>
                                    <div className="min-w-0">
                                      <p className="text-xs font-medium text-neutral-700">{child.product_title}</p>
                                      {child.variant_sku_suffix && (
                                        <p className="text-[10px] text-neutral-500">{child.variant_sku_suffix}</p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="pl-4">
                                    <ModifierPills modifiers={child.modifiers} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-2 mt-auto border-t border-white/25 shrink-0">
                  <button
                    type="button"
                    onClick={() => openPay(s)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-brand-700 text-white text-sm font-semibold hover:bg-brand-600"
                  >
                    <CreditCard className="w-4 h-4" />
                    Pay
                  </button>
                  <button
                    type="button"
                    onClick={() => goModify(s)}
                    disabled={s.kitchen_status === 'preparing' || s.kitchen_status === 'ready'}
                    title={s.kitchen_status === 'preparing' || s.kitchen_status === 'ready' ? 'Cannot modify — kitchen is already working on this order' : 'Modify order'}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl glass-card text-sm font-semibold text-brand-900 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                  >
                    <Pencil className="w-4 h-4" />
                    Modify
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleVoid(s)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-200 text-red-700 text-sm font-semibold hover:bg-red-50"
                  >
                    <Ban className="w-4 h-4" />
                    Void
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {payModalSale && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center glass-overlay px-4 pb-8 sm:p-6">
          <div
            className="glass-floating rounded-t-3xl sm:rounded-2xl w-full max-w-md p-6 space-y-4"
            role="dialog"
            aria-labelledby="pay-modal-title"
          >
            <h2 id="pay-modal-title" className="text-lg font-bold text-neutral-900">
              Take payment — {orderLabel(payModalSale)}
            </h2>
            <p className="text-sm text-neutral-600">
              Order #{payModalSale.id} · {formatCurrency(payModalSale.total_amount)} subtotal (tax applied on confirm)
            </p>
            <div>
              <p className="text-xs font-semibold text-neutral-500 uppercase mb-2">Payment method</p>
              <div className="grid grid-cols-3 gap-2">
                {(['Cash', 'Card', 'Online Transfer'] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaymentMethod(m)}
                    className={`py-2 px-1 rounded-xl border-2 text-xs font-bold ${
                      paymentMethod === m ? 'border-brand-500 bg-brand-50' : 'border-neutral-200 hover:border-brand-300'
                    }`}
                  >
                    {m === 'Online Transfer' ? 'Online' : m}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayModalSale(null)}
                className="flex-1 py-3 rounded-xl border border-neutral-200 font-semibold text-neutral-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={paySubmitting}
                onClick={() => void finalizePayment()}
                className="flex-1 py-3 rounded-xl bg-brand-700 text-white font-bold disabled:opacity-50"
              >
                {paySubmitting ? 'Processing…' : 'Confirm payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
