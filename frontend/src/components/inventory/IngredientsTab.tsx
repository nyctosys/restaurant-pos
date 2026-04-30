import React, { useState, useEffect, useMemo } from 'react';
import { Plus, X, Loader2, Pencil, Package, Layers, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { get, post, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
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
  purchase_unit?: string;
  conversion_factor?: number;
  preferred_supplier_id?: number;
  category?: string;
  notes?: string;
  brand_name?: string;
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
  purchasedUnit: string;
  packageQuantity: string;
  brandName: string;
};

type BulkAddRow = {
  key: string;
  name: string;
  brandName: string;
  sku: string;
  skuTouched: boolean;
  unit: string;
  minStock: string;
  reorderQty: string;
  lastPurchasePrice: string;
  supplierId: string;
};

type SortKey = 'name' | 'current_stock' | 'average_cost' | 'supplier' | 'id';
type SortDirection = 'asc' | 'desc';

const UNITS = [
  { value: 'kg', label: 'Kg' },
  { value: 'g', label: 'g' },
  { value: 'l', label: 'Ltr' },
  { value: 'piece', label: 'Pc' },
  { value: 'ml', label: 'ml' },
];

const PURCHASED_UNITS = [
  { value: 'kg', label: 'Kg' },
  { value: 'g', label: 'g' },
  { value: 'l', label: 'Ltr' },
  { value: 'ml', label: 'ml' },
  { value: 'piece', label: 'Pc' },
  { value: 'carton', label: 'Carton' },
  { value: 'packet', label: 'Packet' },
];

const PACKAGE_UNITS = new Set(['carton', 'packet']);

const formatAverageUnitCost = (amount: number) => {
  return `Rs. ${amount.toLocaleString('en-PK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
};

const getPurchasedUnitCost = (ingredient: Ingredient) => {
  const unit = normalizeUnit(ingredient.unit);
  if (unit === 'g') {
    return { amount: ingredient.average_cost * 1000, unit: 'kg' };
  }
  if (unit === 'ml') {
    return { amount: ingredient.average_cost * 1000, unit: 'l' };
  }
  return { amount: ingredient.average_cost, unit: unit || ingredient.unit };
};

const unitLabel = (unit?: string) => {
  const normalized = normalizeUnit(unit);
  return [...UNITS, ...PURCHASED_UNITS].find((option) => option.value === normalized)?.label || unit || 'unit';
};

const normalizeUnit = (unit?: string) => {
  const value = (unit || '').trim().toLowerCase();
  if (value === 'ltr' || value === 'liter' || value === 'litre') return 'l';
  if (value === 'pc' || value === 'pcs' || value === 'piece' || value === 'pieces') return 'piece';
  if (value === 'kgs' || value === 'kilogram' || value === 'kilograms') return 'kg';
  if (value === 'grams' || value === 'gram') return 'g';
  if (value === 'millilitre' || value === 'milliliter' || value === 'millilitres' || value === 'milliliters') return 'ml';
  return value;
};

const getDirectUnitFactor = (fromUnit?: string, toUnit?: string) => {
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return 1;
  if (from === 'kg' && to === 'g') return 1000;
  if (from === 'g' && to === 'kg') return 0.001;
  if (from === 'l' && to === 'ml') return 1000;
  if (from === 'ml' && to === 'l') return 0.001;
  return null;
};

const getPackageMeasureUnit = (inventoryUnit?: string) => {
  const unit = normalizeUnit(inventoryUnit);
  if (unit === 'kg' || unit === 'g') return 'kg';
  if (unit === 'l' || unit === 'ml') return 'l';
  if (unit === 'piece') return 'piece';
  return unit || 'unit';
};

const getPackageQuantityLabel = (inventoryUnit?: string, purchasedUnit?: string) => {
  return `How many ${unitLabel(getPackageMeasureUnit(inventoryUnit))} in the ${unitLabel(purchasedUnit).toLowerCase()}?`;
};

const getRestockConversionFactor = (inventoryUnit: string, purchasedUnit: string, packageQuantity: string) => {
  if (PACKAGE_UNITS.has(purchasedUnit)) {
    const packageAmount = Number.parseFloat(packageQuantity);
    if (!Number.isFinite(packageAmount) || packageAmount <= 0) return null;
    const measureUnit = getPackageMeasureUnit(inventoryUnit);
    const packageToInventoryFactor = getDirectUnitFactor(measureUnit, inventoryUnit);
    if (!packageToInventoryFactor) return null;
    return packageAmount * packageToInventoryFactor;
  }
  return getDirectUnitFactor(purchasedUnit, inventoryUnit);
};

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
  const [formBrandName, setFormBrandName] = useState('');
  const [formUnit, setFormUnit] = useState('kg');
  const [formMinStock, setFormMinStock] = useState('0');
  const [formReorderQty, setFormReorderQty] = useState('0');
  const [formLastPurchasePrice, setFormLastPurchasePrice] = useState('0');
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

  const [showBulkAddModal, setShowBulkAddModal] = useState(false);
  const [bulkAddRows, setBulkAddRows] = useState<BulkAddRow[]>([]);
  const [bulkAddError, setBulkAddError] = useState('');
  const [bulkAddSubmitting, setBulkAddSubmitting] = useState(false);

  const createRestockRow = (): RestockRow => ({
    key: Math.random().toString(36).substring(7),
    ingredientId: '',
    quantity: '',
    unitCost: '',
    purchasedUnit: '',
    packageQuantity: '',
    brandName: '',
  });

  const createBulkAddRow = (): BulkAddRow => ({
    key: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    brandName: '',
    sku: '',
    skuTouched: false,
    unit: 'kg',
    minStock: '0',
    reorderQty: '0',
    lastPurchasePrice: '0',
    supplierId: '',
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const ingPath = activeBranchId
        ? `/inventory-advanced/ingredients?branch_id=${activeBranchId}`
        : '/inventory-advanced/ingredients';
      const [ingRes, supRes] = await Promise.all([
        get<{ ingredients: Ingredient[] }>(ingPath, { forceRefresh }),
        get<{ suppliers: Supplier[] }>('/inventory-advanced/suppliers', { forceRefresh })
      ]);
      setIngredients(ingRes.ingredients || []);
      setSuppliers(supRes.suppliers || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
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
    setRestockRows((prev) => prev.map((row) => {
      if (row.key !== key) return row;
      const updated = { ...row, ...patch };
      if (patch.ingredientId !== undefined) {
        const selected = ingredients.find((ingredient) => String(ingredient.id) === patch.ingredientId);
        updated.purchasedUnit = normalizeUnit(selected?.unit) || '';
        updated.packageQuantity = '';
      }
      if (patch.purchasedUnit !== undefined && !PACKAGE_UNITS.has(patch.purchasedUnit)) {
        updated.packageQuantity = '';
      }
      return updated;
    }));
  };

  const addRestockRow = () => setRestockRows((prev) => [...prev, createRestockRow()]);

  const removeRestockRow = (key: string) => {
    setRestockRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((row) => row.key !== key);
    });
  };

  const handleOpenBulkAdd = () => {
    setBulkAddRows([createBulkAddRow()]);
    setBulkAddError('');
    setShowBulkAddModal(true);
  };

  const handleCloseBulkAdd = () => {
    setShowBulkAddModal(false);
    setBulkAddRows([]);
    setBulkAddError('');
  };

  const updateBulkAddRow = (key: string, patch: Partial<BulkAddRow>) => {
    setBulkAddRows((prev) => {
      const newRows = prev.map((row) => {
        if (row.key === key) {
          const updated = { ...row, ...patch };

          if (patch.name !== undefined && !updated.skuTouched) {
            const usedSkus = [
              ...ingredients.map((ingredient) => ingredient.sku),
              ...prev.filter((existingRow) => existingRow.key !== key).map((existingRow) => existingRow.sku),
            ];
            updated.sku = updated.name.trim() ? generateAutoSku('ING', updated.name, usedSkus) : '';
          }
          return updated;
        }
        return row;
      });
      return newRows;
    });
  };

  const addBulkAddRow = () => setBulkAddRows((prev) => [...prev, createBulkAddRow()]);

  const removeBulkAddRow = (key: string) => {
    setBulkAddRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((row) => row.key !== key);
    });
  };

  const handleSubmitBulkAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const ingredientsToCreate = [];

    for (let i = 0; i < bulkAddRows.length; i += 1) {
      const row = bulkAddRows[i];
      if (!row.name.trim()) {
        setBulkAddError(`Row ${i + 1}: Name is required.`);
        return;
      }
      if (!row.brandName.trim()) {
        setBulkAddError(`Row ${i + 1}: Brand is required.`);
        return;
      }
      if (!row.unit) {
        setBulkAddError(`Row ${i + 1}: Unit is required.`);
        return;
      }
      const price = parseFloat(row.lastPurchasePrice);
      if (row.lastPurchasePrice.trim() !== '' && (!Number.isFinite(price) || price < 0)) {
        setBulkAddError(`Row ${i + 1}: Price must be a valid amount (0 or greater).`);
        return;
      }

      ingredientsToCreate.push({
        name: row.name.trim(),
        brand_name: row.brandName.trim(),
        sku: row.sku.trim() || undefined,
        unit: row.unit,
        minimum_stock: parseFloat(row.minStock) || 0,
        reorder_quantity: parseFloat(row.reorderQty) || 0,
        last_purchase_price: Number.isFinite(price) ? price : 0,
        average_cost: Number.isFinite(price) ? price : 0,
        preferred_supplier_id: row.supplierId ? parseInt(row.supplierId, 10) : undefined,
      });
    }

    setBulkAddSubmitting(true);
    setBulkAddError('');
    try {
      await post('/inventory-advanced/ingredients/bulk', {
        ingredients: ingredientsToCreate,
      });
      showToast(`Successfully added ${ingredientsToCreate.length} materials`, 'success');
      handleCloseBulkAdd();
      fetchData();
    } catch (error) {
      setBulkAddError(getUserMessage(error));
    } finally {
      setBulkAddSubmitting(false);
    }
  };

  const handleSubmitBulkRestock = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedReason = restockReason.trim();
    const items: { ingredient_id: number; quantity: number; unit_cost?: number; brand_name?: string }[] = [];

    for (let i = 0; i < restockRows.length; i += 1) {
      const row = restockRows[i];
      const ingredientId = Number.parseInt(row.ingredientId, 10);
      const purchasedQuantity = Number.parseFloat(row.quantity);
      const unitCostText = row.unitCost.trim();
      let unitCost = unitCostText === '' ? undefined : Number.parseFloat(unitCostText);

      if (!Number.isFinite(ingredientId)) {
        setRestockError(`Row ${i + 1}: select a material.`);
        return;
      }

      const ing = ingredients.find(ing => ing.id === ingredientId);
      if (!ing) {
        setRestockError(`Row ${i + 1}: selected material was not found.`);
        return;
      }

      if (!row.purchasedUnit) {
        setRestockError(`Row ${i + 1}: select a purchased unit.`);
        return;
      }

      if (!Number.isFinite(purchasedQuantity) || purchasedQuantity <= 0) {
        setRestockError(`Row ${i + 1}: purchased quantity must be greater than 0.`);
        return;
      }

      const conversionFactor = getRestockConversionFactor(ing.unit, row.purchasedUnit, row.packageQuantity);
      if (!conversionFactor) {
        const message = PACKAGE_UNITS.has(row.purchasedUnit)
          ? `Row ${i + 1}: enter how many ${unitLabel(getPackageMeasureUnit(ing.unit))} are in one ${unitLabel(row.purchasedUnit).toLowerCase()}.`
          : `Row ${i + 1}: ${unitLabel(row.purchasedUnit)} cannot be converted to ${unitLabel(ing.unit)}.`;
        setRestockError(message);
        return;
      }

      const quantity = purchasedQuantity * conversionFactor;
      if (unitCost !== undefined) {
        unitCost /= conversionFactor;
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        setRestockError(`Row ${i + 1}: stock quantity must be greater than 0.`);
        return;
      }
      if (unitCostText !== '' && (!Number.isFinite(unitCost) || (unitCost ?? 0) < 0)) {
        setRestockError(`Row ${i + 1}: purchasing cost must be 0 or greater.`);
        return;
      }

      items.push({
        ingredient_id: ingredientId,
        quantity,
        brand_name: row.brandName.trim() || undefined,
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
      fetchData(true);
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
    setFormBrandName(ing.brand_name || '');
    setFormUnit(ing.unit || 'kg');
    setFormMinStock(ing.minimum_stock.toString());
    setFormReorderQty(ing.reorder_quantity.toString());
    setFormLastPurchasePrice(String(ing.last_purchase_price ?? 0));
    setFormSupplierId(ing.preferred_supplier_id ? ing.preferred_supplier_id.toString() : '');
    setFormCategory(ing.category || '');
    setFormError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formUnit || !formBrandName.trim()) {
      setFormError('Name, Brand, and Unit are required.');
      return;
    }

    const parseMoney = (raw: string) => {
      const t = raw.trim();
      if (t === '') return 0;
      const n = parseFloat(t);
      return Number.isNaN(n) ? NaN : n;
    };
    const lastPurchase = parseMoney(formLastPurchasePrice);
    if (Number.isNaN(lastPurchase) || lastPurchase < 0) {
      setFormError('Price must be a valid amount (0 or greater).');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        name: formName.trim(),
        sku: formSku.trim() || undefined,
        brand_name: formBrandName.trim(),
        unit: formUnit,
        minimum_stock: parseFloat(formMinStock) || 0,
        reorder_quantity: parseFloat(formReorderQty) || 0,
        last_purchase_price: lastPurchase,
        average_cost: lastPurchase,
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
            result = getPurchasedUnitCost(left).amount - getPurchasedUnitCost(right).amount;
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
            onClick={handleOpenBulkAdd}
            className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add material
          </button>
          <button
            onClick={handleOpenBulkRestock}
            className="flex items-center gap-2 bg-white/70 border border-white/70 text-soot-700 px-4 py-2 rounded-lg font-medium hover:bg-white/90 touch-target transition-colors"
          >
            <Layers className="w-4 h-4" />
            Restock
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
                <th className="py-3 px-3">Brand</th>
                <th aria-sort={sortKey === 'current_stock' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 text-right">
                  <button type="button" onClick={() => handleSort('current_stock')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Stock</span>
                    {renderSortIcon('current_stock')}
                  </button>
                </th>
                <th aria-sort={sortKey === 'average_cost' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 text-right">
                  <button type="button" onClick={() => handleSort('average_cost')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                    <span>Purchase Unit Cost</span>
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
                const purchaseUnitCost = getPurchasedUnitCost(ing);
                
                return (
                  <tr key={ing.id} className="border-b border-white/20 hover:bg-white/40 transition-colors">
                    <td className="py-4 px-3">
                      <div className="font-bold text-soot-900">{ing.name}</div>
                      <div className="text-xs text-soot-500 font-mono mt-0.5">{ing.sku || '-'}</div>
                    </td>
                    <td className="py-4 px-3 text-sm text-soot-700">{ing.brand_name || '—'}</td>
                    <td className="py-4 px-3 text-right">
                      <div className="font-semibold tabular-nums text-lg inline-flex items-center gap-2">
                        {isLowStock && <span className="w-2 h-2 rounded-full bg-red-500" title="Low Stock"></span>}
                        {ing.current_stock.toFixed(2)}
                      </div>
                      <div className="text-xs text-soot-500 uppercase">{ing.unit}</div>
                    </td>
                    <td className="py-4 px-3 text-right">
                      <div className="font-medium text-soot-700">{formatAverageUnitCost(purchaseUnitCost.amount)}</div>
                      <div className="text-xs text-soot-400">/ {unitLabel(purchaseUnitCost.unit)}</div>
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
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Preferred Supplier</label>
                    <SearchableSelect
                      value={formSupplierId}
                      onChange={setFormSupplierId}
                      placeholder="-- None --"
                      searchPlaceholder="Search suppliers..."
                      options={suppliers.map((supplier) => ({ value: String(supplier.id), label: supplier.name }))}
                      className="glass-card border-0"
                    />
                 </div>

                 <div className="col-span-2">
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Name <span className="text-red-400">*</span></label>
                    <input type="text" value={formName} onChange={e => setFormName(e.target.value)} className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none" placeholder="e.g. Flour, Tomatoes" />
                 </div>

                 <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Unit <span className="text-red-400">*</span></label>
                    <SearchableSelect
                      value={formUnit}
                      onChange={setFormUnit}
                      searchPlaceholder="Search units…"
                      options={UNITS}
                      sortOptions={false}
                      className="glass-card border-0"
                    />
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
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Brand <span className="text-red-400">*</span></label>
                    <input
                      type="text"
                      value={formBrandName}
                      onChange={e => setFormBrandName(e.target.value)}
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      placeholder="e.g. National"
                    />
                 </div>

                 <div className="col-span-2">
                    <label className="block text-sm font-medium text-neutral-700 mb-1">Price (PKR)</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={formLastPurchasePrice}
                      onChange={e => setFormLastPurchasePrice(e.target.value)}
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
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
              <h3 className="text-lg font-bold text-neutral-900">Restock materials</h3>
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
                {restockRows.map((row, idx) => {
                  const selectedIng = ingredients.find(ing => String(ing.id) === row.ingredientId);
                  const conversionFactor = selectedIng && row.purchasedUnit
                    ? getRestockConversionFactor(selectedIng.unit, row.purchasedUnit, row.packageQuantity)
                    : null;
                  const packageUnitSelected = PACKAGE_UNITS.has(row.purchasedUnit);
                  const purchasedQuantity = Number.parseFloat(row.quantity);
                  const purchasingCost = Number.parseFloat(row.unitCost);
                  const convertedQuantity = conversionFactor && Number.isFinite(purchasedQuantity)
                    ? purchasedQuantity * conversionFactor
                    : null;
                  const convertedUnitCost = conversionFactor && row.unitCost.trim() !== '' && Number.isFinite(purchasingCost)
                    ? purchasingCost / conversionFactor
                    : null;

                  return (
                    <div key={row.key} className="grid grid-cols-12 gap-2 items-end glass-card p-4 rounded-xl border border-white/40">
                      <div className="col-span-12 md:col-span-4">
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Select material from inventory</label>
                        <SearchableSelect
                          value={row.ingredientId}
                          onChange={(value) => {
                            const selected = ingredients.find(ingredient => String(ingredient.id) === value);
                            updateRestockRow(row.key, { ingredientId: value, brandName: selected?.brand_name || '' });
                          }}
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
                      <div className="col-span-12 md:col-span-3">
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Purchased unit</label>
                        <SearchableSelect
                          value={row.purchasedUnit}
                          onChange={(value) => updateRestockRow(row.key, { purchasedUnit: value })}
                          placeholder="Select unit"
                          searchPlaceholder="Search units..."
                          options={PURCHASED_UNITS}
                          sortOptions={false}
                          className="glass-card border-0 px-3 py-2.5"
                        />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Brand</label>
                        <input
                          type="text"
                          value={row.brandName}
                          onChange={(e) => updateRestockRow(row.key, { brandName: e.target.value })}
                          className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                          placeholder="Brand name"
                        />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">
                          Purchased quantity
                        </label>
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
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Purchasing Cost</label>
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
                      {packageUnitSelected && selectedIng && (
                        <div className="col-span-12 md:col-span-5">
                          <label className="block text-xs font-semibold text-neutral-600 mb-1">
                            {getPackageQuantityLabel(selectedIng.unit, row.purchasedUnit)}
                          </label>
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={row.packageQuantity}
                            onChange={(e) => updateRestockRow(row.key, { packageQuantity: e.target.value })}
                            className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            placeholder="0"
                          />
                        </div>
                      )}
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
                      {convertedQuantity !== null && selectedIng && (
                        <div className="col-span-12 mt-2 text-[11px] text-neutral-500 italic flex items-center gap-1">
                          <Package className="w-3 h-3" />
                          Will add {convertedQuantity.toFixed(2)} {unitLabel(selectedIng.unit)} to stock
                          {convertedUnitCost !== null && ` at Rs. ${convertedUnitCost.toFixed(2)} per ${unitLabel(selectedIng.unit)}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={addRestockRow}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-white/80 bg-white/70 hover:bg-white/90 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add another item
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
                  Restock All Items
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showBulkAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
          <div className="glass-floating w-full max-w-5xl my-auto flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900">Add raw materials</h3>
              <button onClick={handleCloseBulkAdd} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmitBulkAdd} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {bulkAddError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm font-medium">
                  {bulkAddError}
                </div>
              )}

              <div className="space-y-4">
                {bulkAddRows.map((row) => (
                  <div key={row.key} className="grid grid-cols-12 gap-3 items-end glass-card p-4 rounded-xl border border-white/40">
                    <div className="col-span-12 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Supplier</label>
                      <SearchableSelect
                        value={row.supplierId}
                        onChange={(val) => updateBulkAddRow(row.key, { supplierId: val })}
                        placeholder="--"
                        options={suppliers.map(s => ({ value: String(s.id), label: s.name }))}
                        className="glass-card border-0 px-2 py-1.5"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-3">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Name *</label>
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => updateBulkAddRow(row.key, { name: e.target.value })}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        placeholder="e.g. Flour"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Brand *</label>
                      <input
                        type="text"
                        value={row.brandName}
                        onChange={(e) => updateBulkAddRow(row.key, { brandName: e.target.value })}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        placeholder="e.g. National"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Unit *</label>
                      <SearchableSelect
                        value={row.unit}
                        onChange={(val) => updateBulkAddRow(row.key, { unit: val })}
                        options={UNITS}
                        sortOptions={false}
                        className="glass-card border-0 px-2 py-1.5"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">SKU</label>
                      <input
                        type="text"
                        value={row.sku}
                        onChange={(e) => updateBulkAddRow(row.key, { sku: e.target.value, skuTouched: true })}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        placeholder="Auto-generated"
                      />
                    </div>
                    <div className="col-span-6 md:col-span-2">
                      <label className="block text-xs font-semibold text-neutral-600 mb-1">Price</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={row.lastPurchasePrice}
                        onChange={(e) => updateBulkAddRow(row.key, { lastPurchasePrice: e.target.value })}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      />
                    </div>
                    <div className="col-span-12 md:col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeBulkAddRow(row.key)}
                        className="p-2 rounded-lg text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-between items-center pt-2">
                <button
                  type="button"
                  onClick={addBulkAddRow}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-white/80 bg-white/70 hover:bg-white/90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add another material
                </button>
              </div>

              <div className="flex gap-3 pt-4 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={handleCloseBulkAdd}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={bulkAddSubmitting}
                  className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target"
                >
                  {bulkAddSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create All Materials
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
