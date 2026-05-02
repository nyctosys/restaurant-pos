import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { Plus, X, Loader2, Trash2, ScanBarcode, Upload, Archive, ArchiveRestore, Pencil, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import BarcodeModal from '../BarcodeModal';
import SearchableSelect from '../SearchableSelect';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import { useScanner } from '../../hooks/useScanner';
import { formatCurrency } from '../../utils/formatCurrency';
import { get, post, put, patch, del, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import { generateAutoSku } from '../../utils/sku';

type Product = {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  sale_price?: number;
  section: string;
  variants: { name: string; basePrice: number; salePrice: number; totalQuantity?: number; unit?: string; sku?: string }[];
  image_url?: string;
  archived_at?: string | null;
  unitOfMeasure?: string;
  /** Saved catalog unit from API (preferred when present). */
  catalog_unit?: string | null;
  totalQuantity?: number;
};

type SortKey = 'sku' | 'title' | 'section' | 'base_price' | 'sale_price' | 'archived_at';
type SortDirection = 'asc' | 'desc';

/** Menu catalog: serving units only (not inventory packaging). Must align with `menu.py` _ALLOWED_CATALOG_UNITS. */
const MENU_CATALOG_UNIT_GROUPS: { group: string; options: { value: string; label: string }[] }[] = [
  {
    group: 'Weight',
    options: [
      { value: 'kg', label: 'kg' },
      { value: 'g', label: 'g' },
    ],
  },
  {
    group: 'Volume',
    options: [
      { value: 'ltr', label: 'ltr' },
      { value: 'ml', label: 'ml' },
    ],
  },
  { group: 'Count', options: [{ value: 'pcs', label: 'pcs' }] },
];

function normalizeMenuUnitForForm(raw?: string | null): string {
  const t = (raw || '').trim().toLowerCase();
  if (!t) return '';
  if (t === 'l' || t === 'liter' || t === 'litre') return 'ltr';
  if (t === 'piece' || t === 'pc') return 'pcs';
  return t;
}

function formatUnit(unit?: string): string {
  if (!unit) return '';
  return unit.replace('UnitOfMeasure.', '').toLowerCase();
}

/** Menu catalog only — stock is tracked per ingredient (Recipes / Ingredients tabs). */
export default function MenuItemsTab() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [barcodeProduct, setBarcodeProduct] = useState<Product | null>(null);
  const [addViaScanner, setAddViaScanner] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('title');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const { lastScannedBarcode, clearBarcode } = useScanner();

  const [formSku, setFormSku] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [formSection, setFormSection] = useState('');
  const [formImageUrl, setFormImageUrl] = useState('');
  const [formUnit, setFormUnit] = useState('');
  const [formSkuTouched, setFormSkuTouched] = useState(false);
  const [formVariants, setFormVariants] = useState<{ name: string; salePrice: string; sku: string }[]>([
    { name: 'Default', salePrice: '', sku: '' },
  ]);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void fetchData();
  }, [includeArchived]);

  const fetchData = async (forceRefresh = false) => {
    setLoading(true);
    const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
    const settingsQuery = activeBranchId ? `/settings/?branch_id=${activeBranchId}` : '/settings/';
    const productQuery = includeArchived ? '/menu-items/?include_archived=1' : '/menu-items/';
    try {
      const [prodData, settingsData] = await Promise.all([
        get<{ products?: Product[] }>(productQuery, { cacheTtlMs: 0, forceRefresh }),
        get<{ config?: { sections?: string[] } }>(settingsQuery),
      ]);
      const productsList = prodData?.products ?? [];
      setProducts(productsList);
      const configSections = settingsData?.config?.sections;
      const sectionsList =
        Array.isArray(configSections) && configSections.length > 0
          ? configSections
          : ([...new Set(productsList.map(p => p?.section).filter(Boolean))] as string[]);
      setSections(sectionsList);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormSku('');
    setFormTitle('');
    setFormSection('');
    setFormImageUrl('');
    setFormUnit('');
    setFormSkuTouched(false);
    setFormVariants([{ name: 'Default', salePrice: '', sku: '' }]);
    setFormError('');
  };

  const handleOpenModal = () => {
    resetForm();
    setEditingProduct(null);
    setShowModal(true);
  };

  const handleOpenEditModal = useCallback((p: Product) => {
    setEditingProduct(p);
    setFormSku(p.sku);
    setFormSkuTouched(true);
    setFormTitle(p.title);
    setFormSection(p.section || '');
    setFormImageUrl(p.image_url || '');
    setFormUnit(normalizeMenuUnitForForm(p.catalog_unit || p.unitOfMeasure || ''));
    setFormVariants(
      Array.isArray(p.variants) && p.variants.length
        ? p.variants.map(v => ({
            name: v.name,
            salePrice: String(v.salePrice),
            sku: v.sku || '',
          }))
        : [{ name: 'Default', salePrice: '', sku: '' }]
    );
    setFormError('');
    setShowModal(true);
  }, []);

  useEffect(() => {
    if (!addViaScanner || !lastScannedBarcode || products.length === 0) return;
    const matched = products.find(p => p.sku === lastScannedBarcode);
    if (matched) {
      handleOpenEditModal(matched);
      clearBarcode();
    } else {
      showToast(`SKU not found: ${lastScannedBarcode}`, 'error');
      clearBarcode();
    }
  }, [addViaScanner, lastScannedBarcode, products, clearBarcode, handleOpenEditModal]);

  // Auto-generate SKU from title for new items (only when SKU hasn't been manually touched)
  useEffect(() => {
    if (editingProduct || formSkuTouched) return;
    if (!formTitle.trim()) { setFormSku(''); return; }
    const prefix = formSection ? formSection.substring(0, 3).toUpperCase() : 'MNU';
    const next = generateAutoSku(prefix, formTitle, products.map(p => p.sku));
    setFormSku(next);
  }, [editingProduct, formTitle, formSection, formSkuTouched, products]);

  const handleSectionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const section = e.target.value;
    setFormSection(section);

    if (!editingProduct && section) {
      const prefix = section.substring(0, 3).toUpperCase();
      let generatedSku = '';
      let isUnique = false;

      while (!isUnique) {
        const rand = Math.floor(100000 + Math.random() * 900000);
        generatedSku = `${prefix}-${rand}`;
        // eslint-disable-next-line no-loop-func
        isUnique = !products.some(p => p.sku === generatedSku);
      }

      setFormSku(generatedSku);
    } else if (!editingProduct && !section) {
      setFormSku('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!formSku.trim() || !formTitle.trim() || !formSection) {
      setFormError('SKU, Item name, and Category are required.');
      return;
    }
    if (!formVariants.length) {
      setFormError('At least one variant is required.');
      return;
    }
    const normalizedVariants = formVariants.map((variant, index) => {
      const name = variant.name.trim();
      const salePrice = Number.parseFloat(variant.salePrice);
      if (!name) throw new Error(`Variant row ${index + 1}: name is required.`);
      if (!Number.isFinite(salePrice) || salePrice <= 0) throw new Error(`Variant "${name}": sale price must be greater than 0.`);
      return { name, salePrice, sku: variant.sku.trim() || undefined };
    });
    const duplicate = normalizedVariants.find((variant, index) =>
      normalizedVariants.findIndex(item => item.name.toLowerCase() === variant.name.toLowerCase()) !== index
    );
    if (duplicate) {
      setFormError(`Duplicate variant name: ${duplicate.name}`);
      return;
    }
    let unitTrim = formUnit.trim().toLowerCase();
    if (unitTrim === 'l') unitTrim = 'ltr';
    if (unitTrim === 'piece') unitTrim = 'pcs';
    const allowedMenu = new Set(['kg', 'g', 'ltr', 'ml', 'pcs', '']);
    if (!allowedMenu.has(unitTrim)) {
      setFormError('Selling unit must be Weight / Volume / pcs, or leave empty.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const body = {
        sku: formSku.trim(),
        title: formTitle.trim(),
        section: formSection,
        variants: normalizedVariants,
        image_url: formImageUrl.trim() || '',
        unitOfMeasure: unitTrim || '',
      };
      type SaveResponse = { product?: Product; id?: number; message?: string };
      let saved: SaveResponse | null = null;
      if (editingProduct) {
        saved = await put<SaveResponse>(`/menu-items/${editingProduct.id}`, body);
      } else {
        saved = await post<SaveResponse>('/menu-items/', body);
      }
      if (saved?.product) {
        setProducts((prev) => {
          if (editingProduct) {
            return prev.map((p) => (p.id === editingProduct.id ? saved!.product! : p));
          }
          return [saved.product!, ...prev];
        });
      }
      setShowModal(false);
      await fetchData(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : getUserMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleArchive = async (p: Product) => {
    const previousProducts = products;
    setProducts(prev => includeArchived
      ? prev.map(product => product.id === p.id ? { ...product, archived_at: new Date().toISOString() } : product)
      : prev.filter(product => product.id !== p.id)
    );
    try {
      await patch(`/menu-items/${p.id}/archive`, null);
      showToast('Menu item archived', 'success');
      await fetchData(true);
    } catch (e) {
      setProducts(previousProducts);
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleUnarchive = async (p: Product) => {
    const previousProducts = products;
    setProducts(prev => prev.map(product => product.id === p.id ? { ...product, archived_at: null } : product));
    try {
      await patch(`/menu-items/${p.id}/unarchive`, null);
      showToast('Menu item restored', 'success');
      await fetchData(true);
    } catch (e) {
      setProducts(previousProducts);
      showToast(getUserMessage(e), 'error');
    }
  };

  const handlePermanentDelete = async (p: Product) => {
    const confirmed = await showConfirm({
      title: 'Permanently delete menu item?',
      message: `"${p.title}" will be removed forever. This cannot be undone.`,
      relatedEffects: [
        'Order history is kept; line items may show as "Unknown item".',
        'Remove or update Recipes (BOM) that reference this item separately.',
      ],
      confirmLabel: 'Delete permanently',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await del(`/menu-items/${p.id}`);
      showToast('Menu item deleted permanently', 'success');
      await fetchData(true);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('asc');
  };

  const sortedProducts = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    return products
      .map((product, index) => ({ product, index }))
      .sort((a, b) => {
        const left = a.product;
        const right = b.product;

        let result = 0;
        switch (sortKey) {
          case 'base_price':
            result = left.base_price - right.base_price;
            break;
          case 'sale_price':
            result = (left.sale_price ?? left.base_price) - (right.sale_price ?? right.base_price);
            break;
          case 'archived_at': {
            const leftArchived = left.archived_at ? 1 : 0;
            const rightArchived = right.archived_at ? 1 : 0;
            result = leftArchived - rightArchived;
            break;
          }
          case 'sku':
          case 'title':
          case 'section': {
            result = (left[sortKey] || '').localeCompare(right[sortKey] || '', undefined, { sensitivity: 'base' });
            break;
          }
        }

        if (result !== 0) return result * direction;
        return a.index - b.index;
      })
      .map(entry => entry.product);
  }, [products, sortDirection, sortKey]);

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="w-3.5 h-3.5 text-neutral-400" aria-hidden="true" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" />
      : <ArrowDown className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" />;
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
      <div className="flex flex-col h-full min-h-0 bg-transparent">
        <div className="page-padding border-b border-soot-200/60 flex flex-wrap justify-between items-center gap-4 bg-white/25 shrink-0">
          <div>
            <h2 className="text-xl font-bold text-soot-900">Menu catalog</h2>
            <p className="text-xs text-soot-500 mt-1 max-w-md">
              Pricing and merchandising only. Ingredient stock and recipes are managed under Ingredients and Recipes (BOM).
            </p>
          </div>
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
              <span className="text-sm font-medium text-soot-700">Scan to edit</span>
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
              type="button"
              onClick={handleOpenModal}
              className="flex items-center gap-2 bg-brand-700 text-white px-4 py-2 rounded-[8px] font-medium hover:bg-brand-600 touch-target transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add menu item
            </button>
          </div>
        </div>

        <div className="page-padding flex-1 min-h-0 overflow-auto pt-4 lg:pt-5">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-soot-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading menu…
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-20 text-soot-400">
              <p className="text-lg font-medium mb-1">No menu items yet</p>
              <p className="text-sm">Click &quot;Add menu item&quot; to get started.</p>
            </div>
          ) : (
            <div className="app-table-shell">
              <div className="app-table-scroll max-h-[calc(100vh-18rem)] min-h-[22rem] overscroll-contain lg:max-h-[calc(100vh-16rem)]">
                <table className="app-table menu-items-table min-w-[980px]">
                  <colgroup>
                    <col className="w-[13%]" />
                    <col className="w-[24%]" />
                    <col className="w-[15%]" />
                    <col className="w-[13%]" />
                    <col className="w-[13%]" />
                    <col className="w-[10%]" />
                    <col className="w-[12%]" />
                  </colgroup>
              <thead>
                <tr>
                  <th
                    aria-sort={sortKey === 'sku' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('sku')}
                      className="flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>SKU</span>
                      {renderSortIcon('sku')}
                    </button>
                  </th>
                  <th
                    aria-sort={sortKey === 'title' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('title')}
                      className="flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>Item name</span>
                      {renderSortIcon('title')}
                    </button>
                  </th>
                  <th
                    aria-sort={sortKey === 'section' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('section')}
                      className="flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>Category</span>
                      {renderSortIcon('section')}
                    </button>
                  </th>
                  <th
                    aria-sort={sortKey === 'base_price' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('base_price')}
                      className="flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>Base Price (Cost)</span>
                      {renderSortIcon('base_price')}
                    </button>
                  </th>
                  <th
                    aria-sort={sortKey === 'sale_price' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('sale_price')}
                      className="flex w-full items-center gap-2 text-left transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>Sale Price</span>
                      {renderSortIcon('sale_price')}
                    </button>
                  </th>
                  <th className="sticky top-0 z-10 text-left">
                    Unit
                  </th>
                  <th
                    aria-sort={sortKey === 'archived_at' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="sticky top-0 z-10 text-right"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('archived_at')}
                      className="flex w-full items-center justify-end gap-2 text-right transition-colors hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-950 dark:hover:text-neutral-100 dark:focus-visible:text-white"
                    >
                      <span>Actions</span>
                      {renderSortIcon('archived_at')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedProducts.map(p => (
                  <Fragment key={p.id}>
                  <tr
                    className={`group transition-colors ${
                      p.archived_at ? 'bg-neutral-50/80 text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400' : ''
                    }`}
                  >
                    <td className="px-4 py-3.5 align-middle font-mono text-[13px] font-medium text-neutral-500 dark:text-neutral-400">{p.sku}</td>
                    <td className="px-4 py-3.5 align-middle">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-[15px] font-semibold leading-5 text-neutral-950 dark:text-neutral-100">{p.title}</span>
                        {p.archived_at && (
                          <span className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">Archived</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 align-middle">
                      {p.section ? (
                        <span className="inline-flex max-w-full items-center rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:border-brand-900/70 dark:bg-brand-950/40 dark:text-brand-300">
                          {p.section}
                        </span>
                      ) : (
                        <span className="text-neutral-300 text-sm dark:text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 align-middle text-[13px] font-semibold text-neutral-700 dark:text-neutral-300">
                      {formatCurrency(p.variants?.[0]?.basePrice ?? p.base_price)}
                    </td>
                    <td className="px-4 py-3.5 align-middle text-[14px] font-semibold text-neutral-950 dark:text-neutral-100">
                      {formatCurrency(p.variants?.[0]?.salePrice ?? p.sale_price ?? p.base_price)}
                    </td>
                    <td className="px-4 py-3.5 align-middle">
                      {p.totalQuantity !== undefined && p.totalQuantity !== null && p.unitOfMeasure && p.unitOfMeasure !== 'Mixed Units' ? (
                        <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                          {p.totalQuantity} {formatUnit(p.unitOfMeasure)}
                        </span>
                      ) : p.unitOfMeasure === 'Mixed Units' ? (
                        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Mixed Units</span>
                      ) : (
                        <span className="text-xs text-neutral-300 dark:text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 align-middle text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setExpandedRows(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                          title="Show variants"
                        >
                          {expandedRows[p.id] ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setBarcodeProduct(p)}
                          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                          title="Print barcode label"
                        >
                          <ScanBarcode className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenEditModal(p)}
                          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                          title="Edit item"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {p.archived_at ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleUnarchive(p)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-brand-50 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-brand-950/50 dark:hover:text-brand-300"
                              title="Restore"
                            >
                              <ArchiveRestore className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handlePermanentDelete(p)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                              title="Delete permanently"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleArchive(p)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-amber-50 hover:text-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
                              title="Archive"
                            >
                              <Archive className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handlePermanentDelete(p)}
                              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                              title="Delete permanently"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedRows[p.id] && (p.variants || []).map((variant) => (
                    <tr key={`${p.id}-${variant.name}`} className="bg-neutral-50/80 text-[13px] dark:bg-neutral-900/45">
                      <td className="px-4 py-2.5 font-mono text-xs text-neutral-300 dark:text-neutral-600">Variant</td>
                      <td className="px-4 py-2.5 font-medium text-neutral-700 dark:text-neutral-300">
                        <span className="inline-flex items-center gap-2">
                          <span className="h-px w-5 bg-neutral-300 dark:bg-neutral-700" aria-hidden="true" />
                          {variant.name}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">Option</td>
                      <td className="px-4 py-2.5 font-semibold text-neutral-600 dark:text-neutral-400">{formatCurrency(variant.basePrice)}</td>
                      <td className="px-4 py-2.5 font-semibold text-neutral-800 dark:text-neutral-200">{formatCurrency(variant.salePrice)}</td>
                      <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400">
                        {variant.totalQuantity !== undefined && variant.totalQuantity !== null && variant.unit && variant.unit !== 'Mixed Units'
                          ? `${variant.totalQuantity} ${formatUnit(variant.unit)}`
                          : (variant.unit || '—')}
                      </td>
                      <td className="px-4 py-2.5" />
                    </tr>
                  ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 glass-overlay overflow-y-auto">
          <div className="glass-floating w-full max-w-lg my-auto flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200/60 bg-white/25 shrink-0">
              <h3 className="text-lg font-bold text-neutral-900">{editingProduct ? 'Edit menu item' : 'Add menu item'}</h3>
              <button type="button" onClick={() => setShowModal(false)} className="p-1.5 rounded-[8px] hover:bg-neutral-200 transition-colors">
                <X className="w-5 h-5 text-neutral-500" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto min-h-0 flex-1">
              {formError && (
                <div className="bg-red-50 border border-red-200 text-red-700 rounded-[8px] px-4 py-2 text-sm font-medium">{formError}</div>
              )}

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Item name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  inputMode="text"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder="e.g. Classic cheeseburger"
                  className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  SKU <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  inputMode="text"
                  value={formSku}
                  onChange={e => { setFormSku(e.target.value); setFormSkuTouched(true); }}
                  placeholder="Auto-generated from name"
                  className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
                <p className="text-xs text-neutral-400 mt-1">Auto-generated. Edit if needed.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-2">Variants *</label>
                <div className="space-y-2">
                  {formVariants.map((variant, index) => (
                    <div key={`variant-${index}`} className="grid grid-cols-12 gap-2 items-center">
                      <input className="col-span-6 px-3 py-2 glass-card text-sm" placeholder="Variant name" value={variant.name} onChange={e => setFormVariants(prev => prev.map((v, i) => (i === index ? { ...v, name: e.target.value } : v)))} />
                      <input className="col-span-4 px-3 py-2 glass-card text-sm" type="number" min="0.01" step="0.01" placeholder="Sale" value={variant.salePrice} onChange={e => setFormVariants(prev => prev.map((v, i) => (i === index ? { ...v, salePrice: e.target.value } : v)))} />
                      <button type="button" className="col-span-2 px-2 py-2 rounded-[8px] border border-soot-200 text-xs" onClick={() => setFormVariants(prev => prev.length > 1 ? prev.filter((_, i) => i !== index) : prev)}>Remove</button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <button type="button" onClick={() => setFormVariants(prev => [...prev, { name: '', salePrice: '', sku: '' }])} className="px-3 py-2 rounded-[8px] border border-brand-200 text-sm text-brand-800 hover:bg-brand-50">Add variant</button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Selling unit (optional)</label>
                <select
                  value={formUnit}
                  onChange={(e) => setFormUnit(e.target.value)}
                  className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                >
                  <option value="">No unit</option>
                  {MENU_CATALOG_UNIT_GROUPS.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="text-xs text-neutral-500 mt-1">
                  Serving-style units only (not inventory carton/packet). Saved as catalog display — separate from BOM units.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Item image</label>
                <div className="flex items-start gap-3">
                  {formImageUrl && (
                    <div className="w-16 h-16 rounded-[8px] glass-card overflow-hidden shrink-0">
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
                      className="w-full px-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
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
                <p className="mt-1 text-xs text-neutral-500">Shown on the Dashboard POS.</p>
              </div>


              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Category <span className="text-red-400">*</span>
                </label>
                <SearchableSelect
                  value={formSection}
                  onChange={(value) => handleSectionChange({ target: { value } } as React.ChangeEvent<HTMLSelectElement>)}
                  placeholder="— Select category —"
                  searchPlaceholder="Search categories…"
                  options={sections.map((section) => ({ value: section, label: section }))}
                  className="glass-card border-0 pr-4"
                />
                {sections.length === 0 && (
                  <p className="text-xs text-neutral-400 mt-1">Add categories in Settings → Menu categories.</p>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-[8px] text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-700 text-white rounded-[8px] text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
                >
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {submitting ? 'Saving…' : editingProduct ? 'Save changes' : 'Add menu item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
