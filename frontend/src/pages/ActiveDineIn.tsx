import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw, UtensilsCrossed, Pencil, CreditCard, Ban } from 'lucide-react';
import { get, post, getUserMessage } from '../api';
import { formatCurrency } from '../utils/formatCurrency';
import { showConfirm } from '../components/ConfirmDialog';

type ActiveSale = {
  id: number;
  branch_id: number;
  total_amount: number;
  created_at: string;
  status: string;
  order_type: string | null;
  table_name?: string | null;
  order_snapshot?: { table_name?: string } | null;
  kitchen_status: string;
};

export default function ActiveDineIn() {
  const navigate = useNavigate();
  const [sales, setSales] = useState<ActiveSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [payModalSale, setPayModalSale] = useState<ActiveSale | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'Card' | 'Cash' | 'Online Transfer'>('Card');
  const [paySubmitting, setPaySubmitting] = useState(false);

  // Modification modal state
  const [modifyModalSale, setModifyModalSale] = useState<ActiveSale | null>(null);
  const [modificationType, setModificationType] = useState<'add'|'remove'|'update'>('add');
  const [modificationText, setModificationText] = useState('');
  const [modSubmitting, setModSubmitting] = useState(false);

  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const q = user?.role === 'owner' ? `?branch_id=${activeBranchId}` : '';
      const data = await get<{ sales?: ActiveSale[] }>(`/orders/active${q}`);
      setSales(data.sales ?? []);
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
    const id = setInterval(() => void load(), 8000);
    return () => clearInterval(id);
  }, [load]);

  const tableLabel = (s: ActiveSale) =>
    s.table_name || s.order_snapshot?.table_name || '—';

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
      message: `Cancel order #${s.id} for table ${tableLabel(s)} and restore stock?`,
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

  const openModifyModal = (s: ActiveSale) => {
    setModifyModalSale(s);
    setModificationType('add');
    setModificationText('');
  };

  const submitModification = async () => {
    if (!modifyModalSale || !modificationText.trim()) return;
    setModSubmitting(true);
    try {
      await post(`/orders/${modifyModalSale.id}/modifications`, {
        type: modificationType,
        description: modificationText.trim()
      });
      setModifyModalSale(null);
      setModificationText('');
    } catch (e) {
      setError(getUserMessage(e));
    } finally {
      setModSubmitting(false);
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
            <h1 className="text-2xl font-bold text-neutral-900 truncate">Active dine-in orders</h1>
            <p className="text-sm text-neutral-500">Open tabs after KOT — take payment or change items on the Order screen.</p>
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

      {loading && sales.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-neutral-400 gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : sales.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-neutral-400 gap-2 py-16">
          <UtensilsCrossed className="w-14 h-14 opacity-40" />
          <p className="text-lg font-medium text-neutral-500">No active dine-in orders</p>
          <p className="text-sm text-neutral-400">Send a KOT from Order → Dine in to open a table tab.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sales.map(s => (
              <li
                key={s.id}
                className="glass-card rounded-2xl p-4 flex flex-col gap-3 border border-white/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">Table</p>
                    <p className="text-xl font-bold text-neutral-900">{tableLabel(s)}</p>
                  </div>
                  <span className="text-xs font-mono text-neutral-400">#{s.id}</span>
                </div>
                {['preparing', 'ready', 'served'].includes(s.kitchen_status) && (
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-bold uppercase w-fit">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Kitchen is {s.kitchen_status}
                  </div>
                )}
                <div className="text-sm text-neutral-600">
                  <span className="text-neutral-500">Subtotal </span>
                  <span className="font-semibold text-neutral-900">{formatCurrency(s.total_amount)}</span>
                </div>
                <p className="text-xs text-neutral-400">
                  {new Date(s.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
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
                    onClick={() => openModifyModal(s)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl glass-card text-sm font-semibold text-brand-900 hover:bg-white/50"
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
              Take payment — Table {tableLabel(payModalSale)}
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

      {modifyModalSale && (
        <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center glass-overlay px-4 pb-8 sm:p-6">
          <div className="glass-floating rounded-t-3xl sm:rounded-2xl w-full max-w-md p-6 space-y-4 shadow-xl">
            <h2 className="text-xl font-bold text-neutral-900">Custom Modification</h2>
            <p className="text-sm text-neutral-600">Send a fast free-text request to the kitchen for Table {tableLabel(modifyModalSale)}.</p>
            
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase mb-1">Modification Type</label>
                <div className="flex bg-neutral-100/50 rounded-lg p-1">
                  {(['add', 'remove', 'update'] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setModificationType(t)}
                      className={`flex-1 py-1.5 text-sm font-semibold rounded-md transition-all ${modificationType === t ? 'bg-white shadow-sm text-brand-700' : 'text-neutral-500 hover:text-neutral-700'}`}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-semibold text-neutral-500 uppercase mb-1">Description</label>
                <textarea
                  value={modificationText}
                  onChange={e => setModificationText(e.target.value)}
                  placeholder="e.g. Add Mayo Dip, No Onions..."
                  className="w-full rounded-xl border border-neutral-200 bg-white p-3 text-sm focus:ring-brand-500 focus:border-brand-500 resize-none h-24 shadow-inner"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModifyModalSale(null)}
                className="flex-1 py-2.5 rounded-xl border border-neutral-200 font-semibold text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={modSubmitting || !modificationText.trim()}
                onClick={() => void submitModification()}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold disabled:opacity-50 shadow-md shadow-amber-600/20"
              >
                {modSubmitting ? 'Sending…' : 'Send to Kitchen'}
              </button>
            </div>
            
            <div className="pt-4 border-t border-neutral-200/60 mt-4 text-center">
              <p className="text-xs text-neutral-500 mb-2">Need to add priced menu items?</p>
              <button
                type="button"
                onClick={() => { setModifyModalSale(null); goModify(modifyModalSale); }}
                className="w-full py-2.5 rounded-xl glass-card border-brand-200 text-brand-800 text-sm font-bold hover:bg-brand-50"
              >
                Edit Cart Items
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
