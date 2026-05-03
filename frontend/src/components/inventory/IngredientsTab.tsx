import React, { useState, useEffect, useMemo } from 'react';
import { Plus, X, Loader2, Pencil, Package, Layers, ArrowUpDown, ArrowUp, ArrowDown, Scale } from 'lucide-react';
import { get, post, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { generateAutoSku } from '../../utils/sku';
import {
  formatBaseQuantityGlobal,
  getSelectableInputUnits,
  type IngredientUnitFields,
  normalizeUnitToken,
  quantityToStorageBase,
  toBaseUnit,
} from '../../utils/unitConversion';
import {
  defaultPackagingUnitForStorage,
  emptyPackagingForm,
  packagingFromSavedConversions,
  packagingLinesToUnitConversions,
  PackagingInputForSelectedUnit,
  PackagingMasterOptional,
  type PackagingFormValue,
} from './PackagingSection';

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
  unit_conversions?: Record<string, number>;
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
  packageQty: string;
  packageUnit: string;
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
  packaging: PackagingFormValue;
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

const ORDER_UNIT_LABELS: Record<string, string> = {
  kg: 'Kg',
  g: 'g',
  ltr: 'Ltr',
  ml: 'ml',
  pcs: 'Pcs',
  carton: 'Carton',
  packet: 'Packet',
};

function isPackagingOrderUnit(unit: string): boolean {
  const t = normalizeUnitToken(unit);
  return t === 'carton' || t === 'packet';
}

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
  const fromForm = UNITS.find((option) => option.value === normalized)?.label;
  if (fromForm) return fromForm;
  const tok = normalizeUnitToken(unit || '');
  const orderKey = tok === 'l' ? 'ltr' : tok === 'piece' ? 'pcs' : tok;
  return ORDER_UNIT_LABELS[orderKey] || ORDER_UNIT_LABELS[tok] || unit || 'unit';
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

function computeRestockLinePreview(
  ing: Ingredient,
  row: RestockRow
): { baseQty: number | null; unitCostPerBase: number | null } {
  const purchasedQuantity = Number.parseFloat(row.quantity);
  const purchasingCost = Number.parseFloat(row.unitCost);
  if (!Number.isFinite(purchasedQuantity) || purchasedQuantity <= 0) {
    return { baseQty: null, unitCostPerBase: null };
  }
  let ingUse = ing;
  if (isPackagingOrderUnit(row.purchasedUnit) && row.packageQty.trim()) {
    try {
      const pq = parseFloat(row.packageQty);
      const basePer =
        Number.isFinite(pq) && pq > 0 && row.packageUnit.trim()
          ? quantityToStorageBase(pq, row.packageUnit, ing.unit)
          : NaN;
      if (Number.isFinite(basePer) && basePer > 0) {
        const key = row.purchasedUnit.trim().toLowerCase() as 'carton' | 'packet';
        ingUse = {
          ...ing,
          unit_conversions: { ...(ing.unit_conversions || {}), [key]: basePer },
        };
      }
    } catch {
      ingUse = ing;
    }
  }
  try {
    const baseQty = toBaseUnit(purchasedQuantity, row.purchasedUnit, ingUse);
    const lineTotal = purchasedQuantity * (Number.isFinite(purchasingCost) ? purchasingCost : 0);
    const unitCostPerBase =
      row.unitCost.trim() !== '' && Number.isFinite(purchasingCost) && baseQty > 0
        ? lineTotal / baseQty
        : null;
    return { baseQty, unitCostPerBase };
  } catch {
    return { baseQty: null, unitCostPerBase: null };
  }
}

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
  const [formPackaging, setFormPackaging] = useState<PackagingFormValue>(() => emptyPackagingForm('kg'));
  const [formInitialQty, setFormInitialQty] = useState('');
  const [formInitialUnit, setFormInitialUnit] = useState('kg');
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

  const [stockAdjustIngredient, setStockAdjustIngredient] = useState<Ingredient | null>(null);
  const [stockAdjustDirection, setStockAdjustDirection] = useState<'add' | 'remove'>('add');
  const [stockAdjustQty, setStockAdjustQty] = useState('');
  const [stockAdjustUnit, setStockAdjustUnit] = useState('');
  const [stockAdjustReason, setStockAdjustReason] = useState('');
  const [stockAdjustError, setStockAdjustError] = useState('');
  const [stockAdjustSubmitting, setStockAdjustSubmitting] = useState(false);

  const createRestockRow = (): RestockRow => ({
    key: Math.random().toString(36).substring(7),
    ingredientId: '',
    quantity: '',
    unitCost: '',
    purchasedUnit: '',
    packageQty: '',
    packageUnit: 'g',
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
    packaging: emptyPackagingForm('kg'),
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
        const opts = selected ? getSelectableInputUnits(selected) : [];
        updated.purchasedUnit = opts[0] || '';
        updated.packageQty = '';
        if (selected) {
          updated.packageUnit = defaultPackagingUnitForStorage(selected.unit);
        }
      }
      if (patch.purchasedUnit !== undefined && !isPackagingOrderUnit(patch.purchasedUnit)) {
        updated.packageQty = '';
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

  const handleOpenStockAdjust = (ing: Ingredient) => {
    const opts = getSelectableInputUnits(ing);
    const defaultUnit = opts.length ? (opts.includes(ing.unit) ? ing.unit : opts[0]) : ing.unit;
    setStockAdjustIngredient(ing);
    setStockAdjustDirection('add');
    setStockAdjustQty('');
    setStockAdjustUnit(defaultUnit);
    setStockAdjustReason('');
    setStockAdjustError('');
  };

  const handleCloseStockAdjust = () => {
    setStockAdjustIngredient(null);
    setStockAdjustError('');
    setStockAdjustQty('');
    setStockAdjustReason('');
  };

  const handleSubmitStockAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    const ing = stockAdjustIngredient;
    if (!ing) return;
    const qty = parseFloat(stockAdjustQty.trim());
    if (!Number.isFinite(qty) || qty <= 0) {
      setStockAdjustError('Enter a positive quantity.');
      return;
    }

    const signed = stockAdjustDirection === 'add' ? qty : -qty;
    const payload: Record<string, unknown> = {
      ingredient_id: ing.id,
      stock_delta: signed,
      input_unit: stockAdjustUnit || ing.unit,
      reason: stockAdjustReason.trim() || undefined,
    };

    setStockAdjustSubmitting(true);
    setStockAdjustError('');
    try {
      await post('/stock/update', payload);
      showToast('Stock updated', 'success');
      handleCloseStockAdjust();
      await fetchData(true);
    } catch (error) {
      setStockAdjustError(getUserMessage(error));
    } finally {
      setStockAdjustSubmitting(false);
    }
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
          if (patch.unit !== undefined) {
            updated.packaging = emptyPackagingForm(patch.unit);
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

      const ucRow = packagingLinesToUnitConversions(row.packaging, row.unit);
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
        ...(ucRow ? { unit_conversions: ucRow } : {}),
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
    const items: {
      ingredient_id: number;
      quantity: number;
      input_unit: string;
      packaging_units_per_one?: number;
      unit_cost?: number;
      brand_name?: string;
    }[] = [];

    for (let i = 0; i < restockRows.length; i += 1) {
      const row = restockRows[i];
      const ingredientId = Number.parseInt(row.ingredientId, 10);
      const purchasedQuantity = Number.parseFloat(row.quantity);
      const unitCostText = row.unitCost.trim();
      const unitCost = unitCostText === '' ? undefined : Number.parseFloat(unitCostText);

      if (!Number.isFinite(ingredientId)) {
        setRestockError(`Row ${i + 1}: select a material.`);
        return;
      }

      const ing = ingredients.find((x) => x.id === ingredientId);
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

      let packagingBasePer: number | undefined;
      if (isPackagingOrderUnit(row.purchasedUnit)) {
        let ingConv: Ingredient = ing;
        if (row.packageQty.trim() && row.packageUnit.trim()) {
          try {
            const pq = parseFloat(row.packageQty);
            if (Number.isFinite(pq) && pq > 0) {
              packagingBasePer = quantityToStorageBase(pq, row.packageUnit, ing.unit);
              const k = row.purchasedUnit.trim().toLowerCase() as 'carton' | 'packet';
              if ((k === 'carton' || k === 'packet') && packagingBasePer != null && packagingBasePer > 0) {
                ingConv = {
                  ...ing,
                  unit_conversions: {
                    ...(ing.unit_conversions || {}),
                    [k]: packagingBasePer,
                  },
                };
              }
            }
          } catch {
            packagingBasePer = undefined;
          }
        }
        try {
          toBaseUnit(purchasedQuantity, row.purchasedUnit, ingConv);
        } catch {
          const message = row.packageQty.trim()
            ? `Row ${i + 1}: check the package quantity and unit, or set carton/packet on the material.`
            : `Row ${i + 1}: enter how many (quantity + unit) are in one ${row.purchasedUnit}, or set packaging on the material.`;
          setRestockError(message);
          return;
        }
      }

      if (unitCostText !== '' && (!Number.isFinite(unitCost) || (unitCost ?? 0) < 0)) {
        setRestockError(`Row ${i + 1}: purchasing cost must be 0 or greater.`);
        return;
      }

      const includePkg =
        isPackagingOrderUnit(row.purchasedUnit) &&
        packagingBasePer != null &&
        Number.isFinite(packagingBasePer) &&
        packagingBasePer > 0;

      items.push({
        ingredient_id: ingredientId,
        quantity: purchasedQuantity,
        input_unit: row.purchasedUnit,
        ...(includePkg ? { packaging_units_per_one: packagingBasePer } : {}),
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

  const handleOpenAddMaterial = () => {
    setEditingIngredient(null);
    setFormName('');
    setFormSku('');
    setFormSkuTouched(false);
    setFormBrandName('');
    setFormUnit('kg');
    setFormMinStock('0');
    setFormReorderQty('0');
    setFormLastPurchasePrice('0');
    setFormSupplierId('');
    setFormCategory('');
    setFormPackaging(emptyPackagingForm('kg'));
    setFormInitialQty('');
    setFormInitialUnit('kg');
    setFormError('');
    setShowModal(true);
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
    const uc = ing.unit_conversions || {};
    setFormPackaging(packagingFromSavedConversions(uc, ing.unit || 'kg'));
    setFormInitialQty('');
    setFormInitialUnit(ing.unit || 'kg');
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
      const ucMerged = packagingLinesToUnitConversions(formPackaging, formUnit);

      const payload: Record<string, unknown> = {
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
      if (ucMerged) {
        payload.unit_conversions = ucMerged;
      }

      if (!editingIngredient && formInitialQty.trim()) {
        const q = parseFloat(formInitialQty);
        if (!Number.isFinite(q) || q <= 0) {
          setFormError('Initial stock must be a positive number.');
          setSubmitting(false);
          return;
        }
        const synIng = {
          unit: formUnit,
          unitOfMeasure: formUnit,
          unit_conversions: ucMerged ?? {},
        };
        try {
          const iu = formInitialUnit || formUnit;
          payload.current_stock = toBaseUnit(q, iu, synIng);
        } catch (convErr) {
          setFormError(convErr instanceof Error ? convErr.message : 'Invalid initial stock conversion.');
          setSubmitting(false);
          return;
        }
      }

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

  const initialStockIngredientLike = useMemo(
    (): IngredientUnitFields => ({
      unit: formUnit,
      unitOfMeasure: formUnit,
      unit_conversions: packagingLinesToUnitConversions(formPackaging, formUnit) ?? {},
    }),
    [formUnit, formPackaging]
  );

  useEffect(() => {
    if (editingIngredient) return;
    const opts = getSelectableInputUnits(initialStockIngredientLike);
    if (opts.length && !opts.includes(formInitialUnit)) {
      setFormInitialUnit(opts[0] || formUnit);
    }
  }, [editingIngredient, formUnit, initialStockIngredientLike, formInitialUnit]);

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

  const stockAdjustPreview = useMemo(() => {
    if (!stockAdjustIngredient) return null;
    const ing = stockAdjustIngredient;
    const q = parseFloat(stockAdjustQty.trim());
    if (!Number.isFinite(q) || q <= 0) return null;
    try {
      const u = stockAdjustUnit || ing.unit;
      const deltaBase =
        stockAdjustDirection === 'add' ? toBaseUnit(q, u, ing) : -toBaseUnit(q, u, ing);
      const after = ing.current_stock + deltaBase;
      return { after, delta: deltaBase };
    } catch {
      return null;
    }
  }, [stockAdjustIngredient, stockAdjustDirection, stockAdjustQty, stockAdjustUnit]);

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="w-3.5 h-3.5 text-neutral-400" aria-hidden="true" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" />
      : <ArrowDown className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" />;
  };

  const sortHeaderBtnLeft =
    'flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white';
  const sortHeaderBtnRight =
    'flex w-full items-center justify-end gap-2 text-right transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white';

  return (
    <div className="mt-0 flex flex-col h-full min-h-0 overflow-hidden bg-transparent pt-2 pb-3">
      <div className="page-padding flex justify-between items-center bg-white/90 backdrop-blur-sm border-b border-soot-100/80 shrink-0 py-2">
        <h3 className="text-xl font-bold text-soot-900 hidden sm:block">Raw Materials</h3>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={handleOpenAddMaterial}
            className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-[8px] font-medium hover:bg-brand-600 touch-target transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add material
          </button>
          <button
            type="button"
            onClick={handleOpenBulkAdd}
            className="flex items-center gap-2 bg-white/80 border border-soot-200 text-soot-800 px-4 py-2 rounded-lg font-medium hover:bg-white touch-target transition-colors text-sm"
          >
            <Layers className="w-4 h-4" />
            Add multiple
          </button>
          <button
            onClick={handleOpenBulkRestock}
            className="flex items-center gap-2 bg-white/70 border border-white/70 text-soot-700 px-4 py-2 rounded-[8px] font-medium hover:bg-white/90 touch-target transition-colors"
          >
            <Layers className="w-4 h-4" />
            Restock
          </button>
        </div>
      </div>

      <div className="page-padding flex min-h-0 min-w-0 flex-1 flex-col overflow-auto pt-4 lg:pt-5">
        {loading ? (
          <div className="flex flex-1 items-center justify-center py-20 text-soot-400 gap-2">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading materials...
          </div>
        ) : ingredients.length === 0 ? (
           <div className="flex flex-1 flex-col items-center justify-center py-20 text-soot-400">
             <div className="w-16 h-16 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-4">
               <Package className="w-8 h-8 text-soot-300" />
             </div>
             <p className="text-lg font-medium mb-1">No materials yet</p>
             <p className="text-sm">Click "Add material" to start tracking inventory.</p>
           </div>
        ) : (
          <div className="app-table-shell">
            <div className="app-table-scroll max-h-[calc(100vh-18rem)] min-h-[22rem] overscroll-contain lg:max-h-[calc(100vh-16rem)]">
              <table className="app-table menu-items-table min-w-[760px]">
                <thead>
                  <tr>
                    <th
                      aria-sort={sortKey === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="sticky top-0 z-10"
                    >
                      <button type="button" onClick={() => handleSort('name')} className={sortHeaderBtnLeft}>
                        <span>Item</span>
                        {renderSortIcon('name')}
                      </button>
                    </th>
                    <th className="sticky top-0 z-10 text-left">Brand</th>
                    <th
                      aria-sort={sortKey === 'current_stock' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="sticky top-0 z-10 text-right"
                    >
                      <button type="button" onClick={() => handleSort('current_stock')} className={sortHeaderBtnRight}>
                        <span>Stock</span>
                        {renderSortIcon('current_stock')}
                      </button>
                    </th>
                    <th
                      aria-sort={sortKey === 'average_cost' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="sticky top-0 z-10 text-right"
                    >
                      <button type="button" onClick={() => handleSort('average_cost')} className={sortHeaderBtnRight}>
                        <span>Purchase Unit Cost</span>
                        {renderSortIcon('average_cost')}
                      </button>
                    </th>
                    <th
                      aria-sort={sortKey === 'supplier' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="sticky top-0 z-10 hidden text-left md:table-cell"
                    >
                      <button type="button" onClick={() => handleSort('supplier')} className={sortHeaderBtnLeft}>
                        <span>Supplier</span>
                        {renderSortIcon('supplier')}
                      </button>
                    </th>
                    <th
                      aria-sort={sortKey === 'id' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className="sticky top-0 z-10 text-right"
                    >
                      <button type="button" onClick={() => handleSort('id')} className={sortHeaderBtnRight}>
                        <span>Actions</span>
                        {renderSortIcon('id')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedIngredients.map((ing) => {
                    const supplier = suppliers.find((s) => s.id === ing.preferred_supplier_id);
                    const isLowStock = ing.current_stock <= ing.minimum_stock;
                    const purchaseUnitCost = getPurchasedUnitCost(ing);

                    return (
                      <tr key={ing.id} className="group transition-colors">
                        <td className="px-4 py-3.5 align-middle">
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-100">
                              {ing.name}
                            </span>
                            <span className="mt-0.5 font-mono text-[13px] font-medium text-neutral-500 dark:text-neutral-400">
                              {ing.sku || '—'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-middle text-sm text-neutral-700 dark:text-neutral-300">
                          {ing.brand_name || <span className="text-neutral-300 dark:text-neutral-600">—</span>}
                        </td>
                        <td className="px-4 py-3.5 align-middle text-right">
                          <div className="inline-flex items-center justify-end gap-2 text-[14px] font-semibold tabular-nums text-neutral-950 dark:text-neutral-100">
                            {isLowStock && (
                              <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Low stock" aria-hidden="true" />
                            )}
                            <span
                              className="leading-snug"
                              title={formatBaseQuantityGlobal(ing.current_stock, ing.unit, { ingredient: ing })}
                            >
                              {formatBaseQuantityGlobal(ing.current_stock, ing.unit, { ingredient: ing })}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 align-middle text-right">
                          <div className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-300">
                            {formatAverageUnitCost(purchaseUnitCost.amount)}
                          </div>
                          <div className="text-xs text-neutral-400 dark:text-neutral-500">
                            / {unitLabel(purchaseUnitCost.unit)}
                          </div>
                        </td>
                        <td className="hidden px-4 py-3.5 align-middle text-sm text-neutral-600 dark:text-neutral-400 md:table-cell">
                          {supplier ? supplier.name : <span className="text-neutral-300 dark:text-neutral-600">—</span>}
                        </td>
                        <td className="px-4 py-3.5 align-middle text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleOpenStockAdjust(ing)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                              title="Adjust stock"
                              aria-label={`Adjust stock for ${ing.name}`}
                            >
                              <Scale className="w-4 h-4" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenEdit(ing)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                              title="Edit material"
                              aria-label={`Edit ${ing.name}`}
                            >
                              <Pencil className="w-4 h-4" aria-hidden="true" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showModal && (
         <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
           <div className="glass-floating w-full max-w-lg my-auto flex flex-col max-h-[90vh] overflow-hidden">
             <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
                <h3 className="text-lg font-bold text-neutral-900">{editingIngredient ? 'Edit material' : 'Add raw material'}</h3>
                <button onClick={() => setShowModal(false)} className="p-1.5 rounded-[8px] hover:bg-neutral-200 transition-colors">
                  <X className="w-5 h-5 text-neutral-500" />
                </button>
             </div>

             <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
               {formError && (
                 <div className="bg-red-50 border border-red-200 text-red-700 rounded-[8px] px-4 py-2 text-sm font-medium">
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
                 {!editingIngredient && (
                   <div className="col-span-2 rounded-lg border border-brand-200/40 bg-white/30 p-3 space-y-2">
                     <p className="text-sm font-semibold text-neutral-800">Initial stock (optional)</p>
                     <p className="text-xs text-neutral-500">Set opening quantity in the unit you count or buy in. We store stock in the material base unit above.</p>
                     <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                       <div>
                         <label className="block text-xs font-semibold text-neutral-700 mb-1" htmlFor="ing-modal-init-qty">Quantity</label>
                         <input
                           id="ing-modal-init-qty"
                           type="number"
                           step="any"
                           min="0"
                           value={formInitialQty}
                           onChange={(e) => setFormInitialQty(e.target.value)}
                           className="w-full px-3 py-2 glass-card text-sm"
                           placeholder="e.g. 50"
                         />
                       </div>
                       <div>
                         <label className="block text-xs font-semibold text-neutral-700 mb-1" htmlFor="ing-modal-init-unit">Unit</label>
                         <select
                           id="ing-modal-init-unit"
                           value={formInitialUnit}
                           onChange={(e) => setFormInitialUnit(e.target.value)}
                           className="w-full px-3 py-2 glass-card text-sm"
                         >
                           {getSelectableInputUnits(initialStockIngredientLike).map((u) => (
                             <option key={u} value={u}>
                               {ORDER_UNIT_LABELS[u] || u}
                             </option>
                           ))}
                         </select>
                       </div>
                     </div>
                     <PackagingInputForSelectedUnit
                       storageUnit={formUnit}
                       selectedUnit={formInitialUnit}
                       value={formPackaging}
                       onChange={setFormPackaging}
                       idPrefix="ing-modal-init"
                     />
                   </div>
                 )}
                 <details className="col-span-2 group rounded-lg border border-neutral-200/50 bg-white/20 p-0 open:bg-white/30">
                   <summary className="cursor-pointer list-none px-3 py-2 text-sm font-semibold text-neutral-800 [&::-webkit-details-marker]:hidden">
                     Packaging sizes for carton/packet orders (optional)
                   </summary>
                   <div className="px-3 pb-3 pt-1 border-t border-neutral-100/80 space-y-2">
                     {editingIngredient && (
                       <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200/80 rounded-lg px-3 py-2">
                         Changing packaging will not affect existing stock.
                       </p>
                     )}
                     <PackagingMasterOptional
                       value={formPackaging}
                       onChange={setFormPackaging}
                       storageUnit={formUnit}
                       idPrefix="ing-modal-master"
                     />
                   </div>
                 </details>
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
                 <button type="button" onClick={() => setShowModal(false)} className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-[8px] text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">Cancel</button>
                 <button type="submit" disabled={submitting} className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target">
                   {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                   {editingIngredient ? 'Save changes' : 'Add material'}
                 </button>
               </div>
             </form>
           </div>
         </div>
      )}

      {stockAdjustIngredient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
          <div className="glass-floating w-full max-w-md my-auto flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900">Adjust stock</h3>
              <button
                type="button"
                onClick={handleCloseStockAdjust}
                className="p-1.5 rounded-[8px] hover:bg-neutral-200 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>
            <form onSubmit={handleSubmitStockAdjust} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {stockAdjustError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-[8px] px-4 py-2 text-sm font-medium">
                  {stockAdjustError}
                </div>
              )}
              <div>
                <p className="text-sm font-semibold text-neutral-900">{stockAdjustIngredient.name}</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Current:{' '}
                  <span className="font-medium text-neutral-800 tabular-nums">
                    {formatBaseQuantityGlobal(stockAdjustIngredient.current_stock, stockAdjustIngredient.unit, {
                      ingredient: stockAdjustIngredient,
                    })}
                  </span>{' '}
                  at this branch. Movements appear in stock reports.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStockAdjustDirection('add')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors touch-target ${
                    stockAdjustDirection === 'add'
                      ? 'border-brand-500 bg-brand-50 text-brand-900'
                      : 'border-neutral-200 text-neutral-600 hover:bg-white/60'
                  }`}
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setStockAdjustDirection('remove')}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors touch-target ${
                    stockAdjustDirection === 'remove'
                      ? 'border-brand-500 bg-brand-50 text-brand-900'
                      : 'border-neutral-200 text-neutral-600 hover:bg-white/60'
                  }`}
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-700 mb-1" htmlFor="stock-adj-qty">
                    Quantity
                  </label>
                  <input
                    id="stock-adj-qty"
                    type="number"
                    step="any"
                    min="0"
                    value={stockAdjustQty}
                    onChange={(e) => setStockAdjustQty(e.target.value)}
                    className="w-full px-3 py-2.5 glass-card text-sm tabular-nums focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    placeholder="e.g. 2.5"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-700 mb-1" htmlFor="stock-adj-unit">
                    Unit
                  </label>
                  <select
                    id="stock-adj-unit"
                    value={stockAdjustUnit}
                    onChange={(e) => setStockAdjustUnit(e.target.value)}
                    className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  >
                    {getSelectableInputUnits(stockAdjustIngredient).map((u) => (
                      <option key={u} value={u}>
                        {ORDER_UNIT_LABELS[u] || u}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1" htmlFor="stock-adj-reason">
                  Note (optional)
                </label>
                <input
                  id="stock-adj-reason"
                  type="text"
                  value={stockAdjustReason}
                  onChange={(e) => setStockAdjustReason(e.target.value)}
                  className="w-full px-3 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="e.g. Stock take correction, spoilage"
                  autoComplete="off"
                />
              </div>
              {stockAdjustPreview && stockAdjustPreview.after < -1e-9 && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200/80 rounded-lg px-3 py-2">
                  Resulting stock would be negative. Reduce the amount removed or switch to Add.
                </p>
              )}
              {stockAdjustPreview && stockAdjustPreview.after >= -1e-9 && (
                <p className="text-xs text-neutral-600 bg-white/30 border border-neutral-200/60 rounded-lg px-3 py-2">
                  After save:{' '}
                  <span className="font-semibold text-neutral-900 tabular-nums">
                    {formatBaseQuantityGlobal(Math.max(0, stockAdjustPreview.after), stockAdjustIngredient.unit, {
                      ingredient: stockAdjustIngredient,
                    })}
                  </span>
                  {Math.abs(stockAdjustPreview.delta) > 1e-9 && (
                    <span className="text-neutral-500">
                      {' '}
                      (
                      {stockAdjustPreview.delta > 0 ? '+' : ''}
                      {formatBaseQuantityGlobal(stockAdjustPreview.delta, stockAdjustIngredient.unit, {
                        ingredient: stockAdjustIngredient,
                      })}
                      )
                    </span>
                  )}
                </p>
              )}
              <p className="text-xs text-neutral-500">
                Purchases with updated cost should use <span className="font-medium text-neutral-700">Restock</span> instead.
              </p>
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseStockAdjust}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-[8px] text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors touch-target"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={stockAdjustSubmitting || (stockAdjustPreview !== null && stockAdjustPreview.after < -1e-9)}
                  className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target"
                >
                  {stockAdjustSubmitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  Update stock
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
              <button onClick={handleCloseBulkRestock} className="p-1.5 rounded-[8px] hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmitBulkRestock} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {restockError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-[8px] px-4 py-2 text-sm font-medium">
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
                  const unitOpts = selectedIng ? getSelectableInputUnits(selectedIng) : [];
                  const preview =
                    selectedIng && row.purchasedUnit
                      ? computeRestockLinePreview(selectedIng, row)
                      : { baseQty: null as number | null, unitCostPerBase: null as number | null };
                  const convertedQuantity = preview.baseQty;
                  const convertedUnitCost = preview.unitCostPerBase;

                  return (
                    <div key={row.key} className="grid grid-cols-12 gap-2 items-end glass-card p-4 rounded-[11px] border border-white/40">
                      <div className="col-span-12 md:col-span-4">
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Item</label>
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
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Unit</label>
                        <SearchableSelect
                          value={row.purchasedUnit}
                          onChange={(value) => updateRestockRow(row.key, { purchasedUnit: value })}
                          placeholder="Select unit"
                          searchPlaceholder="Search units…"
                          options={unitOpts.map((u) => ({ value: u, label: ORDER_UNIT_LABELS[u] || u }))}
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
                        <label className="block text-xs font-semibold text-neutral-600 mb-1">Price (optional)</label>
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
                      {selectedIng && (
                        <div className="col-span-12">
                          <PackagingInputForSelectedUnit
                            storageUnit={selectedIng.unit}
                            selectedUnit={row.purchasedUnit}
                            override={{ qty: row.packageQty, unit: row.packageUnit }}
                            onOverrideChange={(next) =>
                              updateRestockRow(row.key, { packageQty: next.qty, packageUnit: next.unit })
                            }
                            idPrefix={`restock-${row.key}`}
                          />
                        </div>
                      )}
                      <div className="col-span-12 md:col-span-1 flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeRestockRow(row.key)}
                          className="p-2 rounded-[8px] text-neutral-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                          title={`Remove row ${idx + 1}`}
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {convertedQuantity !== null && selectedIng && (
                        <div className="col-span-12 mt-1 text-[11px] text-neutral-500 italic flex items-center gap-1">
                          <Package className="w-3 h-3" />
                          Will add {formatBaseQuantityGlobal(convertedQuantity, selectedIng.unit, { ingredient: selectedIng })} to stock
                          {convertedUnitCost !== null && ` at Rs. ${convertedUnitCost.toFixed(2)} / base unit`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={addRestockRow}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-[8px] border border-white/80 bg-white/70 hover:bg-white/90 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add another item
              </button>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseBulkRestock}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-[8px] text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={restockSubmitting}
                  className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target"
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
              <button onClick={handleCloseBulkAdd} className="p-1.5 rounded-[8px] hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmitBulkAdd} className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {bulkAddError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-[8px] px-4 py-2 text-sm font-medium">
                  {bulkAddError}
                </div>
              )}

              <div className="space-y-4">
                {bulkAddRows.map((row) => (
                  <div key={row.key} className="grid grid-cols-12 gap-3 items-end glass-card p-4 rounded-[11px] border border-white/40">
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
                    <details className="col-span-12 group rounded-lg border border-neutral-200/50 bg-white/15">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-neutral-700">
                        Packaging for carton/packet orders (optional)
                      </summary>
                      <div className="px-3 pb-3">
                        <PackagingMasterOptional
                          value={row.packaging}
                          onChange={(p) => updateBulkAddRow(row.key, { packaging: p })}
                          storageUnit={row.unit}
                          idPrefix={`bulk-${row.key}`}
                        />
                      </div>
                    </details>
                    <div className="col-span-12 md:col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeBulkAddRow(row.key)}
                        className="p-2 rounded-[8px] text-neutral-400 hover:text-red-600 hover:bg-red-50 transition-colors"
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
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-[8px] border border-white/80 bg-white/70 hover:bg-white/90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add another material
                </button>
              </div>

              <div className="flex gap-3 pt-4 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={handleCloseBulkAdd}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-[8px] text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={bulkAddSubmitting}
                  className="flex-1 px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 touch-target"
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
