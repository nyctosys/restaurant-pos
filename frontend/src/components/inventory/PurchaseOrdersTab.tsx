import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, ArrowRightCircle, CheckCircle2, ChevronDown, PackageCheck } from 'lucide-react';
import { get, post, getUserMessage } from '../../api';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import { formatCurrency } from '../../utils/formatCurrency';

type Supplier = { id: number; name: string };
type Ingredient = { id: number; name: string; unit: string; last_purchase_price: number };

type POItem = {
  ingredient_id: number;
  quantity_ordered: number;
  unit_price: number;
  unit: string;
};

type PurchaseOrder = {
  id: number;
  po_number: string;
  supplier_id: number;
  status: 'draft' | 'sent' | 'received' | 'cancelled';
  total_amount: number;
  expected_delivery: string | null;
  received_date: string | null;
  created_at: string;
};

export default function PurchaseOrdersTab() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);

  // Form State
  const [showModal, setShowModal] = useState(false);
  const [formSupplierId, setFormSupplierId] = useState('');
  const [formExpectedDate, setFormExpectedDate] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formItems, setFormItems] = useState<POItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

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

  const handleUpdateItem = (index: number, field: keyof POItem, value: any) => {
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
      title: 'Receive Purchase Order',
      message: `Mark ${po.po_number} as received? This will automatically update your raw material stock levels and recalculate average costs.`,
      confirmLabel: 'Yes, receive stock',
      variant: 'default'
    });
    if (!confirmed) return;

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

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'received': return 'bg-emerald-100 text-emerald-800 border-emerald-200';
      case 'draft': return 'bg-neutral-100 text-neutral-700 border-neutral-200';
      case 'sent': return 'bg-blue-100 text-blue-800 border-blue-200';
      default: return 'bg-soot-100 text-soot-700 border-soot-200';
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent py-4">
      <div className="page-padding flex justify-between items-center bg-transparent shrink-0 pb-4">
        <h3 className="text-xl font-bold text-soot-900 hidden sm:block">Purchase Orders</h3>
        <button
          onClick={handleOpenAdd}
          className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors ml-auto"
        >
          <Plus className="w-4 h-4" />
          Create PO
        </button>
      </div>

      <div className="page-padding flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading orders...
          </div>
        ) : pos.length === 0 ? (
           <div className="text-center py-20 text-soot-400">
             <div className="w-16 h-16 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-4">
               <PackageCheck className="w-8 h-8 text-soot-300" />
             </div>
             <p className="text-lg font-medium mb-1">No purchase orders</p>
             <p className="text-sm">Create a PO to restock your ingredients.</p>
           </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pos.map(po => {
              const supplier = suppliers.find(s => s.id === po.supplier_id);
              return (
                 <div key={po.id} className="glass-card p-5 relative group flex flex-col justify-between hover:bg-white/40 transition-colors">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h4 className="text-lg font-bold font-mono text-soot-900 leading-tight">{po.po_number}</h4>
                        <p className="text-sm font-medium text-soot-600 mt-0.5">{supplier?.name || "Unknown Supplier"}</p>
                      </div>
                      <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border ${getStatusColor(po.status)}`}>
                        {po.status}
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
                    </div>
                    
                    <div className="pt-3 border-t border-soot-200/50 flex justify-end">
                      {po.status !== 'received' ? (
                        <button 
                          onClick={() => handleReceive(po)}
                          className="flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:text-brand-800 transition-colors bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-md"
                        >
                          <ArrowRightCircle className="w-4 h-4" /> Receive Stock
                        </button>
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
                     <div className="relative">
                       <select required value={formSupplierId} onChange={e => setFormSupplierId(e.target.value)} className="w-full appearance-none px-4 py-2.5 pr-10 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none">
                         <option value="">— Select Supplier —</option>
                         {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                       </select>
                       <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
                     </div>
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
                            <select 
                              required
                              value={item.ingredient_id || ''}
                              onChange={e => handleUpdateItem(idx, 'ingredient_id', parseInt(e.target.value, 10))}
                              className="flex-1 min-w-[120px] px-3 py-2 glass-card text-sm"
                            >
                              <option value="">— Material —</option>
                              {ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                            </select>
                            
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
    </div>
  );
}
