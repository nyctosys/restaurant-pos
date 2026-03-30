import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useScanner } from '../hooks/useScanner';
import { ShoppingBag, Plus, Minus, Trash2, Search, Loader2, CreditCard, Banknote, Smartphone, LayoutGrid, List, X, Printer, Usb, Tag, ChevronDown, ChevronRight, CheckCircle, XCircle, Package, UtensilsCrossed, Truck, ClipboardList } from 'lucide-react';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, patch, getUserMessage } from '../api';
import { getSocket } from '../realtime/socket';

type Product = {
  id: number;
  sku: string;
  title: string;
  base_price: number;
  section: string;
  variants: string[];
  image_url?: string;
};

type CartItem = {
  uniqueId: string;
  id: number;
  title: string;
  price: number;
  quantity: number;
  image: string;
  variant?: string;
  modifiers?: { id: number; name: string; price: number | null }[];
};

type DiscountPreset = { id: string; name: string; type: 'percent' | 'fixed'; value: number };

/** Sent as `order_type` on checkout; backend accepts for future use / receipts */
type OrderType = 'takeaway' | 'dine_in' | 'delivery';

const ORDER_TYPE_OPTIONS: { id: OrderType; label: string; Icon: typeof Package }[] = [
  { id: 'takeaway', label: 'Takeaway', Icon: Package },
  { id: 'dine_in', label: 'Dine in', Icon: UtensilsCrossed },
  { id: 'delivery', label: 'Delivery', Icon: Truck },
];

const PRODUCT_PLACEHOLDER_IMAGE = '/product-placeholder.svg';

function getProductImageUrl(product: Product): string {
  return (product.image_url && product.image_url.trim()) ? product.image_url.trim() : PRODUCT_PLACEHOLDER_IMAGE;
}

type OrderDetailLine = {
  product_id: number;
  product_title?: string;
  variant_sku_suffix?: string;
  quantity: number;
  unit_price: number;
  modifiers?: { id: number; name: string; price: number | null }[];
};

type OrderDetailResponse = {
  id: number;
  status?: string;
  kitchen_status?: string;
  order_type?: string | null;
  order_snapshot?: { table_name?: string } | null;
  items?: OrderDetailLine[];
};

type Modifier = { id: number; name: string; price: number | null };
type ActiveSale = { id: number; order_snapshot?: { table_name?: string } | null; table_name?: string | null; status: string; order_type?: string | null };

export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const editOrderLoadedRef = useRef<number | null>(null);
  const { lastScannedBarcode, clearBarcode, scannerStatus } = useScanner();
  const [printerStatus, setPrinterStatus] = useState<'checking' | 'connected' | 'disconnected' | 'error'>('checking');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeCategory, setActiveCategory] = useState('All Items');
  const [searchQuery, setSearchQuery] = useState('');
  const [layoutView, setLayoutView] = useState<'grid' | 'list'>('grid');
  const [products, setProducts] = useState<Product[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentDate(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [loading, setLoading] = useState(true);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'Card' | 'Cash' | 'Online Transfer'>('Card');
  const [inventory, setInventory] = useState<Record<string, Record<string, number>>>({});
  const [notification, setNotification] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const [taxEnabled, setTaxEnabled] = useState<boolean>(true);
  const [taxRatesByPaymentMethod, setTaxRatesByPaymentMethod] = useState<Record<string, number>>({ Cash: 0, Card: 8, 'Online Transfer': 8 });
  const [orderId, setOrderId] = useState<string>('#ORD-0001');
  const [discounts, setDiscounts] = useState<DiscountPreset[]>([]);
  const [appliedDiscount, setAppliedDiscount] = useState<DiscountPreset | null>(null);
  const [activeCoupon, setActiveCoupon] = useState<DiscountPreset | null>(null);
  const [couponDropdownOpen, setCouponDropdownOpen] = useState(false);
  const [customCouponInput, setCustomCouponInput] = useState('');
  const [couponSectionExpanded, setCouponSectionExpanded] = useState(true);
  const [paymentMethodSectionExpanded, setPaymentMethodSectionExpanded] = useState(true);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tables, setTables] = useState<string[]>([]);
  const [activeDineInSales, setActiveDineInSales] = useState<ActiveSale[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [activeModifierRowId, setActiveModifierRowId] = useState<string | null>(null);
  const [dineInTable, setDineInTable] = useState<string | null>(null);
  const [deliveryCustomerName, setDeliveryCustomerName] = useState('');
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  /** Table / delivery fields — collapsed by default to save vertical space */
  const [orderMetaSectionExpanded, setOrderMetaSectionExpanded] = useState(false);
  const [checkoutSubmitting, setCheckoutSubmitting] = useState(false);
  /** Set when resuming an open dine-in sale from Active Dine-in → Modify */
  const [editingOpenSaleId, setEditingOpenSaleId] = useState<number | null>(null);

  const ACTIVE_COUPON_STORAGE_KEY = 'pos_active_coupon';

  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;

  const fetchData = useCallback(async () => {
    setLoading(true);
    const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
    try {
      const [prodData, settingsData, invData, activeSalesData, modsData] = await Promise.all([
        get<{ products?: Product[] }>(`/menu-items/`),
        get<{ config?: Record<string, unknown> }>(`/settings/?branch_id=${activeBranchId}`),
        get<{ inventory?: Record<string, Record<string, number>> }>(`/stock/?branch_id=${activeBranchId}`),
        get<{ sales?: ActiveSale[] }>(`/orders/active?branch_id=${activeBranchId}`),
        get<{ modifiers?: Modifier[] }>(`/modifiers/`),
      ]);
      setProducts(prodData?.products ?? []);
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
      setDiscounts(rawDiscounts.filter(d => !d.archived));
      const tablesList = config?.tables;
      setTables(Array.isArray(tablesList) ? (tablesList as string[]) : []);
      setInventory(invData?.inventory ?? {});
      setActiveDineInSales(activeSalesData?.sales ?? []);
      setModifiers(modsData?.modifiers ?? []);

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
  }, [user?.branch_id]);

  useEffect(() => {
    setDineInTable(null);
    setDeliveryCustomerName('');
    setDeliveryPhone('');
    setDeliveryAddress('');
    setOrderMetaSectionExpanded(false);
    if (orderType !== 'dine_in') {
      setEditingOpenSaleId(null);
      editOrderLoadedRef.current = null;
    }
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
        if (d.status !== 'open' || d.order_type !== 'dine_in') {
          setNotification({ type: 'error', msg: 'This order cannot be edited here.' });
          setTimeout(() => setNotification(null), 4000);
          setSearchParams({}, { replace: true });
          return;
        }
        editOrderLoadedRef.current = num;
        setEditingOpenSaleId(num);
        setOrderType('dine_in');
        const table = d.order_snapshot?.table_name;
        if (table) setDineInTable(table);
        setOrderMetaSectionExpanded(true);
        setCart(
          (d.items || []).map(line => {
            const pid = line.product_id;
            const prod = products.find(p => p.id === pid);
            const variant = line.variant_sku_suffix || '';
            const uniqueId = variant ? `${pid}-${variant}` : `${pid}`;
            return {
              uniqueId,
              id: pid,
              title: line.product_title || prod?.title || 'Item',
              price: line.unit_price,
              quantity: line.quantity,
              image: prod ? getProductImageUrl(prod) : PRODUCT_PLACEHOLDER_IMAGE,
              variant: variant || undefined,
              modifiers: line.modifiers ?? [],
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
  }, [loading, searchParams, products, setSearchParams, editingOpenSaleId]);

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

  // Fetch products + sections on mount
  useEffect(() => {
    void fetchData();
    // Check printer status
    const checkPrinter = async () => {
      try {
        const data = await get<{ status?: string }>('/printer/status');
        setPrinterStatus(data?.status === 'connected' ? 'connected' : 'disconnected');
      } catch {
        setPrinterStatus('error');
      }
    };
    checkPrinter();
  }, [fetchData]);

  // Categories come from the sections defined in Settings
  const categories = ['All Items', ...sections];

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
    const variant = product.variants && product.variants.length > 0 ? product.variants[0] : undefined;
    const stockKey = variant || '';
    const stock = inventory[product.id.toString()]?.[stockKey] || 0;
    if (stock <= 0) return; // Prevent adding if out of stock
    handleAddToCart({
      id: product.id,
      title: product.title,
      price: product.base_price,
      image: getProductImageUrl(product),
      variant,
    });
  };

  const handleAddToCart = (product: { id: number; title: string; price: number; image: string; variant?: string }) => {
    setCart(prev => {
      const uniqueId = product.variant ? `${product.id}-${product.variant}` : `${product.id}`;
      const existing = prev.find(i => i.uniqueId === uniqueId);
      if (existing) {
        return prev.map(i => i.uniqueId === uniqueId ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, uniqueId, quantity: 1, modifiers: [] }];
    });
  };

  const handleChangeVariant = (uniqueId: string, newVariant: string) => {
    setCart(prev => {
      const target = prev.find(i => i.uniqueId === uniqueId);
      if (!target) return prev;
      const newUniqueId = `${target.id}-${newVariant}`;
      const existing = prev.find(i => i.uniqueId === newUniqueId);
      if (existing && existing.uniqueId !== uniqueId) {
        // Merge quantities
        return prev
          .map(i => i.uniqueId === newUniqueId ? { ...i, quantity: i.quantity + target.quantity } : i)
          .filter(i => i.uniqueId !== uniqueId);
      } else {
        // Just update variant and ID
        return prev.map(i => i.uniqueId === uniqueId ? { ...i, variant: newVariant, uniqueId: newUniqueId } : i);
      }
    });
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
    | { customer_name: string; phone: string; address: string };

  const submitCheckout = async (orderSnapshot: OrderSnapshotPayload | null) => {
    const items = cart.map(item => ({
      product_id: item.id,
      variant_sku_suffix: item.variant || '',
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
    }));

    setCheckoutSubmitting(true);
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const body: Record<string, unknown> = {
        payment_method: paymentMethod,
        items,
        branch_id: parseInt(activeBranchId, 10),
        discount: appliedDiscount ? { id: appliedDiscount.id, name: appliedDiscount.name, type: appliedDiscount.type, value: appliedDiscount.value } : null,
        order_type: orderType,
      };
      if (orderSnapshot) {
        body.order_snapshot = orderSnapshot;
      }
      const data = await post<{ sale_id?: number; total?: number; message?: string; print_success?: boolean }>('/orders/checkout', body);
      const saleId = data?.sale_id ?? 0;

      if (data.print_success === false) {
        setNotification({ type: 'error', msg: `Payment OK, but Printer Error — Order #ORD-${String(saleId).padStart(4, '0')}` });
      } else {
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
      setOrderMetaSectionExpanded(false);
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    } finally {
      setCheckoutSubmitting(false);
    }
  };

  const finalizeOpenOrder = async () => {
    if (!editingOpenSaleId || cart.length === 0 || checkoutSubmitting) return;
    const items = cart.map(item => ({
      product_id: item.id,
      variant_sku_suffix: item.variant || '',
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
    }));
    setCheckoutSubmitting(true);
    try {
      await patch(`/orders/${editingOpenSaleId}/items`, { items });
      const data = await post<{ sale_id?: number; print_success?: boolean }>(`/orders/${editingOpenSaleId}/finalize`, {
        payment_method: paymentMethod,
        discount: appliedDiscount
          ? { id: appliedDiscount.id, name: appliedDiscount.name, type: appliedDiscount.type, value: appliedDiscount.value }
          : null,
      });
      const saleId = data?.sale_id ?? editingOpenSaleId;
      if (data?.print_success === false) {
        setNotification({ type: 'error', msg: `Payment OK, but Printer Error — Order #ORD-${String(saleId).padStart(4, '0')}` });
      } else {
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
      setOrderMetaSectionExpanded(false);
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
      variant_sku_suffix: item.variant || '',
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
    }));
    setCheckoutSubmitting(true);
    try {
      await patch(`/orders/${editingOpenSaleId}/items`, { items });
      setNotification({ type: 'ok', msg: `Order #${editingOpenSaleId} updated — sent to kitchen` });
      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setEditingOpenSaleId(null);
      editOrderLoadedRef.current = null;
      fetchData();
      setDineInTable(null);
      setOrderMetaSectionExpanded(false);
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
    void submitDineInKot();
  };

  const submitDineInKot = async () => {
    const items = cart.map(item => ({
      product_id: item.id,
      variant_sku_suffix: item.variant || '',
      quantity: item.quantity,
      modifier_ids: (item.modifiers || []).map(m => m.id),
    }));
    setCheckoutSubmitting(true);
    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const data = await post<{ sale_id?: number; print_success?: boolean; message?: string }>('/orders/dine-in/kot', {
        items,
        branch_id: parseInt(activeBranchId, 10),
        order_type: 'dine_in',
        order_snapshot: { table_name: dineInTable },
      });
      const saleId = data?.sale_id ?? 0;
      if (data?.print_success === false) {
        setNotification({
          type: 'error',
          msg: `KOT saved (#${saleId}), but the kitchen printer reported an error.`,
        });
      } else {
        setNotification({ type: 'ok', msg: `Kitchen order sent — tab #${saleId} (table ${dineInTable})` });
      }
      setTimeout(() => setNotification(null), 4000);
      setCart([]);
      setOrderId(`#ORD-${String(saleId + 1).padStart(4, '0')}`);
      fetchData();
      setDineInTable(null);
      setOrderMetaSectionExpanded(false);
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
      void submitCheckout({ customer_name: name, phone, address });
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

  const getActiveBranchId = () => localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';

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
  const discountedSubtotal = subtotal - discountAmount;
  const taxPct = taxEnabled ? (taxRatesByPaymentMethod[paymentMethod] ?? 0) : 0;
  const taxRate = taxPct / 100;
  const tax = discountedSubtotal * taxRate;
  const total = discountedSubtotal + tax;

  const filteredProducts = products.filter(p => {
    const matchesCategory = activeCategory === 'All Items' || p.section === activeCategory;
    const matchesSearch = p.title.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const orderDateStr = currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const orderTimeStr = currentDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

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

  useEffect(() => {
    const s = getSocket();
    const onAny = () => void fetchData();
    s.on('ORDER_CREATED', onAny);
    s.on('ORDER_UPDATED', onAny);
    s.on('ORDER_STATUS_CHANGED', onAny);
    return () => {
      s.off('ORDER_CREATED', onAny);
      s.off('ORDER_UPDATED', onAny);
      s.off('ORDER_STATUS_CHANGED', onAny);
    };
  }, [fetchData]);

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
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 rounded-xl shadow-lg text-sm font-semibold transition-all ${
          notification.type === 'ok'
            ? 'bg-brand-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {notification.msg}
        </div>
      )}

      {/* =========================================
          LEFT PANEL: CART (25-30% width on lg)
          ========================================= */}
      <div className="w-full lg:w-[min(340px,28vw)] xl:w-[360px] border-b lg:border-b-0 lg:border-r border-white/20 flex flex-col shrink-0 min-h-0 bg-white/10 backdrop-blur-md z-10 order-2 lg:order-1">
        
        {/* Cart Header */}
        <div className="p-4 lg:p-5 border-b border-white/20 shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-neutral-900 tracking-tight">Current Order</h2>
            {editingOpenSaleId && (
              <span className="text-[10px] font-bold text-amber-900 bg-amber-100 border border-amber-300 px-2.5 py-1 rounded-lg shadow-sm">
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
              return (
              <div key={item.uniqueId + "-" + index} className="flex flex-col gap-2 p-3 glass-card relative group shadow-sm transition-shadow bg-white/60 hover:bg-white/80 border border-white/50">
                
                {/* Main Item Row */}
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center overflow-hidden shrink-0 border border-white/30">
                    <img src={item.image} alt="" className="w-full h-full object-cover" />
                  </div>
                  
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex justify-between items-start gap-2">
                      <p className="text-sm font-bold text-neutral-800 leading-tight pr-6">{item.title}</p>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.uniqueId); }} className="absolute top-2 right-2 p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-50 transition-colors" aria-label="Remove line">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Inline Variant Dropdown */}
                    {hasVariants ? (
                      <div className="mt-1">
                        <select
                          value={item.variant || ''}
                          onChange={(e) => handleChangeVariant(item.uniqueId, e.target.value)}
                          className="text-xs font-bold text-neutral-700 bg-white/80 border border-white/60 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-brand-500 max-w-full shadow-sm"
                        >
                          {(baseProd?.variants || []).map((v: string) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </div>
                    ) : item.variant ? (
                      <span className="inline-block mt-0.5 px-1.5 py-0.5 bg-neutral-200/80 text-neutral-700 text-[10px] font-bold rounded">
                        {item.variant}
                      </span>
                    ) : null}

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
                    {(item.modifiers || []).map((m: any) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 text-[11px] font-semibold text-neutral-600 bg-white/70 border border-white/80 px-2 py-1.5 rounded-md shadow-sm">
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
                    <div className="p-2.5 bg-brand-50/80 border border-brand-200/60 rounded-lg shadow-inner">
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
                                className="px-2.5 py-1.5 rounded-lg shadow-sm text-[11px] font-bold border transition-colors bg-white hover:bg-brand-100 hover:border-brand-300 border-neutral-200 text-neutral-700 active:scale-95 flex items-center gap-1"
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
                    <button type="button" onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, -1); }} className="w-7 h-7 rounded-lg bg-white/80 hover:bg-white flex items-center justify-center transition-all border border-black/10 shadow-sm active:scale-95">
                      <Minus className="w-3.5 h-3.5 text-neutral-700" />
                    </button>
                    <span className="text-sm font-black text-neutral-800 w-6 text-center tabular-nums">{item.quantity}</span>
                    <button type="button" onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, 1); }} className="w-7 h-7 rounded-lg bg-brand-600 hover:bg-brand-500 flex items-center justify-center transition-all shadow-md shadow-brand-500/20 active:scale-95">
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
      </div>

      {/* =========================================
          CENTER PANEL: MENU (45-50% width)
          ========================================= */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden order-1 lg:order-2">
        <div className="page-padding pb-0 pt-4 lg:pt-5">
          <div className="flex items-center justify-between mb-4 lg:mb-5">
            <div>
              <h1 className="text-2xl xl:text-3xl font-black text-neutral-900 tracking-tight">Menu</h1>
            </div>
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold shadow-sm ${scannerStatus === 'active' ? 'bg-brand-100 text-brand-800 border border-brand-300' : scannerStatus === 'idle' ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-neutral-100 text-neutral-600 border border-neutral-300'}`}>
                <Usb className="w-4 h-4" />
                <span className="hidden sm:inline">{scannerStatus === 'active' ? 'Scanner Active' : scannerStatus === 'idle' ? 'Scanner Idle' : 'Scanner Waiting'}</span>
              </div>
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold shadow-sm ${printerStatus === 'connected' ? 'bg-brand-100 text-brand-800 border border-brand-300' : printerStatus === 'checking' ? 'bg-neutral-100 text-neutral-600 border border-neutral-300' : 'bg-red-100 text-red-700 border border-red-300'}`}>
                <Printer className="w-4 h-4" />
                <span className="hidden sm:inline">{printerStatus === 'connected' ? 'Printer Ready' : printerStatus === 'checking' ? 'Checking…' : 'Printer Offline'}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 mb-5">
            <div className="relative flex-1 min-w-0">
              <Search className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 w-5 h-5 text-neutral-400" aria-hidden />
              <input type="text" inputMode="search" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search menu items..." className="w-full min-h-[48px] pl-12 pr-4 py-2.5 glass-card bg-white/70 text-sm font-medium focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-all shadow-sm rounded-xl border border-white/60" />
            </div>
            <button onClick={() => setLayoutView(prev => prev === 'grid' ? 'list' : 'grid')} className="w-12 h-12 shrink-0 flex items-center justify-center glass-card bg-white/70 hover:bg-white border text-neutral-600 border-white/60 rounded-xl transition-all shadow-sm active:scale-95" type="button">
              {layoutView === 'grid' ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-brand-200/40 overflow-x-auto no-scrollbar pb-1 -mx-2 px-2">
            {categories.map(cat => (
              <button key={cat} type="button" onClick={() => setActiveCategory(cat)} className={`px-5 py-2.5 rounded-full text-sm font-bold whitespace-nowrap transition-all active:scale-95 ${activeCategory === cat ? 'bg-brand-600 text-white shadow-md shadow-brand-500/20' : 'bg-white/50 text-neutral-600 hover:bg-white/80 hover:text-neutral-900 border border-transparent hover:border-white/60'}`}>
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
            <div className={layoutView === 'grid' ? "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] tap-highlight-transparent gap-5 lg:gap-6 pb-20 lg:pb-6 w-full" : "flex flex-col gap-4 pb-20 lg:pb-6 w-full"}>
              {filteredProducts.map(product => {
                const stockQty = (!product.variants || product.variants.length === 0) ? (inventory[product.id.toString()]?.[''] || 0) : 1; 
                const isOutOfStock = stockQty <= 0;
                return (
                <button
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className={`glass-card bg-white/80 overflow-hidden w-full transition-all duration-200 group text-left border border-white/50 shadow-sm ${layoutView === 'grid' ? 'flex flex-col rounded-xl min-h-[220px]' : 'flex items-center p-4 lg:p-5 rounded-xl'} ${isOutOfStock ? 'opacity-50 grayscale cursor-not-allowed border-neutral-200/50' : 'hover:shadow-md hover:border-brand-300 hover:bg-white hover:scale-[1.02] active:scale-[0.98]'}`}
                >
                  <div className={`${layoutView === 'grid' ? 'w-full h-36 shrink-0' : 'w-24 h-24 shrink-0 rounded-lg'} flex items-center justify-center overflow-hidden transition-colors relative ${isOutOfStock ? 'bg-neutral-100/50' : 'bg-gradient-to-br from-brand-50/40 to-brand-100/40 group-hover:from-brand-100/50 group-hover:to-brand-200/50'}`}>
                    <img src={getProductImageUrl(product)} alt="" className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-brand-900/0 group-hover:bg-brand-900/5 transition-colors duration-300" />
                  </div>
                  <div className={layoutView === 'grid' ? "p-4 flex-1 flex flex-col justify-between gap-1 w-full" : "ml-5 flex-1 min-w-0 flex flex-col justify-center gap-1"}>
                    <p className="text-lg font-semibold text-neutral-800 leading-tight line-clamp-2">{product.title}</p>
                    <div className="flex items-center justify-between gap-2 mt-auto pt-2">
                      <p className="text-xl font-bold text-brand-700 whitespace-nowrap">{formatCurrency(product.base_price)}</p>
                      {isOutOfStock ? (
                         <span className="text-[10px] font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded border border-red-200 uppercase whitespace-nowrap shadow-sm">Out of Stock</span>
                      ) : product.section ? (
                         <span className="text-[10px] font-bold text-brand-700 bg-brand-100 px-2 py-0.5 rounded border border-brand-200 truncate min-w-0 shadow-sm">{product.section}</span>
                      ) : null}
                    </div>
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
        <div className="fixed inset-0 bg-neutral-900/50 backdrop-blur-md z-[60] lg:hidden transition-opacity" onClick={() => setIsRightPanelOpen(false)} aria-hidden />
      )}

      <div className={`fixed inset-y-0 right-0 z-[70] w-[min(400px,90vw)] lg:static lg:w-[min(380px,28vw)] xl:w-[min(420px,30vw)] transform transition-transform duration-300 ${isRightPanelOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'} border-l border-white/20 bg-neutral-50/95 lg:bg-white/10 backdrop-blur-xl flex flex-col shrink-0 min-h-0 order-3 shadow-2xl lg:shadow-none`}>
        
        {/* Drawer Header (Mobile only) */}
        <div className="p-4 flex items-center justify-between lg:hidden border-b border-black/5 bg-white/50">
          <h2 className="text-xl font-black text-neutral-900 tracking-tight">Checkout Summary</h2>
          <button onClick={() => setIsRightPanelOpen(false)} className="w-9 h-9 flex items-center justify-center rounded-full bg-neutral-200/70 hover:bg-neutral-300 text-neutral-700 transition-colors shadow-sm">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 lg:p-5 space-y-4 lg:space-y-6">
          
          {/* SECTION 1: ORDER INFO */}
          <div className="glass-card p-4 rounded-xl shadow-sm border border-white/60 bg-white/70">
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
                    onClick={() => setOrderType(id)}
                    className={`min-h-[48px] py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-95 ${
                      selected
                        ? 'bg-brand-50 border-brand-500 text-brand-800 shadow-md shadow-brand-500/10'
                        : 'bg-white/60 border-transparent hover:border-brand-300 text-neutral-600 hover:bg-white shadow-sm'
                    }`}
                  >
                    <Icon className="w-4.5 h-4.5 shrink-0" strokeWidth={selected ? 2.25 : 1.75} />
                    <span className="text-[10px] font-bold leading-tight text-center px-0.5">{label}</span>
                  </button>
                );
              })}
            </div>

            {/* Table / Delivery Selection conditional */}
            {(orderType === 'dine_in' || orderType === 'delivery') && (
              <div className="mt-4 pt-4 border-t border-black/10">
                <button
                  type="button"
                  onClick={() => setOrderMetaSectionExpanded(prev => !prev)}
                  className="w-full flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 rounded-lg hover:bg-white/60 text-left transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-neutral-800">
                      {orderType === 'dine_in' ? 'Table Selection' : 'Delivery Details'}
                    </span>
                    {!orderMetaSectionExpanded && (
                      <span className="block text-[11px] font-bold text-neutral-500 truncate mt-0.5 opacity-80">
                        {orderType === 'dine_in'
                          ? dineInTable
                            ? `Selected · ${dineInTable}`
                            : 'Tap to choose table'
                          : deliveryCustomerName.trim() || deliveryPhone.trim() || deliveryAddress.trim()
                            ? [deliveryCustomerName.trim(), deliveryPhone.trim()].filter(Boolean).join(' · ') || '…'
                            : 'Tap to enter name, phone & address'}
                      </span>
                    )}
                  </span>
                  {orderMetaSectionExpanded ? <ChevronDown className="w-4.5 h-4.5 shrink-0 text-neutral-500 bg-white/50 rounded-full p-0.5" /> : <ChevronRight className="w-4.5 h-4.5 shrink-0 text-neutral-500 bg-white/50 rounded-full p-0.5" />}
                </button>

                {orderMetaSectionExpanded && orderType === 'dine_in' && (
                  <div className="mt-3">
                    {tables.length === 0 ? (
                      <p className="text-xs text-amber-800 bg-amber-50/90 border border-amber-200/80 rounded-lg px-3 py-2 font-medium">
                        No tables registered. Add names under Settings → Tables.
                      </p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 max-h-[min(12rem,30vh)] overflow-y-auto pr-1">
                        {freeTables.map(t => {
                          const selected = dineInTable === t;
                          return (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setDineInTable(t)}
                              className={`py-2.5 rounded-xl text-xs font-bold border-2 transition-all active:scale-95 shadow-sm text-center ${
                                selected
                                  ? 'border-brand-500 bg-brand-500 text-white shadow-brand-500/30'
                                  : 'border-white/80 bg-white text-neutral-700 hover:border-brand-300 hover:bg-brand-50'
                              }`}
                            >
                              {t}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {orderMetaSectionExpanded && orderType === 'delivery' && (
                  <div className="mt-3 space-y-2.5">
                    <input type="text" value={deliveryCustomerName} onChange={e => setDeliveryCustomerName(e.target.value)} placeholder="Customer name" className="w-full px-3.5 py-3 rounded-xl border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all shadow-sm" />
                    <input type="tel" value={deliveryPhone} onChange={e => setDeliveryPhone(e.target.value)} placeholder="Phone number" className="w-full px-3.5 py-3 rounded-xl border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 transition-all shadow-sm" />
                    <textarea value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} placeholder="Delivery address" rows={2} className="w-full px-3.5 py-3 rounded-xl border border-white/80 bg-white text-sm font-semibold text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y min-h-[80px] transition-all shadow-sm" />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SECTION 2: PAYMENT INFO */}
          <div className="glass-card p-4 rounded-xl shadow-sm border border-white/60 bg-white/70 space-y-4">
            
            {/* Coupon / Discount */}
            <div className="relative">
              <button type="button" onClick={() => setCouponSectionExpanded(prev => !prev)} className="w-full flex items-center justify-between gap-2 py-1 px-1 -mx-1 rounded-lg hover:bg-white/60 text-left transition-colors">
                <h3 className="text-sm font-black text-neutral-800 tracking-wide">DISCOUNT</h3>
                {couponSectionExpanded ? <ChevronDown className="w-4.5 h-4.5 shrink-0 text-neutral-500" /> : <ChevronRight className="w-4.5 h-4.5 shrink-0 text-neutral-500" />}
              </button>
              
              {couponSectionExpanded && (
              <div className="relative mt-3">
                <button type="button" onClick={() => setCouponDropdownOpen(prev => !prev)} className={`w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl border-2 text-left text-sm font-bold transition-all shadow-sm ${appliedDiscount ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-neutral-200/80 bg-white hover:border-brand-300 text-neutral-600'}`}>
                  <span className="flex items-center gap-2.5"><Tag className="w-4.5 h-4.5 text-neutral-500" />{appliedDiscount ? `${appliedDiscount.name} (${appliedDiscount.type === 'percent' ? `${appliedDiscount.value}%` : formatCurrency(appliedDiscount.value)})` : 'Apply coupon ticket'}</span>
                  <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${couponDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {couponDropdownOpen && (
                  <div className="absolute top-[calc(100%+4px)] left-0 right-0 py-1.5 glass-floating bg-white/95 backdrop-blur-xl border border-neutral-200 rounded-xl shadow-xl z-10 max-h-60 overflow-auto">
                    <button type="button" onClick={() => { setAppliedDiscount(null); setCouponDropdownOpen(false); }} className="w-full px-4 py-3 text-left text-sm font-bold text-neutral-600 hover:bg-neutral-50 transition-colors">No discount</button>
                    <div className="px-3 py-2.5 border-t border-neutral-100 bg-neutral-50/50">
                      <p className="text-[11px] font-bold text-neutral-500 uppercase tracking-wide mb-2 pl-1">Custom Amount</p>
                      <div className="flex gap-2">
                        <input type="text" value={customCouponInput} onChange={e => setCustomCouponInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyCustomCoupon()} placeholder="e.g. 500 or 10%" className="flex-1 px-3.5 py-2.5 bg-white border border-neutral-200 rounded-lg text-sm font-semibold focus:ring-2 focus:ring-brand-500 focus:outline-none shadow-sm" />
                        <button type="button" onClick={applyCustomCoupon} disabled={!customCouponInput.trim()} className="px-4 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-bold hover:bg-brand-700 disabled:opacity-50 shadow-sm active:scale-95 transition-all">Apply</button>
                      </div>
                    </div>
                    {discounts.length > 0 && <div className="h-px bg-neutral-100 my-1" />}
                    {discounts.map(d => (
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
                  <button type="button" onClick={activateCouponForAllOrders} className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border transition-all shadow-sm ${activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300'}`}>
                    <CheckCircle className="w-3.5 h-3.5" /> {activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value ? 'Active for all orders' : 'Activate for all orders'}
                  </button>
                  {activeCoupon && (
                    <button type="button" onClick={deactivateCouponForAllOrders} className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-neutral-200 bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:border-neutral-300 transition-all shadow-sm">
                      <XCircle className="w-3.5 h-3.5" /> Mark inactive
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Payment Method */}
            <div className="border-t border-black/10 pt-4 mt-4">
              <button type="button" onClick={() => setPaymentMethodSectionExpanded(prev => !prev)} className="w-full flex items-center justify-between gap-2 py-1 px-1 -mx-1 rounded-lg hover:bg-white/60 text-left transition-colors">
                <h3 className="text-sm font-black text-neutral-800 tracking-wide">PAYMENT METHOD</h3>
                {paymentMethodSectionExpanded ? <ChevronDown className="w-4.5 h-4.5 shrink-0 text-neutral-500" /> : <ChevronRight className="w-4.5 h-4.5 shrink-0 text-neutral-500" />}
              </button>
              {paymentMethodSectionExpanded && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(['Cash','Card','Online Transfer'] as const).map(pm => (
                  <button key={pm} type="button" onClick={() => setPaymentMethod(pm)} className={`py-3 px-1 flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 transition-all active:scale-95 shadow-sm ${paymentMethod === pm ? 'bg-brand-50 border-brand-500 text-brand-800 shadow-brand-500/10' : 'bg-white/80 border-transparent hover:border-brand-300 text-neutral-600 hover:bg-white'}`}>
                    {pm === 'Cash' ? <Banknote className="w-5 h-5" /> : pm === 'Card' ? <CreditCard className="w-5 h-5" /> : <Smartphone className="w-5 h-5" />}
                    <span className="text-[10px] font-bold tracking-wide uppercase">{pm === 'Online Transfer' ? 'Online' : pm}</span>
                  </button>
                ))}
              </div>
              )}
            </div>
          </div>
        </div>

        {/* SECTION 3: SUMMARY & BUTTONS */}
        <div className="p-4 lg:p-5 border-t border-black/10 bg-white/70 backdrop-blur-2xl shrink-0 shadow-[0_-4px_24px_-12px_rgba(0,0,0,0.1)]">
          <div className="space-y-2 mb-5 px-1">
            <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
              <span>Subtotal</span>
              <span className="text-neutral-800">{formatCurrency(subtotal)}</span>
            </div>
            {appliedDiscount && discountAmount > 0 && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Discount <span className="opacity-70">({appliedDiscount.name})</span></span>
                <span className="text-red-500">-{formatCurrency(discountAmount)}</span>
              </div>
            )}
            {taxEnabled && (
              <div className="flex justify-between items-center text-[13px] font-bold text-neutral-500">
                <span>Tax</span>
                <span className="text-neutral-800">{formatCurrency(tax)}</span>
              </div>
            )}
            <div className="h-px bg-black/10 my-3" />
            <div className="flex justify-between items-end">
              <span className="text-base font-black text-neutral-800 tracking-tight">TOTAL</span>
              <span className="text-[32px] leading-none font-black text-brand-700 tracking-tight">{formatCurrency(total)}</span>
            </div>
          </div>

          {orderType === 'dine_in' && !editingOpenSaleId ? (
            <div className="grid grid-cols-1 gap-2.5">
              <button onClick={handleGenerateKot} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-white border-2 border-brand-600 text-brand-800 hover:bg-brand-50 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed py-4 rounded-xl font-bold text-[15px] transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm">
                <ClipboardList className="w-5 h-5" /> {checkoutSubmitting ? 'Working…' : 'Generate KOT'}
              </button>
              <button onClick={handleCheckout} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-4 rounded-xl font-bold text-[15px] shadow-lg shadow-brand-900/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2">
                <ShoppingBag className="w-5 h-5" /> {checkoutSubmitting ? 'Processing…' : 'Proceed payment'}
              </button>
            </div>
          ) : editingOpenSaleId ? (
            <div className="grid grid-cols-1 gap-2.5">
              <button type="button" onClick={submitUpdateOrder} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-white border-2 border-amber-500 text-amber-800 hover:bg-amber-50 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed py-4 rounded-xl font-bold text-[15px] transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-sm">
                <ClipboardList className="w-5 h-5" /> {checkoutSubmitting ? 'Working…' : 'Update Order'}
              </button>
              <button type="button" onClick={handleCheckout} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-4 rounded-xl font-bold text-[15px] shadow-lg shadow-brand-900/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2">
                <ShoppingBag className="w-5 h-5" /> {checkoutSubmitting ? 'Processing…' : 'Proceed payment'}
              </button>
            </div>
          ) : (
            <button onClick={handleCheckout} disabled={cart.length === 0 || checkoutSubmitting} className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-4 rounded-2xl font-black text-lg shadow-lg shadow-brand-900/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 tracking-wide">
              <ShoppingBag className="w-5 h-5" /> {checkoutSubmitting ? 'Processing…' : 'PAY & PRINT'}
            </button>
          )}
        </div>

      </div>

      {/* Mobile Checkout Drawer Toggle (Visible only on lg and down) */}
      <div className="lg:hidden fixed bottom-5 right-5 z-[55]">
        {!isRightPanelOpen && (
          <button onClick={() => setIsRightPanelOpen(true)} className="bg-brand-600 text-white px-7 py-4 rounded-full font-black text-[15px] tracking-wide shadow-xl shadow-brand-900/40 flex items-center gap-2 hover:bg-brand-700 active:scale-95 transition-all outline-none focus:ring-4 focus:ring-brand-500/30">
            <ShoppingBag className="w-5 h-5"/> Checkout <span className="opacity-60 mx-1.5 font-normal">|</span> {formatCurrency(total)}
          </button>
        )}
      </div>

    </div>
  );
}
