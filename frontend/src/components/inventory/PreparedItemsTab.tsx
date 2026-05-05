import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Beaker, Loader2, Plus, Save, X } from 'lucide-react';
import { get, getUserMessage, post, put } from '../../api';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import { formatBaseQuantityGlobal, getSelectableInputUnits, normalizeUnitToken, toBaseUnit } from '../../utils/unitConversion';
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
  ingredient_id: number;
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
  minimum_stock: number;
  average_cost: number;
  notes?: string;
  components: PreparedComponent[];
};

type ComponentRow = {
  ingredientId: string;
  quantity: string;
  inputUnit?: string;
};

const UNIT_OPTIONS = ['kg', 'g', 'l', 'ml', 'piece', 'pack', 'can', 'bottle'];

function emptyComponentRow(): ComponentRow {
  return { ingredientId: '', quantity: '', inputUnit: '' };
}

function formatYieldUnit(unit: string) {
  if (unit === 'l') return 'Ltr';
  return unit;
}

function formatCostPerYield(amount: number, unit: string) {
  return `${formatCurrency(amount)} / ${formatYieldUnit(unit)}`;
}

function getPerKgPrice(ingredient: Ingredient): number | null {
  const unit = (ingredient.unit || '').toLowerCase();
  const cost = Number(ingredient.average_cost || 0);
  if (!Number.isFinite(cost) || cost < 0) return null;
  if (unit === 'kg') return cost;
  if (unit === 'g') return cost * 1000;
  return null;
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
  const [minimumStock, setMinimumStock] = useState('0');
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
    setMinimumStock('0');
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
    setMinimumStock(String(item.minimum_stock || 0));
    setNotes(item.notes || '');
    setComponents(
      item.components.length
        ? item.components.map((component) => ({
            ingredientId: String(component.ingredient_id),
            quantity: String(component.quantity),
            inputUnit: component.unit || '',
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

  const resolveInputUnit = (row: ComponentRow, ingredient?: Ingredient): string => {
    if (!ingredient) return row.inputUnit || '';
    const allowed = getSelectableInputUnits(ingredient);
    const normalized = normalizeUnitToken(row.inputUnit || '');
    if (normalized) {
      const matched = allowed.find((u) => normalizeUnitToken(u) === normalized);
      if (matched) return matched;
    }
    return allowed[0] || ingredient.unit;
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
    const qty = Number.parseFloat(row.quantity);
    if (!ingredient || !Number.isFinite(qty) || qty <= 0) return sum;
    try {
      const qtyBase = toBaseUnit(qty, resolveInputUnit(row, ingredient) || ingredient.unit, ingredient);
      return sum + ingredient.average_cost * qtyBase;
    } catch {
      return sum;
    }
  }, 0);

  const lowStockItems = useMemo(
    () => items.filter((item) => item.current_stock <= (item.minimum_stock || 0)),
    [items]
  );

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
        const quantityRaw = Number.parseFloat(row.quantity);
        if (!ingredient || !Number.isFinite(quantityRaw) || quantityRaw <= 0) return null;
        const selectedInputUnit = resolveInputUnit(row, ingredient) || ingredient.unit;
        let quantityBase = quantityRaw;
        try {
          quantityBase = toBaseUnit(quantityRaw, selectedInputUnit, ingredient);
        } catch {
          return null;
        }

        return {
          ingredient_id: ingredient.id,
          quantity: quantityBase,
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
        minimum_stock: Number.parseFloat(minimumStock) || 0,
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
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 py-20 text-soot-400">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading sauces and marinations...
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 lg:px-6">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 xl:flex-row xl:items-stretch">
      <div className="glass-card app-table-shell flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/20 bg-white/20 p-4">
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

        {lowStockItems.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-red-200/70 bg-red-50/85 px-4 py-3 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold">
              {lowStockItems.length} sauce/marination{lowStockItems.length === 1 ? '' : 's'} running low
            </span>
            <span className="text-red-700">
              {lowStockItems.slice(0, 3).map((item) => item.name).join(', ')}
              {lowStockItems.length > 3 ? ` +${lowStockItems.length - 3} more` : ''}
            </span>
          </div>
        )}

        <div className="app-table-scroll min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-contain pb-3">
          <table className="app-table min-w-[640px] text-sm">
            <thead>
              <tr>
                <th className="sticky top-0 z-10">Name</th>
                <th className="sticky top-0 z-10">Type</th>
                <th className="sticky top-0 z-10 text-right">Stock</th>
                <th className="sticky top-0 z-10 text-right">Cost per yield</th>
                <th className="sticky top-0 z-10">Formula</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isLowStock = item.current_stock <= (item.minimum_stock || 0);

                return (
                <tr key={item.id} className="cursor-pointer" onClick={() => openEdit(item)}>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-soot-900">{item.name}</div>
                    <div className="text-xs text-soot-500 font-mono">{item.sku}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-soot-700">{item.kind}</td>
                  <td className="px-4 py-3 text-right font-semibold text-soot-900 whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-2">
                      {isLowStock && (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" aria-label="Low stock" />
                      )}
                      <span>{formatBaseQuantityGlobal(item.current_stock, item.unit)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-soot-700">
                    {formatCostPerYield(item.average_cost, item.unit)}
                  </td>
                  <td className="px-4 py-3 text-soot-600">
                    {item.components.length} ingredient{item.components.length === 1 ? '' : 's'}
                  </td>
                </tr>
              );
              })}
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

      <div className="shrink-0 space-y-4 xl:w-96 xl:min-w-[24rem]">
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
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
          <form onSubmit={handleSubmit} className="glass-card w-full max-w-3xl max-h-[90vh] overflow-hidden p-5 flex flex-col">
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-white/20 pb-2">
              <h3 className="font-bold text-soot-900">{editingItem ? 'Edit' : 'New'} Sauce/Marination</h3>
              <button type="button" onClick={() => setShowForm(false)} className="p-2 text-soot-500 hover:text-soot-900">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto pr-1 space-y-4">
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
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={minimumStock}
                  onChange={(event) => setMinimumStock(event.target.value)}
                  className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                  placeholder="Low stock alert"
                />
              </div>

                <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-soot-900">Formula per 1 {unit}</h4>
                  <span className="text-xs font-semibold text-brand-700">
                    Est. cost / {formatYieldUnit(unit)}: {formatCurrency(formCost)}
                  </span>
                </div>
                <div className="max-h-[40vh] overflow-y-auto overflow-x-hidden pr-1 space-y-1.5">
                  <div className="grid grid-cols-[minmax(14rem,28rem)_8.75rem_7rem_10.5rem_2rem] gap-2 px-1 text-[10px] font-bold uppercase tracking-wide text-soot-500 py-1">
                    <div className="pl-1">Ingredient</div>
                    <div className="text-center whitespace-nowrap">Unit price</div>
                    <div className="text-center whitespace-nowrap">Total</div>
                    <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-1.5 min-w-0">
                      <div className="text-center whitespace-nowrap">Qty</div>
                      <div className="text-center whitespace-nowrap">Unit</div>
                    </div>
                    <div />
                  </div>
                  {components.map((row, index) => {
                    const ingredient = ingredients.find(ing => String(ing.id) === row.ingredientId);
                    const selectedInputUnit = resolveInputUnit(row, ingredient);
                    const qty = Number.parseFloat(row.quantity);
                    let lineTotal = 0;
                    if (ingredient && Number.isFinite(qty) && qty > 0) {
                      try {
                        const qtyBase = toBaseUnit(qty, selectedInputUnit || ingredient.unit, ingredient);
                        lineTotal = qtyBase * Number(ingredient.average_cost || 0);
                      } catch {
                        lineTotal = 0;
                      }
                    }
                    const ingredientPerKgPrice = ingredient ? getPerKgPrice(ingredient) : null;
                    const ingredientUnitPrice = ingredient ? `${formatCurrency(Number(ingredient.average_cost || 0))} / ${ingredient.unit}` : '-';
                    const qtyUnitOptions = ingredient
                      ? getSelectableInputUnits(ingredient).filter((u) => {
                          const normalized = normalizeUnitToken(u);
                          return normalized !== 'carton' && normalized !== 'packet';
                        })
                      : [];

                    return (
                      <div key={index} className="space-y-1">
                        <div className="grid grid-cols-[minmax(14rem,28rem)_8.75rem_7rem_10.5rem_2rem] gap-2 items-center">
                          <SearchableSelect
                            value={row.ingredientId}
                            onChange={(value) => {
                              const selectedIngredient = ingredients.find((ing) => String(ing.id) === value);
                              const firstUnit = selectedIngredient
                                ? (getSelectableInputUnits(selectedIngredient)[0] || selectedIngredient.unit)
                                : '';
                              updateComponent(index, { ingredientId: value, inputUnit: firstUnit });
                            }}
                            placeholder="Ingredient"
                            options={ingredientOptions}
                            className="glass-card border-0 px-2.5 py-1.5 min-w-0"
                          />
                          <div className="text-center text-[11px] leading-tight font-semibold text-brand-700 min-w-0 tabular-nums px-0.5">
                            <div>{ingredientUnitPrice}</div>
                            {ingredient && ingredientPerKgPrice !== null && (
                              <div className="text-[9px] text-soot-400">{formatCurrency(ingredientPerKgPrice)} / kg</div>
                            )}
                          </div>
                          <div className="text-center text-[11px] font-semibold text-soot-700 tabular-nums px-0.5">
                            {ingredient ? formatCurrency(lineTotal) : '-'}
                          </div>
                          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-1.5 min-w-0">
                            <input
                              type="number"
                              min="0.000001"
                              step="any"
                              required
                              value={row.quantity}
                              onChange={(event) => updateComponent(index, { quantity: event.target.value })}
                              className="w-full px-2 py-1.5 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                              placeholder="Qty"
                            />
                            <select
                              value={selectedInputUnit}
                              onChange={(event) => updateComponent(index, { inputUnit: event.target.value })}
                              className="w-full px-1.5 py-1.5 glass-card text-[11px] focus:ring-2 focus:ring-brand-500"
                              disabled={!ingredient}
                            >
                              {qtyUnitOptions.length === 0 && <option value="">Unit</option>}
                              {qtyUnitOptions.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => setComponents((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                            className="p-1.5 text-soot-400 hover:text-red-600"
                            disabled={components.length === 1}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
            </div>

            <div className="pt-3 mt-3 border-t border-white/20 flex justify-end gap-2">
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
