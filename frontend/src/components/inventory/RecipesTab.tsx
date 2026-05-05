import React, { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import { Plus, X, Loader2, Trash2, ArrowRight, Utensils, PackageSearch, Pencil } from 'lucide-react';
import { get, post, patch, del, getUserMessage } from '../../api';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';
import {
  formatBaseQuantityGlobal,
  getSelectableInputUnits,
  ingredientBaseToInputQuantity,
  storageBaseToInputQuantity,
} from '../../utils/unitConversion';

type Product = {
  id: number;
  title: string;
  sku: string;
  base_price: number;
  sale_price?: number;
  variants?: { name: string; basePrice: number; salePrice: number; sku?: string }[];
  is_deal?: boolean;
};

type Ingredient = {
  id: number;
  name: string;
  unit: string;
  average_cost: number;
  purchase_unit?: string;
  conversion_factor?: number;
  unit_conversions?: Record<string, number>;
};

type PreparedItemComponent = {
  id: number;
  ingredient_id: number;
  quantity: number;
  unit: string;
};

type PreparedItem = {
  id: number;
  name: string;
  kind: 'sauce' | 'marination';
  unit: string;
  average_cost: number;
  components?: PreparedItemComponent[];
};

type RecipeItem = {
  id: number;
  product_id: number;
  ingredient_id: number;
  quantity: number;
  unit: string;
  notes?: string;
  variant_key?: string;
};

type RecipePreparedItem = {
  id: number;
  product_id: number;
  prepared_item_id: number;
  quantity: number;
  unit: string;
  notes?: string;
  variant_key?: string;
};

type RecipeExtraCost = {
  id: number;
  product_id: number;
  name: string;
  amount: number;
  variant_key?: string;
};

type RecipeLineEdit =
  | { kind: 'ingredient'; row: RecipeItem }
  | { kind: 'prepared'; row: RecipePreparedItem }
  | { kind: 'extra'; row: RecipeExtraCost };

type BomSectionModel = {
  scopeKey: string;
  label: string;
  recipeRows: RecipeItem[];
  preparedRows: RecipePreparedItem[];
  extraRows: RecipeExtraCost[];
  sectionCost: number;
};

function vkNorm(vk: string | undefined): string {
  return (vk || '').trim();
}

export type RecipesTabProps = {
  /** When set (e.g. from `/inventory?tab=recipes&recipeProduct=123`), select this menu item once data loads. */
  initialFocusProductId?: number | null;
  /** Called after the initial focus is applied or determined invalid, so the URL can drop `recipeProduct`. */
  onInitialRecipeFocusConsumed?: () => void;
};

export default function RecipesTab({
  initialFocusProductId = null,
  onInitialRecipeFocusConsumed,
}: RecipesTabProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [preparedItems, setPreparedItems] = useState<PreparedItem[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  /** '' = base BOM (all variants unless a variant-specific BOM exists); else exact variant label */
  const [recipeVariantScope, setRecipeVariantScope] = useState('');
  const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([]);
  const [recipePreparedItems, setRecipePreparedItems] = useState<RecipePreparedItem[]>([]);
  const [recipeExtraCosts, setRecipeExtraCosts] = useState<RecipeExtraCost[]>([]);
  const [loadingRecipe, setLoadingRecipe] = useState(false);

  // Form
  const [showAddForm, setShowAddForm] = useState(false);
  const [formMaterialType, setFormMaterialType] = useState<'ingredient' | 'prepared'>('ingredient');
  const [formIngredientId, setFormIngredientId] = useState('');
  const [formPreparedItemId, setFormPreparedItemId] = useState('');
  const [formQuantity, setFormQuantity] = useState('');
  const [formInputUnit, setFormInputUnit] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [scrollToRowId, setScrollToRowId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const addFormRef = useRef<HTMLFormElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showExtraCostForm, setShowExtraCostForm] = useState(false);
  const [extraCostName, setExtraCostName] = useState('');
  const [extraCostAmount, setExtraCostAmount] = useState('');
  const [recipeLineEdit, setRecipeLineEdit] = useState<RecipeLineEdit | null>(null);

  const initialFocusAppliedRef = useRef(false);

  const selectedProduct = useMemo(
    () => (selectedProductId != null ? products.find((p) => p.id === selectedProductId) : undefined),
    [products, selectedProductId]
  );

  const bomSections = useMemo((): BomSectionModel[] => {
    if (!selectedProduct) return [];
    const variantNames = (selectedProduct.variants || [])
      .map((v) => (v?.name || '').trim())
      .filter(Boolean);
    const hasVariantScopes = variantNames.length > 0;
    const orderedKeys: string[] = hasVariantScopes ? [] : [''];
    for (const n of variantNames) {
      if (!orderedKeys.includes(n)) orderedKeys.push(n);
    }
    const fromData = new Set<string>();
    recipeItems.forEach((ri) => fromData.add(vkNorm(ri.variant_key)));
    recipePreparedItems.forEach((ri) => fromData.add(vkNorm(ri.variant_key)));
    recipeExtraCosts.forEach((ec) => fromData.add(vkNorm(ec.variant_key)));
    fromData.forEach((k) => {
      if (hasVariantScopes && k === '') return;
      if (!orderedKeys.includes(k)) orderedKeys.push(k);
    });

    return orderedKeys.map((scopeKey) => {
      const recipeRows = recipeItems.filter((ri) => vkNorm(ri.variant_key) === scopeKey);
      const preparedRows = recipePreparedItems.filter((ri) => vkNorm(ri.variant_key) === scopeKey);
      const extraRows = recipeExtraCosts.filter((ec) => vkNorm(ec.variant_key) === scopeKey);
      let sectionCost = 0;
      recipeRows.forEach((ri) => {
        const ing = ingredients.find((i) => i.id === ri.ingredient_id);
        if (ing) sectionCost += (ing.average_cost || 0) * ri.quantity;
      });
      preparedRows.forEach((ri) => {
        const p = preparedItems.find((i) => i.id === ri.prepared_item_id);
        if (p) sectionCost += (p.average_cost || 0) * ri.quantity;
      });
      extraRows.forEach((ec) => {
        sectionCost += Number(ec.amount || 0);
      });
      const label = scopeKey === '' ? 'Base recipe' : `Variant: ${scopeKey}`;
      return { scopeKey, label, recipeRows, preparedRows, extraRows, sectionCost };
    });
  }, [selectedProduct, recipeItems, recipePreparedItems, recipeExtraCosts, ingredients, preparedItems]);

  const activeBomSection = useMemo((): BomSectionModel => {
    const key = vkNorm(recipeVariantScope);
    const found = bomSections.find((s) => s.scopeKey === key);
    if (found) return found;
    return {
      scopeKey: key,
      label: key === '' ? 'Base recipe' : `Variant: ${key}`,
      recipeRows: [],
      preparedRows: [],
      extraRows: [],
      sectionCost: 0,
    };
  }, [bomSections, recipeVariantScope]);

  useEffect(() => {
    fetchBaseData();
  }, []);

  /** Deep-link from Menu catalog: open this product's BOM once lists are ready. */
  useEffect(() => {
    if (loadingInitial || initialFocusProductId == null) return;
    if (initialFocusAppliedRef.current) return;
    const product = products.find((item) => item.id === initialFocusProductId);
    if (!product) {
      if (products.length > 0) {
        initialFocusAppliedRef.current = true;
        showToast('That menu item was not found in the recipe list.', 'error');
        onInitialRecipeFocusConsumed?.();
      }
      return;
    }
    initialFocusAppliedRef.current = true;
    selectProductForRecipe(initialFocusProductId);
    onInitialRecipeFocusConsumed?.();
  }, [
    loadingInitial,
    initialFocusProductId,
    products,
    onInitialRecipeFocusConsumed,
  ]);

  useEffect(() => {
    if (!selectedProduct) return;
    const firstVariant = (selectedProduct.variants || [])
      .map((variant) => (variant?.name || '').trim())
      .find(Boolean);
    if (firstVariant && !recipeVariantScope) {
      setRecipeVariantScope(firstVariant);
    }
    if (!firstVariant && recipeVariantScope) {
      setRecipeVariantScope('');
    }
  }, [selectedProduct, recipeVariantScope]);

  useEffect(() => {
    if (recipeLineEdit) return;
    if (formMaterialType === 'ingredient' && formIngredientId) {
      const ing = ingredients.find((i) => i.id.toString() === formIngredientId);
      if (ing) {
        const opts = getSelectableInputUnits(ing);
        setFormInputUnit(opts[0] || ing.unit);
      }
    } else if (formMaterialType === 'prepared' && formPreparedItemId) {
      const p = preparedItems.find((i) => i.id.toString() === formPreparedItemId);
      if (p) {
        const opts = getSelectableInputUnits(p.unit);
        setFormInputUnit(opts[0] || p.unit);
      }
    }
  }, [recipeLineEdit, formMaterialType, formIngredientId, formPreparedItemId, ingredients, preparedItems]);

  useEffect(() => {
    if (!recipeLineEdit) return;
    if (recipeLineEdit.kind === 'extra') {
      setExtraCostName(recipeLineEdit.row.name);
      setExtraCostAmount(String(recipeLineEdit.row.amount));
      return;
    }
    if (recipeLineEdit.kind === 'ingredient') {
      const ri = recipeLineEdit.row;
      const ing = ingredients.find((i) => i.id === ri.ingredient_id);
      if (!ing) return;
      setFormMaterialType('ingredient');
      setFormIngredientId(String(ri.ingredient_id));
      const opts = getSelectableInputUnits(ing);
      const inputU = opts[0] || ing.unit;
      setFormInputUnit(inputU);
      try {
        const q = ingredientBaseToInputQuantity(ri.quantity, inputU, ing);
        setFormQuantity(String(Number.isFinite(q) ? q : ri.quantity));
      } catch {
        setFormQuantity(String(ri.quantity));
      }
      setFormNotes((ri.notes as string | undefined) || '');
      return;
    }
    const ri = recipeLineEdit.row;
    const p = preparedItems.find((i) => i.id === ri.prepared_item_id);
    if (!p) return;
    setFormMaterialType('prepared');
    setFormPreparedItemId(String(ri.prepared_item_id));
    const opts = getSelectableInputUnits(p.unit);
    const unitStr = p.unit;
    const inputU = opts[0] || unitStr;
    setFormInputUnit(inputU);
    try {
      const q = storageBaseToInputQuantity(ri.quantity, inputU, unitStr);
      setFormQuantity(String(Number.isFinite(q) ? q : ri.quantity));
    } catch {
      setFormQuantity(String(ri.quantity));
    }
    setFormNotes((ri.notes as string | undefined) || '');
  }, [recipeLineEdit, ingredients, preparedItems]);

  useLayoutEffect(() => {
    if (!scrollToRowId) return;
    const el = rowRefs.current.get(scrollToRowId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setScrollToRowId(null);
  }, [scrollToRowId, recipeItems, recipePreparedItems, recipeExtraCosts]);

  const fetchBaseData = async () => {
    setLoadingInitial(true);
    try {
      // Need all menu items and all ingredients
      const [prodRes, ingRes, preparedRes] = await Promise.all([
        get<{ products: Product[] }>('/menu-items/', { forceRefresh: true, cacheTtlMs: 0 }),
        get<{ ingredients: Ingredient[] }>('/inventory-advanced/ingredients'),
        get<{ prepared_items: PreparedItem[] }>('/inventory-advanced/prepared-items')
      ]);
      setProducts((prodRes.products || []).filter((product) => !product.is_deal));
      setIngredients(ingRes.ingredients || []);
      setPreparedItems(preparedRes.prepared_items || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingInitial(false);
    }
  };

  const refreshRecipeData = async (productId: number) => {
    setLoadingRecipe(true);
    try {
      const res = await get<{ recipe_items: RecipeItem[]; recipe_prepared_items: RecipePreparedItem[]; recipe_extra_costs?: RecipeExtraCost[] }>(
        `/inventory-advanced/recipes/${productId}`,
        { forceRefresh: true, cacheTtlMs: 0 }
      );
      setRecipeItems(res.recipe_items || []);
      setRecipePreparedItems(res.recipe_prepared_items || []);
      setRecipeExtraCosts(res.recipe_extra_costs || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingRecipe(false);
    }
  };

  /** Call when user picks a menu item. Resets recipe scope only when switching products. */
  const selectProductForRecipe = (productId: number) => {
    const switchingProduct = selectedProductId !== productId;
    const product = products.find((item) => item.id === productId);
    const firstVariant = (product?.variants || [])
      .map((variant) => (variant?.name || '').trim())
      .find(Boolean);
    setSelectedProductId(productId);
    if (switchingProduct) {
      setRecipeVariantScope(firstVariant || '');
    }
    setShowAddForm(false);
    setShowExtraCostForm(false);
    setRecipeLineEdit(null);
    void refreshRecipeData(productId);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !formQuantity) return;

    const qty = parseFloat(formQuantity);
    if (isNaN(qty) || qty <= 0) {
      showToast('Enter a valid quantity', 'error');
      return;
    }

    const ing = ingredients.find((i) => i.id.toString() === formIngredientId);
    const prepared = preparedItems.find((i) => i.id.toString() === formPreparedItemId);
    if (formMaterialType === 'ingredient' && !ing) return;
    if (formMaterialType === 'prepared' && !prepared) return;

    setSubmitting(true);
    try {
      let newRowKey: string | null = null;
      if (recipeLineEdit?.kind === 'ingredient' && ing) {
        const opts = getSelectableInputUnits(ing);
        const inputU =
          formInputUnit && opts.includes(formInputUnit) ? formInputUnit : opts[0] || ing.unit;
        await patch(`/inventory-advanced/recipes/${recipeLineEdit.row.id}`, {
          ingredient_id: parseInt(formIngredientId, 10),
          quantity: qty,
          unit: inputU,
          notes: formNotes || undefined,
          variant_key: vkNorm(recipeLineEdit.row.variant_key),
        });
        newRowKey = `ing-${recipeLineEdit.row.id}`;
        showToast('Recipe line updated', 'success');
        setRecipeLineEdit(null);
        setShowAddForm(false);
      } else if (recipeLineEdit?.kind === 'prepared' && prepared) {
        const opts = getSelectableInputUnits(prepared.unit);
        const inputU =
          formInputUnit && opts.includes(formInputUnit) ? formInputUnit : opts[0] || prepared.unit;
        await patch(`/inventory-advanced/recipes/prepared-items/${recipeLineEdit.row.id}`, {
          prepared_item_id: parseInt(formPreparedItemId, 10),
          quantity: qty,
          unit: inputU,
          notes: formNotes || undefined,
          variant_key: vkNorm(recipeLineEdit.row.variant_key),
        });
        newRowKey = `prep-${recipeLineEdit.row.id}`;
        showToast('Recipe line updated', 'success');
        setRecipeLineEdit(null);
        setShowAddForm(false);
      } else if (formMaterialType === 'ingredient' && ing) {
        const opts = getSelectableInputUnits(ing);
        const inputU =
          formInputUnit && opts.includes(formInputUnit) ? formInputUnit : opts[0] || ing.unit;

        const res = await post<{ id: number }>('/inventory-advanced/recipes', {
          product_id: selectedProductId,
          ingredient_id: parseInt(formIngredientId, 10),
          quantity: qty,
          unit: inputU,
          notes: formNotes || undefined,
          variant_key: recipeVariantScope || '',
        });
        if (res && typeof res === 'object' && 'id' in res) {
          newRowKey = `ing-${(res as { id: number }).id}`;
        }
        showToast('Material added to recipe', 'success');
      } else if (prepared) {
        const opts = getSelectableInputUnits(prepared.unit);
        const inputU =
          formInputUnit && opts.includes(formInputUnit) ? formInputUnit : opts[0] || prepared.unit;
        const res = await post<{ id: number }>('/inventory-advanced/recipes/prepared-items', {
          product_id: selectedProductId,
          prepared_item_id: parseInt(formPreparedItemId, 10),
          quantity: qty,
          unit: inputU,
          notes: formNotes || undefined,
          variant_key: recipeVariantScope || '',
        });
        if (res && typeof res === 'object' && 'id' in res) {
          newRowKey = `prep-${(res as { id: number }).id}`;
        }
        showToast('Material added to recipe', 'success');
      }

      setFormIngredientId('');
      setFormPreparedItemId('');
      setFormQuantity('');
      setFormNotes('');
      setShowAddForm(false);
      if (selectedProductId) {
        await refreshRecipeData(selectedProductId);
        if (newRowKey) setScrollToRowId(newRowKey);
      }
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (itemId: number, materialType: 'ingredient' | 'prepared' = 'ingredient') => {
    try {
      await del(materialType === 'ingredient' ? `/inventory-advanced/recipes/${itemId}` : `/inventory-advanced/recipes/prepared-items/${itemId}`);
      showToast('Removed from recipe', 'success');
      if (selectedProductId) void refreshRecipeData(selectedProductId);
    } catch (e) {
       showToast(getUserMessage(e), 'error');
    }
  };

  if (loadingInitial) {
    return (
      <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading setup...
      </div>
    );
  }

  const formIngredientResolved = ingredients.find(i => i.id.toString() === formIngredientId);
  const formPreparedResolved = preparedItems.find(i => i.id.toString() === formPreparedItemId);

  const handleAddExtraCost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId) return;
    const name = extraCostName.trim();
    const amount = Number(extraCostAmount);
    if (!name) {
      showToast('Enter cost name', 'error');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      showToast('Enter a valid non-negative cost amount', 'error');
      return;
    }
    setSubmitting(true);
    try {
      if (recipeLineEdit?.kind === 'extra') {
        await patch(`/inventory-advanced/recipes/extra-costs/${recipeLineEdit.row.id}`, {
          name,
          amount,
          variant_key: vkNorm(recipeLineEdit.row.variant_key),
        });
        showToast('Extra cost updated', 'success');
        setRecipeLineEdit(null);
      } else {
        await post('/inventory-advanced/recipes/extra-costs', {
          product_id: selectedProductId,
          name,
          amount,
          variant_key: recipeVariantScope || '',
        });
        showToast('Extra cost added', 'success');
      }
      setExtraCostName('');
      setExtraCostAmount('');
      setShowExtraCostForm(false);
      await refreshRecipeData(selectedProductId);
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteExtraCost = async (extraCostId: number) => {
    try {
      await del(`/inventory-advanced/recipes/extra-costs/${extraCostId}`);
      showToast('Extra cost removed', 'success');
      if (selectedProductId) await refreshRecipeData(selectedProductId);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const scopeOptions =
    selectedProduct && selectedProduct.variants && selectedProduct.variants.length > 0
      ? selectedProduct.variants.map((variant) => ({
            value: variant?.name || '',
            label: `Variant: ${variant?.name || 'Select Variant'}`,
            searchText: variant?.name || '',
          }))
      : [{ value: '', label: 'Base recipe', searchText: 'base' }];

  const hasAnyBomLines =
    recipeItems.length > 0 || recipePreparedItems.length > 0 || recipeExtraCosts.length > 0;
  const viewRowCount =
    activeBomSection.recipeRows.length +
    activeBomSection.preparedRows.length +
    activeBomSection.extraRows.length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,30%)_minmax(0,1fr)] gap-4 h-full min-h-0 bg-transparent py-4 px-4 lg:px-6">
      {/* Product List Sidebar */}
      <div className="flex flex-col glass-card min-h-[36vh] lg:min-h-0 lg:h-full overflow-hidden shrink-0 rounded-xl border border-white/25">
        <div className="px-3 py-2 border-b border-white/20 bg-white/10 shrink-0">
          <h3 className="font-bold text-soot-900">Select Menu Item</h3>
          <p className="text-xs text-soot-500 mt-0.5">Choose an item to manage its Bill of Materials</p>
        </div>
        <div className="overflow-y-auto flex-1 p-1.5 space-y-0.5">
          {products.map(p => (
            <button
              key={p.id}
              onClick={() => selectProductForRecipe(p.id)}
              className={`w-full text-left px-3 py-2.5 rounded-[8px] transition-colors flex items-center justify-between group ${
                selectedProductId === p.id 
                  ? 'bg-brand-600 text-white' 
                  : 'hover:bg-white/40 text-soot-700'
              }`}
            >
              <div className="min-w-0">
                <div className={`font-semibold truncate ${selectedProductId === p.id ? 'text-white' : 'text-soot-900'}`}>
                  {p.title}
                </div>
                <div className={`text-xs font-mono truncate ${selectedProductId === p.id ? 'text-brand-100' : 'text-soot-500'}`}>
                  {p.sku}
                </div>
              </div>
              <ArrowRight className={`w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ${selectedProductId === p.id ? 'text-brand-200 opacity-100' : 'text-soot-400'}`} />
            </button>
          ))}
          {products.length === 0 && (
            <div className="p-4 text-center text-soot-500 text-sm">No menu items found.</div>
          )}
        </div>
      </div>

      {/* Recipe Builder Main Area */}
      <div className="flex flex-col min-h-0 min-w-0 overflow-hidden lg:h-full">
        {!selectedProduct ? (
          <div className="glass-card h-full flex flex-col items-center justify-center p-8 text-center text-soot-400 rounded-xl border border-white/25">
            <Utensils className="w-12 h-12 mb-4 text-soot-300" />
            <p className="text-lg font-medium text-soot-600">No Item Selected</p>
            <p className="text-sm mt-1">Select a menu item from the list to view or build its recipe.</p>
          </div>
        ) : (
          <div className="glass-card flex-1 flex flex-col min-h-0 overflow-hidden relative rounded-xl border border-white/25">
            {/* Sticky header */}
            <header className="sticky top-0 z-10 shrink-0 border-b border-soot-200/70 bg-white/95 backdrop-blur-md px-3 py-2 md:px-4 md:py-3 flex flex-wrap gap-3 justify-between items-start shadow-sm">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg md:text-xl font-bold text-soot-900 truncate" title={selectedProduct.title}>
                  {selectedProduct.title}
                </h2>
                <div className="flex gap-2 text-xs md:text-sm mt-0.5 flex-wrap text-soot-600">
                  <span className="font-mono text-soot-500">{selectedProduct.sku}</span>
                  <span className="text-soot-300">|</span>
                  <span>Sell {formatCurrency(selectedProduct.sale_price ?? selectedProduct.base_price)}</span>
                </div>
                <div className="mt-2 max-w-full md:max-w-md">
                  <label className="block text-[10px] font-semibold text-soot-500 uppercase tracking-wider mb-0.5">
                    BOM scope (view &amp; add lines)
                  </label>
                  <SearchableSelect
                    value={recipeVariantScope}
                    onChange={setRecipeVariantScope}
                    placeholder="Scope"
                    searchPlaceholder="Search scopes…"
                    options={scopeOptions}
                    className="glass-card border-soot-200/80 px-2 py-1.5 text-sm"
                  />
                  <p className="text-[10px] text-soot-500 mt-0.5">
                    {selectedProduct.variants && selectedProduct.variants.length > 0
                      ? 'Only this variant BOM is shown. New lines use the same scope.'
                      : 'Only this base BOM is shown. New lines use the same scope.'}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 px-2 py-1.5 rounded-lg border border-brand-200/60 bg-white/80 shrink-0">
                <span className="text-[10px] uppercase font-bold text-soot-500 tracking-wider">Est. material (this scope)</span>
                <span className="text-lg font-bold text-brand-700 tabular-nums leading-none">
                  {formatCurrency(activeBomSection.sectionCost)}
                </span>
                {(selectedProduct.sale_price ?? selectedProduct.base_price) > 0 && (
                  <span className="text-[10px] text-brand-600/90 font-medium">
                    Margin{' '}
                    {Math.max(
                      0,
                      (((selectedProduct.sale_price ?? selectedProduct.base_price) - activeBomSection.sectionCost) /
                        (selectedProduct.sale_price ?? selectedProduct.base_price)) *
                        100
                    ).toFixed(1)}
                    %
                  </span>
                )}
              </div>
            </header>

            {/* Scrollable BOM */}
            <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2">
              {loadingRecipe ? (
                <div className="flex items-center justify-center py-10 text-soot-400 gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" /> Loading recipe...
                </div>
              ) : !hasAnyBomLines ? (
                <div className="text-center py-10 text-soot-400">
                  <div className="w-12 h-12 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-3">
                    <PackageSearch className="w-6 h-6 text-soot-300" />
                  </div>
                  <p className="font-medium text-soot-600">No ingredients mapped</p>
                  <p className="text-sm mt-1">Add raw materials to track inventory when this item is sold.</p>
                </div>
              ) : (
                <div className="app-table-shell">
                  <div className="px-2 py-1 md:px-2 flex flex-wrap justify-between gap-2 text-xs font-semibold text-soot-800 bg-soot-50/90 border-b border-soot-200/60">
                    <span>{activeBomSection.label}</span>
                    <span className="text-[11px] font-normal text-soot-600 tabular-nums">
                      {formatCurrency(activeBomSection.sectionCost)} · {viewRowCount} line{viewRowCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="app-table-scroll">
                    <table className="app-table text-[11px] md:text-xs min-w-[480px]">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Qty</th>
                          <th className="text-right">Unit cost</th>
                          <th className="text-right text-brand-800">Total</th>
                          <th className="min-w-[4.25rem] w-[4.25rem]" aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                              {activeBomSection.recipeRows.map((ri) => {
                                const ing = ingredients.find((i) => i.id === ri.ingredient_id);
                                if (!ing) return null;
                                const lineCost = (ing.average_cost || 0) * ri.quantity;
                                const unitLabel = ri.unit || ing.unit;
                                const tip = `${ing.name} — ${formatBaseQuantityGlobal(ri.quantity, unitLabel, { ingredient: ing })} @ ${formatCurrency(ing.average_cost)}/${ing.unit}`;
                                return (
                                  <tr
                                    key={ri.id}
                                    ref={(el) => {
                                      rowRefs.current.set(`ing-${ri.id}`, el);
                                    }}
                                    className="transition-colors"
                                  >
                                    <td className="py-1 px-2 align-middle">
                                      <div className="font-semibold text-soot-900 truncate max-w-[14rem] md:max-w-none leading-tight" title={tip}>
                                        {ing.name}
                                      </div>
                                    </td>
                                    <td className="py-1 px-2 align-middle font-semibold text-soot-900 tabular-nums whitespace-nowrap text-[11px]" title={tip}>
                                      {formatBaseQuantityGlobal(ri.quantity, unitLabel, { ingredient: ing })}
                                    </td>
                                    <td className="py-1 px-2 align-middle text-right text-soot-600 tabular-nums whitespace-nowrap text-[11px]">
                                      {formatCurrency(ing.average_cost)}/{ing.unit}
                                    </td>
                                    <td className="py-1 px-2 align-middle text-right font-semibold text-brand-800 tabular-nums whitespace-nowrap text-[11px]">
                                      {formatCurrency(lineCost)}
                                    </td>
                                    <td className="py-1 px-0.5 align-middle text-center">
                                      <div className="inline-flex items-center justify-center gap-0.5">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setRecipeLineEdit({ kind: 'ingredient', row: ri });
                                            setShowAddForm(true);
                                            setShowExtraCostForm(false);
                                            requestAnimationFrame(() =>
                                              addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                                            );
                                          }}
                                          className="p-1 text-soot-500 hover:text-brand-700 rounded-md"
                                          title="Edit line"
                                        >
                                          <Pencil className="w-4 h-4" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDelete(ri.id)}
                                          className="p-1 text-soot-400 hover:text-red-600 rounded-md"
                                          title="Remove"
                                        >
                                          <Trash2 className="w-4 h-4" />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                              {activeBomSection.preparedRows.map((ri) => {
                                const prepared = preparedItems.find((i) => i.id === ri.prepared_item_id);
                                if (!prepared) return null;
                                const unitLabel = ri.unit || prepared.unit;
                                const lineCost = (prepared.average_cost || 0) * ri.quantity;
                                const components = prepared.components || [];
                                const tip = `${prepared.name} (${prepared.kind}) — ${formatBaseQuantityGlobal(ri.quantity, unitLabel)}`;
                                return (
                                  <React.Fragment key={`prep-${ri.id}`}>
                                    <tr
                                      ref={(el) => {
                                        rowRefs.current.set(`prep-${ri.id}`, el);
                                      }}
                                      className="bg-brand-50/30 transition-colors"
                                    >
                                      <td className="py-1 px-2 align-middle">
                                        <div className="font-semibold text-soot-900 truncate max-w-[14rem] leading-tight" title={tip}>
                                          {prepared.name}
                                          <span className="ml-1 text-[10px] font-normal text-brand-700">
                                            ({prepared.kind === 'marination' ? 'Marination' : 'Sauce'})
                                          </span>
                                        </div>
                                      </td>
                                      <td className="py-1 px-2 align-middle font-semibold text-soot-900 tabular-nums whitespace-nowrap text-[11px]" title={tip}>
                                        {formatBaseQuantityGlobal(ri.quantity, unitLabel)}
                                      </td>
                                      <td className="py-1 px-2 align-middle text-right tabular-nums whitespace-nowrap text-[11px]">
                                        {formatCurrency(prepared.average_cost)}/{prepared.unit}
                                      </td>
                                      <td className="py-1 px-2 align-middle text-right font-semibold text-brand-800 tabular-nums text-[11px]">
                                        {formatCurrency(lineCost)}
                                      </td>
                                      <td className="py-1 px-0.5 align-middle text-center">
                                        <div className="inline-flex items-center justify-center gap-0.5">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setRecipeLineEdit({ kind: 'prepared', row: ri });
                                              setShowAddForm(true);
                                              setShowExtraCostForm(false);
                                              requestAnimationFrame(() =>
                                                addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                                              );
                                            }}
                                            className="p-1 text-soot-500 hover:text-brand-700 rounded-md"
                                            title="Edit line"
                                          >
                                            <Pencil className="w-4 h-4" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleDelete(ri.id, 'prepared')}
                                            className="p-1 text-soot-400 hover:text-red-600 rounded-md"
                                            title="Remove"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                    {components.length > 0 && (
                                      <tr className="bg-brand-50/20">
                                        <td colSpan={5} className="py-1.5 px-3 text-[11px] text-soot-600">
                                          <details>
                                            <summary className="cursor-pointer font-medium text-soot-700 select-none">
                                              Raw breakdown
                                            </summary>
                                            <ul className="mt-1 space-y-0.5 pl-2 border-l-2 border-brand-200/80">
                                              {components.map((c) => {
                                                const compIng = ingredients.find((i) => i.id === c.ingredient_id);
                                                if (!compIng) return null;
                                                const rawNeed = c.quantity * ri.quantity;
                                                const subCost = rawNeed * (compIng.average_cost || 0);
                                                const cUnit = c.unit || compIng.unit;
                                                return (
                                                  <li key={c.id} className="flex flex-wrap justify-between gap-1">
                                                    <span className="truncate max-w-[55%]">{compIng.name}</span>
                                                    <span className="text-right tabular-nums">
                                                      {formatBaseQuantityGlobal(rawNeed, cUnit, { ingredient: compIng })}{' '}
                                                      · {formatCurrency(subCost)}
                                                    </span>
                                                  </li>
                                                );
                                              })}
                                            </ul>
                                          </details>
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                              {activeBomSection.extraRows.map((ec) => (
                                <tr key={`extra-${ec.id}`} className="bg-orange-50/40">
                                  <td className="py-1 px-2 align-middle font-semibold text-soot-900">{ec.name}</td>
                                  <td className="py-1 px-2 align-middle text-soot-500">—</td>
                                  <td className="py-1 px-2 align-middle text-right text-soot-500 text-[11px]">Extra</td>
                                  <td className="py-1 px-2 align-middle text-right font-semibold text-brand-800 tabular-nums text-[11px]">
                                    {formatCurrency(ec.amount)}
                                  </td>
                                  <td className="py-1 px-0.5 align-middle text-center">
                                    <div className="inline-flex items-center justify-center gap-0.5">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setRecipeLineEdit({ kind: 'extra', row: ec });
                                          setShowExtraCostForm(true);
                                          setShowAddForm(false);
                                          requestAnimationFrame(() =>
                                            addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                                          );
                                        }}
                                        className="p-1 text-soot-500 hover:text-brand-700 rounded-md"
                                        title="Edit extra cost"
                                      >
                                        <Pencil className="w-4 h-4" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteExtraCost(ec.id)}
                                        className="p-1 text-soot-400 hover:text-red-600 rounded-md"
                                        title="Remove"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                              {viewRowCount === 0 && (
                                <tr>
                                  <td colSpan={5} className="py-3 px-2 text-center text-soot-400 text-[11px]">
                                    No lines for this scope yet.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                  </div>
                </div>
              )}
            </div>

            {/* Sticky bottom actions */}
            <div className="sticky bottom-0 z-10 shrink-0 border-t border-soot-200/80 bg-white/95 backdrop-blur-md px-2 py-2 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]">
              {!showAddForm && !showExtraCostForm && !recipeLineEdit ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      setRecipeLineEdit(null);
                      setShowExtraCostForm(true);
                      requestAnimationFrame(() =>
                        addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                      );
                    }}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[8px] border border-soot-200 bg-white/80 text-soot-800 text-sm font-medium hover:bg-white transition-colors touch-target"
                  >
                    <Plus className="w-5 h-5" /> Add Extra Cost
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRecipeLineEdit(null);
                      setShowAddForm(true);
                      requestAnimationFrame(() =>
                        addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                      );
                    }}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[8px] bg-brand-700 text-white text-sm font-medium hover:bg-brand-600 transition-colors touch-target"
                  >
                    <Plus className="w-5 h-5" /> Add Ingredient or Sauce to Recipe
                  </button>
                </div>
              ) : (
                <form
                  ref={addFormRef}
                  onSubmit={showExtraCostForm || recipeLineEdit?.kind === 'extra' ? handleAddExtraCost : handleAddSubmit}
                  className="glass-card p-3 space-y-3 shadow-sm border border-brand-200 bg-white/50 max-h-[70vh] overflow-y-auto overscroll-contain"
                >
                  <div className="flex justify-between items-center mb-1">
                    <h4 className="font-bold text-soot-900 text-sm">
                      {recipeLineEdit?.kind === 'extra'
                        ? 'Edit extra cost'
                        : showExtraCostForm
                          ? 'Add Extra Cost'
                          : recipeLineEdit?.kind === 'ingredient' || recipeLineEdit?.kind === 'prepared'
                            ? 'Edit recipe line'
                            : 'Add Material'}
                    </h4>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(false);
                        setShowExtraCostForm(false);
                        setRecipeLineEdit(null);
                      }}
                      className="text-soot-400 hover:text-soot-700 p-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {showExtraCostForm || recipeLineEdit?.kind === 'extra' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Cost Name</label>
                        <input
                          type="text"
                          required
                          value={extraCostName}
                          onChange={(e) => setExtraCostName(e.target.value)}
                          placeholder="Gas / Electricity / Packaging / Labour"
                          className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Cost Amount (PKR)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          required
                          value={extraCostAmount}
                          onChange={(e) => setExtraCostAmount(e.target.value)}
                          placeholder="e.g. 50"
                          className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                        />
                      </div>
                    </div>
                  ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Material type</label>
                      <select
                        value={formMaterialType}
                        disabled={!!recipeLineEdit}
                        onChange={(e) => {
                          setFormMaterialType(e.target.value as 'ingredient' | 'prepared');
                          setFormIngredientId('');
                          setFormPreparedItemId('');
                        }}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
                      >
                        <option value="ingredient">Ingredient</option>
                        <option value="prepared">Sauce/Marination</option>
                      </select>
                    </div>
                    {formMaterialType === 'ingredient' ? (
                      <div>
                        <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Ingredient</label>
                        <SearchableSelect
                          value={formIngredientId}
                          onChange={setFormIngredientId}
                          placeholder="Select ingredient"
                          searchPlaceholder="Search ingredients..."
                          options={ingredients.map((ingredient) => ({
                            value: String(ingredient.id),
                            label: `${ingredient.name} (${ingredient.unit})`,
                            searchText: ingredient.name,
                          }))}
                          disabled={!!recipeLineEdit}
                          className="glass-card border-0 px-3 py-2"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Sauce / Marination</label>
                        <SearchableSelect
                          value={formPreparedItemId}
                          onChange={setFormPreparedItemId}
                          placeholder="Select sauce/marination"
                          searchPlaceholder="Search sauces..."
                          options={preparedItems.map((item) => ({
                            value: String(item.id),
                            label: `${item.name} (${item.unit})`,
                            searchText: item.name,
                          }))}
                          disabled={!!recipeLineEdit}
                          className="glass-card border-0 px-3 py-2"
                        />
                      </div>
                    )}
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">
                        Quantity per portion
                      </label>
                      <div className="flex flex-col sm:flex-row gap-2 items-stretch">
                        <div className="relative flex-1 min-w-0">
                          <input
                            type="number"
                            step="any"
                            min="0.000001"
                            required
                            value={formQuantity}
                            onChange={(e) => setFormQuantity(e.target.value)}
                            className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                            placeholder="e.g. 0.15 or 150"
                          />
                        </div>
                        <select
                          value={
                            formMaterialType === 'ingredient' && formIngredientResolved
                              ? (getSelectableInputUnits(formIngredientResolved).includes(formInputUnit)
                                  ? formInputUnit
                                  : getSelectableInputUnits(formIngredientResolved)[0] || formIngredientResolved.unit)
                              : formMaterialType === 'prepared' && formPreparedResolved
                                ? (getSelectableInputUnits(formPreparedResolved.unit).includes(formInputUnit)
                                    ? formInputUnit
                                    : getSelectableInputUnits(formPreparedResolved.unit)[0] || formPreparedResolved.unit)
                                : formInputUnit
                          }
                          onChange={(e) => setFormInputUnit(e.target.value)}
                          className="w-full sm:w-28 shrink-0 px-3 py-2 glass-card text-sm font-medium text-soot-800 focus:ring-2 focus:ring-brand-500"
                          disabled={!formIngredientResolved && !formPreparedResolved}
                        >
                          {(formMaterialType === 'ingredient' && formIngredientResolved
                            ? getSelectableInputUnits(formIngredientResolved)
                            : formPreparedResolved
                              ? getSelectableInputUnits(formPreparedResolved.unit)
                              : []
                          ).map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">
                        Notes (optional)
                      </label>
                      <textarea
                        value={formNotes}
                        onChange={(e) => setFormNotes(e.target.value)}
                        rows={2}
                        placeholder="Kitchen notes for this line…"
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 resize-y min-h-[2.5rem]"
                      />
                    </div>
                  </div>
                  )}
                  
                  <div className="flex justify-end gap-2 pt-2">
                    <button 
                      type="submit" 
                      disabled={submitting}
                      className="px-4 py-2 bg-brand-700 text-white rounded-[8px] text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 touch-target"
                    >
                      {submitting
                        ? 'Saving...'
                        : recipeLineEdit
                          ? 'Save changes'
                          : showExtraCostForm
                            ? 'Save extra cost'
                            : 'Save mapping'}
                    </button>
                  </div>
                </form>
              )}
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
