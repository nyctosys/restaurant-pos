import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Loader2, RefreshCw, UtensilsCrossed, Pencil, CreditCard, Ban, ChefHat, CheckCircle2, Bell, X, ShoppingBag, Truck } from 'lucide-react';
import { get, post, patch, getUserMessage } from '../api';
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
  branch_id: string;
  total_amount: number;
  created_at: string;
  status: string;
  order_type: string | null;
  delivery_status?: 'pending' | 'assigned' | 'delivered' | null;
  assigned_rider_id?: number | null;
  kitchen_status: 'placed' | 'preparing' | 'ready' | null;
  table_name?: string | null;
  order_snapshot?: { table_name?: string; customer_name?: string; rider_name?: string } | null;
  items?: ActiveSaleLine[];
};

type OrderColumnKey = 'takeaway' | 'dine_in' | 'delivery';

const orderColumns: { key: OrderColumnKey; title: string; empty: string; Icon: LucideIcon }[] = [
  { key: 'takeaway', title: 'Takeaway', empty: 'No takeaway orders waiting.', Icon: ShoppingBag },
  { key: 'dine_in', title: 'Dine-in', empty: 'No dine-in tables open.', Icon: UtensilsCrossed },
  { key: 'delivery', title: 'Delivery', empty: 'No delivery orders active.', Icon: Truck },
];

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

function OpenOrderCard({
  sale,
  deliveringSaleId,
  onPay,
  onModify,
  onVoid,
  onDelivered,
}: {
  sale: ActiveSale;
  deliveringSaleId: number | null;
  onPay: (sale: ActiveSale) => void;
  onModify: (sale: ActiveSale) => void;
  onVoid: (sale: ActiveSale) => void;
  onDelivered: (sale: ActiveSale) => void;
}) {
  const modifyDisabled = sale.kitchen_status === 'preparing' || sale.kitchen_status === 'ready';
  const riderLabel = deliveryRiderLabel(sale);

  return (
    <li className="glass-card rounded-xl p-3 flex flex-col gap-2 border border-white/40 min-h-[210px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">{orderKindLabel(sale)}</p>
          <p className="text-base font-bold text-neutral-900 truncate">{orderLabel(sale)}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-xs font-mono text-neutral-400">#{sale.id}</span>
          {sale.kitchen_status === 'ready' && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
              <CheckCircle2 className="w-3 h-3" /> Ready
            </span>
          )}
          {sale.kitchen_status === 'preparing' && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
              <ChefHat className="w-3 h-3" /> Preparing
            </span>
          )}
        </div>
      </div>
      <div className="text-xs text-neutral-600">
        {riderLabel && (
          <p className="mb-1 text-xs font-semibold text-brand-700">Rider: {riderLabel}</p>
        )}
        <span className="text-neutral-500">Subtotal </span>
        <span className="font-semibold text-neutral-900">{formatCurrency(sale.total_amount)}</span>
      </div>
      <p className="text-[11px] text-neutral-400">
        {new Date(sale.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
      </p>
      {sale.items && sale.items.length > 0 && (
        <div className="rounded-lg bg-white/35 border border-white/40 px-2.5 py-2 space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Items to prepare
          </p>
          <div className="space-y-1.5 max-h-[min(26vh,180px)] overflow-y-auto pr-0.5">
            {sale.items.map((line, idx) => (
              <div
                key={`${sale.id}-${line.id}-${idx}`}
                className="border-b border-black/5 pb-1.5 last:border-0 last:pb-0"
              >
                <div className="flex gap-2 items-start">
                  <span className="shrink-0 min-w-[2rem] text-center text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-900">
                    {line.quantity}x
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-neutral-900 leading-tight">
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
                  <div className="pl-8 mt-1.5 space-y-1">
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
      <div className="flex flex-wrap gap-1.5 pt-2 mt-auto border-t border-white/25 shrink-0">
        <button
          type="button"
          onClick={() => onPay(sale)}
          disabled={sale.status !== 'open'}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-brand-700 text-white text-xs font-semibold hover:bg-brand-600"
        >
          <CreditCard className="w-3.5 h-3.5" />
          {sale.status === 'open' ? 'Pay' : 'Paid'}
        </button>
        <button
          type="button"
          onClick={() => onModify(sale)}
          disabled={modifyDisabled}
          title={modifyDisabled ? 'Cannot modify — kitchen is already working on this order' : 'Modify order'}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg glass-card text-xs font-semibold text-brand-900 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
        >
          <Pencil className="w-3.5 h-3.5" />
          Modify
        </button>
        <button
          type="button"
          onClick={() => onVoid(sale)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-700 text-xs font-semibold hover:bg-red-50"
        >
          <Ban className="w-3.5 h-3.5" />
          Void
        </button>
        {sale.order_type === 'delivery' && sale.delivery_status === 'assigned' && sale.assigned_rider_id ? (
          <button
            type="button"
            onClick={() => onDelivered(sale)}
            disabled={deliveringSaleId === sale.id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-200 text-emerald-700 text-xs font-semibold hover:bg-emerald-50 disabled:opacity-60"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            {deliveringSaleId === sale.id ? 'Updating…' : 'Delivered'}
          </button>
        ) : null}
      </div>
    </li>
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
  const [deliveringSaleId, setDeliveringSaleId] = useState<number | null>(null);
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


  const groupedSales = useMemo(() => {
    const grouped: Record<OrderColumnKey, ActiveSale[]> = {
      takeaway: [],
      dine_in: [],
      delivery: [],
    };
    for (const sale of sales) {
      const key = sale.order_type === 'takeaway' || sale.order_type === 'delivery' ? sale.order_type : 'dine_in';
      grouped[key].push(sale);
    }
    return grouped;
  }, [sales]);

  const totalByColumn = useMemo(() => {
    const totals: Record<OrderColumnKey, number> = {
      takeaway: 0,
      dine_in: 0,
      delivery: 0,
    };
    for (const column of orderColumns) {
      totals[column.key] = groupedSales[column.key].reduce((sum, sale) => sum + sale.total_amount, 0);
    }
    return totals;
  }, [groupedSales]);

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

  const handleDelivered = async (sale: ActiveSale) => {
    if (deliveringSaleId === sale.id) return;
    setDeliveringSaleId(sale.id);
    const previousSales = sales;
    setSales(prev => prev.filter(item => item.id !== sale.id));
    try {
      await patch(`/orders/${sale.id}/delivery-complete`, {});
      await load();
    } catch (e) {
      setSales(previousSales);
      setError(getUserMessage(e));
    } finally {
      setDeliveringSaleId(null);
    }
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
        <div className="flex-1 min-h-0 overflow-auto pb-2">
          <div className="grid gap-4 lg:grid-cols-3 items-start min-w-0">
            {orderColumns.map(({ key, title, empty, Icon }) => (
              <section key={key} className="min-w-0 rounded-2xl border border-white/45 bg-white/25 backdrop-blur-xl p-2.5">
                <div className="flex items-start justify-between gap-3 mb-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-9 h-9 rounded-xl bg-white/65 border border-white/70 flex items-center justify-center shrink-0">
                      <Icon className="w-[18px] h-[18px] text-brand-800" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-base font-bold text-neutral-900 truncate">{title}</h2>
                      <p className="text-xs font-semibold text-neutral-500">
                        {groupedSales[key].length} {groupedSales[key].length === 1 ? 'order' : 'orders'}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm font-bold tabular-nums text-neutral-900 shrink-0">
                    {formatCurrency(totalByColumn[key])}
                  </p>
                </div>

                {groupedSales[key].length === 0 ? (
                  <div className="min-h-[180px] rounded-xl border border-dashed border-white/70 bg-white/25 flex flex-col items-center justify-center text-center px-4 py-6 text-neutral-500">
                    <Icon className="w-7 h-7 opacity-40 mb-2" />
                    <p className="text-sm font-semibold">{empty}</p>
                  </div>
                ) : (
                  <ul className="space-y-2.5">
                    {groupedSales[key].map(sale => (
                      <OpenOrderCard
                        key={sale.id}
                        sale={sale}
                        deliveringSaleId={deliveringSaleId}
                        onPay={openPay}
                        onModify={goModify}
                        onVoid={saleToVoid => void handleVoid(saleToVoid)}
                        onDelivered={saleToDeliver => void handleDelivered(saleToDeliver)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
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
