import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, Pencil, Package } from 'lucide-react';
import { get, post, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';

type Ingredient = {
  id: number;
  name: string;
  sku?: string;
  unit: string;
  current_stock: number;
  minimum_stock: number;
  reorder_quantity: number;
  last_purchase_price: number;
  average_cost: number;
  preferred_supplier_id?: number;
  category?: string;
  notes?: string;
};

type Supplier = {
  id: number;
  name: string;
};

const UNITS = ['kg', 'g', 'l', 'ml', 'piece', 'dozen', 'pack', 'can', 'bottle'];

export default function IngredientsTab() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formSku, setFormSku] = useState('');
  const [formUnit, setFormUnit] = useState('kg');
  const [formMinStock, setFormMinStock] = useState('0');
  const [formReorderQty, setFormReorderQty] = useState('0');
  const [formLastPurchasePrice, setFormLastPurchasePrice] = useState('0');
  const [formAverageCost, setFormAverageCost] = useState('0');
  const [formSupplierId, setFormSupplierId] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const ingPath = activeBranchId
        ? `/inventory-advanced/ingredients?branch_id=${activeBranchId}`
        : '/inventory-advanced/ingredients';
      const [ingRes, supRes] = await Promise.all([
        get<{ ingredients: Ingredient[] }>(ingPath),
        get<{ suppliers: Supplier[] }>('/inventory-advanced/suppliers')
      ]);
      setIngredients(ingRes.ingredients || []);
      setSuppliers(supRes.suppliers || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormSku('');
    setFormUnit('kg');
    setFormMinStock('0');
    setFormReorderQty('0');
    setFormLastPurchasePrice('0');
    setFormAverageCost('0');
    setFormSupplierId('');
    setFormCategory('');
    setFormError('');
    setEditingIngredient(null);
  };

  const handleOpenAdd = () => {
    resetForm();
    setShowModal(true);
  };

  const handleOpenEdit = (ing: Ingredient) => {
    setEditingIngredient(ing);
    setFormName(ing.name);
    setFormSku(ing.sku || '');
    setFormUnit(ing.unit || 'kg');
    setFormMinStock(ing.minimum_stock.toString());
    setFormReorderQty(ing.reorder_quantity.toString());
    setFormLastPurchasePrice(String(ing.last_purchase_price ?? 0));
    setFormAverageCost(String(ing.average_cost ?? 0));
    setFormSupplierId(ing.preferred_supplier_id ? ing.preferred_supplier_id.toString() : '');
    setFormCategory(ing.category || '');
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formUnit) {
      setFormError('Name and Unit are required.');
      return;
    }

    const parseMoney = (raw: string) => {
      const t = raw.trim();
      if (t === '') return 0;
      const n = parseFloat(t);
      return Number.isNaN(n) ? NaN : n;
    };
    const lastPurchase = parseMoney(formLastPurchasePrice);
    const avgCost = parseMoney(formAverageCost);
    if (Number.isNaN(lastPurchase) || lastPurchase < 0 || Number.isNaN(avgCost) || avgCost < 0) {
      setFormError('Cost fields must be valid amounts (0 or greater).');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        name: formName.trim(),
        sku: formSku.trim() || undefined,
        unit: formUnit,
        minimum_stock: parseFloat(formMinStock) || 0,
        reorder_quantity: parseFloat(formReorderQty) || 0,
        last_purchase_price: lastPurchase,
        average_cost: avgCost,
        preferred_supplier_id: formSupplierId ? parseInt(formSupplierId, 10) : undefined,
        category: formCategory.trim() || undefined,
      };

      if (editingIngredient) {
        await put(`/inventory-advanced/ingredients/${editingIngredient.id}`, payload);
        showToast('Ingredient updated successfully', 'success');
      } else {
        await post('/inventory-advanced/ingredients', payload);
        showToast('Ingredient added successfully', 'success');
      }
      setShowModal(false);
      fetchData();
    } catch (error) {
       setFormError(getUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent py-4">
      <div className="page-padding flex justify-between items-center bg-transparent shrink-0 pb-4">
        <h3 className="text-xl font-bold text-soot-900 hidden sm:block">Raw Materials</h3>
        <button
          onClick={handleOpenAdd}
          className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors ml-auto"
        >
          <Plus className="w-4 h-4" />
          Add material
        </button>
      </div>

      <div className="page-padding flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading materials...
          </div>
        ) : ingredients.length === 0 ? (
           <div className="text-center py-20 text-soot-400">
             <div className="w-16 h-16 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-4">
               <Package className="w-8 h-8 text-soot-300" />
             </div>
             <p className="text-lg font-medium mb-1">No materials yet</p>
             <p className="text-sm">Click "Add material" to start tracking inventory.</p>
           </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b-2 border-soot-200 text-sm uppercase text-soot-500 font-semibold tracking-wider">
                <th className="py-3 px-3">Item</th>
                <th className="py-3 px-3 text-right">Stock</th>
                <th className="py-3 px-3 text-right">Avg Cost</th>
                <th className="py-3 px-3 hidden md:table-cell">Supplier</th>
                <th className="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="glass-card">
              {ingredients.map(ing => {
                const supplier = suppliers.find(s => s.id === ing.preferred_supplier_id);
                const isLowStock = ing.current_stock <= ing.minimum_stock;
                
                return (
                  <tr key={ing.id} className="border-b border-white/20 hover:bg-white/40 transition-colors">
                    <td className="py-4 px-3">
                      <div className="font-bold text-soot-900">{ing.name}</div>
                      <div className="text-xs text-soot-500 font-mono mt-0.5">{ing.sku || '-'}</div>
                    </td>
                    <td className="py-4 px-3 text-right">
                      <div className="font-semibold tabular-nums text-lg inline-flex items-center gap-2">
                        {isLowStock && <span className="w-2 h-2 rounded-full bg-red-500" title="Low Stock"></span>}
                        {ing.current_stock.toFixed(2)}
                      </div>
                      <div className="text-xs text-soot-500 uppercase">{ing.unit}</div>
                    </td>
                    <td className="py-4 px-3 text-right">
                      <div className="font-medium text-soot-700">{formatCurrency(ing.average_cost)}</div>
                      <div className="text-xs text-soot-400">/ {ing.unit}</div>
                    </td>
                    <td className="py-4 px-3 hidden md:table-cell text-sm text-soot-600">
                      {supplier ? supplier.name : <span className="text-soot-300">—</span>}
                    </td>
                    <td className="py-4 px-3 text-right">
                      <button 
                        onClick={() => handleOpenEdit(ing)}
                        className="p-2 text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors inline-block"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
         <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
           <div className="glass-floating w-full max-w-lg my-auto flex flex-col max-h-[90vh] overflow-hidden">
             <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
                <h3 className="text-lg font-bold text-neutral-900">{editingIngredient ? 'Edit material' : 'Add raw material'}</h3>
                <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                  <X className="w-5 h-5 text-neutral-500" />
                </button>
             </div>

             <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
               {formError && (
                 <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm font-medium">
                   {formError}
                 </div>
               )}
               
               <div className="grid grid-cols-2 gap-4">
                 <div className="col-span-2">
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Name <span className="text-red-400">*</span></label>
                    <input type="text" value={formName} onChange={e => setFormName(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="e.g. Flour, Tomatoes" />
                 </div>
                 
                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">SKU</label>
                    <input type="text" value={formSku} onChange={e => setFormSku(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="e.g. MAT-001" />
                 </div>

                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Unit of Measure <span className="text-red-400">*</span></label>
                    <select value={formUnit} onChange={e => setFormUnit(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none">
                      {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                 </div>
                 
                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Low Stock Alert (Min Qty)</label>
                    <input type="number" step="any" min="0" value={formMinStock} onChange={e => setFormMinStock(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                 </div>
                 
                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Reorder Quantity</label>
                    <input type="number" step="any" min="0" value={formReorderQty} onChange={e => setFormReorderQty(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                 </div>

                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Average cost (PKR / unit)</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={formAverageCost}
                      onChange={e => setFormAverageCost(e.target.value)}
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    />
                    <p className="text-xs text-neutral-500 mt-1">Used in the materials list and for recipe cost context.</p>
                 </div>

                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Last purchase price (PKR / unit)</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={formLastPurchasePrice}
                      onChange={e => setFormLastPurchasePrice(e.target.value)}
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    />
                    <p className="text-xs text-neutral-500 mt-1">Latest price paid per unit (optional reference).</p>
                 </div>
                 
                 <div className="col-span-2">
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Preferred Supplier</label>
                    <select value={formSupplierId} onChange={e => setFormSupplierId(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none">
                      <option value="">— None —</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                 </div>
               </div>

               <div className="flex gap-3 pt-4">
                 <button type="button" onClick={() => setShowModal(false)} className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">Cancel</button>
                 <button type="submit" disabled={submitting} className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target">
                   {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                   {editingIngredient ? 'Save changes' : 'Add material'}
                 </button>
               </div>
             </form>
           </div>
         </div>
      )}
    </div>
  );
}
