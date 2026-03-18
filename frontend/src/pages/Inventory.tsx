import { useState, useEffect } from 'react';
import { Plus, X, Loader2, ChevronDown, Check, Trash2, PackagePlus, Minus, Pencil, ScanBarcode, Upload, Archive, ArchiveRestore } from 'lucide-react';
import BarcodeModal from '../components/BarcodeModal';
import { showToast } from '../components/Toast';
import { showConfirm } from '../components/ConfirmDialog';
import { useScanner } from '../hooks/useScanner';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, put, patch, del, getUserMessage } from '../api';
const FALLBACK_VARIANT_OPTIONS = ['Standard', 'Spicy', 'Mild', 'Large', 'Small'];

type Product = {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  section: string;
  variants: string[];
  image_url?: string;
  archived_at?: string | null;
};

function StockInput({ initialStock, onUpdate }: { initialStock: number, onUpdate: (delta: number) => void }) {
  const [val, setVal] = useState(initialStock.toString());

  useEffect(() => {
    setVal(initialStock.toString());
  }, [initialStock]);

  const handleBlur = () => {
    const num = parseInt(val) || 0;
    if (num !== initialStock) {
      onUpdate(num - initialStock);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleBlur();
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="w-16 min-h-[44px] text-xl font-bold text-center border-b-2 border-transparent focus:border-brand-500 bg-transparent focus:outline-none focus:ring-0 px-1 m-0 transition-colors touch-target"
      style={{ MozAppearance: 'textfield' }}
      aria-label="Quantity"
    />
  );
}

export default function Inventory() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [variantOptions, setVariantOptions] = useState<string[]>(FALLBACK_VARIANT_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [stockEditingProduct, setStockEditingProduct] = useState<Product | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null);
  const [inventory, setInventory] = useState<Record<string, Record<string, number>>>({});
  const [addViaScanner, setAddViaScanner] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const { lastScannedBarcode, clearBarcode } = useScanner();

  // When "Add via scanner" is on and a barcode is scanned, open variants/quantities modal for that product
  useEffect(() => {
    if (!addViaScanner || !lastScannedBarcode || products.length === 0) return;
    const matched = products.find(p => p.sku === lastScannedBarcode);
    if (matched) {
      setStockEditingProduct(matched);
      clearBarcode();
    } else {
      showToast(`SKU not found: ${lastScannedBarcode}`, 'error');
      clearBarcode();
    }
  }, [addViaScanner, lastScannedBarcode, products, clearBarcode]);

  useEffect(() => {
    fetchData();
  }, [includeArchived]);

  // ── Form state ──
  const [formSku, setFormSku] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formPrice, setFormPrice] = useState('');
  const [formSection, setFormSection] = useState('');
  const [formVariants, setFormVariants] = useState<string[]>([]);
  const [formImageUrl, setFormImageUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Fetch products + sections on mount
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    const activeBranchId = localStorage.getItem('active_branch_id') ?? '1';
    const productQuery = includeArchived ? '/menu-items/?include_archived=1' : '/menu-items/';
    try {
      const [prodData, settingsData, invData] = await Promise.all([
        get<{ products?: Product[] }>(productQuery),
        get<{ config?: { sections?: string[]; variants?: string[] } }>(`/settings/?branch_id=${activeBranchId}`),
        get<{ inventory?: Record<string, Record<string, number>> }>(`/stock/?branch_id=${activeBranchId}`),
      ]);
      const productsList = prodData?.products ?? [];
      setProducts(productsList);
      const configSections = settingsData?.config?.sections;
      const sectionsList = Array.isArray(configSections) && configSections.length > 0
        ? configSections
        : [...new Set(productsList.map(p => p?.section).filter(Boolean))] as string[];
      setSections(sectionsList);
      const configVariants = settingsData?.config?.variants;
      setVariantOptions(
        Array.isArray(configVariants) && configVariants.length > 0
          ? configVariants
          : FALLBACK_VARIANT_OPTIONS
      );
      setInventory(invData?.inventory ?? {});
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormSku('');
    setFormTitle('');
    setFormPrice('');
    setFormSection('');
    setFormVariants([]);
    setFormImageUrl('');
    setFormError('');
  };

  const handleOpenModal = () => {
    resetForm();
    setEditingProduct(null);
    setShowModal(true);
  };

  const handleOpenEditModal = (p: Product) => {
    setEditingProduct(p);
    setFormSku(p.sku);
    setFormTitle(p.title);
    setFormPrice(p.base_price.toString());
    setFormSection(p.section || '');
    setFormVariants(p.variants || []);
    setFormImageUrl(p.image_url || '');
    setFormError('');
    setShowModal(true);
  };

  const handleSectionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const section = e.target.value;
    setFormSection(section);
    
    // Auto-generate SKU only for new products
    if (!editingProduct && section) {
      const prefix = section.substring(0, 3).toUpperCase();
      let generatedSku = '';
      let isUnique = false;
      
      while (!isUnique) {
        const rand = Math.floor(100000 + Math.random() * 900000); // 6 digits
        generatedSku = `${prefix}-${rand}`;
        // eslint-disable-next-line no-loop-func
        isUnique = !products.some(p => p.sku === generatedSku);
      }
      
      setFormSku(generatedSku);
    } else if (!editingProduct && !section) {
      setFormSku('');
    }
  };

  const toggleVariant = (v: string) => {
    setFormVariants(prev =>
      prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!formSku.trim() || !formTitle.trim() || !formPrice.trim() || !formSection) {
      setFormError('SKU, Title, Base Price, and Category are required.');
      return;
    }
    const parsedPrice = parseFloat(formPrice);
    if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
      setFormError('Base price must be a valid number (0 or greater).');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const body = {
        sku: formSku.trim(),
        title: formTitle.trim(),
        base_price: parsedPrice,
        section: formSection,
        variants: formVariants,
        image_url: formImageUrl.trim() || '',
      };
      if (editingProduct) {
        await put(`/menu-items/${editingProduct.id}`, body);
      } else {
        await post('/menu-items/', body);
      }
      setShowModal(false);
      fetchData();
    } catch (e) {
      setFormError(getUserMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchive = async (p: Product) => {
    try {
      await patch(`/menu-items/${p.id}/archive`, null);
      showToast('Product archived', 'success');
      fetchData();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleUnarchive = async (p: Product) => {
    try {
      await patch(`/menu-items/${p.id}/unarchive`, null);
      showToast('Product restored', 'success');
      fetchData();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handlePermanentDelete = async (p: Product) => {
    const confirmed = await showConfirm({
      title: 'Permanently delete product?',
      message: `"${p.title}" will be removed forever. This cannot be undone.`,
      relatedEffects: [
        'All stock records for this item will be deleted.',
        'Order history will be kept; line items will show as "Unknown item".',
      ],
      confirmLabel: 'Delete permanently',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await del(`/menu-items/${p.id}`);
      showToast('Product deleted permanently', 'success');
      fetchData();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleAdjustStock = async (productId: number, variantSuffix: string, delta: number) => {
    // Optimistic update
    setInventory(prev => {
      const pId = productId.toString();
      const newMap = { ...prev };
      if (!newMap[pId]) newMap[pId] = {};
      const current = newMap[pId][variantSuffix] || 0;
      newMap[pId][variantSuffix] = current + delta;
      return newMap;
    });
    
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? '1';
      await post('/stock/update', {
        product_id: productId,
        variant_sku_suffix: variantSuffix,
        stock_delta: delta,
        branch_id: parseInt(activeBranchId, 10),
      });
    } catch {
      fetchData(); // Revert on failure
    }
  };

  return (
    <>
      {barcodeProduct && (
        <BarcodeModal
          sku={barcodeProduct.sku}
          title={barcodeProduct.title}
          onClose={() => setBarcodeProduct(null)}
        />
      )}
      <div className="flex flex-col h-full bg-white rounded-xl shadow-sm border border-soot-200">
        {/* Header */}
        <div className="p-6 border-b border-soot-200 flex flex-wrap justify-between items-center gap-4 bg-soot-50">
          <h2 className="text-xl font-bold text-soot-900">Menu & Stock</h2>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={() => setIncludeArchived(v => !v)}
                className="rounded border-soot-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm font-medium text-soot-700">Include archived</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-sm font-medium text-soot-700">Add via scanner</span>
              <button
                type="button"
                role="switch"
                aria-checked={addViaScanner}
                onClick={() => setAddViaScanner(v => !v)}
                className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                  addViaScanner ? 'bg-brand-600 border-brand-600' : 'bg-soot-200 border-soot-200'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                    addViaScanner ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                  style={{ marginTop: 2 }}
                />
              </button>
            </label>
            <button
              onClick={handleOpenModal}
              className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-lg font-medium hover:bg-brand-600 touch-target transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add menu item
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="p-6 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading stock…
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-20 text-soot-400">
              <p className="text-lg font-medium mb-1">No menu items yet</p>
              <p className="text-sm">Click "Add menu item" to get started.</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b-2 border-soot-200 text-sm uppercase text-soot-500 font-semibold tracking-wider">
                  <th className="py-3 px-4">SKU</th>
                  <th className="py-3 px-4">Item name</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4">Options</th>
                  <th className="py-3 px-4">Base Price</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => (
                  <tr key={p.id} className={`border-b border-soot-100 hover:bg-soot-50 transition-colors ${p.archived_at ? 'bg-soot-50/70 opacity-90' : ''}`}>
                    <td className="py-3 px-4 font-mono text-sm">{p.sku}</td>
                    <td className="py-3 px-4 font-medium text-soot-900">{p.title}</td>
                    <td className="py-3 px-4">
                      {p.section ? (
                        <span className="inline-block px-2.5 py-1 bg-brand-50 text-brand-700 rounded-md text-xs font-semibold border border-brand-100">
                          {p.section}
                        </span>
                      ) : (
                        <span className="text-soot-300 text-sm">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {p.variants && p.variants.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {p.variants.map((v: string) => (
                            <span key={v} className="inline-block px-2 py-0.5 bg-neutral-100 text-neutral-600 rounded text-xs font-medium border border-neutral-200">
                              {v} <span className="text-neutral-400 font-bold ml-1">({inventory[p.id.toString()]?.[v] || 0})</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="inline-block px-2 py-0.5 bg-neutral-100 text-neutral-600 rounded text-xs font-medium border border-neutral-200">
                          Standard <span className="text-neutral-400 font-bold ml-1">({inventory[p.id.toString()]?.[''] || 0})</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-semibold">{formatCurrency(p.base_price)}</td>
                    <td className="py-3 px-4 text-right">
                       <div className="flex items-center justify-end gap-1">
                         <button 
                           onClick={() => setBarcodeProduct(p)}
                           className="p-2 flex items-center justify-center text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                           title="Print Barcode Label"
                         >
                           <ScanBarcode className="w-4 h-4" />
                         </button>
                         <button 
                           onClick={() => handleOpenEditModal(p)}
                           className="p-2 flex items-center justify-center text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                           title="Edit item"
                         >
                           <Pencil className="w-4 h-4" />
                         </button>
                         {!p.archived_at && (
                           <button
                             onClick={() => setStockEditingProduct(p)}
                             className="p-2 flex items-center justify-center text-neutral-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                             title="Adjust Stock"
                           >
                             <PackagePlus className="w-4 h-4" />
                           </button>
                         )}
                         {p.archived_at ? (
                           <>
                             <button onClick={() => handleUnarchive(p)} className="p-2 flex items-center justify-center text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors" title="Restore">
                               <ArchiveRestore className="w-4 h-4" />
                             </button>
                             <button onClick={() => handlePermanentDelete(p)} className="p-2 flex items-center justify-center text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete permanently">
                               <Trash2 className="w-4 h-4" />
                             </button>
                           </>
                         ) : (
                           <>
                             <button onClick={() => handleArchive(p)} className="p-2 flex items-center justify-center text-neutral-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors" title="Archive">
                               <Archive className="w-4 h-4" />
                             </button>
                             <button onClick={() => handlePermanentDelete(p)} className="p-2 flex items-center justify-center text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete permanently">
                               <Trash2 className="w-4 h-4" />
                             </button>
                           </>
                         )}
                       </div>
                     </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Add menu item modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-auto flex flex-col max-h-[90vh] overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 bg-neutral-50 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900">{editingProduct ? 'Edit menu item' : 'Add menu item'}</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            {/* Form - scrollable on small screens */}
            <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto min-h-0 flex-1">
              {formError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-2 text-sm font-medium">
                  {formError}
                </div>
              )}

              {/* SKU */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">SKU <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  inputMode="text"
                  value={formSku}
                  onChange={e => setFormSku(e.target.value)}
                  placeholder="e.g. BURGER-001"
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Item name <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  inputMode="text"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder="e.g. Classic Cheeseburger"
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>

              {/* Price */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Base Price <span className="text-red-400">*</span></label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={formPrice}
                  onChange={e => setFormPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>

              {/* Product Image */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Item image</label>
                <div className="flex items-start gap-3">
                  {formImageUrl && (
                    <div className="w-16 h-16 rounded-lg border border-neutral-200 bg-neutral-50 overflow-hidden shrink-0">
                      <img src={formImageUrl} alt="" className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className="flex-1 space-y-2">
                    <input
                      type="url"
                      inputMode="url"
                      value={formImageUrl.startsWith('data:') ? '' : formImageUrl}
                      onChange={e => setFormImageUrl(e.target.value)}
                      placeholder="Image URL (or upload below)"
                      className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    />
                    <label className="flex items-center gap-2 text-sm text-neutral-600 cursor-pointer">
                      <Upload className="w-4 h-4" />
                      <span>Upload image</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (!file || file.size > 1024 * 1024) return;
                          const reader = new FileReader();
                          reader.onload = () => setFormImageUrl(reader.result as string);
                          reader.readAsDataURL(file);
                        }}
                      />
                    </label>
                  </div>
                </div>
                <p className="mt-1 text-xs text-neutral-500">Shown on the Dashboard. Leave empty for default placeholder.</p>
              </div>

              {/* Section Dropdown */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Category <span className="text-red-400">*</span></label>
                <div className="relative">
                  <select
                    value={formSection}
                    onChange={handleSectionChange}
                    className="w-full appearance-none px-4 py-2.5 pr-10 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none bg-white"
                  >
                    <option value="">— No category —</option>
                    {sections.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
                </div>
                {sections.length === 0 && (
                  <p className="text-xs text-neutral-400 mt-1">No categories yet. Add them in Settings → Categories.</p>
                )}
              </div>

              {/* Option checkboxes (from Settings → Variants when configured; include current product variants so they stay editable) */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-2">Options</label>
                <div className="flex flex-wrap gap-2">
                  {[...new Set([...variantOptions, ...formVariants])].map(v => {
                    const selected = formVariants.includes(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => toggleVariant(v)}
                        className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium border transition-all ${
                          selected
                            ? 'bg-brand-700 text-white border-brand-700'
                            : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-300'
                        }`}
                      >
                        {selected && <Check className="w-3.5 h-3.5" />}
                        {v}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-neutral-500">Manage option names in Settings → Variants.</p>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {submitting ? 'Saving…' : (editingProduct ? 'Save Changes' : 'Add menu item')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Adjust stock modal (options / quantities) */}
      {stockEditingProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden my-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 bg-neutral-50 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900 truncate pr-2">Manage Stock: {stockEditingProduct.title}</h3>
              <button onClick={() => setStockEditingProduct(null)} className="p-1.5 rounded-lg hover:bg-neutral-200 transition-colors shrink-0">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>
            
            <div className="p-6 space-y-4 overflow-y-auto min-h-0 flex-1">
              {(!stockEditingProduct.variants || stockEditingProduct.variants.length === 0) ? (
                // No variants
                <div className="flex items-center justify-between bg-neutral-50 p-4 rounded-xl border border-neutral-200">
                  <span className="font-medium text-neutral-800">Standard</span>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => handleAdjustStock(stockEditingProduct.id, '', -1)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg bg-white border border-neutral-300 text-neutral-600 hover:bg-neutral-100 touch-target active:bg-neutral-200"
                    >
                      <Minus className="w-5 h-5" />
                    </button>
                    <StockInput 
                      initialStock={inventory[stockEditingProduct.id.toString()]?.[''] || 0}
                      onUpdate={(delta) => handleAdjustStock(stockEditingProduct.id, '', delta)}
                    />
                    <button 
                      onClick={() => handleAdjustStock(stockEditingProduct.id, '', 1)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg bg-white border border-neutral-300 text-neutral-600 hover:bg-neutral-100 touch-target active:bg-neutral-200"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ) : (
                // With variants
                stockEditingProduct.variants.map(v => (
                  <div key={v} className="flex items-center justify-between bg-neutral-50 p-4 rounded-xl border border-neutral-200">
                    <span className="font-semibold text-neutral-800 bg-white px-2 py-1 rounded text-sm border border-neutral-200">{v}</span>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => handleAdjustStock(stockEditingProduct.id, v, -1)}
                        className="w-10 h-10 flex items-center justify-center rounded-lg bg-white border border-neutral-300 text-neutral-600 hover:bg-neutral-100 touch-target active:bg-neutral-200"
                      >
                        <Minus className="w-5 h-5" />
                      </button>
                      <StockInput 
                        initialStock={inventory[stockEditingProduct.id.toString()]?.[v] || 0}
                        onUpdate={(delta) => handleAdjustStock(stockEditingProduct.id, v, delta)}
                      />
                      <button 
                        onClick={() => handleAdjustStock(stockEditingProduct.id, v, 1)}
                        className="w-10 h-10 flex items-center justify-center rounded-lg bg-white border border-neutral-300 text-neutral-600 hover:bg-neutral-100 touch-target active:bg-neutral-200"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-6 pb-6 flex justify-end border-t border-neutral-100 bg-white shrink-0">
              <button
                type="button"
                onClick={() => {
                  setStockEditingProduct(null);
                  showToast('Stock updated', 'success');
                }}
                className="px-4 py-2.5 bg-brand-700 text-white rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
