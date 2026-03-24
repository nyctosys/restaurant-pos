import { useState, useEffect } from 'react';
import { X, Printer, RotateCcw, Loader2, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { showToast } from './Toast';
import { showConfirm } from './ConfirmDialog';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, patch, del, getUserMessage } from '../api';

type SaleItem = {
  id: number;
  product_id: number;
  product_title: string;
  variant_sku_suffix: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
};

type OrderSnapshot = {
  table_name?: string;
  customer_name?: string;
  phone?: string;
  address?: string;
};

type TransactionDetails = {
  id: number;
  user_id: number;
  operator_name: string;
  branch_id: number;
  total_amount: number;
  tax_amount: number;
  payment_method: string;
  created_at: string;
  status: string;
  items: SaleItem[];
  archived_at?: string | null;
  order_type?: string | null;
  order_snapshot?: OrderSnapshot | null;
};

type Props = {
  saleId: number;
  onClose: () => void;
  onRefresh: () => void;
  canArchive?: boolean;
  canDeletePermanent?: boolean;
};

export default function TransactionDetailsModal({ saleId, onClose, onRefresh, canArchive = true, canDeletePermanent = false }: Props) {
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<'rollback' | 'print' | 'archive' | 'unarchive' | 'delete' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);

  const fetchDetails = async () => {
    try {
      setLoading(true);
      setError('');
      const data = await get<TransactionDetails>(`/orders/${saleId}`);
      setDetails(data ?? null);
    } catch (err) {
      setError(getUserMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRollback = async () => {
    const confirmed = await showConfirm({
      title: 'Rollback Transaction',
      message: 'Are you certain you want to rollback this transaction? This will refund the amount and return items to inventory.',
      confirmLabel: 'Yes, Rollback',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });
    
    if (!confirmed) return;
    
    try {
      setActionLoading('rollback');
      setError('');
      await post(`/orders/${saleId}/rollback`, null);
      showToast('Transaction rolled back successfully.', 'success');
      onRefresh();
      onClose();
    } catch (err) {
      const msg = getUserMessage(err);
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handlePrint = async () => {
    try {
      setActionLoading('print');
      setError('');
      await post(`/orders/${saleId}/print`, null);
      showToast('Receipt sent to printer.', 'success');
    } catch (err) {
      const msg = getUserMessage(err);
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleArchive = async () => {
    try {
      setActionLoading('archive');
      setError('');
      await patch(`/orders/${saleId}/archive`, null);
      showToast('Transaction archived.', 'success');
      fetchDetails();
      onRefresh();
    } catch (err) {
      setError(getUserMessage(err));
      showToast(getUserMessage(err), 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnarchive = async () => {
    try {
      setActionLoading('unarchive');
      setError('');
      await patch(`/orders/${saleId}/unarchive`, null);
      showToast('Transaction restored.', 'success');
      fetchDetails();
      onRefresh();
    } catch (err) {
      setError(getUserMessage(err));
      showToast(getUserMessage(err), 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const orderTypeLabel = (t: string | null | undefined) => {
    if (!t) return null;
    const labels: Record<string, string> = { takeaway: 'Takeaway', dine_in: 'Dine-in', delivery: 'Delivery' };
    return labels[t] ?? t;
  };

  const handlePermanentDelete = async () => {
    const confirmed = await showConfirm({
      title: 'Permanently delete transaction?',
      message: `Transaction #${saleId} and all its line items will be removed forever. This cannot be undone.`,
      relatedEffects: ['All line items for this transaction will be deleted.'],
      confirmLabel: 'Delete permanently',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      setActionLoading('delete');
      setError('');
      await del(`/orders/${saleId}`);
      showToast('Transaction deleted permanently.', 'success');
      onRefresh();
      onClose();
    } catch (err) {
      setError(getUserMessage(err));
      showToast(getUserMessage(err), 'error');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center glass-overlay p-4 lg:p-6">
      <div className="glass-floating w-full max-w-2xl xl:max-w-4xl mx-auto overflow-hidden flex flex-col max-h-[min(92vh,900px)] animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 lg:px-6 py-4 border-b border-white/20 bg-white/20 shrink-0">
          <h3 className="text-lg font-bold text-soot-900 flex items-center gap-2">
            Transaction #{saleId}
            {details?.status === 'open' && (
              <span className="text-xs font-bold bg-sky-100 text-sky-800 px-2 py-0.5 rounded border border-sky-200">
                OPEN TAB
              </span>
            )}
            {details?.status === 'refunded' && (
              <span className="text-xs font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded border border-red-200">
                REFUNDED
              </span>
            )}
            {details?.archived_at && (
              <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200">
                ARCHIVED
              </span>
            )}
          </h3>
          <button type="button" onClick={onClose} className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg hover:bg-soot-200 transition-colors" aria-label="Close">
            <X className="w-5 h-5 text-soot-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 lg:p-6 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm font-medium">
              {error}
            </div>
          )}

          {loading || !details ? (
            <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Fetching details...
            </div>
          ) : (
            <div className="space-y-6">
              {/* Meta info */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 bg-white/20 p-4 rounded-xl border border-white/20">
                <div>
                  <p className="text-xs font-semibold text-soot-500 uppercase">Date</p>
                  <p className="text-sm font-medium text-soot-900 mt-0.5">
                    {new Date(details.created_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-soot-500 uppercase">Operator</p>
                  <p className="text-sm font-medium text-soot-900 mt-0.5">{details.operator_name}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-soot-500 uppercase">Method</p>
                  <p className="text-sm font-medium text-soot-900 mt-0.5">
                    {details.status === 'open' ? '— (pending)' : details.payment_method}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-soot-500 uppercase">Total</p>
                  <p className="text-sm font-bold text-gold-600 mt-0.5">{formatCurrency(details.total_amount)}</p>
                </div>
              </div>

              {/* Order type / table / delivery */}
              {(details.order_type || details.order_snapshot) && (
                <div className="bg-white/20 p-4 rounded-xl border border-white/20 space-y-2">
                  <h4 className="text-sm font-bold text-soot-900">Order</h4>
                  {details.order_type && (
                    <p className="text-sm text-soot-800">
                      <span className="text-soot-500">Type: </span>
                      {orderTypeLabel(details.order_type) ?? details.order_type}
                    </p>
                  )}
                  {details.order_type === 'dine_in' && details.order_snapshot?.table_name && (
                    <p className="text-sm text-soot-800">
                      <span className="text-soot-500">Table: </span>
                      {details.order_snapshot.table_name}
                    </p>
                  )}
                  {details.order_type === 'delivery' && details.order_snapshot && (
                    <div className="text-sm text-soot-800 space-y-1">
                      {details.order_snapshot.customer_name && (
                        <p>
                          <span className="text-soot-500">Customer: </span>
                          {details.order_snapshot.customer_name}
                        </p>
                      )}
                      {details.order_snapshot.phone && (
                        <p>
                          <span className="text-soot-500">Phone: </span>
                          {details.order_snapshot.phone}
                        </p>
                      )}
                      {details.order_snapshot.address && (
                        <p>
                          <span className="text-soot-500">Address: </span>
                          {details.order_snapshot.address}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Items */}
              <div>
                <h4 className="text-sm font-bold text-soot-900 mb-3 border-b border-soot-100 pb-2">Items</h4>
                <div className="space-y-3">
                  {(details?.items ?? []).map(item => (
                    <div key={item.id} className="flex items-center justify-between text-sm">
                      <div className="flex-1">
                        <p className="font-medium text-soot-800">
                          {item.product_title} 
                          {item.variant_sku_suffix && <span className="ml-2 text-xs font-bold bg-soot-100 px-1.5 py-0.5 rounded text-soot-600">{item.variant_sku_suffix}</span>}
                        </p>
                        <p className="text-soot-500 text-xs mt-0.5">{formatCurrency(item.unit_price)} &times; {item.quantity}</p>
                      </div>
                      <div className="font-semibold text-soot-900">
                        {formatCurrency(item.subtotal)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="border-t border-soot-200 pt-4 flex flex-col items-end text-sm">
                <div className="flex justify-between w-48 mb-1">
                  <span className="text-soot-500">Tax</span>
                  <span className="font-medium text-soot-800">{formatCurrency(details.tax_amount)}</span>
                </div>
                <div className="flex justify-between w-48 items-center border-t border-soot-100 pt-2 mt-1">
                  <span className="font-bold text-soot-900">Total</span>
                  <span className="font-bold text-lg text-gold-600">{formatCurrency(details.total_amount)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 lg:px-6 py-4 bg-white/20 border-t border-white/20 flex flex-wrap justify-end gap-2 lg:gap-3 shrink-0">
          <button
            type="button"
            onClick={handlePrint}
            disabled={loading || actionLoading !== null || details?.status === 'open'}
            className="flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 bg-white border border-soot-300 rounded-lg text-sm font-medium text-soot-700 hover:bg-soot-100 disabled:opacity-50 transition-colors"
          >
            {actionLoading === 'print' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
            Print
          </button>
          {canArchive && (
            details?.archived_at ? (
              <button type="button" onClick={handleUnarchive} disabled={loading || actionLoading !== null} className="flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">
                {actionLoading === 'unarchive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArchiveRestore className="w-4 h-4" />}
                Restore
              </button>
            ) : (
              <button type="button" onClick={handleArchive} disabled={loading || actionLoading !== null} className="flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors">
                {actionLoading === 'archive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                Archive
              </button>
            )
          )}
          {canDeletePermanent && (
            <button type="button" onClick={handlePermanentDelete} disabled={loading || actionLoading !== null} className="flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 bg-white border border-red-300 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors">
              {actionLoading === 'delete' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete permanently
            </button>
          )}
          <button
            type="button"
            onClick={handleRollback}
            disabled={loading || details?.status === 'refunded' || details?.status === 'open' || actionLoading !== null}
            className="flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:bg-neutral-300 disabled:text-neutral-500 transition-colors"
          >
            {actionLoading === 'rollback' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            {details?.status === 'refunded' ? 'Already Refunded' : details?.status === 'open' ? 'Finalize payment first' : 'Rollback'}
          </button>
        </div>
      </div>
    </div>
  );
}
