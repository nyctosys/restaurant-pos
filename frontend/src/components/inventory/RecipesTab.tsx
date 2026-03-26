import React, { useState, useEffect } from 'react';
import { Plus, X, Loader2, Trash2, ArrowRight, Utensils, PackageSearch } from 'lucide-react';
import { get, post, del, getUserMessage } from '../../api';
import { showToast } from '../Toast';
import { formatCurrency } from '../../utils/formatCurrency';

type Product = {
  id: number;
  title: string;
  sku: string;
  base_price: number;
};

type Ingredient = {
  id: number;
  name: string;
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
};

export default function RecipesTab() {
  const [products, setProducts] = useState<Product[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([]);
  const [loadingRecipe, setLoadingRecipe] = useState(false);

  // Form
  const [showAddForm, setShowAddForm] = useState(false);
  const [formIngredientId, setFormIngredientId] = useState('');
  const [formQuantity, setFormQuantity] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchBaseData();
  }, []);

  const fetchBaseData = async () => {
    setLoadingInitial(true);
    try {
      // Need all menu items and all ingredients
      const [prodRes, ingRes] = await Promise.all([
        get<{ products: Product[] }>('/menu-items/'),
        get<{ ingredients: Ingredient[] }>('/inventory-advanced/ingredients')
      ]);
      setProducts(prodRes.products || []);
      setIngredients(ingRes.ingredients || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingInitial(false);
    }
  };

  const loadRecipe = async (productId: number) => {
    setSelectedProductId(productId);
    setLoadingRecipe(true);
    setShowAddForm(false);
    try {
      const res = await get<{ recipe_items: RecipeItem[] }>(`/inventory-advanced/recipes/${productId}`);
      setRecipeItems(res.recipe_items || []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoadingRecipe(false);
    }
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || !formIngredientId || !formQuantity) return;
    
    const qty = parseFloat(formQuantity);
    if (isNaN(qty) || qty <= 0) {
      showToast('Enter a valid quantity', 'error');
      return;
    }

    const ing = ingredients.find(i => i.id.toString() === formIngredientId);
    if (!ing) return;

    setSubmitting(true);
    try {
      await post('/inventory-advanced/recipes', {
        product_id: selectedProductId,
        ingredient_id: parseInt(formIngredientId, 10),
        quantity: qty,
        unit: ing.unit,
        notes: formNotes || undefined
      });
      showToast('Ingredient added to recipe', 'success');
      
      // Reset and reload
      setFormIngredientId('');
      setFormQuantity('');
      setFormNotes('');
      setShowAddForm(false);
      loadRecipe(selectedProductId);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (itemId: number) => {
    try {
      await del(`/inventory-advanced/recipes/${itemId}`);
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

  // Calculate recipe cost
  let totalCost = 0;
  recipeItems.forEach(ri => {
    const ing = ingredients.find(i => i.id === ri.ingredient_id);
    if (ing) {
      totalCost += (ing.average_cost * ri.quantity);
    }
  });

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
                <div className="flex gap-3 text-sm mt-1">
                  <span className="text-soot-500 font-mono">{selectedProduct.sku}</span>
                  <span className="text-soot-300">|</span>
                  <span className="text-soot-600 font-medium">Sell Price: {formatCurrency(selectedProduct.base_price)}</span>
                </div>
              </div>
              
              <div className="glass-card px-4 py-2 bg-white/40 border-brand-200/50 flex flex-col items-end">
                <span className="text-xs uppercase font-bold text-soot-500 tracking-wider">Est. Material Cost</span>
                <span className="text-lg font-bold text-brand-700 leading-none mt-1">
                  {formatCurrency(totalCost)}
                </span>
                {selectedProduct.base_price > 0 && (
                  <span className="text-xs text-brand-600/80 font-medium mt-1">
                    Margin: {Math.max(0, 100 - (totalCost / selectedProduct.base_price * 100)).toFixed(1)}%
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
              ) : recipeItems.length === 0 ? (
                 <div className="text-center py-10 text-soot-400">
                   <div className="w-12 h-12 rounded-full bg-soot-100 flex items-center justify-center mx-auto mb-3">
                     <PackageSearch className="w-6 h-6 text-soot-300" />
                   </div>
                   <p className="font-medium text-soot-600">No ingredients mapped</p>
                   <p className="text-sm mt-1">Add raw materials to track inventory when this item is sold.</p>
                 </div>
              ) : (
                <div className="space-y-3">
                  {recipeItems.map(ri => {
                    const ing = ingredients.find(i => i.id === ri.ingredient_id);
                    if (!ing) return null;
                    return (
                      <div key={ri.id} className="flex items-center justify-between p-3 rounded-lg border border-soot-200 bg-white/30 hover:bg-white/50 transition-colors">
                        <div>
                          <p className="font-bold text-soot-900">{ing.name}</p>
                          <p className="text-xs text-soot-500 mt-0.5">
                            Cost: {formatCurrency(ing.average_cost)} / {ing.unit}
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
                </div>
              )}
            </div>

            {/* Bottom Add Bar */}
            <div className="p-5 border-t border-white/20 bg-white/20 shrink-0">
              {!showAddForm ? (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border-2 border-dashed border-brand-300 text-brand-700 font-semibold hover:bg-brand-50 hover:border-brand-400 transition-colors touch-target"
                >
                  <Plus className="w-5 h-5" /> Add Ingredient to Recipe
                </button>
              ) : (
                <form onSubmit={handleAddSubmit} className="glass-card p-4 space-y-4 shadow-sm border border-brand-200 bg-white/50">
                  <div className="flex justify-between items-center mb-1">
                    <h4 className="font-bold text-soot-900 text-sm">Add Material</h4>
                    <button type="button" onClick={() => setShowAddForm(false)} className="text-soot-400 hover:text-soot-700 p-1">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">Ingredient</label>
                      <select 
                        required
                        value={formIngredientId} 
                        onChange={e => setFormIngredientId(e.target.value)} 
                        className="w-full px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                      >
                        <option value="">— Select —</option>
                        {ingredients.map(i => (
                          <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-soot-600 uppercase tracking-wider mb-1">
                        Quantity per portion
                      </label>
                      <div className="relative">
                        <input 
                          type="number" 
                          step="any" 
                          min="0.01"
                          required
                          value={formQuantity} 
                          onChange={e => setFormQuantity(e.target.value)} 
                          className="w-full px-3 py-2 pr-12 glass-card text-sm focus:ring-2 focus:ring-brand-500"
                          placeholder="e.g. 0.15"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-soot-400 pointer-events-none">
                          {formIngredientId && ingredients.find(i => i.id.toString() === formIngredientId)?.unit}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex justify-end gap-2 pt-2">
                    <button 
                      type="submit" 
                      disabled={submitting}
                      className="px-4 py-2 bg-brand-700 text-white rounded-lg text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 touch-target"
                    >
                      {submitting ? 'Adding...' : 'Save mapping'}
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
