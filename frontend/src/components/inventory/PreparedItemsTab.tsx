import React, { useEffect, useMemo, useState } from 'react';
import { Beaker, Loader2, Plus, Save, X } from 'lucide-react';
import { get, getUserMessage, post, put } from '../../api';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import { formatBaseQuantityGlobal } from '../../utils/unitConversion';
import { generateAutoSku } from '../../utils/sku';

type Ingredient = {
  id: number;
  name: string;
  sku?: string;
  unit: string;
  current_stock: number;
  average_cost: number;
  purchase_unit?: string;
  conversion_factor?: number;
};

type PreparedComponent = {
  ingredient_id?: number;
  prepared_item_id?: number;
  component_type?: string;
  quantity: number;
  unit: string;
  notes?: string;
};

type PreparedItem = {
  id: number;
  name: string;
  sku?: string;
  kind: 'sauce' | 'marination';
  unit: string;
  current_stock: number;
  average_cost: number;
  notes?: string;
  components: PreparedComponent[];
};

type ComponentRow = {
  ingredientId: string;
  quantity: string;
  usePurchaseUnit?: boolean;
};

const UNIT_OPTIONS = ['kg', 'g', 'l', 'ml', 'piece', 'pack', 'can', 'bottle'];

function emptyComponentRow(): ComponentRow {
  return { ingredientId: '', quantity: '', usePurchaseUnit: false };
}

function formatYieldUnit(unit: string) {
  if (unit === 'l') return 'Ltr';
  return unit;
}

function formatCostPerYield(amount: number, unit: string) {
  return `${formatCurrency(amount)} / ${formatYieldUnit(unit)}`;
}

export default function PreparedItemsTab() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [items, setItems] = useState<PreparedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState<PreparedItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [kind, setKind] = useState<'sauce' | 'marination'>('sauce');
  const [unit, setUnit] = useState('kg');
  const [notes, setNotes] = useState('');
  const [components, setComponents] = useState<ComponentRow[]>([emptyComponentRow()]);
  const [batchItemId, setBatchItemId] = useState('');
  const [batchQuantity, setBatchQuantity] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ingRes, preparedRes] = await Promise.all([
        get<{ ingredients: Ingredient[] }>('/inventory-advanced/ingredients'),
        get<{ prepared_items: PreparedItem[] }>('/inventory-advanced/prepared-items'),
      ]);
      setIngredients(ingRes.ingredients || []);
      setItems(preparedRes.prepared_items || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const resetForm = () => {
    setEditingItem(null);
    setName('');
    setSku('');
    setKind('sauce');
    setUnit('kg');
    setNotes('');
    setComponents([emptyComponentRow()]);
  };

  const openCreate = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (item: PreparedItem) => {
    setEditingItem(item);
    setName(item.name);
    setSku(item.sku || '');
    setKind(item.kind);
    setUnit(item.unit);
    setNotes(item.notes || '');
    const editableComponents = item.components.filter(
      (component) =>
        component.ingredient_id &&
        (component.component_type !== 'prepared_item' ||
          Number(component.prepared_item_id || 0) !== item.id)
    );
    setComponents(
      editableComponents.length
        ? editableComponents.map((component) => ({
            ingredientId: String(component.ingredient_id),
            quantity: String(component.quantity),
          }))
        : [emptyComponentRow()]
    );
    setShowForm(true);
  };

  const updateComponent = (index: number, patch: Partial<ComponentRow>) => {
    setComponents((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
    );
  };

  const ingredientOptions = ingredients.map((ingredient) => ({
    value: String(ingredient.id),
    label: `${ingredient.name} (${ingredient.unit})`,
    searchText: ingredient.name,
  }));

  const nextSku = useMemo(() => {
    if (editingItem || sku.trim()) return sku;
    return generateAutoSku('PRP', name || kind, items.map((item) => item.sku || '').filter(Boolean));
  }, [editingItem, items, kind, name, sku]);

  const formCost = components.reduce((sum, row) => {
    const ingredient = ingredients.find((ing) => String(ing.id) === row.ingredientId);
    let qty = Number.parseFloat(row.quantity);
    if (!ingredient || !Number.isFinite(qty)) return sum;
    
    if (row.usePurchaseUnit && ingredient.conversion_factor) {
      qty = qty * ingredient.conversion_factor;
    }
    
    return sum + ingredient.average_cost * qty;
  }, 0);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Name is required', 'error');
      return;
    }
    const payloadComponents = components
      .map((row) => {
        const ingredient = ingredients.find((ing) => String(ing.id) === row.ingredientId);
        let quantity = Number.parseFloat(row.quantity);
        if (!ingredient || !Number.isFinite(quantity) || quantity <= 0) return null;
        
        if (row.usePurchaseUnit && ingredient.conversion_factor) {
          quantity = quantity * ingredient.conversion_factor;
        }

        return {
          ingredient_id: ingredient.id,
          quantity,
          unit: ingredient.unit,
        };
      })
      .filter(Boolean);
    if (payloadComponents.length === 0) {
      showToast('Add at least one ingredient to the formula', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: trimmedName,
        sku: (sku || nextSku).trim() || undefined,
        kind,
        unit,
        notes: notes.trim() || undefined,
        components: payloadComponents,
      };
      if (editingItem) {
        await put(`/inventory-advanced/prepared-items/${editingItem.id}`, payload);
        showToast('Sauce/marination updated', 'success');
      } else {
        await post('/inventory-advanced/prepared-items', payload);
        showToast('Sauce/marination created', 'success');
      }
      setShowForm(false);
      resetForm();
      await loadData();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBatchSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const qty = Number.parseFloat(batchQuantity);
    if (!batchItemId || !Number.isFinite(qty) || qty <= 0) {
      showToast('Choose an item and enter a valid batch quantity', 'error');
      return;
    }
    setSubmitting(true);
    try {
      await post(`/inventory-advanced/prepared-items/${batchItemId}/batches`, {
        quantity: qty,
      });
      showToast('Batch made; ingredients deducted', 'success');
      setBatchItemId('');
      setBatchQuantity('');
      await loadData();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading sauces and marinations...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_24rem] gap-4 px-4 lg:px-6 py-4">
      <div className="glass-card overflow-hidden">
        <div className="p-4 border-b border-white/20 bg-white/20 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-soot-900">Marinations & Sauces</h3>
            <p className="text-xs text-soot-500 mt-0.5">Batch-made prep items built from raw ingredients.</p>
          </div>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-[8px] bg-brand-700 text-white text-sm font-semibold hover:bg-brand-600 touch-target"
          >
            <Plus className="w-4 h-4" /> New
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/25 text-soot-500 uppercase text-xs">
              <tr>
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-right px-4 py-3">Stock</th>
                <th className="text-right px-4 py-3">Cost per yield</th>
                <th className="text-left px-4 py-3">Formula</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/20">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-white/25 cursor-pointer" onClick={() => openEdit(item)}>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-soot-900">{item.name}</div>
                    <div className="text-xs text-soot-500 font-mono">{item.sku}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-soot-700">{item.kind}</td>
                  <td className="px-4 py-3 text-right font-semibold text-soot-900 whitespace-nowrap">
                    {formatBaseQuantityGlobal(item.current_stock, item.unit)}
                  </td>
                  <td className="px-4 py-3 text-right text-soot-700">
                    {formatCostPerYield(item.average_cost, item.unit)}
                  </td>
                  <td className="px-4 py-3 text-soot-600">
                    {item.components.length} ingredient{item.components.length === 1 ? '' : 's'}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-soot-500">
                    No marinations or sauces yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-4">
        <form onSubmit={handleBatchSubmit} className="glass-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Beaker className="w-5 h-5 text-brand-700" />
            <h3 className="font-bold text-soot-900">Make Batch</h3>
          </div>
          <SearchableSelect
            value={batchItemId}
            onChange={setBatchItemId}
            placeholder="Select sauce/marination"
            options={items.map((item) => ({
              value: String(item.id),
              label: `${item.name} (${item.unit})`,
              searchText: item.name,
            }))}
            className="glass-card border-0 px-3 py-2"
          />
          <input
            type="number"
            min="0.01"
            step="any"
            value={batchQuantity}
            onChange={(event) => setBatchQuantity(event.target.value)}
            className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
            placeholder="Batch quantity"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[8px] bg-brand-700 text-white text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 touch-target"
          >
            <Save className="w-4 h-4" /> Make and deduct
          </button>
        </form>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
          <form onSubmit={handleSubmit} className="glass-card w-full max-w-3xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-soot-900">{editingItem ? 'Edit' : 'New'} Sauce/Marination</h3>
              <button type="button" onClick={() => setShowForm(false)} className="p-2 text-soot-500 hover:text-soot-900">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                placeholder="Name"
              />
              <input
                value={sku || nextSku}
                onChange={(event) => setSku(event.target.value)}
                className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                placeholder="SKU"
              />
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as 'sauce' | 'marination')}
                className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
              >
                <option value="sauce">Sauce</option>
                <option value="marination">Marination</option>
              </select>
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
                className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
              >
                {UNIT_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-soot-900">Formula per 1 {unit}</h4>
                <span className="text-xs font-semibold text-brand-700">
                  Est. cost / {formatYieldUnit(unit)}: {formatCurrency(formCost)}
                </span>
              </div>
              {components.map((row, index) => {
                const ingredient = ingredients.find(ing => String(ing.id) === row.ingredientId);
                const showConversionToggle = ingredient?.purchase_unit && (ingredient.conversion_factor ?? 0) > 1;
                
                return (
                  <div key={index} className="space-y-1">
                    <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-2 items-center">
                      <SearchableSelect
                        value={row.ingredientId}
                        onChange={(value) => updateComponent(index, { ingredientId: value, usePurchaseUnit: false })}
                        placeholder="Ingredient"
                        options={ingredientOptions}
                        className="glass-card border-0 px-3 py-2"
                      />
                      <div className="relative">
                        <input
                          type="number"
                          min="0.000001"
                          step="any"
                          required
                          value={row.quantity}
                          onChange={(event) => updateComponent(index, { quantity: event.target.value })}
                          className="w-full px-3 py-2 pr-10 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                          placeholder="Qty"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-soot-400 pointer-events-none">
                          {row.usePurchaseUnit ? ingredient?.purchase_unit : ingredient?.unit}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setComponents((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                        className="p-2 text-soot-400 hover:text-red-600"
                        disabled={components.length === 1}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {showConversionToggle && (
                      <div className="flex items-center gap-2 pl-1">
                        <button
                          type="button"
                          onClick={() => updateComponent(index, { usePurchaseUnit: !row.usePurchaseUnit })}
                          className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded border transition-colors ${
                            row.usePurchaseUnit ? 'bg-brand-100 text-brand-700 border-brand-200' : 'bg-neutral-50 text-neutral-400 border-neutral-200'
                          }`}
                        >
                          {row.usePurchaseUnit ? `In ${ingredient.purchase_unit}` : `Use ${ingredient.purchase_unit}?`}
                        </button>
                        {row.usePurchaseUnit && row.quantity && (
                          <span className="text-[10px] text-brand-600 font-medium italic">
                            = {(parseFloat(row.quantity) * (ingredient.conversion_factor || 1)).toFixed(4)} {ingredient.unit}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => setComponents((current) => [...current, emptyComponentRow()])}
                className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-600"
              >
                <Plus className="w-4 h-4" /> Add ingredient
              </button>
            </div>

            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
              rows={3}
              placeholder="Notes"
            />

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm font-semibold text-soot-600">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-[8px] bg-brand-700 text-white text-sm font-semibold hover:bg-brand-600 disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
