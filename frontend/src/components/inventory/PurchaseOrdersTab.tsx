import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, ArrowRightCircle, CheckCircle2, PackageCheck, Ban, History } from 'lucide-react';
import { get, post, getUserMessage } from '../../api';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import { formatCurrency } from '../../utils/formatCurrency';
import SearchableSelect from '../SearchableSelect';

type Supplier = { id: number; name: string };
type Ingredient = { id: number; name: string; unit: string; last_purchase_price: number };

type POItem = {
  ingredient_id: number;
  quantity_ordered: number;
  quantity_received?: number;
  quantity_remaining?: number;
  unit_price: number;
  unit: string;
};

type PurchaseOrderItem = POItem & {
  id: number;
  ingredient_name: string | null;
  quantity_received: number;
  quantity_remaining: number;
};

type PurchaseOrder = {
  id: number;
  po_number: string;
  supplier_id: number;
  status: 'draft' | 'sent' | 'partially_received' | 'received' | 'cancelled';
  total_amount: number;
  expected_delivery: string | null;
  received_date: string | null;
  created_at: string;
  items?: PurchaseOrderItem[];
};

export default function PurchaseOrdersTab() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);

  // Form State
  const [showModal, setShowModal] = useState(false);
  const [formSupplierId, setFormSupplierId] = useState('');
  const [formExpectedDate, setFormExpectedDate] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formItems, setFormItems] = useState<POItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [partialReceivePo, setPartialReceivePo] = useState<PurchaseOrder | null>(null);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<number, string>>({});
  const [receiving, setReceiving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [poRes, supRes, ingRes] = await Promise.all([
        get<{ purchase_orders: PurchaseOrder[] }>('/inventory-advanced/purchase-orders'),
        get<{ suppliers: Supplier[] }>('/inventory-advanced/suppliers'),
        get<{ ingredients: Ingredient[] }>('/inventory-advanced/ingredients')
      ]);
      setPos(poRes.purchase_orders || []);
      setSuppliers(supRes.suppliers || []);
      setIngredients(ingRes.ingredients || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenAdd = () => {
    setFormSupplierId('');
    setFormExpectedDate('');
    setFormNotes('');
    setFormItems([]);
    setShowModal(true);
  };

  const handleAddItem = () => {
    setFormItems([...formItems, { ingredient_id: 0, quantity_ordered: 1, unit_price: 0, unit: 'kg' }]);
  };

  const handleUpdateItem = (index: number, field: keyof POItem, value: string | number) => {
    const newItems = [...formItems];
    newItems[index] = { ...newItems[index], [field]: value };
    
    // Auto-fill unit and price if ingredient selected
    if (field === 'ingredient_id') {
      const ing = ingredients.find(i => i.id === value);
      if (ing) {
        newItems[index].unit = ing.unit;
        newItems[index].unit_price = ing.last_purchase_price || 0;
      }
    }
    setFormItems(newItems);
  };

  const handleRemoveItem = (index: number) => {
    setFormItems(formItems.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formSupplierId) {
      showToast('Select a supplier', 'error');
      return;
    }
    if (formItems.length === 0) {
      showToast('Add at least one item', 'error');
      return;
    }
    if (formItems.some(i => i.ingredient_id === 0 || i.quantity_ordered <= 0)) {
      showToast('Complete all item fields correctly', 'error');
      return;
    }

    setSubmitting(true);
    try {
      await post('/inventory-advanced/purchase-orders', {
        supplier_id: parseInt(formSupplierId, 10),
        expected_delivery: formExpectedDate ? new Date(formExpectedDate).toISOString() : undefined,
        notes: formNotes || undefined,
        items: formItems
      });
      showToast('Purchase Order created', 'success');
      setShowModal(false);
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReceive = async (po: PurchaseOrder) => {
    const confirmed = await showConfirm({
      title: 'Was the complete order received?',
      message: `Confirm if every pending item on ${po.po_number} has arrived. This will update ingredient stock and costs for the full remaining order.`,
      confirmLabel: 'Yes, receive all',
      cancelLabel: 'No, enter quantities',
      variant: 'default'
    });
    if (!confirmed) {
      const quantities = Object.fromEntries(
        (po.items || [])
          .filter(item => (item.quantity_remaining ?? item.quantity_ordered) > 0)
          .map(item => [item.id, ''])
      );
      setReceiveQuantities(quantities);
      setPartialReceivePo(po);
      return;
    }

    try {
      await post(`/inventory-advanced/purchase-orders/${po.id}/receive`, {
        received_date: new Date().toISOString()
      });
      showToast('Stock updated successfully', 'success');
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const handleSubmitPartialReceive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partialReceivePo) return;

    const items = (partialReceivePo.items || [])
      .map(item => {
        const quantity = parseFloat(receiveQuantities[item.id] || '0') || 0;
        return { item, quantity };
      })
      .filter(({ quantity }) => quantity > 0);

    if (items.length === 0) {
      showToast('Enter at least one received quantity', 'error');
      return;
    }

    const invalid = items.find(({ item, quantity }) => quantity > (item.quantity_remaining ?? item.quantity_ordered));
    if (invalid) {
      showToast(`Received quantity for ${invalid.item.ingredient_name || 'item'} is more than the remaining order`, 'error');
      return;
    }

    setReceiving(true);
    try {
      await post(`/inventory-advanced/purchase-orders/${partialReceivePo.id}/receive`, {
        received_date: new Date().toISOString(),
        items: items.map(({ item, quantity }) => ({
          item_id: item.id,
          quantity_received: quantity
        }))
      });
      showToast('Received stock updated', 'success');
      setPartialReceivePo(null);
      setReceiveQuantities({});
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setReceiving(false);
    }
  };

  const handleCancel = async (po: PurchaseOrder) => {
    const confirmed = await showConfirm({
      title: 'Cancel Purchase Order',
      message: `Are you sure you want to cancel ${po.po_number}? This action cannot be undone.`,
      confirmLabel: 'Yes, cancel PO',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await post(`/inventory-advanced/purchase-orders/${po.id}/cancel`, {});
      showToast('PO cancelled', 'success');
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'received': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'partially_received': return 'bg-amber-100 text-amber-800 border-amber-200';
      case 'draft': return 'bg-neutral-100 text-neutral-700 border-neutral-200';
      case 'sent': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'cancelled': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-soot-100 text-soot-700 border-soot-200';
    }
  };

  const getStatusLabel = (status: string) => {
    if (status === 'partially_received') return 'partial';
    return status;
  };

  const formatQuantity = (value: number) => Number(value || 0).toLocaleString('en-PK', {
    maximumFractionDigits: 3
  });

  const completedPos = pos.filter(po => po.status === 'received');
  const activePos = pos.filter(po => po.status !== 'received');
  const visiblePos = showCompleted ? completedPos : activePos;
  const emptyTitle = showCompleted ? 'No completed purchase orders' : 'No active purchase orders';
  const emptyMessage = showCompleted
    ? 'Received purchase orders will appear here for tracking.'
    : 'Create a PO to restock your ingredients.';

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent py-4">
      <div className="page-padding flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 bg-transparent shrink-0 pb-4">
        <h3 className="text-xl font-bold text-soot-900">
          {showCompleted ? 'Completed Purchase Orders' : 'Purchase Orders'}
        </h3>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={() => setShowCompleted(prev => !prev)}
            className="flex items-center gap-2 border border-soot-200/70 bg-white/45 text-soot-700 px-4 py-2 rounded-lg font-medium hover:bg-white/70 touch-target transition-colors"
          >
            {showCompleted ? <PackageCheck className="w-4 h-4" /> : <History className="w-4 h-4" />}
            {showCompleted ? 'Active POs' : 'Completed POs'}
            {!showCompleted && completedPos.length > 0 && (
              <span className="min-w-5 rounded-full bg-soot-900/10 px-1.5 text-xs font-bold text-soot-700">
                {completedPos.length}
              </span>
            )}
          </button>
          <button
            onClick={handleOpenAdd}
            className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors"
          >
            <Plus className="w-4 h-4" />
            Create PO
          </button>
        </div>
      </div>

      <div className="page-padding flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading orders...
          </div>
        ) : visiblePos.length === 0 ? (
           <div className="text-center py-20 text-soot-400">
             <div className="w-16 h-16 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-4">
               <PackageCheck className="w-8 h-8 text-soot-300" />
             </div>
             <p className="text-lg font-medium mb-1">{emptyTitle}</p>
             <p className="text-sm">{emptyMessage}</p>
           </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {visiblePos.map(po => {
              const supplier = suppliers.find(s => s.id === po.supplier_id);
              const remainingCount = (po.items || []).filter(item => item.quantity_remaining > 0).length;
              return (
                 <div key={po.id} className="glass-card p-5 relative group flex flex-col justify-between hover:bg-white/40 transition-colors">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h4 className="text-lg font-bold font-mono text-soot-900 leading-tight">{po.po_number}</h4>
                        <p className="text-sm font-medium text-soot-600 mt-0.5">{supplier?.name || "Unknown Supplier"}</p>
                      </div>
                      <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border ${getStatusColor(po.status)}`}>
                        {getStatusLabel(po.status)}
                      </span>
                    </div>
                    
                    <div className="space-y-1 mb-4">
                      <p className="text-sm text-soot-600 flex justify-between">
                         <span className="text-soot-400">Total:</span>
                         <span className="font-semibold text-soot-800">{formatCurrency(po.total_amount)}</span>
                      </p>
                      <p className="text-sm text-soot-600 flex justify-between">
                         <span className="text-soot-400">Date:</span>
                         <span>{new Date(po.created_at).toLocaleDateString()}</span>
                      </p>
                      {po.status === 'partially_received' && (
                        <p className="text-sm text-soot-600 flex justify-between">
                           <span className="text-soot-400">Remaining:</span>
                           <span className="font-semibold text-amber-700">{remainingCount} item{remainingCount === 1 ? '' : 's'}</span>
                        </p>
                      )}
                    </div>
                    
                    <div className="pt-3 border-t border-soot-200/50 flex justify-end gap-2">
                      {po.status === 'cancelled' ? (
                        <span className="flex items-center gap-1.5 text-sm font-medium text-red-600 px-3 py-1.5 rounded-md bg-red-50 border border-red-100/50">
                          <Ban className="w-4 h-4" /> Cancelled
                        </span>
                      ) : po.status !== 'received' ? (
                        <>
                          <button 
                            onClick={() => handleCancel(po)}
                            className="flex items-center gap-1.5 text-sm font-semibold text-red-600 hover:text-red-700 transition-colors hover:bg-red-50 px-2 py-1.5 rounded-md"
                            title="Cancel Order"
                          >
                            <Ban className="w-4 h-4" /> Cancel
                          </button>
                          <button 
                            onClick={() => handleReceive(po)}
                            className="flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800 transition-colors bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-md"
                          >
                            <ArrowRightCircle className="w-4 h-4" /> Receive Stock
                          </button>
                        </>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 px-3 py-1.5 rounded-md bg-emerald-50 border border-emerald-100/50">
                          <CheckCircle2 className="w-4 h-4" /> Stock Updated
                        </span>
                      )}
                    </div>
                 </div>
              );
            })}
          </div>
        )}
      </div>

      {showModal && (
         <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
           <div className="glass-floating w-full max-w-2xl my-auto flex flex-col max-h-[90vh] overflow-hidden">
             <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
                <h3 className="text-lg font-bold text-neutral-900">Create Purchase Order</h3>
                <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                  <X className="w-5 h-5 text-neutral-500" />
                </button>
             </div>

             <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
               <div className="p-6 overflow-y-auto space-y-6">
                 
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                   <div>
                     <label className="block text-sm font-medium text-neutral-700 mb-1">Supplier <span className="text-red-400">*</span></label>
                     <SearchableSelect
                       value={formSupplierId}
                       onChange={setFormSupplierId}
                       placeholder="— Select supplier —"
                       searchPlaceholder="Search suppliers…"
                       options={suppliers.map((supplier) => ({ value: String(supplier.id), label: supplier.name }))}
                       className="glass-card border-0 pr-4"
                     />
                   </div>
                   <div>
                     <label className="block text-sm font-medium text-neutral-700 mb-1">Expected Delivery</label>
                     <input type="date" value={formExpectedDate} onChange={e => setFormExpectedDate(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none text-soot-700 font-medium" />
                   </div>
                 </div>

                 <div>
                   <div className="flex items-center justify-between mb-2">
                     <label className="block text-sm font-medium text-neutral-700">Order Items <span className="text-red-400">*</span></label>
                     <button type="button" onClick={handleAddItem} className="text-sm font-medium text-brand-700 hover:bg-brand-50 px-2 py-1 rounded transition-colors">+ Add row</button>
                   </div>
                   
                   {formItems.length === 0 ? (
                     <div className="p-4 border-2 border-dashed border-soot-200 rounded-lg text-center text-soot-400 text-sm">
                       No items added yet. Click "+ Add row".
                     </div>
                   ) : (
                     <div className="space-y-2">
                       {formItems.map((item, idx) => (
                         <div key={idx} className="flex flex-wrap sm:flex-nowrap gap-2 items-center bg-white/40 p-2 rounded-lg border border-soot-200">
                            <div className="flex-1 min-w-[120px]">
                              <SearchableSelect
                                value={item.ingredient_id ? String(item.ingredient_id) : ''}
                                onChange={(value) => handleUpdateItem(idx, 'ingredient_id', parseInt(value, 10))}
                                placeholder="— Material —"
                                searchPlaceholder="Search materials…"
                                options={ingredients.map((ingredient) => ({
                                  value: String(ingredient.id),
                                  label: ingredient.name,
                                  searchText: ingredient.unit,
                                }))}
                                className="glass-card border-0 px-3 py-2"
                              />
                            </div>
                            
                            <input 
                              type="number" step="any" min="0.01" required
                              value={item.quantity_ordered}
                              onChange={e => handleUpdateItem(idx, 'quantity_ordered', parseFloat(e.target.value) || 0)}
                              className="w-24 px-3 py-2 glass-card text-sm text-right"
                              placeholder="Qty"
                            />
                            
                            <div className="w-16 px-2 text-xs font-semibold text-soot-500 truncate">
                              {item.unit}
                            </div>
                            
                            <div className="relative w-28">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-soot-400 text-sm">$</span>
                              <input 
                                type="number" step="0.01" min="0" required
                                value={item.unit_price}
                                onChange={e => handleUpdateItem(idx, 'unit_price', parseFloat(e.target.value) || 0)}
                                className="w-full pl-6 pr-3 py-2 glass-card text-sm text-right"
                                placeholder="Price"
                              />
                            </div>
                            
                            <button type="button" onClick={() => handleRemoveItem(idx)} className="p-2 text-soot-400 hover:text-red-600 transition-colors">
                              <X className="w-4 h-4" />
                            </button>
                         </div>
                       ))}
                     </div>
                   )}
                 </div>

               </div>
               
               <div className="p-6 border-t border-soot-200/60 bg-white/20 shrink-0 flex gap-3">
                 <div className="flex-1 font-semibold text-lg text-soot-800 flex items-center">
                   Total: {formatCurrency(formItems.reduce((acc, it) => acc + (it.quantity_ordered * it.unit_price), 0))}
                 </div>
                 <button type="button" onClick={() => setShowModal(false)} className="px-5 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">Cancel</button>
                 <button type="submit" disabled={submitting} className="px-6 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 flex items-center gap-2 touch-target">
                   {submitting && <Loader2 className="w-4 h-4 animate-spin" />} Save PO
                 </button>
               </div>
             </form>
           </div>
         </div>
      )}

      {partialReceivePo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
          <div className="glass-floating w-full max-w-2xl my-auto flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
              <div>
                <h3 className="text-lg font-bold text-neutral-900">Receive Stock</h3>
                <p className="text-sm text-soot-500 mt-0.5">{partialReceivePo.po_number}</p>
              </div>
              <button onClick={() => setPartialReceivePo(null)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmitPartialReceive} className="flex flex-col flex-1 min-h-0">
              <div className="p-6 overflow-y-auto space-y-3">
                {(partialReceivePo.items || []).filter(item => item.quantity_remaining > 0).map(item => (
                  <div key={item.id} className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3 items-end bg-white/40 p-3 rounded-lg border border-soot-200">
                    <div className="min-w-0">
                      <p className="font-semibold text-soot-800 truncate">{item.ingredient_name || 'Ingredient'}</p>
                      <p className="text-sm text-soot-500">
                        Remaining {formatQuantity(item.quantity_remaining)} {item.unit} of {formatQuantity(item.quantity_ordered)} {item.unit}
                      </p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-soot-500 mb-1">Received</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          max={item.quantity_remaining}
                          value={receiveQuantities[item.id] || ''}
                          onChange={e => setReceiveQuantities(prev => ({ ...prev, [item.id]: e.target.value }))}
                          className="w-full px-3 py-2 glass-card text-sm text-right"
                          placeholder="0"
                        />
                        <span className="w-10 text-xs font-semibold text-soot-500 truncate">{item.unit}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="p-6 border-t border-soot-200/60 bg-white/20 shrink-0 flex justify-end gap-3">
                <button type="button" onClick={() => setPartialReceivePo(null)} className="px-5 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">Cancel</button>
                <button type="submit" disabled={receiving} className="px-6 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 flex items-center gap-2 touch-target">
                  {receiving && <Loader2 className="w-4 h-4 animate-spin" />} Update Stock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
