import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Beaker, Loader2, Plus, Save, X } from 'lucide-react';
import { get, getUserMessage, post, put } from '../../api';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import {
  formatBaseQuantityGlobal,
  getSelectableInputUnits,
  normalizeUnitToken,
  quantityToStorageBase,
  toBaseUnit,
} from '../../utils/unitConversion';
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
  component_type?: 'ingredient' | 'prepared_item';
  ingredient_id?: number;
  prepared_item_id?: number;
  quantity: number;
  unit: string;
  notes?: string;
  prepared_item_name?: string | null;
  prepared_item_unit?: string;
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
  componentType: 'ingredient' | 'prepared_item';
  ingredientId: string;
  preparedItemId: string;
  preparedItemName: string;
  quantity: string;
  inputUnit?: string;
};

const UNIT_OPTIONS = ['kg', 'g', 'l', 'ml', 'piece', 'pack', 'can', 'bottle'];

function emptyComponentRow(): ComponentRow {
  return {
    componentType: 'ingredient',
    ingredientId: '',
    preparedItemId: '',
    preparedItemName: '',
    quantity: '',
    inputUnit: '',
  };
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
  // Avoid duplicating the same "/ kg" price when the ingredient is already priced per kg.
  if (unit === 'kg') return null;
  if (unit === 'g') return cost * 1000;
  return null;
}

function getSelectablePreparedInputUnits(unitRaw: string): string[] {
  const unit = (unitRaw || '').toLowerCase();
  if (unit === 'kg') return ['kg', 'g'];
  if (unit === 'g') return ['g', 'kg'];
  if (unit === 'l') return ['l', 'ml'];
  if (unit === 'ml') return ['ml', 'l'];
  return unit ? [unit] : [];
}

export default function PreparedItemsTab() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [items, setItems] = useState<PreparedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<'name' | 'kind' | 'stock' | 'cost' | 'formula'>('kind');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
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
        ? item.components.map((component) => {
            const componentType =
              component.component_type === 'prepared_item' ? 'prepared_item' : 'ingredient';
            return {
              componentType,
              ingredientId:
                componentType === 'ingredient' ? String(component.ingredient_id || '') : '',
              preparedItemId:
                componentType === 'prepared_item' ? String(component.prepared_item_id || '') : '',
              preparedItemName:
                componentType === 'prepared_item' ? String(component.prepared_item_name || '') : '',
              quantity: String(component.quantity),
              inputUnit: component.unit || '',
            };
          })
        : [emptyComponentRow()]
    );
    setShowForm(true);
  };

  const updateComponent = (index: number, patch: Partial<ComponentRow>) => {
    setComponents((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
    );
  };

  const findPreparedItemForRow = (row: ComponentRow): PreparedItem | undefined => {
    if (row.preparedItemId) {
      return items.find((it) => String(it.id) === row.preparedItemId);
    }
    const nameKey = (row.preparedItemName || '').trim().toLowerCase();
    if (!nameKey) return undefined;
    return items.find((it) => (it.name || '').trim().toLowerCase() === nameKey);
  };

  const resolveInputUnit = (row: ComponentRow, ingredient?: Ingredient): string => {
    if (row.componentType === 'prepared_item') {
      const prepared = findPreparedItemForRow(row);
      const allowed = getSelectablePreparedInputUnits(prepared?.unit || '');
      const normalized = normalizeUnitToken(row.inputUnit || '');
      if (normalized) {
        const matched = allowed.find((u) => normalizeUnitToken(u) === normalized);
        if (matched) return matched;
      }
      return allowed[0] || prepared?.unit || row.inputUnit || '';
    }
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

  const preparedItemOptions = items.map((item) => ({
    value: String(item.id),
    label: `${item.name} (${item.unit})`,
    searchText: item.name,
  }));

  const nextSku = useMemo(() => {
    if (editingItem || sku.trim()) return sku;
    return generateAutoSku('PRP', name || kind, items.map((item) => item.sku || '').filter(Boolean));
  }, [editingItem, items, kind, name, sku]);

  const formCost = components.reduce((sum, row) => {
    const qty = Number.parseFloat(row.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return sum;

    if (row.componentType === 'prepared_item') {
      const prepared = items.find((it) => String(it.id) === row.preparedItemId);
      if (!prepared) return sum;
      try {
        const inputUnit = resolveInputUnit(row) || prepared.unit;
        const qtyInPreparedUnit = quantityToStorageBase(qty, inputUnit, prepared.unit);
        return sum + Number(prepared.average_cost || 0) * qtyInPreparedUnit;
      } catch {
        return sum;
      }
    }

    const ingredient = ingredients.find((ing) => String(ing.id) === row.ingredientId);
    if (!ingredient) return sum;
    try {
      const qtyBase = toBaseUnit(qty, resolveInputUnit(row, ingredient) || ingredient.unit, ingredient);
      return sum + ingredient.average_cost * qtyBase;
    } catch {
      return sum;
    }
  }, 0);

  const formulaYield = components.reduce((sum, row) => {
    const qty = Number.parseFloat(row.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return sum;

    if (row.componentType === 'prepared_item') {
      const prepared = items.find((it) => String(it.id) === row.preparedItemId);
      if (!prepared) return sum;
      try {
        const inputUnit = resolveInputUnit(row) || prepared.unit;
        // Approximate prepared yield as the sum of all line quantities, expressed in this item's unit.
        const qtyInThisUnit = quantityToStorageBase(qty, inputUnit, unit);
        return sum + qtyInThisUnit;
      } catch {
        return sum;
      }
    }

    const ingredient = ingredients.find((ing) => String(ing.id) === row.ingredientId);
    if (!ingredient) return sum;
    try {
      const inputUnit = resolveInputUnit(row, ingredient) || ingredient.unit;
      // Approximate prepared yield as the sum of ingredient quantities, expressed in this item's unit.
      const qtyInThisUnit = quantityToStorageBase(qty, inputUnit, unit);
      return sum + qtyInThisUnit;
    } catch {
      return sum;
    }
  }, 0);

  const formulaCostPerUnit = formulaYield > 0 ? formCost / formulaYield : 0;

  const formulaCostPerCanonical = useMemo(() => {
    if (!(formulaYield > 0)) return null;
    const u = normalizeUnitToken(unit);
    const canonical = u === 'g' ? 'kg' : u === 'ml' ? 'l' : u;
    if (canonical === u) return null;
    try {
      const yieldCanonical = quantityToStorageBase(formulaYield, unit, canonical);
      if (!(yieldCanonical > 0)) return null;
      return { canonicalUnit: canonical, cost: formCost / yieldCanonical };
    } catch {
      return null;
    }
  }, [formCost, formulaYield, unit]);

  const lowStockItems = useMemo(
    () => items.filter((item) => item.current_stock <= (item.minimum_stock || 0)),
    [items]
  );

  const handleSort = (key: 'name' | 'kind' | 'stock' | 'cost' | 'formula') => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  };

  const renderSortIcon = (key: 'name' | 'kind' | 'stock' | 'cost' | 'formula') => {
    if (sortKey !== key) return <ArrowUpDown className="w-3.5 h-3.5 text-soot-400" aria-hidden="true" />;
    return sortDirection === 'asc' ? (
      <ArrowUp className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
    ) : (
      <ArrowDown className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
    );
  };

  const sortedItems = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    const kindWeight = (kindValue: PreparedItem['kind']) => (kindValue === 'sauce' ? 0 : 1);

    return items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const left = a.item;
        const right = b.item;

        let result = 0;
        switch (sortKey) {
          case 'kind':
            result = kindWeight(left.kind) - kindWeight(right.kind);
            break;
          case 'stock':
            result = Number(left.current_stock || 0) - Number(right.current_stock || 0);
            break;
          case 'cost':
            result = Number(left.average_cost || 0) - Number(right.average_cost || 0);
            break;
          case 'formula':
            result = Number(left.components?.length || 0) - Number(right.components?.length || 0);
            break;
          case 'name':
            result = (left.name || '').localeCompare(right.name || '', undefined, { sensitivity: 'base' });
            break;
        }

        if (result !== 0) return result * direction;
        return a.index - b.index;
      })
      .map((entry) => entry.item);
  }, [items, sortDirection, sortKey]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      showToast('Name is required', 'error');
      return;
    }

    setSubmitting(true);
    const preparedNameToId = new Map<string, number>();
    const payloadComponents: Array<
      | { component_type: 'ingredient'; ingredient_id: number; quantity: number; unit: string }
      | { component_type: 'prepared_item'; prepared_item_id: number; quantity: number; unit: string }
    > = [];

    try {
      for (const row of components) {
        const quantityRaw = Number.parseFloat(row.quantity);
        if (!Number.isFinite(quantityRaw) || quantityRaw <= 0) continue;

        if (row.componentType === 'ingredient') {
          const ingredient = ingredients.find((ing) => String(ing.id) === row.ingredientId);
          if (!ingredient) continue;
          const selectedInputUnit = resolveInputUnit(row, ingredient) || ingredient.unit;
          let quantityBase = quantityRaw;
          try {
            quantityBase = toBaseUnit(quantityRaw, selectedInputUnit, ingredient);
          } catch {
            continue;
          }
          payloadComponents.push({
            component_type: 'ingredient',
            ingredient_id: ingredient.id,
            quantity: quantityBase,
            unit: ingredient.unit,
          });
          continue;
        }

        const preparedNameKey = (row.preparedItemName || '').trim().toLowerCase();
        if (preparedNameKey && preparedNameKey === trimmedName.trim().toLowerCase()) {
          showToast('A sauce/marination cannot include itself in its formula', 'error');
          setSubmitting(false);
          return;
        }

        const selectedExisting = findPreparedItemForRow(row);
        let preparedId: number | null = selectedExisting?.id ?? null;
        if (!preparedId && preparedNameKey) {
          preparedId = preparedNameToId.get(preparedNameKey) ?? null;
        }

        if (!preparedId) {
          if (!preparedNameKey) continue;
          const created = await post<{ id: number }>('/inventory-advanced/prepared-items', {
            name: row.preparedItemName.trim(),
            kind: 'sauce',
            unit,
            minimum_stock: 0,
            components: [],
          });
          preparedId = created.id;
          preparedNameToId.set(preparedNameKey, preparedId);
        }

        const prepared = items.find((it) => it.id === preparedId);
        const preparedUnit = prepared?.unit || unit;
        const selectedInputUnit =
          resolveInputUnit({ ...row, preparedItemId: String(preparedId) }) || preparedUnit;
        let quantityBase = quantityRaw;
        try {
          quantityBase = quantityToStorageBase(quantityRaw, selectedInputUnit, preparedUnit);
        } catch {
          continue;
        }
        payloadComponents.push({
          component_type: 'prepared_item',
          prepared_item_id: preparedId,
          quantity: quantityBase,
          unit: preparedUnit,
        });
      }
    } catch (e) {
      showToast(getUserMessage(e), 'error');
      setSubmitting(false);
      return;
    }

    if (payloadComponents.length === 0) {
      showToast('Add at least one ingredient or sauce/marination to the formula', 'error');
      setSubmitting(false);
      return;
    }

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
                <th
                  aria-sort={sortKey === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('name')}
                    className="flex w-full items-center gap-2 text-left transition-colors hover:text-soot-900 focus:outline-none focus-visible:text-soot-950"
                  >
                    <span>Name</span>
                    {renderSortIcon('name')}
                  </button>
                </th>
                <th
                  aria-sort={sortKey === 'kind' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('kind')}
                    className="flex w-full items-center gap-2 text-left transition-colors hover:text-soot-900 focus:outline-none focus-visible:text-soot-950"
                  >
                    <span>Type</span>
                    {renderSortIcon('kind')}
                  </button>
                </th>
                <th
                  aria-sort={sortKey === 'stock' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('stock')}
                    className="flex w-full items-center justify-end gap-2 text-right transition-colors hover:text-soot-900 focus:outline-none focus-visible:text-soot-950"
                  >
                    <span>Stock</span>
                    {renderSortIcon('stock')}
                  </button>
                </th>
                <th
                  aria-sort={sortKey === 'cost' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10 text-right"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('cost')}
                    className="flex w-full items-center justify-end gap-2 text-right transition-colors hover:text-soot-900 focus:outline-none focus-visible:text-soot-950"
                  >
                    <span>Cost per yield</span>
                    {renderSortIcon('cost')}
                  </button>
                </th>
                <th
                  aria-sort={sortKey === 'formula' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className="sticky top-0 z-10"
                >
                  <button
                    type="button"
                    onClick={() => handleSort('formula')}
                    className="flex w-full items-center gap-2 text-left transition-colors hover:text-soot-900 focus:outline-none focus-visible:text-soot-950"
                  >
                    <span>Formula</span>
                    {renderSortIcon('formula')}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => {
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
          <form onSubmit={handleSubmit} className="glass-card w-full max-w-5xl max-h-[90vh] overflow-hidden p-5 flex flex-col">
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
                  <h4 className="text-sm font-bold text-soot-900">
                    Formula yield: {formatBaseQuantityGlobal(formulaYield, unit)}
                  </h4>
                  <span className="text-xs font-semibold text-brand-700 text-right">
                    <span className="whitespace-nowrap">
                      Est. cost / {formatYieldUnit(unit)}: {formatCurrency(formulaCostPerUnit || 0)}
                    </span>
                    {formulaCostPerCanonical && (
                      <span className="block whitespace-nowrap text-soot-500 font-semibold">
                        Est. cost / {formatYieldUnit(formulaCostPerCanonical.canonicalUnit)}:{' '}
                        {formatCurrency(formulaCostPerCanonical.cost)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="max-h-[40vh] overflow-y-auto overflow-x-hidden pr-1 space-y-1.5">
                  <div className="grid grid-cols-[minmax(0,3.4fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_2.5rem] gap-1.5 px-1 text-[10px] font-bold uppercase tracking-wide text-soot-500 py-1">
                    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 pl-1 min-w-0">
                      <div>Type</div>
                      <div>Item</div>
                    </div>
                    <div className="text-center whitespace-nowrap">Unit price</div>
                    <div className="text-center whitespace-nowrap">Total</div>
                    <div className="text-center whitespace-nowrap">Qty</div>
                    <div className="text-center whitespace-nowrap">Unit</div>
                    <div />
                  </div>
                  {components.map((row, index) => {
                    const ingredient = row.componentType === 'ingredient'
                      ? ingredients.find(ing => String(ing.id) === row.ingredientId)
                      : undefined;
                    const prepared = row.componentType === 'prepared_item'
                      ? findPreparedItemForRow(row)
                      : undefined;
                    const selectedInputUnit = resolveInputUnit(row, ingredient);
                    const qty = Number.parseFloat(row.quantity);
                    let lineTotal = 0;
                    if (row.componentType === 'prepared_item' && prepared && Number.isFinite(qty) && qty > 0) {
                      try {
                        const qtyBase = quantityToStorageBase(qty, selectedInputUnit || prepared.unit, prepared.unit);
                        lineTotal = qtyBase * Number(prepared.average_cost || 0);
                      } catch {
                        lineTotal = 0;
                      }
                    } else if (ingredient && Number.isFinite(qty) && qty > 0) {
                      try {
                        const qtyBase = toBaseUnit(qty, selectedInputUnit || ingredient.unit, ingredient);
                        lineTotal = qtyBase * Number(ingredient.average_cost || 0);
                      } catch {
                        lineTotal = 0;
                      }
                    }
                    const ingredientPerKgPrice = ingredient ? getPerKgPrice(ingredient) : null;
                    const unitPriceLabel = row.componentType === 'prepared_item'
                      ? (prepared ? `${formatCurrency(Number(prepared.average_cost || 0))} / ${prepared.unit}` : '-')
                      : (ingredient ? `${formatCurrency(Number(ingredient.average_cost || 0))} / ${ingredient.unit}` : '-');
                    const qtyUnitOptions = row.componentType === 'prepared_item'
                      ? (prepared ? getSelectablePreparedInputUnits(prepared.unit) : [])
                      : (ingredient
                          ? getSelectableInputUnits(ingredient).filter((u) => {
                              const normalized = normalizeUnitToken(u);
                              return normalized !== 'carton' && normalized !== 'packet';
                            })
                          : []);

                    return (
                      <div key={index} className="space-y-1">
                        <div className="grid grid-cols-[minmax(0,3.4fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_2.5rem] gap-1.5 items-center">
                          <div className="min-w-0 grid grid-cols-[8rem_minmax(0,1fr)] gap-2 items-center">
                            <div className="min-w-0">
                              <div className="inline-flex w-full items-center justify-start rounded-[10px] bg-white/50 px-2.5 py-1 text-[11px] font-semibold text-soot-700">
                                {row.componentType === 'prepared_item' ? 'Marin./Sauce' : 'Ingredient'}
                              </div>
                            </div>
                            <div className="min-w-0">
                              {row.componentType === 'prepared_item' ? (
                                <SearchableSelect
                                  value={row.preparedItemId}
                                  onChange={(value) => {
                                    const selectedPrepared = items.find((it) => String(it.id) === value);
                                    const firstUnit = selectedPrepared
                                      ? (getSelectablePreparedInputUnits(selectedPrepared.unit)[0] || selectedPrepared.unit)
                                      : '';
                                    updateComponent(index, {
                                      preparedItemId: value,
                                      preparedItemName: selectedPrepared?.name || '',
                                      inputUnit: firstUnit,
                                    });
                                  }}
                                  placeholder="Select sauce/marination"
                                  options={preparedItemOptions}
                                  className="glass-card border-0 px-2.5 py-1.5 min-w-0 w-full"
                                />
                              ) : (
                                <SearchableSelect
                                  value={row.ingredientId}
                                  onChange={(value) => {
                                    const selectedIngredient = ingredients.find((ing) => String(ing.id) === value);
                                    const firstUnit = selectedIngredient
                                      ? (getSelectableInputUnits(selectedIngredient)[0] || selectedIngredient.unit)
                                      : '';
                                    updateComponent(index, { ingredientId: value, inputUnit: firstUnit });
                                  }}
                                  placeholder="Select ingredient"
                                  options={ingredientOptions}
                                  className="glass-card border-0 px-2.5 py-1.5 min-w-0 w-full"
                                />
                              )}
                            </div>
                          </div>
                          <div className="text-center text-[11px] leading-tight font-semibold text-brand-700 min-w-0 tabular-nums px-0.5">
                            <div>{unitPriceLabel}</div>
                            {ingredient && ingredientPerKgPrice !== null && row.componentType === 'ingredient' && (
                              <div className="text-[9px] text-soot-400">{formatCurrency(ingredientPerKgPrice)} / kg</div>
                            )}
                          </div>
                          <div className="text-center text-[11px] font-semibold text-soot-700 tabular-nums px-0.5">
                            {(ingredient || prepared) ? formatCurrency(lineTotal) : '-'}
                          </div>
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
                            disabled={row.componentType === 'ingredient' ? !ingredient : !prepared}
                          >
                            {qtyUnitOptions.length === 0 && <option value="">Unit</option>}
                            {qtyUnitOptions.map((u) => (
                              <option key={u} value={u}>
                                {u}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => setComponents((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                            className="justify-self-end p-1.5 text-soot-400 hover:text-red-600"
                            disabled={components.length === 1}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <button
                    type="button"
                    onClick={() => setComponents((current) => [...current, emptyComponentRow()])}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-600"
                  >
                    <Plus className="w-4 h-4" /> Add ingredient
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setComponents((current) => [
                        ...current,
                        { ...emptyComponentRow(), componentType: 'prepared_item' },
                      ])
                    }
                    className="inline-flex items-center gap-2 text-sm font-semibold text-brand-700 hover:text-brand-600"
                  >
                    <Plus className="w-4 h-4" /> Add sauce/marination
                  </button>
                </div>
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
