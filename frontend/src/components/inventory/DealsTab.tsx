import React, { useState, useEffect, useMemo } from 'react';
import { Plus, X, Loader2, ListPlus, Trash2, UtensilsCrossed } from 'lucide-react';
import { get, post, del, getUserMessage } from '../../api';
import { formatCurrency } from '../../utils/formatCurrency';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';

interface Product {
  id: number;
  sku: string;
  title: string;
  base_price: number;
}

interface ComboItem {
  id?: number;
  product_id: number;
  product_title?: string;
  quantity: number;
  /** Empty = base combo (all deal variants); otherwise must match a deal variant label. */
  variant_key?: string;
}

interface Deal {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  section?: string;
  variants?: string[];
  combo_items: ComboItem[];
}

export default function DealsTab() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    sku: '',
    base_price: '',
    /** Comma-separated deal variant labels (optional). Used for variant-specific combo lines. */
    variants: '',
    combo_items: [] as ComboItem[]
  });

  const dealVariantOptions = useMemo(
    () =>
      formData.variants
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    [formData.variants]
  );

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [dealsRes, productsRes] = await Promise.all([
        // Same handlers as /menu/deals/; inventory-advanced path is stable across backend reloads.
        get('/inventory-advanced/deals/'),
        get('/menu-items/')
      ]);
      setDeals((dealsRes as any).deals || []);
      // Filter out deals from the products list so we don't nest deals in deals
      const allProducts = (productsRes as any).products || [];
      const nonDealProducts = allProducts.filter((p: any) => !p.is_deal);
      setProducts(nonDealProducts);
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.combo_items.length === 0) {
      showToast('Please add at least one menu item to the deal', 'error');
      return;
    }

    try {
      const variantList = dealVariantOptions;
      await post('/inventory-advanced/deals/', {
        title: formData.title,
        sku: formData.sku,
        base_price: parseFloat(formData.base_price),
        variants: variantList,
        combo_items: formData.combo_items.map(({ product_id, quantity, variant_key }) => ({
          product_id,
          quantity,
          variant_key: (variant_key || '').trim()
        }))
      });
      showToast('Deal created successfully', 'success');
      setShowForm(false);
      setFormData({ title: '', sku: '', base_price: '', variants: '', combo_items: [] });
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const handleDelete = async (id: number) => {
    const confirmed = await showConfirm({
      title: 'Remove deal from menu',
      message:
        'This archives the deal: it disappears from the POS and menu, but past receipts and sales history stay intact.',
      confirmLabel: 'Remove',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await del(`/inventory-advanced/deals/${id}`);
      showToast('Deal removed from menu', 'success');
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const addComboItem = () => {
    setFormData(prev => ({
      ...prev,
      combo_items: [...prev.combo_items, { product_id: 0, quantity: 1, variant_key: '' }]
    }));
  };

  const updateComboItem = (index: number, field: keyof ComboItem, value: any) => {
    const newItems = [...formData.combo_items];
    newItems[index] = { ...newItems[index], [field]: value };
    setFormData(prev => ({ ...prev, combo_items: newItems }));
  };

  const removeComboItem = (index: number) => {
    setFormData(prev => ({
      ...prev,
      combo_items: prev.combo_items.filter((_, i) => i !== index)
    }));
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-brand-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-2 duration-300">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-soot-900 flex items-center gap-2">
            <UtensilsCrossed className="w-6 h-6 text-brand-500" />
            Deals & Combos
          </h2>
          <p className="text-soot-600 font-medium">
            Bundle menu items into promotions. Deals use the <span className="font-semibold text-soot-800">Deals</span>{' '}
            section and appear on the order screen (category filter &quot;Deals&quot; when needed). Ingredient depletion
            follows each bundled item&apos;s recipe (BOM), same as regular menu items.
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-xl transition-all shadow-md touch-target font-semibold"
        >
          {showForm ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
          {showForm ? 'Cancel' : 'New Deal'}
        </button>
      </div>

      {showForm && (
        <div className="glass-card page-padding rounded-2xl animate-in slide-in-from-top-4 duration-300 border-l-4 border-l-brand-500">
          <h3 className="text-lg font-bold text-soot-900 mb-4">Create New Deal</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-3">
                <label className="block text-sm font-semibold text-soot-700 mb-2">
                  Deal variants <span className="text-soot-500 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formData.variants}
                  onChange={e => setFormData({ ...formData, variants: e.target.value })}
                  className="w-full bg-white/50 border border-soot-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="e.g. Regular, Large — comma-separated"
                />
                <p className="text-xs text-soot-500 mt-1.5">
                  If set, you can tag each combo line for a variant (or leave as base for all). POS will require a
                  variant pick when the deal has variants.
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Deal Title</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={e => setFormData({...formData, title: e.target.value})}
                  className="w-full bg-white/50 border border-soot-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="e.g. Burger Combo"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Deal SKU</label>
                <input
                  type="text"
                  required
                  value={formData.sku}
                  onChange={e => setFormData({...formData, sku: e.target.value})}
                  className="w-full bg-white/50 border border-soot-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="e.g. DL-BURGER-1"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Bundled price (PKR)</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formData.base_price}
                  onChange={e => setFormData({...formData, base_price: e.target.value})}
                  className="w-full bg-white/50 border border-soot-200 rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="mt-6 border-t border-soot-200/50 pt-6">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-md font-bold text-soot-800">Combo Items</h4>
                <button
                  type="button"
                  onClick={addComboItem}
                  className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <ListPlus className="w-4 h-4" /> Add Item
                </button>
              </div>
              
              <div className="space-y-3">
                {formData.combo_items.map((item, index) => (
                  <div key={index} className="flex flex-wrap gap-4 items-end bg-white/30 p-4 rounded-xl border border-soot-100">
                    <div className="flex-1 min-w-[200px]">
                      <label className="block text-xs font-semibold text-soot-600 mb-1">Menu Item</label>
                      <select
                        required
                        value={item.product_id}
                        onChange={(e) => updateComboItem(index, 'product_id', parseInt(e.target.value))}
                        className="w-full bg-white border border-soot-200 rounded-lg px-3 py-2 font-medium focus:ring-2 focus:ring-brand-400 outline-none"
                      >
                        <option value="0" disabled>Select Product...</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.title} ({formatCurrency(p.base_price)})</option>
                        ))}
                      </select>
                    </div>
                    <div className="w-24 shrink-0">
                      <label className="block text-xs font-semibold text-soot-600 mb-1">Quantity</label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={item.quantity}
                        onChange={e => updateComboItem(index, 'quantity', parseInt(e.target.value))}
                        className="w-full bg-white border border-soot-200 rounded-lg px-3 py-2 font-medium focus:ring-2 focus:ring-brand-400 outline-none"
                      />
                    </div>
                    {dealVariantOptions.length > 0 && (
                      <div className="w-full sm:w-44 shrink-0">
                        <label className="block text-xs font-semibold text-soot-600 mb-1">Combo for variant</label>
                        <select
                          value={item.variant_key || ''}
                          onChange={e => updateComboItem(index, 'variant_key', e.target.value)}
                          className="w-full bg-white border border-soot-200 rounded-lg px-3 py-2 font-medium focus:ring-2 focus:ring-brand-400 outline-none"
                        >
                          <option value="">Base (all)</option>
                          {dealVariantOptions.map(v => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeComboItem(index)}
                      className="p-2 text-soot-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                ))}
                {formData.combo_items.length === 0 && (
                  <div className="text-center py-6 bg-white/20 rounded-xl border border-dashed border-soot-200">
                    <p className="text-soot-500 font-medium">No items added to this deal yet.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-6 py-2.5 rounded-xl text-soot-600 font-semibold hover:bg-soot-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bg-brand-600 hover:bg-brand-700 text-white px-8 py-2.5 rounded-xl font-bold transition-all shadow-md touch-target"
              >
                Save Deal
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {deals.length === 0 ? (
          <div className="col-span-full glass-card page-padding rounded-2xl text-center py-12">
            <UtensilsCrossed className="w-12 h-12 text-soot-300 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-soot-900">No Deals Created</h3>
            <p className="text-soot-500">Create your first deal to bundle items together.</p>
          </div>
        ) : (
          deals.map(deal => (
            <div key={deal.id} className="glass-card rounded-2xl border border-soot-200/50 flex flex-col hover:border-brand-300 transition-colors group">
              <div className="p-5 border-b border-soot-100 flex justify-between items-start bg-gradient-to-br from-white/40 to-white/10 rounded-t-2xl">
                <div>
                  <h3 className="font-bold text-lg text-soot-900">{deal.title}</h3>
                  <span className="text-xs bg-brand-100 text-brand-800 font-bold px-2 py-0.5 rounded-md border border-brand-200 inline-block mt-1">
                    {deal.sku}
                  </span>
                  <span className="text-xs bg-soot-100 text-soot-700 font-semibold px-2 py-0.5 rounded-md border border-soot-200 inline-block mt-1 ml-1">
                    {deal.section || 'Deals'}
                  </span>
                  {deal.variants && deal.variants.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {deal.variants.map(v => (
                        <span key={v} className="text-[10px] font-bold uppercase tracking-wide text-brand-800 bg-white/80 border border-brand-200 px-1.5 py-0.5 rounded">
                          {v}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleDelete(deal.id)}
                  className="p-1.5 text-soot-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 flex-1">
                <ul className="space-y-2">
                  {deal.combo_items.map((item, idx) => (
                    <li key={idx} className="flex justify-between items-center text-sm gap-2">
                      <span className="text-soot-600 font-medium pb-1 border-b border-dashed border-soot-200 flex-1 mr-4">
                        <span className="font-bold text-soot-900 mr-2">{item.quantity}x</span>
                        {item.product_title}
                        {item.variant_key ? (
                          <span className="text-[10px] font-bold text-brand-700 ml-2">({item.variant_key})</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="p-5 bg-soot-50/50 border-t border-soot-100 rounded-b-2xl font-bold text-lg text-brand-700 flex justify-between items-center">
                <span>Bundle Price:</span>
                <span>{formatCurrency(deal.base_price)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
