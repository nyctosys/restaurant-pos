import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScanner } from '../hooks/useScanner';
import { ShoppingBag, Plus, Minus, Trash2, Search, Loader2, CreditCard, Banknote, Smartphone, X, Printer, Usb, Tag, ChevronDown, ChevronRight, CheckCircle, XCircle, Package, UtensilsCrossed, Truck, ClipboardList, Bell } from 'lucide-react';
import { getSocket } from '../realtime/socket';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, patch, getUserMessage } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import SearchableSelect from '../components/SearchableSelect';

type Product = {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  sale_price?: number;
  section: string;
  variants: { name: string; basePrice: number; salePrice: number; sku?: string }[];
  image_url?: string;
  is_deal?: boolean;
};

type DealComboItem = {
  id: number;
  product_id?: number | null;
  product_title?: string | null;
  quantity: number;
  selection_type?: 'product' | 'category' | 'multiple_category';
  category_name?: string;
  category_names?: string[];
  variant_key?: string;
};

type Deal = {
  id: number;
  title: string;
  variants: string[];
  combo_items: DealComboItem[];
};

type DealSelection = {
  combo_item_id: number;
  product_id: number;
  product_title: string;
  category_name: string;
  variant?: string;
};

type CartItem = {
  uniqueId: string;
  id: number;
  title: string;
  price: number;
  quantity: number;
  image: string;
  variant?: string;
  variantPrice?: number;
  dealSelections?: DealSelection[];
  modifiers?: { id: number; name: string; price: number | null }[];
};

type DiscountPreset = { id: string; name: string; type: 'percent' | 'fixed'; value: number };
type PrinterStatus = 'checking' | 'connected' | 'disconnected' | 'error';
type PrinterStatusResponse = {
  status?: string;
  success?: boolean;
  ready?: boolean;
  connected?: boolean;
};

/** Sent as `order_type` on checkout; backend accepts for future use / receipts */
type OrderType = 'takeaway' | 'dine_in' | 'delivery';

const ORDER_TYPE_OPTIONS: { id: OrderType; label: string; Icon: typeof Package }[] = [
  { id: 'takeaway', label: 'Takeaway', Icon: Package },
  { id: 'dine_in', label: 'Dine in', Icon: UtensilsCrossed },
  { id: 'delivery', label: 'Delivery', Icon: Truck },
];

const PRODUCT_PLACEHOLDER_IMAGE = '/product-placeholder.svg';

/** Default delivery fee when not specified (matches backend `DELIVERY_CHARGE`). */
const DEFAULT_DELIVERY_CHARGE_PKR = 300;

function normalizePrinterStatus(data: PrinterStatusResponse | null | undefined): PrinterStatus {
  const rawStatus = String(data?.status ?? '').trim().toLowerCase();
  if (data?.connected === true || data?.ready === true || data?.success === true) {
    return 'connected';
  }
  if (['connected', 'ready', 'online', 'ok', 'available'].includes(rawStatus)) {
    return 'connected';
  }
  if (['checking', 'connecting'].includes(rawStatus)) {
    return 'checking';
  }
  if (['error', 'failed', 'failure'].includes(rawStatus)) {
    return 'error';
  }
  return 'disconnected';
}

function getProductImageUrl(product: Product): string {
  return (product.image_url && product.image_url.trim()) ? product.image_url.trim() : PRODUCT_PLACEHOLDER_IMAGE;
}

type OrderDetailLine = {
  id?: number;
  product_id: number;
  product_title?: string;
  variant_sku_suffix?: string;
  quantity: number;
  unit_price: number;
  is_deal?: boolean;
  modifiers?: { id: number; name: string; price: number | null }[];
  children?: OrderDetailLine[];
};

type OrderDetailResponse = {
  id: number;
  status?: string;
  kitchen_status?: string;
  order_type?: string | null;
  delivery_charge?: number;
  service_charge?: number;
  order_snapshot?: {
    table_name?: string;
    customer_name?: string;
    phone?: string;
    address?: string;
    rider_name?: string;
  } | null;
  items?: OrderDetailLine[];
};

type Modifier = { id: number; name: string; price: number | null; ingredient_id?: number | null; depletion_quantity?: number | null };
type ActiveSale = {
  id: number;
  order_snapshot?: { table_name?: string; customer_name?: string; rider_name?: string } | null;
  table_name?: string | null;
  status: string;
  order_type?: string | null;
};
type DeliveryCustomerLookupResponse = {
  found?: boolean;
  customer_name?: string;
  address?: string;
  phone?: string;
  matches?: { customer_name?: string; address?: string; phone?: string }[];
};
type DeliveryDistanceResponse = {
  found?: boolean;
  distance_km?: number | null;
  duration_min?: number | null;
  source?: 'google_route' | 'cached' | 'haversine_fallback' | 'unavailable' | string;
  message?: string | null;
};

function normalizeDealVariantKey(value?: string | null): string {
  return (value || '').trim();
}

function shouldShowCurrentOrderVariant(value?: string | null): boolean {
  const normalized = (value || '').trim();
  return normalized.length > 0 && normalized.toLowerCase() !== 'default';
}

function getDealComboItemsForVariant(deal: Deal | undefined, variant?: string): DealComboItem[] {
  if (!deal) return [];
  const rows = deal.combo_items || [];
  const normalizedVariant = normalizeDealVariantKey(variant);
  const baseRows = rows.filter(row => normalizeDealVariantKey(row.variant_key) === '');
  if (!normalizedVariant) return baseRows;
  const specificRows = rows.filter(row => normalizeDealVariantKey(row.variant_key) === normalizedVariant);
  return specificRows.length > 0 ? specificRows : baseRows;
}

function isCategoryChoiceRow(row: DealComboItem): boolean {
  return ['category', 'multiple_category'].includes(row.selection_type || 'product');
}

function getChoiceRowCategories(row: DealComboItem): string[] {
  if ((row.selection_type || 'product') === 'multiple_category') {
    const seen = new Set<string>();
    return (row.category_names || [])
      .map(name => (name || '').trim())
      .filter(name => {
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }
  const single = (row.category_name || '').trim();
  return single ? [single] : [];
}

function getChoiceRowLabel(row: DealComboItem): string {
  const categories = getChoiceRowCategories(row);
  return categories.length ? categories.join(' / ') : row.category_name || 'Category';
}

function rowNeedsFixedItemVariant(row: DealComboItem, catalog: Product[]): boolean {
  if (isCategoryChoiceRow(row) || !row.product_id) return false;
  const p = catalog.find(x => x.id === row.product_id);
  return Boolean(p?.variants && p.variants.length > 1);
}

function getDefaultProductVariant(product: Product | undefined): string {
  return product?.variants?.[0]?.name?.trim() || '';
}

function isDealConfigurableRow(row: DealComboItem, catalog: Product[]): boolean {
  return isCategoryChoiceRow(row) || rowNeedsFixedItemVariant(row, catalog);
}

function buildCartItemUniqueId(productId: number, variant?: string, dealSelections?: DealSelection[]): string {
  const normalizedVariant = (variant || '').trim();
  const selectionKey = [...(dealSelections || [])]
    .sort((left, right) => left.combo_item_id - right.combo_item_id)
    .map(selection => `${selection.combo_item_id}:${selection.product_id}:${(selection.variant || '').trim()}`)
    .join('|');
  return [String(productId), normalizedVariant, selectionKey].filter(Boolean).join('::');
}

export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const editOrderLoadedRef = useRef<number | null>(null);
  const skipOrderTypeResetRef = useRef(false);
  const { lastScannedBarcode, clearBarcode, scannerStatus } = useScanner();
  const [printerStatus, setPrinterStatus] = useState<PrinterStatus>('checking');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeCategory, setActiveCategory] = useState('All Items');
  const [searchQuery, setSearchQuery] = useState('');
  const [layoutView, setLayoutView] = useState<'grid' | 'list'>('list');
  const [products, setProducts] = useState<Product[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'Card' | 'Cash' | 'Online Transfer'>('Card');
  const [notification, setNotification] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const [taxEnabled, setTaxEnabled] = useState<boolean>(true);
  const [taxRatesByPaymentMethod, setTaxRatesByPaymentMethod] = useState<Record<string, number>>({ Cash: 0, Card: 8, 'Online Transfer': 8 });
  const [, setOrderId] = useState<string>('#ORD-0001');
  const [discounts, setDiscounts] = useState<DiscountPreset[]>([]);
  const [appliedDiscount, setAppliedDiscount] = useState<DiscountPreset | null>(null);
  const [activeCoupon, setActiveCoupon] = useState<DiscountPreset | null>(null);
  const [couponDropdownOpen, setCouponDropdownOpen] = useState(false);
  const [customCouponInput, setCustomCouponInput] = useState('');
  const [couponSectionExpanded, setCouponSectionExpanded] = useState(true);
  const [paymentMethodSectionExpanded, setPaymentMethodSectionExpanded] = useState(true);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tables, setTables] = useState<string[]>([]);
  const [riders, setRiders] = useState<string[]>([]);
  const [activeDineInSales, setActiveDineInSales] = useState<ActiveSale[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [activeModifierRowId, setActiveModifierRowId] = useState<string | null>(null);
  const [dineInTable, setDineInTable] = useState<string | null>(null);
  const [deliveryCustomerName, setDeliveryCustomerName] = useState('');
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryRiderName, setDeliveryRiderName] = useState('');
  const [deliveryLookupState, setDeliveryLookupState] = useState<'idle' | 'loading' | 'found' | 'not_found'>('idle');
  const [deliveryLookupMatches, setDeliveryLookupMatches] = useState<{ customer_name: string; address: string; phone: string }[]>([]);
  const [deliveryDistance, setDeliveryDistance] = useState<{ km: number | null; minutes: number | null; source: string | null; state: 'idle' | 'loading' | 'ready' | 'unavailable'; message: string | null }>({
    km: null,
    minutes: null,
    source: null,
    state: 'idle',
    message: null,
  });
  const [serviceChargePkr, setServiceChargePkr] = useState(0);
  const [deliveryChargePkr, setDeliveryChargePkr] = useState(DEFAULT_DELIVERY_CHARGE_PKR);
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  const [dealConfigurator, setDealConfigurator] = useState<{
    product: Product;
    variant: string;
    selections: Record<number, { productId: string; variant: string; categoryName?: string }>;
  } | null>(null);
  const [checkoutSlowNotice, setCheckoutSlowNotice] = useState(false);
  /** Set when resuming an open dine-in sale from Active Dine-in → Modify */
  const [editingOpenSaleId, setEditingOpenSaleId] = useState<number | null>(null);
  const [orderReadyAlerts, setOrderReadyAlerts] = useState<{ id: string; sale_id: number; table_name?: string | null }[]>([]);

  const ACTIVE_COUPON_STORAGE_KEY = 'pos_active_coupon';

  const terminalBranchKey = getTerminalBranchIdString(parseUserFromStorage());

  const getVariantSalePrice = useCallback((product: Product, variantName?: string) => {
    const key = (variantName || '').trim().toLowerCase();
    const selected = (product.variants || []).find(variant => variant.name.trim().toLowerCase() === key);
    if (selected && Number.isFinite(selected.salePrice) && selected.salePrice > 0) return selected.salePrice;
    return product.sale_price ?? product.base_price;
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const activeBranchId = terminalBranchKey;
    try {
      const [prodResult, dealsResult, settingsResult, activeSalesResult, modsResult] = await Promise.allSettled([
        get<{ products?: Product[] }>(`/menu-items/`),
        get<{ deals?: Deal[] }>(`/menu/deals/`),
        get<{ config?: Record<string, unknown> }>(`/settings/?branch_id=${activeBranchId}`),
        get<{ sales?: ActiveSale[] }>(`/orders/active?branch_id=${activeBranchId}`),
        get<{ modifiers?: Modifier[] }>(`/modifiers/`),
      ]);

      if (prodResult.status !== 'fulfilled') {
        throw prodResult.reason;
      }

      setProducts(prodResult.value?.products ?? []);
      setDeals(dealsResult.status === 'fulfilled' ? dealsResult.value?.deals ?? [] : []);

      const settingsData = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
      const activeSalesData = activeSalesResult.status === 'fulfilled' ? activeSalesResult.value : null;
      const modsData = modsResult.status === 'fulfilled' ? modsResult.value : null;

      const config = settingsData?.config ?? {};
      setSections(Array.isArray(config?.sections) ? (config.sections as string[]) : []);
      setTaxEnabled((config.tax_enabled as boolean) !== false);
      const rates = (config.tax_rates_by_payment_method as Record<string, number>) ?? {};
      setTaxRatesByPaymentMethod({
        Cash: rates.Cash ?? 0,
        Card: rates.Card ?? 8,
        'Online Transfer': rates['Online Transfer'] ?? 8,
      });
      const rawDiscounts = Array.isArray(config?.discounts) ? (config.discounts as (DiscountPreset & { archived?: boolean })[]) : [];
      setLayoutView(config?.dashboard_menu_layout === 'grid' ? 'grid' : 'list');
      setDiscounts(rawDiscounts.filter(d => !d.archived));
      const tablesList = config?.tables;
      setTables(Array.isArray(tablesList) ? (tablesList as string[]) : []);
      const ridersList = config?.riders;
      setRiders(Array.isArray(ridersList) ? (ridersList as string[]) : []);
      setActiveDineInSales(activeSalesData?.sales ?? []);
      setModifiers(modsData?.modifiers ?? []);

      if (modsResult.status !== 'fulfilled') {
        setNotification({ type: 'error', msg: 'Modifiers could not be loaded. Menu items are still available.' });
        setTimeout(() => setNotification(null), 4000);
      }

      const storedActive = localStorage.getItem(`${ACTIVE_COUPON_STORAGE_KEY}_${activeBranchId}`);
      if (storedActive) {
        try {
          const parsed = JSON.parse(storedActive) as DiscountPreset;
          setActiveCoupon(parsed);
          setAppliedDiscount(parsed);
        } catch {
          localStorage.removeItem(`${ACTIVE_COUPON_STORAGE_KEY}_${activeBranchId}`);
          setActiveCoupon(null);
        }
      } else {
        setActiveCoupon(null);
      }

      try {
        const salesData = await get<{ sales?: { id: number }[] }>(`/orders/?limit=1&branch_id=${activeBranchId}`);
        const latestId = salesData?.sales?.length ? salesData.sales[0]?.id ?? 0 : 0;
        setOrderId(`#ORD-${String(latestId + 1).padStart(4, '0')}`);
      } catch {
        // fallback if sales endpoint fails
      }
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setLoading(false);
    }
  }, [terminalBranchKey]);

  const checkPrinterStatus = useCallback(async () => {
    try {
      const data = await get<PrinterStatusResponse>('/printer/status', { cacheTtlMs: 0, forceRefresh: true });
      setPrinterStatus(normalizePrinterStatus(data));
    } catch {
      setPrinterStatus('error');
    }
  }, []);

  useEffect(() => {
    if (skipOrderTypeResetRef.current) {
      skipOrderTypeResetRef.current = false;
      return;
    }
    setDineInTable(null);
    setDeliveryCustomerName('');
    setDeliveryPhone('');
    setDeliveryAddress('');
    setDeliveryRiderName('');
    setDeliveryLookupMatches([]);
    setDeliveryLookupState('idle');
    setDeliveryDistance({ km: null, minutes: null, source: null, state: 'idle', message: null });
    setServiceChargePkr(0);
    setDeliveryChargePkr(DEFAULT_DELIVERY_CHARGE_PKR);
  }, [orderType]);

  useEffect(() => {
    const raw = searchParams.get('editOrder');
    if (!raw) {
      if (editingOpenSaleId == null) editOrderLoadedRef.current = null;
      return;
    }
    if (loading) return;
    const num = parseInt(raw, 10);
    if (Number.isNaN(num)) {
      setSearchParams({}, { replace: true });
      return;
    }
    if (editOrderLoadedRef.current === num) return;

    let cancelled = false;
    void (async () => {
      try {
        const d = await get<OrderDetailResponse>(`/orders/${num}`);
        if (cancelled) return;
        const ot = (d.order_type || '') as OrderType;
        if (d.status !== 'open' || !['dine_in', 'takeaway', 'delivery'].includes(ot)) {
          setNotification({ type: 'error', msg: 'This order cannot be edited here.' });
          setTimeout(() => setNotification(null), 4000);
          setSearchParams({}, { replace: true });
          return;
        }
        editOrderLoadedRef.current = num;
        setEditingOpenSaleId(num);
        skipOrderTypeResetRef.current = ot !== orderType;
        setOrderType(ot);
        const table = d.order_snapshot?.table_name;
        if (table) setDineInTable(table);
        if (ot === 'delivery' && d.order_snapshot) {
          setDeliveryCustomerName(d.order_snapshot.customer_name ?? '');
          setDeliveryPhone(d.order_snapshot.phone ?? '');
          setDeliveryAddress(d.order_snapshot.address ?? '');
          setDeliveryRiderName(d.order_snapshot.rider_name ?? '');
        } else {
          setDeliveryCustomerName('');
          setDeliveryPhone('');
          setDeliveryAddress('');
          setDeliveryRiderName('');
        }
        setServiceChargePkr(typeof d.service_charge === 'number' ? d.service_charge : 0);
        setDeliveryChargePkr(
          typeof d.delivery_charge === 'number' ? d.delivery_charge : DEFAULT_DELIVERY_CHARGE_PKR
        );
        setCart(
          (d.items || []).map(line => {
            const pid = line.product_id;
            const prod = products.find(p => p.id === pid);
            const v = (line.variant_sku_suffix || '').trim();
            const mods = (line.modifiers || []).filter(
              (m: { id?: number }) => m && typeof m.id === 'number' && m.id > 0
            ) as { id: number; name: string; price: number | null }[];
            const deal = deals.find(candidate => candidate.id === pid);
            const activeRows = getDealComboItemsForVariant(deal, v);
            let dealSelections: DealSelection[] | undefined;
            if (line.is_deal && activeRows.some(isCategoryChoiceRow)) {
              const remainingChildren = [...(line.children || [])];
              activeRows
                .filter(row => !isCategoryChoiceRow(row))
                .forEach(row => {
                  const expectedQty = row.quantity * line.quantity;
                  const matchIndex = remainingChildren.findIndex(child => child.product_id === row.product_id && child.quantity === expectedQty);
                  if (matchIndex >= 0) {
                    remainingChildren.splice(matchIndex, 1);
                  }
                });
              const reconstructed = activeRows
                .filter(isCategoryChoiceRow)
                .map(row => {
                  const expectedCategories = getChoiceRowCategories(row);
                  const expectedKeys = new Set(expectedCategories.map(category => category.toLowerCase()));
                  const matchIndex = remainingChildren.findIndex(child => {
                    const childProduct = products.find(product => product.id === child.product_id);
                    return expectedKeys.has((childProduct?.section || '').trim().toLowerCase());
                  });
                  if (matchIndex < 0) return null;
                  const child = remainingChildren.splice(matchIndex, 1)[0];
                  const childProduct = products.find(product => product.id === child.product_id);
                  const childVariant = (child.variant_sku_suffix || '').trim();
                  return {
                    combo_item_id: row.id,
                    product_id: child.product_id,
                    product_title: child.product_title || 'Item',
                    category_name: (childProduct?.section || '').trim() || getChoiceRowLabel(row),
                    ...(childVariant ? { variant: childVariant } : {}),
                  };
                })
                .filter(Boolean) as DealSelection[];
              if (reconstructed.length > 0) {
                dealSelections = reconstructed;
              }
            }
            const uniqueId = buildCartItemUniqueId(pid, v, dealSelections);
            return {
              uniqueId,
              id: pid,
              title: line.product_title || prod?.title || 'Item',
              price: line.unit_price,
              quantity: line.quantity,
              image: prod ? getProductImageUrl(prod) : PRODUCT_PLACEHOLDER_IMAGE,
              modifiers: mods,
              ...(dealSelections?.length ? { dealSelections } : {}),
              ...(v ? { variant: v } : {}),
            };
          })
        );
        setSearchParams({}, { replace: true });
      } catch (e) {
        setNotification({ type: 'error', msg: getUserMessage(e) });
        setTimeout(() => setNotification(null), 4000);
        setSearchParams({}, { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, searchParams, products, deals, setSearchParams, editingOpenSaleId, orderType]);

  useEffect(() => {
    if (!editingOpenSaleId || products.length === 0) return;
    setCart(prev =>
      prev.map(item => {
        const prod = products.find(p => p.id === item.id);
        if (!prod) return item;
        const img = getProductImageUrl(prod);
        if (img === item.image && prod.title === item.title) return item;
        return { ...item, title: prod.title, image: img };
      })
    );
  }, [products, editingOpenSaleId]);

  const availableRiderOptions = useMemo(() => {
    const busy = new Set(
      activeDineInSales
        .filter(sale => sale.order_type === 'delivery')
        .filter(sale => editingOpenSaleId == null || sale.id !== editingOpenSaleId)
        .map(sale => (sale.order_snapshot?.rider_name || '').trim())
        .filter(Boolean)
    );
    const base = riders.filter(name => {
      const trimmed = name.trim();
      return trimmed && !busy.has(trimmed);
    });
    const selected = deliveryRiderName.trim();
    if (selected && !base.includes(selected)) {
      return [selected, ...base];
    }
    return base;
  }, [activeDineInSales, deliveryRiderName, editingOpenSaleId, riders]);

  // Fetch products + sections on mount
  useEffect(() => {
    void fetchData();
    void checkPrinterStatus();

    const intervalId = window.setInterval(() => {
      void checkPrinterStatus();
    }, 60_000);
    const handleFocus = () => {
      void checkPrinterStatus();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkPrinterStatus();
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkPrinterStatus, fetchData]);

  // ORDER_READY real-time notification from KDS
  useEffect(() => {
    const s = getSocket();
    const handler = (payload: { sale_id?: number; table_name?: string | null }) => {
      const alertId = `${Date.now()}_${payload.sale_id ?? 0}`;
      setOrderReadyAlerts(prev => [
        { id: alertId, sale_id: payload.sale_id ?? 0, table_name: payload.table_name ?? null },
        ...prev,
      ]);
      // Auto-dismiss after 60s
      setTimeout(() => {
        setOrderReadyAlerts(prev => prev.filter(a => a.id !== alertId));
      }, 60_000);
    };
    s.on('order_ready', handler);
    return () => { s.off('order_ready', handler); };
  }, []);
  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryLookupState('idle');
      setDeliveryLookupMatches([]);
      return;
    }

    const normalizedPhone = deliveryPhone.replace(/\D/g, '');
    if (normalizedPhone.length < 7) {
      setDeliveryLookupState('idle');
      setDeliveryLookupMatches([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setDeliveryLookupState('loading');
        try {
          const data = await get<DeliveryCustomerLookupResponse>(`/orders/delivery-customer?phone=${encodeURIComponent(deliveryPhone.trim())}`);
          if (cancelled) return;
          if (data?.found) {
            setDeliveryCustomerName(data.customer_name ?? '');
            setDeliveryAddress(data.address ?? '');
            const matches = (data.matches || [])
              .map(match => ({
                customer_name: (match.customer_name || '').trim(),
                address: (match.address || '').trim(),
                phone: (match.phone || '').trim(),
              }))
              .filter(match => match.customer_name && match.address);
            setDeliveryLookupMatches(matches);
            setDeliveryLookupState('found');
            return;
          }
          setDeliveryLookupMatches([]);
          setDeliveryLookupState('not_found');
        } catch {
          if (cancelled) return;
          setDeliveryLookupMatches([]);
          setDeliveryLookupState('idle');
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deliveryPhone, orderType]);

  useEffect(() => {
    if (orderType !== 'delivery') {
      setDeliveryDistance({ km: null, minutes: null, source: null, state: 'idle', message: null });
      return;
    }
    const trimmedAddress = deliveryAddress.trim();
    if (trimmedAddress.length < 8) {
      setDeliveryDistance({ km: null, minutes: null, source: null, state: 'idle', message: null });
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setDeliveryDistance(prev => ({ ...prev, state: 'loading', message: null }));
        try {
          const data = await get<DeliveryDistanceResponse>(`/orders/delivery-distance?address=${encodeURIComponent(trimmedAddress)}`);
          if (cancelled) return;
          if (data?.found && typeof data.distance_km === 'number') {
            setDeliveryDistance({
              km: data.distance_km,
              minutes: typeof data.duration_min === 'number' ? data.duration_min : null,
              source: data.source ?? null,
              state: 'ready',
              message: data.message ?? null,
            });
            return;
          }
          setDeliveryDistance({
            km: null,
            minutes: null,
            source: data?.source ?? 'unavailable',
            state: 'unavailable',
            message: data?.message ?? 'Distance unavailable.',
          });
        } catch {
          if (cancelled) return;
          setDeliveryDistance({
            km: null,
            minutes: null,
            source: 'unavailable',
            state: 'unavailable',
            message: 'Distance lookup failed.',
          });
        }
      })();
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [deliveryAddress, orderType]);

  const dealsById = useMemo(() => {
    const next = new Map<number, Deal>();
    deals.forEach(deal => {
      next.set(deal.id, deal);
    });
    return next;
  }, [deals]);

  const menuProductsBySection = useMemo(() => {
    const next = new Map<string, Product[]>();
    products
      .filter(product => !product.is_deal)
      .forEach(product => {
        const section = (product.section || '').trim();
        if (!section) return;
        const current = next.get(section) || [];
        current.push(product);
        next.set(section, current);
      });
    next.forEach((sectionProducts, section) => {
      next.set(
        section,
        [...sectionProducts].sort((left, right) =>
          left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
        )
      );
    });
    return next;
  }, [products]);

  const activeDealConfigRows = useMemo(
    () => (dealConfigurator ? getDealComboItemsForVariant(dealsById.get(dealConfigurator.product.id), dealConfigurator.variant) : []),
    [dealConfigurator, dealsById]
  );

  const dealNeedsConfigurator = useCallback(
    (product: Product) => (dealsById.get(product.id)?.combo_items || []).length > 0,
    [dealsById]
  );

  // Categories: settings sections, plus "Deals" when any deal product exists (section may be missing from settings JSON).
  const categories = useMemo(() => {
    const fromSettings = Array.isArray(sections) ? sections : [];
    const hasDeals = products.some(
      p => p.is_deal === true || (p.section || '').trim() === 'Deals'
    );
    const merged =
      hasDeals && !fromSettings.some(s => (s || '').trim() === 'Deals')
        ? [...fromSettings, 'Deals']
        : fromSettings;
    return ['All Items', ...merged];
  }, [sections, products]);

  useEffect(() => {
    if (lastScannedBarcode) {
      const matched = products.find(p => p.sku === lastScannedBarcode);
      if (matched) {
        handleProductClick(matched);
        setNotification({ type: 'ok', msg: `Added: ${matched.title}` });
      } else {
        setNotification({ type: 'error', msg: `SKU Not Found: ${lastScannedBarcode}` });
      }
      clearBarcode();
      setTimeout(() => setNotification(null), 2000);
    }
// eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastScannedBarcode]);

  const handleProductClick = (product: Product) => {
    const defaultVariant = product.variants?.length ? product.variants[0]?.name : undefined;
    if (product.is_deal && dealNeedsConfigurator(product)) {
      const deal = dealsById.get(product.id);
      const cfgRows = getDealComboItemsForVariant(deal, defaultVariant || undefined);
      const initialSelections: Record<number, { productId: string; variant: string }> = {};
      for (const r of cfgRows) {
        if (rowNeedsFixedItemVariant(r, products)) {
          const fixedProduct = products.find(p => p.id === r.product_id);
          initialSelections[r.id] = {
            productId: String(r.product_id || ''),
            variant: getDefaultProductVariant(fixedProduct),
          };
        }
      }
      setDealConfigurator({
        product,
        variant: defaultVariant || '',
        selections: initialSelections,
      });
      return;
    }
    handleAddToCart({
      id: product.id,
      title: product.title,
      price: getVariantSalePrice(product, defaultVariant),
      image: getProductImageUrl(product),
      variant: defaultVariant,
      variantPrice: getVariantSalePrice(product, defaultVariant),
    });
  };

  const handleAddToCart = (product: { id: number; title: string; price: number; image: string; variant?: string; variantPrice?: number; dealSelections?: DealSelection[] }) => {
    setCart(prev => {
      const variant = product.variant?.trim() || undefined;
      const uniqueId = buildCartItemUniqueId(product.id, variant, product.dealSelections);
      const existing = prev.find(i => i.uniqueId === uniqueId);
      if (existing) {
        return prev.map(i => i.uniqueId === uniqueId ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, uniqueId, quantity: 1, modifiers: [], variant }];
    });
  };

  const handleChangeVariant = (uniqueId: string, newVariant: string) => {
    setCart(prev => {
      const target = prev.find(i => i.uniqueId === uniqueId);
      if (!target) return prev;
      const newUniqueId = buildCartItemUniqueId(target.id, newVariant, target.dealSelections);
      const existing = prev.find(i => i.uniqueId === newUniqueId);
      if (existing && existing.uniqueId !== uniqueId) {
        // Merge quantities
        return prev
          .map(i => i.uniqueId === newUniqueId ? { ...i, quantity: i.quantity + target.quantity } : i)
          .filter(i => i.uniqueId !== uniqueId);
      } else {
        // Just update variant and ID
        return prev.map(i => {
          if (i.uniqueId !== uniqueId) return i;
          const baseProd = products.find(p => p.id === i.id);
          const nextPrice = baseProd ? getVariantSalePrice(baseProd, newVariant) : i.price;
          return { ...i, variant: newVariant, uniqueId: newUniqueId, price: nextPrice };
        });
      }
    });
  };

  const handleDealConfirmAddToCart = () => {
    if (!dealConfigurator) return;
    const rows = activeDealConfigRows.filter(row => isDealConfigurableRow(row, products));

    for (const row of rows) {
      if (isCategoryChoiceRow(row)) {
        const rawSelection = dealConfigurator.selections[row.id];
        const selectedProductId = parseInt(rawSelection?.productId || '', 10);
        if (!selectedProductId) {
          setNotification({ type: 'error', msg: `Choose an item from ${getChoiceRowLabel(row)}.` });
          setTimeout(() => setNotification(null), 3000);
          return;
        }
        const selectedProduct = products.find(product => product.id === selectedProductId);
        if (!selectedProduct) {
          setNotification({ type: 'error', msg: 'One of the chosen deal items is no longer available.' });
          setTimeout(() => setNotification(null), 3000);
          return;
        }
        const variant = (rawSelection?.variant || '').trim();
        if (selectedProduct.variants?.length && !variant) {
          setNotification({ type: 'error', msg: `Choose a variant for ${selectedProduct.title}.` });
          setTimeout(() => setNotification(null), 3000);
          return;
        }
      } else if (rowNeedsFixedItemVariant(row, products)) {
        const v = (dealConfigurator.selections[row.id]?.variant || '').trim();
        if (!v) {
          setNotification({ type: 'error', msg: `Choose a variant for ${row.product_title || 'bundled item'}.` });
          setTimeout(() => setNotification(null), 3000);
          return;
        }
      }
    }
    const nextSelections: DealSelection[] = [];

    for (const row of rows) {
      if (isCategoryChoiceRow(row)) {
        const rawSelection = dealConfigurator.selections[row.id];
        const selectedProductId = parseInt(rawSelection?.productId || '', 10);
        const selectedProduct = products.find(product => product.id === selectedProductId);
        if (!selectedProduct) continue;
        const variant = (rawSelection?.variant || '').trim();
        nextSelections.push({
          combo_item_id: row.id,
          product_id: selectedProduct.id,
          product_title: selectedProduct.title,
          category_name: (selectedProduct.section || '').trim() || getChoiceRowLabel(row),
          ...(variant ? { variant } : {}),
        });
      } else if (row.product_id) {
        const v = (dealConfigurator.selections[row.id]?.variant || '').trim();
        nextSelections.push({
          combo_item_id: row.id,
          product_id: row.product_id,
          product_title: row.product_title || '',
          category_name: '',
          ...(v ? { variant: v } : {}),
        });
      }
    }

    handleAddToCart({
      id: dealConfigurator.product.id,
      title: dealConfigurator.product.title,
      price: getVariantSalePrice(dealConfigurator.product, dealConfigurator.variant || undefined),
      image: getProductImageUrl(dealConfigurator.product),
      variant: dealConfigurator.variant || undefined,
      dealSelections: nextSelections,
    });
    setDealConfigurator(null);
    setCheckoutSlowNotice(false);
  };

  const handleUpdateQuantity = (uniqueId: string, delta: number) => {
    setCart(prev =>
      prev
        .map(i => i.uniqueId === uniqueId ? { ...i, quantity: i.quantity + delta } : i)
        .filter(i => i.quantity > 0)
    );
  };

  const handleRemoveItem = (uniqueId: string) => {
    setCart(prev => prev.filter(i => i.uniqueId !== uniqueId));
  };

  type OrderSnapshotPayload =
    | { table_name: string }
    | { customer_name: string; phone: string; address: string; rider_name?: string; distance_km?: number; distance_source?: string };

  const submitCheckout = async (orderSnapshot: OrderSnapshotPayload | null) => {
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
      ...(item.variant ? { variant_sku_suffix: item.variant } : {}),
      ...(item.dealSelections?.length
        ? {
            deal_selections: item.dealSelections.map(selection => ({
              combo_item_id: selection.combo_item_id,
              product_id: selection.product_id,
              ...(selection.variant ? { variant_sku_suffix: selection.variant } : {}),
            })),
          }
        : {}),
    }));

    setCheckoutSlowNotice(false);
    const slowTimer = window.setTimeout(() => setCheckoutSlowNotice(true), 5000);
    setCheckoutSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        payment_method: paymentMethod,
        items,
        discount: appliedDiscount ? { id: appliedDiscount.id, name: appliedDiscount.name, type: appliedDiscount.type, value: appliedDiscount.value } : null,
        order_type: orderType,
      };
      if (orderSnapshot) {
        body.order_snapshot = orderSnapshot;
      }
      if (orderType === 'dine_in') {
        body.service_charge = Math.max(0, Number(serviceChargePkr) || 0);
      }
      if (orderType === 'delivery') {
        body.delivery_charge = Math.max(0, Number(deliveryChargePkr) || 0);
      }
      const data = await post<{ sale_id?: number; total?: number; message?: string; print_success?: boolean }>('/orders/checkout', body);
      window.clearTimeout(slowTimer);
      setCheckoutSlowNotice(false);
      const saleId = data?.sale_id ?? 0;

      if (data.print_success === false) {
        setPrinterStatus('disconnected');
        setNotification({ type: 'error', msg: `Payment OK, but Printer Error — Order #ORD-${String(saleId).padStart(4, '0')}` });
      } else {
        setPrinterStatus('connected');
        setNotification({ type: 'ok', msg: `Payment Processed — Order #ORD-${String(saleId).padStart(4, '0')}` });
      }

      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setAppliedDiscount(activeCoupon);
      setOrderId(`#ORD-${String(saleId + 1).padStart(4, '0')}`);
      fetchData();
      setDineInTable(null);
      setDeliveryCustomerName('');
      setDeliveryPhone('');
      setDeliveryAddress('');
      setDeliveryRiderName('');
      setServiceChargePkr(0);
      setDeliveryChargePkr(DEFAULT_DELIVERY_CHARGE_PKR);
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      window.clearTimeout(slowTimer);
      setCheckoutSlowNotice(false);
      setCheckoutSubmitting(false);
    }
  };

  const finalizeOpenOrder = async () => {
    if (!editingOpenSaleId || cart.length === 0 || checkoutSubmitting) return;
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
      ...(item.variant ? { variant_sku_suffix: item.variant } : {}),
      ...(item.dealSelections?.length
        ? {
            deal_selections: item.dealSelections.map(selection => ({
              combo_item_id: selection.combo_item_id,
              product_id: selection.product_id,
              ...(selection.variant ? { variant_sku_suffix: selection.variant } : {}),
            })),
          }
        : {}),
    }));
    setCheckoutSubmitting(true);
    try {
      const orderSnapshot =
        orderType === 'delivery'
          ? {
              customer_name: deliveryCustomerName.trim(),
              phone: deliveryPhone.trim(),
              address: deliveryAddress.trim(),
              ...(deliveryRiderName.trim() ? { rider_name: deliveryRiderName.trim() } : {}),
              ...(deliveryDistance.km != null ? { distance_km: deliveryDistance.km } : {}),
              ...(deliveryDistance.source ? { distance_source: deliveryDistance.source } : {}),
            }
          : orderType === 'dine_in' && dineInTable
            ? { table_name: dineInTable }
            : undefined;
      await patch(`/orders/${editingOpenSaleId}/items`, {
        items,
        order_type: orderType,
        ...(orderSnapshot ? { order_snapshot: orderSnapshot } : {}),
      });
      const finalizeBody: Record<string, unknown> = {
        payment_method: paymentMethod,
        discount: appliedDiscount
          ? { id: appliedDiscount.id, name: appliedDiscount.name, type: appliedDiscount.type, value: appliedDiscount.value }
          : null,
      };
      if (orderType === 'dine_in') {
        finalizeBody.service_charge = Math.max(0, Number(serviceChargePkr) || 0);
      }
      if (orderType === 'delivery') {
        finalizeBody.delivery_charge = Math.max(0, Number(deliveryChargePkr) || 0);
      }
      const data = await post<{ sale_id?: number; print_success?: boolean }>(`/orders/${editingOpenSaleId}/finalize`, finalizeBody);
      const saleId = data?.sale_id ?? editingOpenSaleId;
      if (data?.print_success === false) {
        setPrinterStatus('disconnected');
        setNotification({ type: 'error', msg: `Payment OK, but Printer Error — Order #ORD-${String(saleId).padStart(4, '0')}` });
      } else {
        setPrinterStatus('connected');
        setNotification({ type: 'ok', msg: `Payment Processed — Order #ORD-${String(saleId).padStart(4, '0')}` });
      }
      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setAppliedDiscount(activeCoupon);
      setOrderId(`#ORD-${String(saleId + 1).padStart(4, '0')}`);
      setEditingOpenSaleId(null);
      editOrderLoadedRef.current = null;
      fetchData();
      setDineInTable(null);
      setDeliveryCustomerName('');
      setDeliveryPhone('');
      setDeliveryAddress('');
      setDeliveryRiderName('');
      setServiceChargePkr(0);
      setDeliveryChargePkr(DEFAULT_DELIVERY_CHARGE_PKR);
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const submitUpdateOrder = async () => {
    if (!editingOpenSaleId || checkoutSubmitting || cart.length === 0) return;
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
      ...(item.variant ? { variant_sku_suffix: item.variant } : {}),
      ...(item.dealSelections?.length
        ? {
            deal_selections: item.dealSelections.map(selection => ({
              combo_item_id: selection.combo_item_id,
              product_id: selection.product_id,
              ...(selection.variant ? { variant_sku_suffix: selection.variant } : {}),
            })),
          }
        : {}),
    }));
    setCheckoutSubmitting(true);
    try {
      const orderSnapshot =
        orderType === 'delivery'
          ? {
              customer_name: deliveryCustomerName.trim(),
              phone: deliveryPhone.trim(),
              address: deliveryAddress.trim(),
              ...(deliveryRiderName.trim() ? { rider_name: deliveryRiderName.trim() } : {}),
              ...(deliveryDistance.km != null ? { distance_km: deliveryDistance.km } : {}),
              ...(deliveryDistance.source ? { distance_source: deliveryDistance.source } : {}),
            }
          : orderType === 'dine_in' && dineInTable
            ? { table_name: dineInTable }
            : undefined;
      await patch(`/orders/${editingOpenSaleId}/items`, {
        items,
        order_type: orderType,
        ...(orderSnapshot ? { order_snapshot: orderSnapshot } : {}),
      });
      setNotification({ type: 'ok', msg: `Order #${editingOpenSaleId} updated — sent to kitchen` });
      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setEditingOpenSaleId(null);
      editOrderLoadedRef.current = null;
      fetchData();
      setDineInTable(null);
      setDeliveryCustomerName('');
      setDeliveryPhone('');
      setDeliveryAddress('');
      setDeliveryRiderName('');
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const handleGenerateKot = () => {
    if (cart.length === 0 || checkoutSubmitting || editingOpenSaleId) return;
    if (tables.length === 0) {
      setNotification({
        type: 'error',
        msg: 'No tables registered. Add table names in Settings → Tables before taking dine-in orders.',
      });
      setTimeout(() => setNotification(null), 5000);
      return;
    }
    if (!dineInTable) {
      setNotification({
        type: 'error',
        msg: 'Select a table for this dine-in order.',
      });
      setTimeout(() => setNotification(null), 4000);
      return;
    }
    void submitDineInOpenKot();
  };

  /** Dine-in only: open tab + KOT to kitchen (payment later). */
  const submitDineInOpenKot = async () => {
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
      ...(item.variant ? { variant_sku_suffix: item.variant } : {}),
      ...(item.dealSelections?.length
        ? {
            deal_selections: item.dealSelections.map(selection => ({
              combo_item_id: selection.combo_item_id,
              product_id: selection.product_id,
              ...(selection.variant ? { variant_sku_suffix: selection.variant } : {}),
            })),
          }
        : {}),
    }));
    setCheckoutSubmitting(true);
    try {
      const order_snapshot = dineInTable ? { table_name: dineInTable } : undefined;
      const data = await post<{ sale_id?: number; print_success?: boolean; message?: string }>('/orders/kot', {
        items,
        order_type: 'dine_in',
        ...(order_snapshot ? { order_snapshot } : {}),
      });
      const saleId = data?.sale_id ?? 0;
      if (data?.print_success === false) {
        setNotification({
          type: 'error',
          msg: `KOT saved (#${saleId}), but the kitchen printer reported an error.`,
        });
      } else {
        setNotification({
          type: 'ok',
          msg: `Kitchen order sent — tab #${saleId}${dineInTable ? ` (table ${dineInTable})` : ''}`,
        });
      }
      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setOrderId(`#ORD-${String(saleId + 1).padStart(4, '0')}`);
      fetchData();
      setDineInTable(null);
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  /**
   * Takeaway / delivery: open KOT (same flow as dine-in).
   * Payment is collected from the Active Orders page — unified across all order types.
   */
  const submitTakeawayDeliveryKotAndPay = async () => {
    if (cart.length === 0 || checkoutSubmitting || editingOpenSaleId) return;
    if (orderType === 'delivery') {
      const name = deliveryCustomerName.trim();
      const phone = deliveryPhone.trim();
      const address = deliveryAddress.trim();
      if (!name || !phone || !address) {
        setNotification({
          type: 'error',
          msg: 'Enter customer name, phone, and delivery address to complete this order.',
        });
        setTimeout(() => setNotification(null), 5000);
        return;
      }
    }
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
      ...(item.variant ? { variant_sku_suffix: item.variant } : {}),
      ...(item.dealSelections?.length
        ? {
            deal_selections: item.dealSelections.map(selection => ({
              combo_item_id: selection.combo_item_id,
              product_id: selection.product_id,
              ...(selection.variant ? { variant_sku_suffix: selection.variant } : {}),
            })),
          }
        : {}),
    }));
    setCheckoutSubmitting(true);
    try {
      let order_snapshot: Record<string, string | number> | undefined;
      if (orderType === 'delivery') {
        order_snapshot = {
          customer_name: deliveryCustomerName.trim(),
          phone: deliveryPhone.trim(),
          address: deliveryAddress.trim(),
          ...(deliveryRiderName.trim() ? { rider_name: deliveryRiderName.trim() } : {}),
          ...(deliveryDistance.km != null ? { distance_km: deliveryDistance.km } : {}),
          ...(deliveryDistance.source ? { distance_source: deliveryDistance.source } : {}),
        };
      } else if (orderType === 'takeaway') {
        order_snapshot = undefined;
      }
      const data = await post<{ sale_id?: number; print_success?: boolean; message?: string }>('/orders/kot', {
        items,
        order_type: orderType,
        ...(order_snapshot ? { order_snapshot } : {}),
      });
      const saleId = data?.sale_id ?? 0;
      const typeLabel = orderType === 'delivery' ? 'Delivery' : 'Takeaway';
      if (data?.print_success === false) {
        setNotification({
          type: 'error',
          msg: `${typeLabel} KOT saved (#${saleId}), but the kitchen printer reported an error.`,
        });
      } else {
        setNotification({
          type: 'ok',
          msg: `${typeLabel} order #${saleId} sent to kitchen — collect payment in Open Orders.`,
        });
      }
      setTimeout(() => setNotification(null), 5000);
      setCart([]);
      setOrderId(`#ORD-${String(saleId + 1).padStart(4, '0')}`);
      setAppliedDiscount(activeCoupon);
      fetchData();
      setDeliveryCustomerName('');
      setDeliveryPhone('');
      setDeliveryAddress('');
      setDeliveryRiderName('');
      setDeliveryChargePkr(DEFAULT_DELIVERY_CHARGE_PKR);
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const handleCheckout = () => {
    if (cart.length === 0 || checkoutSubmitting) return;

    if (editingOpenSaleId) {
      void finalizeOpenOrder();
      return;
    }

    if (orderType === 'dine_in') {
      if (tables.length === 0) {
        setNotification({
          type: 'error',
          msg: 'No tables registered. Add table names in Settings → Tables before taking dine-in orders.',
        });
        setTimeout(() => setNotification(null), 5000);
        return;
      }
      if (!dineInTable) {
        setNotification({
          type: 'error',
          msg: 'Select a table for this dine-in order.',
        });
        setTimeout(() => setNotification(null), 4000);
        return;
      }
      void submitCheckout({ table_name: dineInTable });
      return;
    }

    if (orderType === 'delivery') {
      const name = deliveryCustomerName.trim();
      const phone = deliveryPhone.trim();
      const address = deliveryAddress.trim();
      if (!name || !phone || !address) {
        setNotification({
          type: 'error',
          msg: 'Enter customer name, phone, and delivery address for this order.',
        });
        setTimeout(() => setNotification(null), 5000);
        return;
      }
      void submitCheckout({
        customer_name: name,
        phone,
        address,
        ...(deliveryRiderName.trim() ? { rider_name: deliveryRiderName.trim() } : {}),
        ...(deliveryDistance.km != null ? { distance_km: deliveryDistance.km } : {}),
        ...(deliveryDistance.source ? { distance_source: deliveryDistance.source } : {}),
      });
      return;
    }

    void submitCheckout(null);
  };

  const applyCustomCoupon = () => {
    const raw = customCouponInput.trim();
    if (!raw) return;
    const isPercent = raw.includes('%');
    const num = parseFloat(raw.replace(/%/g, '').trim()) || 0;
    if (num <= 0) return;
    const type: 'percent' | 'fixed' = isPercent ? 'percent' : 'fixed';
    const value = isPercent ? Math.min(100, Math.max(0, num)) : num;
    setAppliedDiscount({ id: 'custom', name: 'Custom', type, value });
    setCustomCouponInput('');
    setCouponDropdownOpen(false);
  };

  const getActiveBranchId = () => terminalBranchKey;

  const activateCouponForAllOrders = () => {
    if (!appliedDiscount) return;
    const branchId = getActiveBranchId();
    setActiveCoupon(appliedDiscount);
    localStorage.setItem(`${ACTIVE_COUPON_STORAGE_KEY}_${branchId}`, JSON.stringify(appliedDiscount));
    setCouponDropdownOpen(false);
  };

  const deactivateCouponForAllOrders = () => {
    const branchId = getActiveBranchId();
    setActiveCoupon(null);
    setAppliedDiscount(null);
    localStorage.removeItem(`${ACTIVE_COUPON_STORAGE_KEY}_${branchId}`);
    setCouponDropdownOpen(false);
  };

  const subtotal = cart.reduce((sum, item) => {
    const mods = (item.modifiers || []).reduce((s, m) => s + (m.price ?? 0), 0);
    return sum + ((item.price + mods) * item.quantity);
  }, 0);
  const discountAmount = appliedDiscount
    ? appliedDiscount.type === 'percent'
      ? subtotal * (appliedDiscount.value / 100)
      : Math.min(appliedDiscount.value, subtotal)
    : 0;
  const sortedDiscounts = useMemo(
    () => [...discounts].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
    [discounts]
  );
  const discountedSubtotal = subtotal - discountAmount;
  const taxPct = taxEnabled ? (taxRatesByPaymentMethod[paymentMethod] ?? 0) : 0;
  const taxRate = taxPct / 100;
  const tax = discountedSubtotal * taxRate;
  const orderFeePkr =
    orderType === 'delivery'
      ? Math.max(0, Number(deliveryChargePkr) || 0)
      : orderType === 'dine_in'
        ? Math.max(0, Number(serviceChargePkr) || 0)
        : 0;
  const total = discountedSubtotal + tax + orderFeePkr;

  const filteredProducts = products.filter(p => {
    const sec = (p.section || '').trim();
    const isDealProduct = p.is_deal === true || sec === 'Deals';
    const matchesCategory =
      activeCategory === 'All Items' ||
      sec === activeCategory ||
      (activeCategory === 'Deals' && isDealProduct);
    const matchesSearch = p.title.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });


  const occupiedTables = useMemo(() => {
    const set = new Set<string>();
    for (const s of activeDineInSales) {
      const t = s.table_name || s.order_snapshot?.table_name;
      if (t) set.add(t);
    }
    return set;
  }, [activeDineInSales]);

  const freeTables = useMemo(() => {
    if (orderType !== 'dine_in') return tables;
    return tables.filter(t => !occupiedTables.has(t) || t === dineInTable);
  }, [tables, occupiedTables, orderType, dineInTable]);

  const attachModifier = (m: Modifier) => {
    if (!activeModifierRowId) return;
    setCart(prev =>
      prev.map(ci => {
        if (ci.uniqueId !== activeModifierRowId) return ci;
        const existing = ci.modifiers || [];
        if (existing.some(x => x.id === m.id)) return ci;
        return { ...ci, modifiers: [...existing, m] };
      })
    );
    // Keep it open to allow attaching multiple modifiers quickly, 
    // or close it depending on UX preference. Let's leave it open.
  };

  const removeModifier = (uniqueId: string, modifierId: number) => {
    setCart(prev => prev.map(ci => ci.uniqueId !== uniqueId ? ci : { ...ci, modifiers: (ci.modifiers || []).filter(m => m.id !== modifierId) }));
  };

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0 bg-transparent relative">

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-[11px] text-sm font-semibold transition-all ${
          notification.type === 'ok'
            ? 'bg-brand-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {notification.msg}
        </div>
      )}

      {/* ORDER READY Alerts (from KDS) */}
      {orderReadyAlerts.length > 0 && (
        <div className="fixed top-5 right-5 z-[199] flex flex-col gap-2 max-w-sm">
          {orderReadyAlerts.map(alert => (
            <div
              key={alert.id}
              className="flex items-center gap-3 bg-green-700 text-white px-4 py-3 rounded-[11px] border border-green-500 animate-pulse-once"
              role="alert"
            >
              <Bell className="w-5 h-5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm leading-tight">Order Ready!</p>
                <p className="text-xs text-green-100 truncate">
                  {alert.table_name ? `Table: ${alert.table_name}` : `Order #${alert.sale_id}`}
                  {alert.table_name ? ` · #${alert.sale_id}` : ''}
                </p>
              </div>
              <button
                onClick={() => setOrderReadyAlerts(prev => prev.filter(a => a.id !== alert.id))}
                className="p-1 rounded-md hover:bg-green-600 transition-colors shrink-0"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {dealConfigurator && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-neutral-900/55 p-4">
          <div className="w-full max-w-2xl rounded-[18px] border border-white/30 bg-white/90 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-brand-700">Configure Deal</p>
                <h2 className="mt-1 text-2xl font-black text-neutral-900">{dealConfigurator.product.title}</h2>
                <p className="mt-1 text-sm font-medium text-neutral-600">
                  Configure each bundled item and add the deal to the order.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDealConfigurator(null)}
                className="rounded-full bg-white p-2 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
                aria-label="Close deal configuration"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {dealConfigurator.product.variants?.length > 0 && (
              <div className="mt-5">
                <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-neutral-600">Deal variant</label>
                <SearchableSelect
                  value={dealConfigurator.variant}
                  onChange={(value) =>
                    setDealConfigurator(current => {
                      if (!current) return current;
                      const deal = dealsById.get(current.product.id);
                      const cfgRows = getDealComboItemsForVariant(deal, value);
                      const nextSel: Record<number, { productId: string; variant: string }> = {};
                      for (const r of cfgRows) {
                        if (rowNeedsFixedItemVariant(r, products)) {
                          const fixedProduct = products.find(p => p.id === r.product_id);
                          nextSel[r.id] = {
                            productId: String(r.product_id || ''),
                            variant: getDefaultProductVariant(fixedProduct),
                          };
                        }
                      }
                      return { ...current, variant: value, selections: nextSel };
                    })
                  }
                  options={dealConfigurator.product.variants.map(variant => ({
                    value: variant.name,
                    label: `${variant.name} (${formatCurrency(variant.salePrice)})`,
                  }))}
                  placeholder="Select variant…"
                  searchPlaceholder="Search variants…"
                  className="border-white/70 bg-white px-3 py-3 font-semibold"
                />
              </div>
            )}

            <div className="mt-5 space-y-4">
              {activeDealConfigRows.map((row) => {
                if (!isDealConfigurableRow(row, products)) {
                  return (
                    <div key={row.id} className="space-y-2">
                      <div className="flex items-center justify-between rounded-[18px] border border-white/60 bg-white/70 px-4 py-3">
                        <div>
                          <p className="text-sm font-bold text-neutral-900">{row.product_title || 'Menu item'}</p>
                          <p className="text-xs font-medium text-neutral-500">Included automatically</p>
                        </div>
                        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-black text-neutral-700">
                          {row.quantity}x
                        </span>
                      </div>
                    </div>
                  );
                }

                if (isCategoryChoiceRow(row)) {
                  const selectedState = dealConfigurator.selections[row.id] || { productId: '', variant: '' };
                  const categoryNames = getChoiceRowCategories(row);
                  const selectedCategoryName =
                    selectedState.categoryName && categoryNames.includes(selectedState.categoryName)
                      ? selectedState.categoryName
                      : categoryNames[0] || '';
                  const categoryLabel = getChoiceRowLabel(row);
                  const categoryProducts = selectedCategoryName ? menuProductsBySection.get(selectedCategoryName) || [] : [];
                  const selectedProduct = categoryProducts.find(product => String(product.id) === selectedState.productId);
                  return (
                    <div key={row.id} className="space-y-2">
                      <div className="rounded-[18px] border border-white/60 bg-white/70 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold text-neutral-900">{categoryLabel}</p>
                            <p className="text-xs font-medium text-neutral-500">
                              {categoryNames.length > 1
                                ? `Pick one category, then ${row.quantity}x item`
                                : `Pick ${row.quantity}x from this category`}
                            </p>
                          </div>
                          <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-black text-brand-700">
                            Required
                          </span>
                        </div>
                        {categoryNames.length > 1 && (
                          <div className="mb-3 flex flex-wrap gap-2">
                            {categoryNames.map(categoryName => (
                              <button
                                key={categoryName}
                                type="button"
                                onClick={() =>
                                  setDealConfigurator(current =>
                                    current
                                      ? {
                                          ...current,
                                          selections: {
                                            ...current.selections,
                                            [row.id]: { productId: '', variant: '', categoryName },
                                          },
                                        }
                                      : current
                                  )
                                }
                                className={`rounded-full px-3 py-1.5 text-xs font-black transition-colors ${
                                  selectedCategoryName === categoryName
                                    ? 'bg-brand-600 text-white'
                                    : 'border border-neutral-200 bg-white text-neutral-700 hover:border-brand-300'
                                }`}
                              >
                                {categoryName}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                          <div className="min-w-0">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                              Item
                            </label>
                            <SearchableSelect
                              value={selectedState.productId}
                              onChange={(value) =>
                                setDealConfigurator(current =>
                                  current
                                    ? {
                                        ...current,
                                        selections: {
                                          ...current.selections,
                                          [row.id]: {
                                            productId: value,
                                            categoryName: selectedCategoryName,
                                            variant: getDefaultProductVariant(
                                              categoryProducts.find(product => String(product.id) === value)
                                            ),
                                          },
                                        },
                                      }
                                    : current
                                )
                              }
                              options={categoryProducts.map(product => ({
                                value: String(product.id),
                                label: `${product.title} (${formatCurrency(product.base_price)})`,
                                searchText: `${product.sku} ${product.title}`,
                              }))}
                              placeholder={`Choose from ${selectedCategoryName || 'category'}…`}
                              searchPlaceholder={`Search ${(selectedCategoryName || 'category').toLowerCase()}…`}
                              emptyMessage={`No menu items found in ${selectedCategoryName || 'this category'}.`}
                              className="border-white/70 bg-white px-3 py-3 font-semibold"
                            />
                          </div>
                          <div className="min-w-0">
                            {selectedProduct?.variants?.length ? (
                              <>
                                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                                  Variant
                                </label>
                                <SearchableSelect
                                  value={selectedState.variant}
                                  onChange={(value) =>
                                    setDealConfigurator(current =>
                                      current
                                        ? {
                                            ...current,
                                            selections: {
                                              ...current.selections,
                                              [row.id]: {
                                                productId: selectedState.productId,
                                                variant: value,
                                                categoryName: selectedCategoryName,
                                              },
                                            },
                                          }
                                        : current
                                    )
                                  }
                                  options={selectedProduct.variants.map(variant => ({
                                    value: variant.name,
                                    label: `${variant.name} (${formatCurrency(variant.salePrice)})`,
                                  }))}
                                  placeholder="Variant…"
                                  searchPlaceholder="Search variants…"
                                  className="border-white/70 bg-white px-3 py-3 font-semibold"
                                />
                              </>
                            ) : (
                              <span className="text-xs text-neutral-400 sm:pb-3 sm:pl-1">Qty ×{row.quantity}</span>
                            )}
                          </div>
                          <div className="flex items-center justify-end pb-1 sm:pb-3">
                            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-black text-neutral-700">
                              ×{row.quantity}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }

                const fixedProduct = products.find(p => p.id === row.product_id);
                const fvState = dealConfigurator.selections[row.id] || {
                  productId: String(row.product_id || ''),
                  variant: getDefaultProductVariant(fixedProduct),
                };
                return (
                  <div key={row.id} className="space-y-2">
                    <div className="rounded-[18px] border border-white/60 bg-white/70 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-neutral-900">{row.product_title || 'Bundled item'}</p>
                          <p className="text-xs font-medium text-neutral-500">
                            {fixedProduct?.variants?.length ? 'Choose portion / variant' : 'Included automatically'}
                          </p>
                        </div>
                        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-black text-neutral-700">
                          {row.quantity}x
                        </span>
                      </div>
                      {fixedProduct?.variants?.length ? (
                        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                          <div className="min-w-0">
                            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                              Variant
                            </label>
                            <SearchableSelect
                              value={fvState.variant}
                              onChange={(value) =>
                                setDealConfigurator(current =>
                                  current
                                    ? {
                                        ...current,
                                        selections: {
                                          ...current.selections,
                                          [row.id]: { productId: String(row.product_id || ''), variant: value },
                                        },
                                      }
                                    : current
                                )
                              }
                              options={fixedProduct.variants.map(variant => ({
                                value: variant.name,
                                label: `${variant.name} (${formatCurrency(variant.salePrice)})`,
                              }))}
                              placeholder="Choose variant…"
                              searchPlaceholder="Search variants…"
                              className="border-white/70 bg-white px-3 py-3 font-semibold"
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 border-t border-black/5 pt-4">
              <div>
                <p className="text-sm font-bold text-neutral-900">{formatCurrency(dealConfigurator.product.base_price)}</p>
                <p className="text-xs font-medium text-neutral-500">Deal price</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDealConfigurator(null)}
                  className="rounded-[11px] border border-neutral-200 bg-white px-4 py-2.5 text-sm font-bold text-neutral-700 transition-colors hover:bg-neutral-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDealConfirmAddToCart}
                  className="rounded-[11px] bg-brand-600 px-5 py-2.5 text-sm font-black text-white transition-colors hover:bg-brand-700"
                >
                  Add deal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =========================================
          LEFT PANEL: CART (25-30% width on lg)
          ========================================= */}
      <div className="w-full lg:w-[min(340px,28vw)] xl:w-[360px] border-b lg:border-b-0 lg:border-r border-white/20 flex flex-col shrink-0 min-h-0 bg-white/10 z-10 order-2 lg:order-1">
        
        {/* Cart Header */}
        <div className="p-4 lg:p-5 border-b border-white/20 shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-neutral-900 tracking-tight">Current Order</h2>
            {editingOpenSaleId && (
              <span className="text-[10px] font-bold text-amber-900 bg-amber-100 border border-amber-300 px-2.5 py-1 rounded-[8px]">
                Open tab #{editingOpenSaleId}
              </span>
            )}
          </div>
        </div>

        {/* Cart Items List */}
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3 relative">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-400">
              <ShoppingBag className="w-16 h-16 mb-3 stroke-1 opacity-50" />
              <p className="text-sm font-medium">No items yet</p>
              <p className="text-xs mt-1 opacity-70">Tap an item to add it</p>
            </div>
          ) : (
            cart.map((item, index) => {
              const baseProd = products.find(p => p.id === item.id);
              const hasVariants = baseProd && baseProd.variants && baseProd.variants.length > 0;
              const hasDealSelections = (item.dealSelections || []).length > 0;
              const showVariantSelector = Boolean(hasVariants && !hasDealSelections);
              return (
              <div key={item.uniqueId + "-" + index} className="flex flex-col gap-2 p-3 glass-card relative group transition-shadow bg-white/60 hover:bg-white/80 border border-white/50">
                
                {/* Main Item Row */}
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-[8px] bg-white/20 flex items-center justify-center overflow-hidden shrink-0 border border-white/30 p-0.5">
                    <img src={item.image} alt="" className="h-full w-full object-contain object-center" />
                  </div>
                  
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800 leading-tight">{item.title}</p>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.uniqueId); }} className="shrink-0 p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-50 transition-colors" aria-label="Remove line">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Variant selector — compact but still reads as a control */}
                    {showVariantSelector ? (
                      <div className="mt-1.5 w-full max-w-[calc(100%-2.25rem)]">
                        <label htmlFor={`cart-variant-${item.uniqueId.replace(/\W/g, '-')}`} className="sr-only">
                          Variant
                        </label>
                        <SearchableSelect
                          value={item.variant || ''}
                          onChange={(value) => handleChangeVariant(item.uniqueId, value)}
                          searchPlaceholder="Search variants…"
                          options={(baseProd?.variants || []).map((variant) => ({ value: variant.name, label: `${variant.name} (${formatCurrency(variant.salePrice)})` }))}
                          className="min-h-[32px] border-brand-300/80 bg-white py-1 pl-2 pr-2 text-xs font-bold text-neutral-800 hover:border-brand-400 hover:bg-brand-50/30 focus:border-brand-500"
                          dropdownClassName="min-w-[8.5rem]"
                        />
                      </div>
                    ) : shouldShowCurrentOrderVariant(item.variant) ? (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 bg-neutral-200/80 text-neutral-700 text-[10px] font-bold rounded">
                        {item.variant}
                      </span>
                    ) : null}

                    {hasDealSelections && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(item.dealSelections || []).map(selection => (
                          <span
                            key={`${item.uniqueId}-${selection.combo_item_id}`}
                            className="inline-flex items-center rounded-full border border-brand-200 bg-brand-50 px-2 py-1 text-[10px] font-bold text-brand-800"
                          >
                            {selection.category_name}: {selection.product_title}
                            {shouldShowCurrentOrderVariant(selection.variant) ? ` (${selection.variant})` : ''}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Price & Add Modifier Button */}
                    <div className="flex items-center gap-2 mt-1.5">
                      <p className="text-sm font-black text-gold-600">{formatCurrency(item.price)}</p>
                      <span className="text-neutral-300 select-none">&bull;</span>
                      <button 
                        type="button" 
                        onClick={(e) => { e.stopPropagation(); setActiveModifierRowId(activeModifierRowId === item.uniqueId ? null : item.uniqueId); }} 
                        className="text-[11px] font-bold text-brand-600 hover:text-brand-700 hover:underline transition-colors"
                      >
                        {activeModifierRowId === item.uniqueId ? 'Close Modifiers' : '+ Add Modifier'}
                      </button>
                    </div>

                  </div>
                </div>

                {/* Modifiers List on Item */}
                {(item.modifiers || []).length > 0 && (
                  <div className="mt-1 space-y-1">
                    {(item.modifiers || []).map((m: { id: number; name: string; price: number | null }) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 text-[11px] font-semibold text-neutral-600 bg-white/70 border border-white/80 px-2 py-1.5 rounded-md">
                        <span className="truncate flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-brand-400"></span> {m.name} {m.price ? `(+${formatCurrency(m.price)})` : ''}
                        </span>
                        <button type="button" onClick={(e) => { e.stopPropagation(); removeModifier(item.uniqueId, m.id); }} className="text-red-500 hover:text-red-700 mx-1">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Active Modifier Picker Tray */}
                {activeModifierRowId === item.uniqueId && (
                  <div className="mt-2">
                    <div className="p-2.5 bg-brand-50/80 border border-brand-200/60 rounded-[8px]">
                      <p className="text-[10px] font-bold text-brand-800 uppercase tracking-wide mb-2 opacity-80">Available Modifiers</p>
                      {modifiers.length === 0 ? (
                        <p className="text-xs text-neutral-500 font-medium">None configured.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {modifiers.map(m => {
                            const isAttached = (item.modifiers || []).some(x => x.id === m.id);
                            if (isAttached) return null;
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => attachModifier({ id: m.id, name: m.name, price: m.price })}
                                className="px-2.5 py-1.5 rounded-[8px] text-[11px] font-bold border transition-colors bg-white hover:bg-brand-100 hover:border-brand-300 border-neutral-200 text-neutral-700 active:scale-95 flex items-center gap-1"
                              >
                                {m.name} <span className="opacity-60">{m.price ? `(+${m.price})` : ''}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Bottom Row: Quantity & Total */}
                <div className="flex items-center justify-between mt-1 pt-2 border-t border-black/5">
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, -1); }} className="w-7 h-7 rounded-[8px] bg-white/80 hover:bg-white flex items-center justify-center transition-all border border-black/10 active:scale-95">
                      <Minus className="w-3.5 h-3.5 text-neutral-700" />
                    </button>
                    <span className="text-sm font-black text-neutral-800 w-6 text-center tabular-nums">{item.quantity}</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, 1); }} className="w-7 h-7 rounded-[8px] bg-brand-600 hover:bg-brand-500 flex items-center justify-center transition-all active:scale-95">
                      <Plus className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                  <p className="text-sm font-black text-neutral-900 min-w-[70px] text-right">
                    {formatCurrency((item.price + (item.modifiers || []).reduce((s, m) => s + (m.price ?? 0), 0)) * item.quantity)}
                  </p>
                </div>

              </div>
              );
            })
          )}
        </div>

        {/* Cart totals: subtotal, discount, tax, total */}
        <div className="shrink-0 border-t border-white/20 bg-white/40 px-4 py-3 lg:px-5 lg:py-4">
          <div className="space-y-2">
            <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
              <span>Subtotal</span>
              <span className="text-neutral-800 tabular-nums">{formatCurrency(subtotal)}</span>
            </div>
            {appliedDiscount && discountAmount > 0 && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Discount <span className="opacity-70">({appliedDiscount.name})</span></span>
                <span className="text-red-500 tabular-nums">-{formatCurrency(discountAmount)}</span>
              </div>
            )}
            {orderType === 'dine_in' && orderFeePkr > 0 && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Service charge</span>
                <span className="text-neutral-800 tabular-nums">{formatCurrency(orderFeePkr)}</span>
              </div>
            )}
            {orderType === 'delivery' && orderFeePkr > 0 && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Delivery charge</span>
                <span className="text-neutral-800 tabular-nums">{formatCurrency(orderFeePkr)}</span>
              </div>
            )}
            {taxEnabled && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Tax</span>
                <span className="text-neutral-800 tabular-nums">{formatCurrency(tax)}</span>
              </div>
            )}
            <div className="h-px bg-black/10 my-2" />
            <div className="flex justify-between items-end gap-2">
              <span className="text-base font-black text-neutral-800 tracking-tight">TOTAL</span>
              <span className="text-[26px] sm:text-[28px] leading-none font-black text-brand-700 tracking-tight tabular-nums">{formatCurrency(total)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* =========================================
          CENTER PANEL: MENU (45-50% width)
          ========================================= */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden order-1 lg:order-2">
        <div className="page-padding pb-0 pt-4 lg:pt-5">
          <div className="mb-4 lg:mb-5">
            <h1 className="text-2xl xl:text-3xl font-black text-neutral-900 tracking-tight">Menu</h1>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-brand-200/40 pb-2">
            {categories.map(cat => (
              <button key={cat} type="button" onClick={() => setActiveCategory(cat)} className={`px-5 py-2.5 rounded-full text-sm font-bold whitespace-nowrap transition-all active:scale-95 ${activeCategory === cat ? 'bg-brand-600 text-white' : 'bg-white/50 text-neutral-600 hover:bg-white/80 hover:text-neutral-900 border border-transparent hover:border-white/60'}`}>
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto page-padding pt-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-48 text-neutral-400 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-brand-500" />
              <p className="font-medium text-sm">Loading menu…</p>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-neutral-400 gap-2">
              <Search className="w-10 h-10 stroke-1 opacity-50 mb-2" />
              <p className="text-lg font-bold text-neutral-500">No items found</p>
              <p className="text-xs">Try adjusting your search criteria</p>
            </div>
          ) : (
            <div className={layoutView === 'grid' ? "grid grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(170px,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] tap-highlight-transparent gap-2.5 lg:gap-3 pb-20 lg:pb-6 w-full" : "flex flex-col gap-2.5 pb-20 lg:pb-6 w-full"}>
              {filteredProducts.map(product => {
                const needsDealConfigurator = product.is_deal && dealNeedsConfigurator(product);
                return (
                <button
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className={`glass-card bg-white/80 overflow-hidden w-full transition-all duration-200 group text-left border border-white/50 ${layoutView === 'grid' ? 'flex items-center gap-3 rounded-[11px] min-h-[72px] px-3 py-2.5' : 'flex items-center gap-3 p-3 rounded-[11px]'} hover:border-brand-300 hover:bg-white hover:scale-[1.02] active:scale-[0.98]`}
                >
                  <div className={`${layoutView === 'grid' ? 'w-14 h-14' : 'w-14 h-14 lg:w-16 lg:h-16'} shrink-0 rounded-[8px] p-1 flex items-center justify-center overflow-hidden transition-colors relative bg-brand-50 group-hover:bg-brand-100`}>
                    <img src={getProductImageUrl(product)} alt="" className="h-full w-full object-contain object-center" />
                    <div className="absolute inset-0 bg-brand-900/0 group-hover:bg-brand-900/5 transition-colors duration-300" />
                  </div>
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`${layoutView === 'grid' ? 'text-sm line-clamp-3 whitespace-normal' : 'text-sm lg:text-base truncate'} min-w-0 font-semibold text-neutral-800 leading-tight`}>{product.title}</p>
                      {needsDealConfigurator ? (
                        <span className="mt-1 inline-flex rounded-full border border-brand-200 bg-brand-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-brand-700">
                          Configure
                        </span>
                      ) : null}
                    </div>
                    <p className={`${layoutView === 'grid' ? 'text-sm' : 'text-base'} shrink-0 font-bold text-brand-700 whitespace-nowrap`}>{formatCurrency(product.sale_price ?? product.base_price)}</p>
                  </div>
                </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* =========================================
          RIGHT PANEL: SUMMARY & CHECKOUT (28-30vw)
          acts as sliding drawer on smaller screens
          ========================================= */}
      
      {/* Mobile Backdrop overlay */}
      {isRightPanelOpen && (
        <div className="fixed inset-0 bg-neutral-900/50 z-[60] lg:hidden transition-opacity" onClick={() => setIsRightPanelOpen(false)} aria-hidden />
      )}

      <div className={`fixed inset-y-0 right-0 z-[70] w-[min(400px,90vw)] lg:static lg:w-[min(380px,28vw)] xl:w-[min(420px,30vw)] transform transition-transform duration-300 ${isRightPanelOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'} border-l border-white/20 bg-neutral-50/95 lg:bg-white/10 flex flex-col shrink-0 min-h-0 order-3`}>
        
        {/* Drawer Header (Mobile only) */}
        <div className="p-4 flex items-center justify-between lg:hidden border-b border-black/5 bg-white/50">
          <h2 className="text-xl font-black text-neutral-900 tracking-tight">Checkout Summary</h2>
          <button onClick={() => setIsRightPanelOpen(false)} className="w-9 h-9 flex items-center justify-center rounded-full bg-neutral-200/70 hover:bg-neutral-300 text-neutral-700 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 lg:p-5 space-y-4 lg:space-y-6">
          <div className="glass-card !overflow-visible p-4 rounded-[11px] border border-white/60 bg-white/70">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${scannerStatus === 'active' ? 'bg-brand-100 text-brand-800 border border-brand-300' : scannerStatus === 'idle' ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-neutral-100 text-neutral-600 border border-neutral-300'}`}>
                <Usb className="w-4 h-4" />
                <span>{scannerStatus === 'active' ? 'Scanner Active' : scannerStatus === 'idle' ? 'Scanner Idle' : 'Scanner Waiting'}</span>
              </div>
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold ${printerStatus === 'connected' ? 'bg-brand-100 text-brand-800 border border-brand-300' : printerStatus === 'checking' ? 'bg-neutral-100 text-neutral-600 border border-neutral-300' : 'bg-red-100 text-red-700 border border-red-300'}`}>
                <Printer className="w-4 h-4" />
                <span>{printerStatus === 'connected' ? 'Printer Ready' : printerStatus === 'checking' ? 'Checking…' : 'Printer Offline'}</span>
              </div>
            </div>
          </div>

          <div className="glass-card !overflow-visible p-4 rounded-[11px] border border-white/60 bg-white/70">
            <h3 className="text-sm font-black text-neutral-800 mb-3 tracking-wide">MENU SEARCH</h3>
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 w-5 h-5 text-neutral-400" aria-hidden />
              <input type="text" inputMode="search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search menu items..." className="w-full min-h-[48px] pl-12 pr-4 py-2.5 glass-card bg-white/70 text-sm font-medium focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-all rounded-[11px] border border-white/60" />
            </div>
          </div>

          
          {/* SECTION 1: ORDER INFO */}
          <div className="glass-card !overflow-visible p-4 rounded-[11px] border border-white/60 bg-white/70">
            <h3 className="text-sm font-black text-neutral-800 mb-3 tracking-wide">ORDER INFO</h3>
            
            {/* Order Type Buttons */}
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Order type">
              {ORDER_TYPE_OPTIONS.map(({ id, label, Icon }) => {
                const selected = orderType === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setEditingOpenSaleId(null);
                      editOrderLoadedRef.current = null;
                      setOrderType(id);
                    }}
                    className={`min-h-[48px] py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-[11px] border-2 transition-all active:scale-95 ${
                      selected
                        ? 'bg-brand-50 border-brand-500 text-brand-800'
                        : 'bg-white/60 border-transparent hover:border-brand-300 text-neutral-600 hover:bg-white'
                    }`}
                  >
                    <Icon className="w-4.5 h-4.5 shrink-0" strokeWidth={selected ? 2.25 : 1.75} />
                    <span className="text-[10px] font-bold leading-tight text-center px-0.5">{label}</span>
                  </button>
                );
              })}
            </div>

            {/* Table / delivery — always visible for dine-in and delivery */}
            {(orderType === 'dine_in' || orderType === 'delivery') && (
              <div className="mt-4 pt-4 border-t border-black/10">
                <h4 className="text-sm font-bold text-neutral-800 mb-3">
                  {orderType === 'dine_in' ? 'Table Selection' : 'Delivery Details'}
                </h4>

                {orderType === 'dine_in' && (
                  <div>
                    {tables.length === 0 ? (
                      <p className="text-xs text-amber-800 bg-amber-50/90 border border-amber-200/80 rounded-[8px] px-3 py-2 font-medium">
                        No tables registered. Add names under Settings → Tables.
                      </p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 max-h-[min(12rem,30vh)] overflow-y-auto p-2 pr-1">
                        {freeTables.map(t => {
                          const selected = dineInTable === t;
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setDineInTable(t)}
                              className={`table-select-button py-2.5 rounded-[11px] text-xs font-bold border-2 transition-all active:scale-95 text-center ${
                                selected
                                  ? 'border-brand-500 bg-brand-500 text-white'
                                  : 'border-white/80 bg-white text-neutral-700 hover:border-brand-300 hover:bg-brand-50'
                              }`}
                            >
                              {t}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <label className="mt-4 block">
                      <span className="text-[11px] font-bold text-neutral-600 uppercase tracking-wide">Service charge (PKR)</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={1}
                        value={serviceChargePkr || ''}
                        onChange={e => setServiceChargePkr(e.target.value === '' ? 0 : Number(e.target.value))}
                        className="mt-1.5 w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all"
                        placeholder="0"
                      />
                    </label>
                  </div>
                )}

                {orderType === 'delivery' && (
                  <div className="space-y-2.5">
                    <input type="text" value={deliveryCustomerName} onChange={e => setDeliveryCustomerName(e.target.value)} placeholder="Customer name" className="w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all" />
                    <input type="tel" value={deliveryPhone} onChange={e => setDeliveryPhone(e.target.value)} placeholder="Phone number" className="w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all" />
                    {deliveryLookupState === 'loading' && (
                      <p className="text-[11px] font-semibold text-neutral-500">Looking up customer details...</p>
                    )}
                    {deliveryLookupState === 'found' && (
                      <p className="text-[11px] font-semibold text-brand-700">Returning customer found. Name and address auto-filled.</p>
                    )}
                    {deliveryLookupState === 'not_found' && (
                      <p className="text-[11px] font-semibold text-neutral-500">No previous delivery found for this number.</p>
                    )}
                    {deliveryDistance.state === 'loading' && (
                      <p className="text-[11px] font-semibold text-neutral-500">Calculating route distance...</p>
                    )}
                    {deliveryDistance.state === 'ready' && (
                      <p className="text-[11px] font-semibold text-brand-700">
                        Distance: {deliveryDistance.km?.toFixed(2)} km
                        {deliveryDistance.minutes != null ? ` (${Math.round(deliveryDistance.minutes)} min)` : ''}
                        {deliveryDistance.source ? ` - ${deliveryDistance.source.replace(/_/g, ' ')}` : ''}
                      </p>
                    )}
                    {deliveryDistance.state === 'unavailable' && (
                      <p className="text-[11px] font-semibold text-amber-700">
                        {deliveryDistance.message || 'Distance currently unavailable. You can still continue checkout.'}
                      </p>
                    )}
                    {deliveryLookupMatches.length > 1 && (
                      <label className="block">
                        <span className="text-[11px] font-bold text-neutral-600 uppercase tracking-wide">Saved customer/address</span>
                        <select
                          value={`${deliveryCustomerName}|||${deliveryAddress}`}
                          onChange={e => {
                            const [name, address] = e.target.value.split('|||');
                            setDeliveryCustomerName(name || '');
                            setDeliveryAddress(address || '');
                          }}
                          className="mt-1.5 w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all"
                        >
                          {deliveryLookupMatches.map((match, idx) => (
                            <option key={`${match.customer_name}-${match.address}-${idx}`} value={`${match.customer_name}|||${match.address}`}>
                              {match.customer_name} - {match.address}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <textarea value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="Delivery address" rows={2} className="w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y min-h-[80px] transition-all" />
                    <label className="block">
                      <span className="text-[11px] font-bold text-neutral-600 uppercase tracking-wide">Assign rider</span>
                      <select
                        value={deliveryRiderName}
                        onChange={e => setDeliveryRiderName(e.target.value)}
                        className="mt-1.5 w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all"
                      >
                        <option value="">Select rider</option>
                        {availableRiderOptions.map(rider => (
                          <option key={rider} value={rider}>
                            {rider}
                          </option>
                        ))}
                      </select>
                    </label>
                    {riders.length > 0 && !availableRiderOptions.length && !deliveryRiderName.trim() && (
                      <p className="text-[11px] font-semibold text-amber-700">No rider available right now.</p>
                    )}
                    <label className="block">
                      <span className="text-[11px] font-bold text-neutral-600 uppercase tracking-wide">Delivery charge (PKR)</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={1}
                        value={deliveryChargePkr || ''}
                        onChange={e => setDeliveryChargePkr(e.target.value === '' ? 0 : Number(e.target.value))}
                        className="mt-1.5 w-full px-3.5 py-3 rounded-[11px] border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all"
                        placeholder={String(DEFAULT_DELIVERY_CHARGE_PKR)}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SECTION 2: PAYMENT INFO */}
          <div className="glass-card p-4 rounded-[11px] border border-white/60 bg-white/70 space-y-4">
            
            {/* Coupon / Discount */}
            <div className="relative">
              <button type="button" onClick={() => setCouponSectionExpanded(prev => !prev)} className="w-full flex items-center justify-between gap-2 py-1 px-1 -mx-1 rounded-[8px] hover:bg-white/60 text-left transition-colors">
                <h3 className="text-sm font-black text-neutral-800 tracking-wide">DISCOUNT</h3>
                {couponSectionExpanded ? <ChevronDown className="w-4.5 h-4.5 shrink-0 text-neutral-500" /> : <ChevronRight className="w-4.5 h-4.5 shrink-0 text-neutral-500" />}
              </button>
              
              {couponSectionExpanded && (
              <div className="relative mt-3">
                <button type="button" onClick={() => setCouponDropdownOpen(prev => !prev)} className={`w-full flex items-center justify-between gap-2 px-4 py-3 rounded-[11px] border-2 text-left text-sm font-bold transition-all ${appliedDiscount ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-neutral-200/80 bg-white hover:border-brand-300 text-neutral-600'}`}>
                  <span className="flex items-center gap-2.5"><Tag className="w-4.5 h-4.5 text-neutral-500" />{appliedDiscount ? `${appliedDiscount.name} (${appliedDiscount.type === 'percent' ? `${appliedDiscount.value}%` : formatCurrency(appliedDiscount.value)})` : 'Apply coupon ticket'}</span>
                  <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${couponDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {couponDropdownOpen && (
                  <div className="absolute top-[calc(100%+4px)] left-0 right-0 py-1.5 glass-floating bg-white/95 border border-neutral-200 rounded-[11px] z-10 max-h-60 overflow-auto">
                    <button type="button" onClick={() => { setAppliedDiscount(null); setCouponDropdownOpen(false); }} className="w-full px-4 py-3 text-left text-sm font-bold text-neutral-600 hover:bg-neutral-50 transition-colors">No discount</button>
                    <div className="px-3 py-2.5 border-t border-neutral-100 bg-neutral-50/50">
                      <p className="text-[11px] font-bold text-neutral-500 uppercase tracking-wide mb-2 pl-1">Custom Amount</p>
                      <div className="flex gap-2">
                        <input type="text" value={customCouponInput} onChange={e => setCustomCouponInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyCustomCoupon()} placeholder="e.g. 500 or 10%" className="flex-1 px-3.5 py-2.5 bg-white border border-neutral-200 rounded-[8px] text-sm font-semibold focus:ring-2 focus:ring-brand-500 focus:outline-none" />
                        <button type="button" onClick={applyCustomCoupon} disabled={!customCouponInput.trim()} className="px-4 py-2.5 bg-brand-600 text-white rounded-[8px] text-sm font-bold hover:bg-brand-700 disabled:opacity-50 active:scale-95 transition-all">Apply</button>
                      </div>
                    </div>
                    {sortedDiscounts.length > 0 && <div className="h-px bg-neutral-100 my-1" />}
                    {sortedDiscounts.map(d => (
                      <button key={d.id} type="button" onClick={() => { setAppliedDiscount(d); setCouponDropdownOpen(false); }} className="w-full px-4 py-3 border-b border-black/5 last:border-0 text-left text-sm font-bold text-neutral-800 hover:bg-brand-50 transition-colors">{d.name} <span className="text-neutral-500 font-medium ml-1">— {d.type === 'percent' ? `${d.value}%` : formatCurrency(d.value)}</span></button>
                    ))}
                  </div>
                )}
              </div>
              )}
              {/* Inline active coupon indicator (remove button) */}
              {appliedDiscount && couponSectionExpanded && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setAppliedDiscount(null)} className="text-[11px] font-bold text-red-600 hover:text-red-700 hover:underline px-1 py-1">Remove discount</button>
                  <button type="button" onClick={activateCouponForAllOrders} className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-[8px] border transition-all ${activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300'}`}>
                    <CheckCircle className="w-3.5 h-3.5" /> {activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value ? 'Active for all orders' : 'Activate for all orders'}
                  </button>
                  {activeCoupon && (
                    <button type="button" onClick={deactivateCouponForAllOrders} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-[8px] border border-neutral-200 bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:border-neutral-300 transition-all">
                      <XCircle className="w-3.5 h-3.5" /> Mark inactive
                    </button>
                  )}
                </div>
              )}
              </div>

            {/* Payment Method — only relevant for takeaway/delivery */}
            {(orderType === 'takeaway' || orderType === 'delivery') && (
            <div className="border-t border-black/10 pt-4 mt-4">
              <button type="button" onClick={() => setPaymentMethodSectionExpanded(prev => !prev)} className="w-full flex items-center justify-between gap-2 py-1 px-1 -mx-1 rounded-[8px] hover:bg-white/60 text-left transition-colors">
                <h3 className="text-sm font-black text-neutral-800 tracking-wide">PAYMENT METHOD</h3>
                {paymentMethodSectionExpanded ? <ChevronDown className="w-4.5 h-4.5 shrink-0 text-neutral-500" /> : <ChevronRight className="w-4.5 h-4.5 shrink-0 text-neutral-500" />}
              </button>
              {paymentMethodSectionExpanded && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(['Cash','Card','Online Transfer'] as const).map(pm => (
                  <button key={pm} type="button" onClick={() => setPaymentMethod(pm)} className={`py-3 px-1 flex flex-col items-center justify-center gap-1.5 rounded-[11px] border-2 transition-all active:scale-95 ${paymentMethod === pm ? 'bg-brand-50 border-brand-500 text-brand-800' : 'bg-white/80 border-transparent hover:border-brand-300 text-neutral-600 hover:bg-white'}`}>
                    {pm === 'Cash' ? <Banknote className="w-5 h-5" /> : pm === 'Card' ? <CreditCard className="w-5 h-5" /> : <Smartphone className="w-5 h-5" />}
                    <span className="text-[10px] font-bold tracking-wide uppercase">{pm === 'Online Transfer' ? 'Online' : pm}</span>
                  </button>
                ))}
              </div>
              )}
            </div>
            )}
          </div>
        </div>

        {/* SECTION 3: CHECKOUT ACTIONS */}
        <div className="p-4 lg:p-5 border-t border-black/10 bg-white/70 shrink-0">
          {orderType === 'dine_in' && !editingOpenSaleId ? (
            <div className="grid grid-cols-1 gap-2.5">
              <button type="button" onClick={handleGenerateKot} disabled={cart.length === 0 || checkoutSubmitting} className="kot-primary w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed text-white py-4 rounded-[11px] font-bold text-[15px] transition-all active:scale-[0.98] flex items-center justify-center gap-2">
                <ClipboardList className="w-5 h-5" /> {checkoutSubmitting ? 'Working…' : 'Send to Kitchen (KOT)'}
              </button>
              <p className="text-center text-xs text-neutral-400 font-medium">To collect payment, open Active Dine-in Orders.</p>
            </div>
          ) : (orderType === 'takeaway' || orderType === 'delivery') && !editingOpenSaleId ? (
            <div className="grid grid-cols-1 gap-2.5">
              <button
                type="button"
                onClick={() => void submitTakeawayDeliveryKotAndPay()}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="kot-primary w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-4 rounded-[11px] font-bold text-[15px] transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <ClipboardList className="w-5 h-5" /> {checkoutSubmitting ? 'Working…' : 'Send to Kitchen (KOT)'}
              </button>
              <p className="text-center text-xs text-neutral-400 font-medium">Order saved to Active Orders — collect payment there.</p>
            </div>
          ) : editingOpenSaleId ? (
            <div className="grid grid-cols-1 gap-2.5">
              <button type="button" onClick={submitUpdateOrder} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-brand-600 hover:bg-brand-700 border-2 border-amber-500 text-white disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed py-4 rounded-[11px] font-bold text-[15px] transition-all active:scale-[0.98] flex items-center justify-center gap-2">
                <ClipboardList className="w-5 h-5" /> {checkoutSubmitting ? 'Working…' : 'Update Order'}
              </button>
              <p className="text-center text-xs text-neutral-400 font-medium">To collect payment, open Active Dine-in Orders.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {checkoutSlowNotice && (
                <p className="text-xs font-semibold text-amber-900 bg-amber-50 border border-amber-200 rounded-[10px] px-3 py-2 leading-snug">
                  Still processing… If nothing happens, wait a few seconds before paying again. Receipt printing runs in the background after payment succeeds.
                </p>
              )}
              <button
                onClick={handleCheckout}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-4 rounded-[18px] font-black text-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 tracking-wide"
              >
                <ShoppingBag className="w-5 h-5" /> {checkoutSubmitting ? 'Processing…' : 'PAY & PRINT'}
              </button>
            </div>
          )}
        </div>

      </div>

      {/* Mobile Checkout Drawer Toggle (Visible only on lg and down) */}
      <div className="lg:hidden fixed bottom-5 right-5 z-[55]">
        {!isRightPanelOpen && (
          <button onClick={() => setIsRightPanelOpen(true)} className="bg-brand-600 text-white px-7 py-4 rounded-full font-black text-[15px] tracking-wide flex items-center gap-2 hover:bg-brand-700 active:scale-95 transition-all outline-none focus:ring-4 focus:ring-brand-500/30">
            <ShoppingBag className="w-5 h-5"/> Checkout <span className="opacity-60 mx-1.5 font-normal">|</span> {formatCurrency(total)}
          </button>
        )}
      </div>

    </div>
  );
}
