import React, { useState, useEffect, useMemo } from 'react';
import { Plus, X, Loader2, Pencil, Package, Layers, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { get, post, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import { generateAutoSku } from '../../utils/sku';

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

type RestockRow = {
  key: string;
  ingredientId: string;
  quantity: string;
  unitCost: string;
};

type SortKey = 'name' | 'current_stock' | 'average_cost' | 'supplier' | 'id';
type SortDirection = 'asc' | 'desc';

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
  const [formSkuTouched, setFormSkuTouched] = useState(false);
  const [formUnit, setFormUnit] = useState('kg');
  const [formMinStock, setFormMinStock] = useState('0');
  const [formReorderQty, setFormReorderQty] = useState('0');
  const [formLastPurchasePrice, setFormLastPurchasePrice] = useState('0');
  const [formAverageCost, setFormAverageCost] = useState('0');
  const [formSupplierId, setFormSupplierId] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showRestockModal, setShowRestockModal] = useState(false);
  const [restockRows, setRestockRows] = useState<RestockRow[]>([]);
  const [restockReason, setRestockReason] = useState('');
  const [restockError, setRestockError] = useState('');
  const [restockSubmitting, setRestockSubmitting] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const createRestockRow = (): RestockRow => ({
    key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ingredientId: '',
    quantity: '',
    unitCost: '',
  });

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
    setFormSkuTouched(false);
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

  const handleOpenBulkRestock = () => {
    setRestockRows([createRestockRow()]);
    setRestockReason('');
    setRestockError('');
    setShowRestockModal(true);
  };

  const handleCloseBulkRestock = () => {
    setShowRestockModal(false);
    setRestockRows([]);
    setRestockReason('');
    setRestockError('');
  };

  const updateRestockRow = (key: string, patch: Partial<RestockRow>) => {
    setRestockRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRestockRow = () => setRestockRows((prev) => [...prev, createRestockRow()]);

  const removeRestockRow = (key: string) => {
    setRestockRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((row) => row.key !== key);
    });
  };

  const handleSubmitBulkRestock = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedReason = restockReason.trim();
    const items: { ingredient_id: number; quantity: number; unit_cost?: number }[] = [];

    for (let i = 0; i < restockRows.length; i += 1) {
      const row = restockRows[i];
      const ingredientId = Number.parseInt(row.ingredientId, 10);
      const quantity = Number.parseFloat(row.quantity);
      const unitCostText = row.unitCost.trim();
      const unitCost = unitCostText === '' ? undefined : Number.parseFloat(unitCostText);

      if (!Number.isFinite(ingredientId)) {
        setRestockError(`Row ${i + 1}: select a material.`);
        return;
      }
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setRestockError(`Row ${i + 1}: quantity must be greater than 0.`);
        return;
      }
      if (unitCostText !== '' && (!Number.isFinite(unitCost) || (unitCost ?? 0) < 0)) {
        setRestockError(`Row ${i + 1}: unit cost must be 0 or greater.`);
        return;
      }

      items.push({
        ingredient_id: ingredientId,
        quantity,
        ...(unitCost !== undefined ? { unit_cost: unitCost } : {}),
      });
    }

    setRestockSubmitting(true);
    setRestockError('');
    try {
      await post('/stock/bulk-restock', {
        reason: trimmedReason || undefined,
        items,
      });
      showToast('Bulk restock completed', 'success');
      handleCloseBulkRestock();
      fetchData();
    } catch (error) {
      setRestockError(getUserMessage(error));
    } finally {
      setRestockSubmitting(false);
    }
  };

  const handleOpenEdit = (ing: Ingredient) => {
    setEditingIngredient(ing);
    setFormName(ing.name);
    setFormSku(ing.sku || '');
    setFormSkuTouched(true);
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

  useEffect(() => {
    if (editingIngredient || formSkuTouched) {
      return;
    }
    const nextSku = formName.trim() ? generateAutoSku('ING', formName, ingredients.map((ingredient) => ingredient.sku)) : '';
    setFormSku(nextSku);
  }, [editingIngredient, formName, formSkuTouched, ingredients]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  };

  const sortedIngredients = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    return ingredients
      .map((ingredient, index) => ({ ingredient, index }))
      .sort((a, b) => {
        const left = a.ingredient;
        const right = b.ingredient;
        const leftSupplier = suppliers.find(s => s.id === left.preferred_supplier_id)?.name || '';
        const rightSupplier = suppliers.find(s => s.id === right.preferred_supplier_id)?.name || '';

        let result = 0;
        switch (sortKey) {
          case 'current_stock':
            result = left.current_stock - right.current_stock;
            break;
          case 'average_cost':
            result = left.average_cost - right.average_cost;
            break;
          case 'supplier':
            result = leftSupplier.localeCompare(rightSupplier, undefined, { sensitivity: 'base' });
            break;
          case 'id':
            result = left.id - right.id;
            break;
          case 'name':
            result = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
            break;
        }

        if (result !== 0) return result * direction;
        return a.index - b.index;
      })
      .map(entry => entry.ingredient);
  }, [ingredients, sortDirection, sortKey, suppliers]);

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="w-3.5 h-3.5 text-soot-400" aria-hidden="true" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
      : <ArrowDown className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />;
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent py-4">
      <div className="page-padding flex justify-between items-center bg-transparent shrink-0 pb-4">
        <h3 className="text-xl font-bold text-soot-900 hidden sm:block">Raw Materials</h3>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleOpenBulkRestock}
            className="flex items-center gap-2 bg-white/70 border border-white/70 text-soot-700 px-4 py-2 rounded-lg font-medium hover:bg-white/90 touch-target transition-colors"
          >
            <Layers className="w-4 h-4" />
            Bulk restock
          </button>
          <button
            onClick={handleOpenAdd}
            className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add material
          </button>
        </div>
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
                <th aria-sort={sortKey === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3">
                  <button type="button" onClick={() => handleSort('name')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Item</span>
                    {renderSortIcon('name')}
                  </button>
                </th>
                <th aria-sort={sortKey === 'current_stock' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 text-right">
                  <button type="button" onClick={() => handleSort('current_stock')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Stock</span>
                    {renderSortIcon('current_stock')}
                  </button>
                </th>
                <th aria-sort={sortKey === 'average_cost' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 text-right">
                  <button type="button" onClick={() => handleSort('average_cost')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Avg Cost</span>
                    {renderSortIcon('average_cost')}
                  </button>
                </th>
                <th aria-sort={sortKey === 'supplier' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 hidden md:table-cell">
                  <button type="button" onClick={() => handleSort('supplier')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Supplier</span>
                    {renderSortIcon('supplier')}
                  </button>
                </th>
                <th aria-sort={sortKey === 'id' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 text-right">
                  <button type="button" onClick={() => handleSort('id')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Actions</span>
                    {renderSortIcon('id')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="glass-card">
              {sortedIngredients.map(ing => {
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
                    <input
                      type="text"
                      value={formSku}
                      onChange={e => {
                        setFormSku(e.target.value);
                        setFormSkuTouched(true);
                      }}
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      placeholder="Auto-generated from material name"
                    />
                    <p className="text-xs text-neutral-500 mt-1">Auto-generated for new materials. You can still edit it.</p>
                 </div>

                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Unit of Measure <span className="text-red-400">*</span></label>
                    <SearchableSelect
                      value={formUnit}
                      onChange={setFormUnit}
                      searchPlaceholder="Search units…"
                      options={UNITS.map((unit) => ({ value: unit, label: unit }))}
                      className="glass-card border-0"
                    />
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
                    <SearchableSelect
                      value={formSupplierId}
                      onChange={setFormSupplierId}
                      placeholder="— None —"
                      searchPlaceholder="Search suppliers…"
                      options={suppliers.map((supplier) => ({ value: String(supplier.id), label: supplier.name }))}
                      className="glass-card border-0"
                    />
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

      {showRestockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
          <div className="glass-floating w-full max-w-3xl my-auto flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900">Bulk restock materials</h3>
              <button onClick={handleCloseBulkRestock} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmitBulkRestock} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {restockError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm font-medium">
                  {restockError}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Note / Reason (optional)</label>
                <input
                  type="text"
                  value={restockReason}
                  onChange={(e) => setRestockReason(e.target.value)}
                  className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="e.g. Weekly supplier delivery"
                />
              </div>

              <div className="space-y-3">
                {restockRows.map((row, idx) => (
                  <div key={row.key} className="grid grid-cols-12 gap-2 items-end glass-card p-3 rounded-lg">
                    <div className="col-span-12 md:col-span-6">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Material</label>
                      <SearchableSelect
                        value={row.ingredientId}
                        onChange={(value) => updateRestockRow(row.key, { ingredientId: value })}
                        placeholder="Select material"
                        searchPlaceholder="Search materials…"
                        options={ingredients.map((ingredient) => ({
                          value: String(ingredient.id),
                          label: `${ingredient.name} (${ingredient.unit})`,
                          searchText: `${ingredient.sku ?? ''} ${ingredient.category ?? ''}`.trim(),
                        }))}
                        className="glass-card border-0 px-3 py-2.5"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Quantity</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={row.quantity}
                        onChange={(e) => updateRestockRow(row.key, { quantity: e.target.value })}
                        className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        placeholder="0"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-3">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Unit cost (PKR)</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={row.unitCost}
                        onChange={(e) => updateRestockRow(row.key, { unitCost: e.target.value })}
                        className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        placeholder="Optional"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeRestockRow(row.key)}
                        className="p-2 rounded-lg text-neutral-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title={`Remove row ${idx + 1}`}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={addRestockRow}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-white/80 bg-white/70 hover:bg-white/90 transition-colors"
              >
                Add row
              </button>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseBulkRestock}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={restockSubmitting}
                  className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target"
                >
                  {restockSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Submit restock
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
