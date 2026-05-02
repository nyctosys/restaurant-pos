import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, X, Loader2, ListPlus, Trash2, UtensilsCrossed, Pencil, Archive, ArchiveRestore } from 'lucide-react';
import { get, post, put, patch, del, getUserMessage } from '../../api';
import { formatCurrency } from '../../utils/formatCurrency';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import SearchableSelect from '../SearchableSelect';
import { generateAutoSku } from '../../utils/sku';

interface Product {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  section?: string;
  sale_price?: number;
}

interface ComboItem {
  id?: number;
  product_id?: number | null;
  product_title?: string;
  quantity: number;
  selection_type?: 'product' | 'category';
  category_name?: string;
}

interface Deal {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  sale_price?: number;
  section?: string;
  combo_items: ComboItem[];
  archived_at?: string | null;
}

type DealsResponse = { deals?: Deal[] };
type ProductsResponse = { products?: Array<Product & { is_deal?: boolean }> };

export default function DealsTab() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [showForm, setShowForm] = useState(false);
  const [editingDealId, setEditingDealId] = useState<number | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formSkuTouched, setFormSkuTouched] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    sku: '',
    sale_price: '',
    combo_items: [] as ComboItem[]
  });

  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set(
          products
            .map(product => (product.section || '').trim())
            .filter(section => section && section !== 'Deals')
        )
      )
        .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        .map(section => ({ value: section, label: section })),
    [products]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [dealsRes, productsRes] = await Promise.all([
        // Same handlers as /menu/deals/; inventory-advanced path is stable across backend reloads.
        get<DealsResponse>(`/inventory-advanced/deals/${includeArchived ? '?include_archived=1' : ''}`),
        get<ProductsResponse>('/menu-items/')
      ]);
      setDeals(dealsRes.deals || []);
      // Filter out deals from the products list so we don't nest deals in deals
      const allProducts = productsRes.products || [];
      const nonDealProducts = allProducts.filter((p) => !p.is_deal);
      setProducts(nonDealProducts);
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setFormData({ title: '', sku: '', sale_price: '', combo_items: [] });
    setEditingDealId(null);
    setFormSkuTouched(false);
  };

  const buildPayload = () => {
    return {
      title: formData.title,
      sku: formData.sku,
      sale_price: Number(formData.sale_price),
      combo_items: formData.combo_items.map(({ product_id, quantity, selection_type, category_name }) => ({
        selection_type: selection_type || 'product',
        product_id: (selection_type || 'product') === 'product' ? Number(product_id) : null,
        category_name: (selection_type || 'product') === 'category' ? (category_name || '').trim() : '',
        quantity: Number(quantity),
      }))
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedPrice = Number(formData.sale_price);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
      showToast('Enter valid bundled price before saving deal', 'error');
      return;
    }

    if (formData.combo_items.length === 0) {
      showToast('Please add at least one menu item to the deal', 'error');
      return;
    }

    const invalidRowIndex = formData.combo_items.findIndex((item) => {
      const selectionType = item.selection_type || 'product';
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return true;
      }
      if (selectionType === 'category') {
        return !item.category_name?.trim();
      }
      return !Number.isInteger(Number(item.product_id)) || Number(item.product_id) <= 0;
    });
    if (invalidRowIndex >= 0) {
      showToast(`Complete combo line ${invalidRowIndex + 1} before saving deal`, 'error');
      return;
    }

    try {
      if (editingDealId) {
        await put(`/inventory-advanced/deals/${editingDealId}`, buildPayload());
        showToast('Deal updated successfully', 'success');
      } else {
        await post('/inventory-advanced/deals/', buildPayload());
        showToast('Deal created successfully', 'success');
      }
      setShowForm(false);
      resetForm();
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const handleEdit = (deal: Deal) => {
    setEditingDealId(deal.id);
    setFormSkuTouched(true);
    setFormData({
      title: deal.title,
      sku: deal.sku,
      sale_price: String(deal.sale_price ?? deal.base_price ?? ''),
      combo_items: (deal.combo_items || []).map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        selection_type: item.selection_type || 'product',
        category_name: item.category_name || '',
      })),
    });
    setShowForm(true);
  };

  const handleArchive = async (id: number) => {
    const confirmed = await showConfirm({
      title: 'Remove deal from menu',
      message:
        'This archives the deal: it disappears from the POS and menu, but past receipts and sales history stay intact.',
      confirmLabel: 'Remove',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await patch(`/inventory-advanced/deals/${id}/archive`, {});
      showToast('Deal removed from menu', 'success');
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const handleRestore = async (id: number) => {
    try {
      await patch(`/inventory-advanced/deals/${id}/unarchive`, {});
      showToast('Deal restored to menu', 'success');
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const handlePermanentDelete = async (deal: Deal) => {
    const confirmed = await showConfirm({
      title: 'Permanently delete deal',
      message:
        `This permanently deletes "${deal.title}" and its combo setup. Past sales keep their receipt lines, but the deal product link is cleared. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      variant: 'danger'
    });
    if (!confirmed) return;

    try {
      await del(`/inventory-advanced/deals/${deal.id}?permanent=1`);
      showToast('Deal permanently deleted', 'success');
      if (editingDealId === deal.id) {
        setShowForm(false);
        resetForm();
      }
      fetchData();
    } catch (err) {
      showToast(getUserMessage(err), 'error');
    }
  };

  const addComboItem = () => {
    setFormData(prev => ({
      ...prev,
      combo_items: [
        ...prev.combo_items,
        { product_id: undefined, quantity: 1, selection_type: 'product', category_name: '' },
      ]
    }));
  };

  const updateComboItem = (index: number, field: keyof ComboItem, value: string | number | null | undefined) => {
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

  useEffect(() => {
    if (formSkuTouched) {
      return;
    }
    const nextSku = formData.title.trim() ? generateAutoSku('DEAL', formData.title, deals.map((deal) => deal.sku)) : '';
    setFormData((prev) => (prev.sku === nextSku ? prev : { ...prev, sku: nextSku }));
  }, [deals, formData.title, formSkuTouched]);

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
            follows each bundled item&apos;s recipe (BOM), same as regular menu items. Deals themselves do not carry a
            separate BOM.
          </p>
        </div>
        <button
          onClick={() => {
            setShowForm((prev) => {
              const next = !prev;
              if (next) {
                resetForm();
              }
              return next;
            });
          }}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded-[11px] transition-all touch-target font-semibold"
        >
          {showForm ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
          {showForm ? 'Cancel' : 'New Deal'}
        </button>
      </div>

      <div className="flex items-center justify-between rounded-[18px] border border-soot-200/60 bg-white/60 px-4 py-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={() => setIncludeArchived(v => !v)}
            className="rounded border-soot-300 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-semibold text-soot-700">Include archived deals</span>
        </label>
        {editingDealId && (
          <span className="text-xs font-semibold text-brand-700">Editing deal #{editingDealId}</span>
        )}
      </div>

      {showForm && (
        <div className="glass-card page-padding rounded-[18px] animate-in slide-in-from-top-4 duration-300 border-l-4 border-l-brand-500">
          <h3 className="text-lg font-bold text-soot-900 mb-4">{editingDealId ? 'Edit Deal' : 'Create New Deal'}</h3>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Deal Title</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={e => setFormData({...formData, title: e.target.value})}
                  className="w-full bg-white/50 border border-soot-200 rounded-[11px] px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="e.g. Burger Combo"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Deal SKU</label>
                <input
                  type="text"
                  required
                  value={formData.sku}
                  onChange={e => {
                    setFormSkuTouched(true);
                    setFormData({...formData, sku: e.target.value});
                  }}
                  className="w-full bg-white/50 border border-soot-200 rounded-[11px] px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
                  placeholder="Auto-generated from deal title"
                />
                <p className="text-xs text-soot-500 mt-1.5">Auto-generated for new deals. You can still edit it.</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-soot-700 mb-2">Bundled price (PKR)</label>
                <input
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value={formData.sale_price}
                  onChange={e => setFormData({...formData, sale_price: e.target.value})}
                  className="w-full bg-white/50 border border-soot-200 rounded-[11px] px-4 py-3 focus:ring-2 focus:ring-brand-500 transition-all font-medium touch-target outline-none"
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
                  className="flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-[8px] transition-colors"
                >
                  <ListPlus className="w-4 h-4" /> Add Item
                </button>
              </div>
              
              <div className="space-y-3">
                {formData.combo_items.map((item, index) => (
                  <div key={index} className="space-y-4 bg-white/30 p-4 rounded-[11px] border border-soot-100">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => updateComboItem(index, 'selection_type', 'product')}
                        className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                          (item.selection_type || 'product') === 'product'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white text-soot-600 border border-soot-200 hover:border-brand-300'
                        }`}
                      >
                        Fixed menu item
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setFormData(prev => {
                            const nextItems = [...prev.combo_items];
                            nextItems[index] = {
                              ...nextItems[index],
                              selection_type: 'category',
                              product_id: undefined,
                            };
                            return { ...prev, combo_items: nextItems };
                          })
                        }
                        className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                          (item.selection_type || 'product') === 'category'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white text-soot-600 border border-soot-200 hover:border-brand-300'
                        }`}
                      >
                        Category choice
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-4 items-end">
                    <div className="flex-1 min-w-[200px]">
                      <label className="block text-xs font-semibold text-soot-600 mb-1">
                        {(item.selection_type || 'product') === 'category' ? 'Category' : 'Menu Item'}
                      </label>
                      {(item.selection_type || 'product') === 'category' ? (
                        <SearchableSelect
                          value={item.category_name || ''}
                          onChange={(value) => updateComboItem(index, 'category_name', value)}
                          placeholder="Select category…"
                          searchPlaceholder="Search categories…"
                          options={categoryOptions}
                          className="border-soot-200 bg-white px-3 py-2 font-medium"
                        />
                      ) : (
                        <SearchableSelect
                          value={item.product_id ? String(item.product_id) : ''}
                          onChange={(value) => updateComboItem(index, 'product_id', parseInt(value, 10))}
                          placeholder="Select product…"
                          searchPlaceholder="Search menu items…"
                          options={products.map((product) => ({
                            value: String(product.id),
                            label: `${product.title} (${formatCurrency(product.sale_price ?? product.base_price)})`,
                            searchText: `${product.sku} ${product.title} ${(product.section || '').trim()}`,
                          }))}
                          className="border-soot-200 bg-white px-3 py-2 font-medium"
                        />
                      )}
                    </div>
                    <div className="w-24 shrink-0">
                      <label className="block text-xs font-semibold text-soot-600 mb-1">Quantity</label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={item.quantity}
                        onChange={e => updateComboItem(index, 'quantity', parseInt(e.target.value))}
                        className="w-full bg-white border border-soot-200 rounded-[8px] px-3 py-2 font-medium focus:ring-2 focus:ring-brand-400 outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeComboItem(index)}
                      className="p-2 text-soot-400 hover:text-red-500 hover:bg-red-50 rounded-[8px] transition-colors"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                    </div>
                    {(item.selection_type || 'product') === 'category' && (
                      <p className="text-xs text-soot-500">
                        Cashier will choose any menu item from this category on the dashboard before adding the deal.
                      </p>
                    )}
                  </div>
                ))}
                {formData.combo_items.length === 0 && (
                  <div className="text-center py-6 bg-white/20 rounded-[11px] border border-dashed border-soot-200">
                    <p className="text-soot-500 font-medium">No items added to this deal yet.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className="px-6 py-2.5 rounded-[11px] text-soot-600 font-semibold hover:bg-soot-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bg-brand-600 hover:bg-brand-700 text-white px-8 py-2.5 rounded-[11px] font-bold transition-all touch-target"
              >
                {editingDealId ? 'Update Deal' : 'Save Deal'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {deals.length === 0 ? (
          <div className="col-span-full glass-card page-padding rounded-[18px] text-center py-12">
            <UtensilsCrossed className="w-12 h-12 text-soot-300 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-soot-900">No Deals Created</h3>
            <p className="text-soot-500">Create your first deal to bundle items together.</p>
          </div>
        ) : (
          deals.map(deal => (
            <div key={deal.id} className={`glass-card rounded-[18px] border border-soot-200/50 flex flex-col hover:border-brand-300 transition-colors group ${deal.archived_at ? 'opacity-75' : ''}`}>
              <div className="p-5 border-b border-soot-100 flex justify-between items-start bg-white rounded-t-[18px]">
                <div>
                  <h3 className="font-bold text-lg text-soot-900">{deal.title}</h3>
                  <span className="text-xs bg-brand-100 text-brand-800 font-bold px-2 py-0.5 rounded-md border border-brand-200 inline-block mt-1">
                    {deal.sku}
                  </span>
                  <span className="text-xs bg-soot-100 text-soot-700 font-semibold px-2 py-0.5 rounded-md border border-soot-200 inline-block mt-1 ml-1">
                    {deal.section || 'Deals'}
                  </span>
                  {deal.archived_at && (
                    <span className="text-xs bg-amber-100 text-amber-800 font-semibold px-2 py-0.5 rounded-md border border-amber-200 inline-block mt-1 ml-1">
                      Archived
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => handleEdit(deal)}
                    className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded-[8px] transition-colors"
                    title="Edit deal"
                  >
                    <Pencil className="w-5 h-5" />
                  </button>
                  {deal.archived_at ? (
                    <button
                      type="button"
                      onClick={() => handleRestore(deal.id)}
                      className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded-[8px] transition-colors"
                      title="Restore deal"
                    >
                      <ArchiveRestore className="w-5 h-5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleArchive(deal.id)}
                      className="p-1.5 text-soot-400 hover:text-amber-600 hover:bg-amber-50 rounded-[8px] transition-colors"
                      title="Archive deal"
                    >
                      <Archive className="w-5 h-5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handlePermanentDelete(deal)}
                    className="p-1.5 text-soot-400 hover:text-red-500 hover:bg-red-50 rounded-[8px] transition-colors"
                    title="Delete permanently"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>
              <div className="p-5 flex-1">
                <ul className="space-y-2">
                  {deal.combo_items.map((item, idx) => (
                    <li key={idx} className="flex justify-between items-center text-sm gap-2">
                      <span className="text-soot-600 font-medium pb-1 border-b border-dashed border-soot-200 flex-1 mr-4">
                        <span className="font-bold text-soot-900 mr-2">{item.quantity}x</span>
                        {(item.selection_type || 'product') === 'category'
                          ? `Choose any from ${item.category_name || 'category'}`
                          : item.product_title}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="p-5 bg-soot-50/50 border-t border-soot-100 rounded-b-2xl font-bold text-lg text-brand-700 flex justify-between items-center">
                <span>Bundle Price:</span>
                <span>{formatCurrency(deal.sale_price ?? deal.base_price)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
