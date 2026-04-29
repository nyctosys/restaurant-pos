import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, Trash2, ArrowRight, Utensils, PackageSearch } from 'lucide-react';
import { get, post, del, getUserMessage } from '../../api';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';

type Product = {
  id: number;
  title: string;
  sku: string;
  base_price: number;
  sale_price?: number;
  variants?: { name: string; basePrice: number; salePrice: number; sku?: string }[];
};

type Ingredient = {
  id: number;
  name: string;
  unit: string;
  average_cost: number;
  purchase_unit?: string;
  conversion_factor?: number;
};

type PreparedItem = {
  id: number;
  name: string;
  kind: 'sauce' | 'marination';
  unit: string;
  average_cost: number;
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

export default function RecipesTab() {
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
  const [formUsePurchaseUnit, setFormUsePurchaseUnit] = useState(false);
  const [formNotes, setFormNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showExtraCostForm, setShowExtraCostForm] = useState(false);
  const [extraCostName, setExtraCostName] = useState('');
  const [extraCostAmount, setExtraCostAmount] = useState('');

  useEffect(() => {
    fetchBaseData();
  }, []);

  const fetchBaseData = async () => {
    setLoadingInitial(true);
    try {
      // Need all menu items and all ingredients
      const [prodRes, ingRes, preparedRes] = await Promise.all([
        get<{ products: Product[] }>('/menu-items/'),
        get<{ ingredients: Ingredient[] }>('/inventory-advanced/ingredients'),
        get<{ prepared_items: PreparedItem[] }>('/inventory-advanced/prepared-items')
      ]);
      setProducts(prodRes.products || []);
      setIngredients(ingRes.ingredients || []);
      setPreparedItems(preparedRes.prepared_items || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingInitial(false);
    }
  };

  const loadRecipe = async (productId: number) => {
    setSelectedProductId(productId);
    setRecipeVariantScope('');
    setLoadingRecipe(true);
    setShowAddForm(false);
    setShowExtraCostForm(false);
    try {
      const res = await get<{ recipe_items: RecipeItem[]; recipe_prepared_items: RecipePreparedItem[]; recipe_extra_costs?: RecipeExtraCost[] }>(`/inventory-advanced/recipes/${productId}`);
      setRecipeItems(res.recipe_items || []);
      setRecipePreparedItems(res.recipe_prepared_items || []);
      setRecipeExtraCosts(res.recipe_extra_costs || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingRecipe(false);
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !formQuantity) return;
    
    const qty = parseFloat(formQuantity);
    if (isNaN(qty) || qty <= 0) {
      showToast('Enter a valid quantity', 'error');
      return;
    }

    const ing = ingredients.find(i => i.id.toString() === formIngredientId);
    const prepared = preparedItems.find(i => i.id.toString() === formPreparedItemId);
    if (formMaterialType === 'ingredient' && !ing) return;
    if (formMaterialType === 'prepared' && !prepared) return;

    setSubmitting(true);
    try {
      if (formMaterialType === 'ingredient' && ing) {
        let finalQty = qty;
        if (formUsePurchaseUnit && ing.conversion_factor) {
          finalQty = qty * ing.conversion_factor;
        }

        await post('/inventory-advanced/recipes', {
          product_id: selectedProductId,
          ingredient_id: parseInt(formIngredientId, 10),
          quantity: finalQty,
          unit: ing.unit,
          notes: formNotes || undefined,
          variant_key: recipeVariantScope || '',
        });
      } else if (prepared) {
        await post('/inventory-advanced/recipes/prepared-items', {
          product_id: selectedProductId,
          prepared_item_id: parseInt(formPreparedItemId, 10),
          quantity: qty,
          unit: prepared.unit,
          notes: formNotes || undefined,
          variant_key: recipeVariantScope || '',
        });
      }
      showToast('Material added to recipe', 'success');
      
      // Reset and reload
      setFormIngredientId('');
      setFormPreparedItemId('');
      setFormQuantity('');
      setFormUsePurchaseUnit(false);
      setFormNotes('');
      setShowAddForm(false);
      loadRecipe(selectedProductId);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (itemId: number, materialType: 'ingredient' | 'prepared' = 'ingredient') => {
    try {
      await del(materialType === 'ingredient' ? `/inventory-advanced/recipes/${itemId}` : `/inventory-advanced/recipes/prepared-items/${itemId}`);
      showToast('Removed from recipe', 'success');
      if (selectedProductId) loadRecipe(selectedProductId);
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

  const selectedProduct = products.find(p => p.id === selectedProductId);

  const displayedRecipeItems = recipeItems.filter(ri => {
    const vk = (ri.variant_key || '').trim();
    if (!recipeVariantScope) return vk === '';
    return vk === recipeVariantScope;
  });
  const displayedPreparedRecipeItems = recipePreparedItems.filter(ri => {
    const vk = (ri.variant_key || '').trim();
    if (!recipeVariantScope) return vk === '';
    return vk === recipeVariantScope;
  });
  const displayedExtraCosts = recipeExtraCosts.filter(ec => {
    const vk = (ec.variant_key || '').trim();
    if (!recipeVariantScope) return vk === '';
    return vk === recipeVariantScope;
  });

  // Calculate recipe cost for the selected scope only
  let totalCost = 0;
  displayedRecipeItems.forEach(ri => {
    const ing = ingredients.find(i => i.id === ri.ingredient_id);
    if (ing) {
      totalCost += (ing.average_cost * ri.quantity);
    }
  });
  displayedPreparedRecipeItems.forEach(ri => {
    const prepared = preparedItems.find(i => i.id === ri.prepared_item_id);
    if (prepared) {
      totalCost += (prepared.average_cost * ri.quantity);
    }
  });
  displayedExtraCosts.forEach((ec) => {
    totalCost += Number(ec.amount || 0);
  });

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
      await post('/inventory-advanced/recipes/extra-costs', {
        product_id: selectedProductId,
        name,
        amount,
        variant_key: recipeVariantScope || '',
      });
      showToast('Extra cost added', 'success');
      setExtraCostName('');
      setExtraCostAmount('');
      setShowExtraCostForm(false);
      await loadRecipe(selectedProductId);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteExtraCost = async (extraCostId: number) => {
    try {
      await del(`/inventory-advanced/recipes/extra-costs/${extraCostId}`);
      showToast('Extra cost removed', 'success');
      if (selectedProductId) await loadRecipe(selectedProductId);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0 bg-transparent py-4 gap-4 px-4 lg:px-6">
      
      {/* Product List Sidebar */}
      <div className="w-full lg:w-1/3 flex flex-col glass-card h-[40vh] lg:h-full overflow-hidden shrink-0">
        <div className="p-4 border-b border-white/20 bg-white/10 shrink-0">
          <h3 className="font-bold text-soot-900">Select Menu Item</h3>
          <p className="text-xs text-soot-500 mt-0.5">Choose an item to manage its Bill of Materials</p>
        </div>
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
          {products.map(p => (
            <button
              key={p.id}
              onClick={() => loadRecipe(p.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between group ${
                selectedProductId === p.id 
                  ? 'bg-brand-600 text-white shadow-md' 
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
      <div className="w-full lg:w-2/3 flex flex-col h-auto lg:h-full overflow-hidden">
        {!selectedProduct ? (
          <div className="glass-card h-full flex flex-col items-center justify-center p-8 text-center text-soot-400">
            <Utensils className="w-12 h-12 mb-4 text-soot-300" />
            <p className="text-lg font-medium text-soot-600">No Item Selected</p>
            <p className="text-sm mt-1">Select a menu item from the list to view or build its recipe.</p>
          </div>
        ) : (
          <div className="glass-card flex-1 flex flex-col min-h-0 relative">
            
            {/* Header */}
            <div className="p-5 border-b border-white/20 bg-white/20 shrink-0 flex flex-wrap justify-between items-start gap-4">
              <div>
                <h2 className="text-xl font-bold text-soot-900">{selectedProduct.title}</h2>
                <div className="flex gap-3 text-sm mt-1 flex-wrap">
                  <span className="text-soot-500 font-mono">{selectedProduct.sku}</span>
                  <span className="text-soot-300">|</span>
                  <span className="text-soot-600 font-medium">Sell Price: {formatCurrency(selectedProduct.sale_price ?? selectedProduct.base_price)}</span>
                </div>
                {(selectedProduct.variants && selectedProduct.variants.length > 0) && (
                  <div className="mt-3 max-w-full">
                    <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">
                      Recipe scope
                    </label>
                    <div className="w-full sm:max-w-md">
                      <SearchableSelect
                        value={recipeVariantScope}
                        onChange={setRecipeVariantScope}
                        placeholder="Base (default — used when no variant-specific BOM exists)"
                        searchPlaceholder="Search recipe scopes…"
                        options={selectedProduct.variants.map((variant) => ({
                          value: variant?.name || '',
                          label: `Variant: ${variant?.name || 'Select Variant'}`,
                          searchText: variant?.name || '',
                        }))}
                        className="glass-card border-soot-200/80 px-3 py-2"
                      />
                    </div>
                    <p className="text-xs text-soot-500 mt-1">
                      Add ingredients for the base recipe, or pick a variant to override the BOM for that option only.
                    </p>
                  </div>
                )}
              </div>
              
              <div className="glass-card px-4 py-2 bg-white/40 border-brand-200/50 flex flex-col items-end">
                <span className="text-xs uppercase font-bold text-soot-500 tracking-wider">Est. Material Cost</span>
                <span className="text-lg font-bold text-brand-700 leading-none mt-1">
                  {formatCurrency(totalCost)}
                </span>
                {(selectedProduct.sale_price ?? selectedProduct.base_price) > 0 && (
                  <span className="text-xs text-brand-600/80 font-medium mt-1">
                    Margin: {Math.max(0, (((selectedProduct.sale_price ?? selectedProduct.base_price) - totalCost) / (selectedProduct.sale_price ?? selectedProduct.base_price)) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-5">
              {loadingRecipe ? (
                 <div className="flex items-center justify-center py-10 text-soot-400 gap-2">
                   <Loader2 className="w-5 h-5 animate-spin" /> Loading recipe...
                 </div>
              ) : displayedRecipeItems.length === 0 && displayedPreparedRecipeItems.length === 0 && displayedExtraCosts.length === 0 ? (
                 <div className="text-center py-10 text-soot-400">
                   <div className="w-12 h-12 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-3">
                     <PackageSearch className="w-6 h-6 text-soot-300" />
                   </div>
                   <p className="font-medium text-soot-600">No ingredients mapped</p>
                   <p className="text-sm mt-1">Add raw materials to track inventory when this item is sold.</p>
                 </div>
              ) : (
                <div className="space-y-3">
                  {displayedRecipeItems.map(ri => {
                    const ing = ingredients.find(i => i.id === ri.ingredient_id);
                    if (!ing) return null;
                    return (
                      <div key={ri.id} className="flex items-center justify-between p-3 rounded-lg border border-soot-200 bg-white/30 hover:bg-white/50 transition-colors">
                        <div>
                          <p className="font-bold text-soot-900">{ing.name}</p>
                          <p className="text-xs text-soot-500 mt-0.5">
                            Cost: {formatCurrency(ing.average_cost)} / {ing.unit}
                            {(ri.variant_key || '').trim() ? (
                              <span className="ml-2 text-brand-700 font-semibold">({(ri.variant_key || '').trim()})</span>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-right">
                            <span className="font-bold text-lg text-soot-800">{ri.quantity}</span>
                            <span className="text-sm text-soot-500 ml-1 font-medium">{ri.unit}</span>
                          </div>
                          <button 
                            onClick={() => handleDelete(ri.id)}
                            className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Remove ingredient"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {displayedPreparedRecipeItems.map(ri => {
                    const prepared = preparedItems.find(i => i.id === ri.prepared_item_id);
                    if (!prepared) return null;
                    return (
                      <div key={`prepared-${ri.id}`} className="flex items-center justify-between p-3 rounded-lg border border-brand-200 bg-brand-50/40 hover:bg-brand-50/70 transition-colors">
                        <div>
                          <p className="font-bold text-soot-900">{prepared.name}</p>
                          <p className="text-xs text-soot-500 mt-0.5">
                            {prepared.kind === 'marination' ? 'Marination' : 'Sauce'} cost: {formatCurrency(prepared.average_cost)} / {prepared.unit}
                            {(ri.variant_key || '').trim() ? (
                              <span className="ml-2 text-brand-700 font-semibold">({(ri.variant_key || '').trim()})</span>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-right">
                            <span className="font-bold text-lg text-soot-800">{ri.quantity}</span>
                            <span className="text-sm text-soot-500 ml-1 font-medium">{ri.unit}</span>
                          </div>
                          <button 
                            onClick={() => handleDelete(ri.id, 'prepared')}
                            className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Remove sauce/marination"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {displayedExtraCosts.map((ec) => (
                    <div key={`extra-${ec.id}`} className="flex items-center justify-between p-3 rounded-lg border border-orange-200 bg-orange-50/50 hover:bg-orange-50/80 transition-colors">
                      <div>
                        <p className="font-bold text-soot-900">{ec.name}</p>
                        <p className="text-xs text-soot-500 mt-0.5">
                          Operational cost
                          {(ec.variant_key || '').trim() ? (
                            <span className="ml-2 text-brand-700 font-semibold">({(ec.variant_key || '').trim()})</span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <span className="font-bold text-lg text-soot-800">{formatCurrency(ec.amount)}</span>
                        </div>
                        <button
                          onClick={() => handleDeleteExtraCost(ec.id)}
                          className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Remove extra cost"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Bottom Add Bar */}
            <div className="p-5 border-t border-white/20 bg-white/20 shrink-0">
              {!showAddForm && !showExtraCostForm ? (
                <div className="space-y-2">
                  <button
                    onClick={() => setShowExtraCostForm(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed border-orange-300 text-orange-700 font-semibold hover:bg-orange-50 hover:border-orange-400 transition-colors touch-target"
                  >
                    <Plus className="w-5 h-5" /> Add Extra Cost
                  </button>
                  <button
                    onClick={() => setShowAddForm(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed border-brand-300 text-brand-700 font-semibold hover:bg-brand-50 hover:border-brand-400 transition-colors touch-target"
                  >
                    <Plus className="w-5 h-5" /> Add Ingredient or Sauce to Recipe
                  </button>
                </div>
              ) : (
                <form onSubmit={showExtraCostForm ? handleAddExtraCost : handleAddSubmit} className="glass-card p-4 space-y-4 shadow-sm border border-brand-200 bg-white/50">
                  <div className="flex justify-between items-center mb-1">
                    <h4 className="font-bold text-soot-900 text-sm">{showExtraCostForm ? 'Add Extra Cost' : 'Add Material'}</h4>
                    <button type="button" onClick={() => { setShowAddForm(false); setShowExtraCostForm(false); }} className="text-soot-400 hover:text-soot-700 p-1">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {showExtraCostForm ? (
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
                        onChange={(e) => {
                          setFormMaterialType(e.target.value as 'ingredient' | 'prepared');
                          setFormIngredientId('');
                          setFormPreparedItemId('');
                        }}
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                      >
                        <option value="ingredient">Ingredient</option>
                        <option value="prepared">Sauce/Marination</option>
                      </select>
                    </div>
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
                        disabled={formMaterialType !== 'ingredient'}
                        className="glass-card border-0 px-3 py-2"
                      />
                    </div>
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
                        disabled={formMaterialType !== 'prepared'}
                        className="glass-card border-0 px-3 py-2"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1 flex justify-between items-center">
                        <span>Quantity per portion</span>
                        {formMaterialType === 'ingredient' && formIngredientId && (
                          (() => {
                            const ing = ingredients.find(i => i.id.toString() === formIngredientId);
                            if (ing?.purchase_unit && (ing.conversion_factor ?? 0) > 1) {
                              return (
                                <button
                                  type="button"
                                  onClick={() => setFormUsePurchaseUnit(!formUsePurchaseUnit)}
                                  className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded border ${
                                    formUsePurchaseUnit ? 'bg-brand-100 text-brand-700 border-brand-200' : 'bg-neutral-100 text-neutral-500 border-neutral-200'
                                  }`}
                                >
                                  {formUsePurchaseUnit ? `In ${ing.purchase_unit}` : `Use ${ing.purchase_unit}?`}
                                </button>
                              );
                            }
                            return null;
                          })()
                        )}
                      </label>
                      <div className="relative">
                        <input 
                          type="number" 
                          step="any" 
                          min="0.000001"
                          required
                          value={formQuantity} 
                          onChange={e => setFormQuantity(e.target.value)} 
                          className="w-full px-3 py-2 pr-12 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                          placeholder="e.g. 0.15"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-soot-400 pointer-events-none">
                          {formMaterialType === 'ingredient'
                            ? (formUsePurchaseUnit 
                                ? ingredients.find(i => i.id.toString() === formIngredientId)?.purchase_unit 
                                : ingredients.find(i => i.id.toString() === formIngredientId)?.unit)
                            : formPreparedItemId && preparedItems.find(i => i.id.toString() === formPreparedItemId)?.unit}
                        </div>
                      </div>
                      {formUsePurchaseUnit && formQuantity && (
                        <div className="mt-1 text-[10px] text-brand-600 font-medium italic">
                          = {(parseFloat(formQuantity) * (ingredients.find(i => i.id.toString() === formIngredientId)?.conversion_factor || 1)).toFixed(4)} {ingredients.find(i => i.id.toString() === formIngredientId)?.unit}
                        </div>
                      )}
                    </div>
                  </div>
                  )}
                  
                  <div className="flex justify-end gap-2 pt-2">
                    <button 
                      type="submit" 
                      disabled={submitting}
                      className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 touch-target"
                    >
                      {submitting ? 'Adding...' : (showExtraCostForm ? 'Save extra cost' : 'Save mapping')}
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
