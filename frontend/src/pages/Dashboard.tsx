import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useScanner } from '../hooks/useScanner';
import { ShoppingBag, Plus, Minus, Trash2, Search, Loader2, CreditCard, Banknote, Smartphone, LayoutGrid, List, X, Printer, Usb, Tag, ChevronDown, ChevronRight, CheckCircle, XCircle, Package, UtensilsCrossed, Truck, ClipboardList } from 'lucide-react';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, patch, getUserMessage } from '../api';

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
};

type OrderDetailResponse = {
  id: number;
  status?: string;
  order_type?: string | null;
  order_snapshot?: { table_name?: string } | null;
  items?: OrderDetailLine[];
};

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
  const [productForVariants, setProductForVariants] = useState<Product | null>(null);
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
  const [couponSectionExpanded, setCouponSectionExpanded] = useState(false);
  const [paymentMethodSectionExpanded, setPaymentMethodSectionExpanded] = useState(false);
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [tables, setTables] = useState<string[]>([]);
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

  const fetchData = async () => {
    setLoading(true);
    const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
    try {
      const [prodData, settingsData, invData] = await Promise.all([
        get<{ products?: Product[] }>(`/menu-items/`),
        get<{ config?: Record<string, unknown> }>(`/settings/?branch_id=${activeBranchId}`),
        get<{ inventory?: Record<string, Record<string, number>> }>(`/stock/?branch_id=${activeBranchId}`),
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
  };

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
    fetchData();
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
  }, []);

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
    if (product.variants && product.variants.length > 0) {
      setProductForVariants(product);
    } else {
      const stock = inventory[product.id.toString()]?.[''] || 0;
      if (stock <= 0) return; // Prevent adding if out of stock
      handleAddToCart({
        id: product.id,
        title: product.title,
        price: product.base_price,
        image: getProductImageUrl(product),
      });
    }
  };

  const handleAddToCart = (product: { id: number; title: string; price: number; image: string; variant?: string }) => {
    setCart(prev => {
      const uniqueId = product.variant ? `${product.id}-${product.variant}` : `${product.id}`;
      const existing = prev.find(i => i.uniqueId === uniqueId);
      if (existing) {
        return prev.map(i => i.uniqueId === uniqueId ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { ...product, uniqueId, quantity: 1 }];
    });
    setProductForVariants(null);
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
      quantity: item.quantity
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

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
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

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0 bg-transparent">

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-semibold transition-all ${
          notification.type === 'ok'
            ? 'bg-brand-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {notification.msg}
        </div>
      )}
      
      {/* Menu + search (tablet-first two-pane starts at lg) */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden order-1">
        {/* Header */}
        <div className="page-padding pb-0">
          <div className="flex items-center justify-between mb-4 lg:mb-5">
            <div>
              <h1 className="text-2xl xl:text-3xl font-bold text-neutral-900">Order</h1>
            </div>
            <div className="flex items-center gap-2">
              {/* Scanner Status */}
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                scannerStatus === 'active'
                  ? 'bg-brand-50 text-brand-700 border border-brand-200'
                  : scannerStatus === 'idle'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-neutral-100 text-neutral-500 border border-neutral-200'
              }`}>
                <Usb className="w-3.5 h-3.5" />
                {scannerStatus === 'active' ? 'Scanner Active' : scannerStatus === 'idle' ? 'Scanner Idle' : 'Scanner Waiting'}
              </div>
              {/* Printer Status */}
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                printerStatus === 'connected'
                  ? 'bg-brand-50 text-brand-700 border border-brand-200'
                  : printerStatus === 'checking'
                  ? 'bg-neutral-100 text-neutral-500 border border-neutral-200'
                  : 'bg-red-50 text-red-600 border border-red-200'
              }`}>
                <Printer className="w-3.5 h-3.5" />
                {printerStatus === 'connected' ? 'Printer Ready' : printerStatus === 'checking' ? 'Checking…' : 'Printer Offline'}
              </div>
            </div>
          </div>

          {/* Search Bar */}
          <div className="flex items-center gap-3 mb-4 lg:mb-5">
            <div className="relative flex-1 min-w-0">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 w-4.5 h-4.5 text-neutral-400"
                aria-hidden
              />
              <input 
                type="text"
                inputMode="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search menu"
                className="w-full min-h-[44px] pl-11 pr-4 py-2.5 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-shadow"
              />
            </div>
            <button 
              onClick={() => setLayoutView(prev => prev === 'grid' ? 'list' : 'grid')}
              className="touch-target shrink-0 flex items-center justify-center glass-card hover:bg-white/40 transition-colors"
              title="Toggle Layout"
              type="button"
            >
              {layoutView === 'grid' ? <List className="w-4.5 h-4.5 text-neutral-500" /> : <LayoutGrid className="w-4.5 h-4.5 text-neutral-500" />}
            </button>
          </div>

          {/* Category tabs — from Settings → Categories (brand palette matches rail / header) */}
          <div className="flex items-center gap-1 border-b border-brand-200/45 overflow-x-auto no-scrollbar pb-px -mx-1 px-1">
            {categories.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={`min-h-[44px] px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeCategory === cat
                    ? 'border-brand-500 text-brand-800 font-semibold'
                    : 'border-transparent text-brand-700/75 hover:text-brand-900'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Menu grid */}
        <div className="flex-1 min-h-0 overflow-auto page-padding pt-0">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-neutral-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading menu…
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-20 text-neutral-400">
              <p className="text-lg font-medium">No menu items found</p>
              <p className="text-sm mt-1">Add items in the Stock page.</p>
            </div>
          ) : (
            <div className={layoutView === 'grid' ? "grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 lg:gap-4 xl:gap-5" : "flex flex-col gap-3"}>
              {filteredProducts.map(product => (
                <button
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className={`glass-card overflow-hidden transition-all duration-200 group text-left ${
                    layoutView === 'grid' ? 'flex flex-col' : 'flex items-center p-3'
                  } ${
                    (!product.variants || product.variants.length === 0) && (inventory[product.id.toString()]?.[''] || 0) <= 0
                      ? 'opacity-50 grayscale cursor-not-allowed border-neutral-200/50'
                      : 'hover:shadow-md hover:border-white/60 active:scale-[0.97]'
                  }`}
                >
                  {/* Product Image Area — aspect-square so size scales with card width (responsive), consistent across all cards */}
                  <div className={`${layoutView === 'grid' ? 'w-full aspect-square shrink-0' : 'w-16 h-16 shrink-0 rounded-lg'} flex items-center justify-center overflow-hidden transition-colors ${
                    (!product.variants || product.variants.length === 0) && (inventory[product.id.toString()]?.[''] || 0) <= 0
                      ? 'bg-neutral-100/50'
                      : 'bg-gradient-to-br from-brand-50/40 to-brand-100/40 group-hover:from-brand-100/50 group-hover:to-brand-200/50'
                  }`}>
                    <img
                      src={getProductImageUrl(product)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  {/* Product Info */}
                  <div className={layoutView === 'grid' ? "p-3.5" : "ml-4 flex-1 min-w-0"}>
                    <p className="text-sm font-medium text-neutral-800 truncate">{product.title}</p>
                    <div className="flex items-center justify-between gap-2 mt-1 min-h-6">
                      <p className="text-base font-bold text-gold-600 whitespace-nowrap flex-shrink-0">{formatCurrency(product.base_price)}</p>
                      {(!product.variants || product.variants.length === 0) && (inventory[product.id.toString()]?.[''] || 0) <= 0 ? (
                        <span className="text-[10px] font-bold text-red-600 bg-red-50 px-1.5 py-0.5 rounded border border-red-100 uppercase flex-shrink-0">
                          Out of Stock
                        </span>
                      ) : product.section ? (
                        <span className="text-[10px] font-semibold text-brand-600 bg-brand-50 px-1.5 py-0.5 rounded border border-brand-100 truncate min-w-0">
                          {product.section}
                        </span>
                      ) : (
                        <span className="flex-shrink-0 w-0 h-0 overflow-hidden" aria-hidden> </span>
                      )}
                    </div>
                    {product.variants && product.variants.length > 0 && layoutView === 'grid' && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {product.variants.map(v => (
                          <span key={v} className="text-[10px] px-1.5 py-0.5 bg-neutral-100 text-neutral-500 rounded border border-neutral-200">
                            {v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Order pane — full width stacked below lg; fixed width at xl+ desktop variant */}
      <div className="w-full lg:w-[min(380px,42vw)] xl:w-[400px] xl:max-w-[min(440px,34vw)] border-t border-white/30 lg:border-t-0 lg:border-l flex flex-col shrink-0 min-h-0 max-h-[45vh] lg:max-h-none order-2 lg:order-none bg-white/10 backdrop-blur-md">
        {/* Order Header */}
        <div className="p-4 lg:p-5 border-b border-white/20 shrink-0">
          <div className="flex items-center justify-between mb-1 gap-2">
            <h2 className="text-lg font-bold text-neutral-900">Current Order</h2>
            <div className="flex flex-col items-end gap-1 shrink-0">
              {editingOpenSaleId != null && (
                <span className="text-[10px] font-bold text-amber-900 bg-amber-100 border border-amber-300/80 px-2 py-0.5 rounded-lg">
                  Open tab #{editingOpenSaleId}
                </span>
              )}
              <span className="text-xs text-neutral-400 font-mono">{orderId}</span>
            </div>
          </div>
          <p className="text-xs text-neutral-400 font-medium">{orderDateStr} &bull; {orderTimeStr}</p>

          <div className="mt-3">
            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wide mb-2">Order type</p>
            <div
              className="grid grid-cols-3 gap-1.5"
              role="radiogroup"
              aria-label="Order type"
            >
              {ORDER_TYPE_OPTIONS.map(({ id, label, Icon }) => {
                const selected = orderType === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setOrderType(id)}
                    className={`min-h-[44px] py-2 px-1 flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 transition-all active:scale-[0.98] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${
                      selected
                        ? 'glass-card border-brand-500 text-brand-800'
                        : 'glass-card border-transparent hover:border-brand-300 text-neutral-500'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" strokeWidth={selected ? 2.25 : 1.75} />
                    <span className="text-[10px] font-bold leading-tight text-center px-0.5">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {(orderType === 'dine_in' || orderType === 'delivery') && (
            <div className="mt-3 pt-3 border-t border-white/20">
              <button
                type="button"
                onClick={() => setOrderMetaSectionExpanded(prev => !prev)}
                className="w-full flex items-center justify-between gap-2 py-1 -mx-1 rounded-lg hover:bg-neutral-100/80 text-left"
                aria-expanded={orderMetaSectionExpanded}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-neutral-800">
                    {orderType === 'dine_in' ? 'Table' : 'Delivery details'}
                  </span>
                  {!orderMetaSectionExpanded && (
                    <span className="block text-xs text-neutral-500 truncate mt-0.5">
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
                {orderMetaSectionExpanded ? (
                  <ChevronDown className="w-4 h-4 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronRight className="w-4 h-4 shrink-0 text-neutral-500" />
                )}
              </button>

              {orderMetaSectionExpanded && orderType === 'dine_in' && (
                <div className="mt-2">
                  {tables.length === 0 ? (
                    <p className="text-xs text-amber-800 bg-amber-50/90 border border-amber-200/80 rounded-lg px-3 py-2">
                      No tables registered. Add names under Settings → Tables.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 max-h-[min(7rem,30vh)] overflow-y-auto pr-0.5">
                      {tables.map(t => {
                        const selected = dineInTable === t;
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setDineInTable(t)}
                            className={`min-h-[40px] px-3 py-2 rounded-xl text-xs font-bold border-2 transition-all active:scale-[0.98] ${
                              selected
                                ? 'border-brand-500 bg-brand-50/90 text-brand-900 shadow-sm'
                                : 'border-white/35 bg-white/15 text-neutral-700 hover:border-brand-300'
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
                <div className="mt-2 space-y-2">
                  <input
                    type="text"
                    value={deliveryCustomerName}
                    onChange={e => setDeliveryCustomerName(e.target.value)}
                    placeholder="Customer name"
                    autoComplete="name"
                    className="w-full px-3 py-2.5 rounded-xl border border-white/35 bg-white/20 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <input
                    type="tel"
                    value={deliveryPhone}
                    onChange={e => setDeliveryPhone(e.target.value)}
                    placeholder="Phone number"
                    autoComplete="tel"
                    className="w-full px-3 py-2.5 rounded-xl border border-white/35 bg-white/20 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <textarea
                    value={deliveryAddress}
                    onChange={e => setDeliveryAddress(e.target.value)}
                    placeholder="Delivery address"
                    rows={2}
                    autoComplete="street-address"
                    className="w-full px-3 py-2.5 rounded-xl border border-white/35 bg-white/20 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y min-h-[72px]"
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cart Items */}
        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-400">
              <ShoppingBag className="w-16 h-16 mb-3 stroke-1 opacity-50" />
              <p className="text-sm font-medium">No items yet</p>
              <p className="text-xs mt-1 opacity-70">Tap an item to add it</p>
            </div>
          ) : (
            cart.map(item => (
              <div key={item.uniqueId} className="flex items-start gap-3 p-3 glass-card">
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded-lg bg-white/20 flex items-center justify-center overflow-hidden shrink-0 border border-white/30">
                  <img src={item.image} alt="" className="w-full h-full object-cover" />
                </div>
                {/* Item Details */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-800 truncate">{item.title}</p>
                  {item.variant && (
                    <span className="inline-block mt-0.5 px-1.5 py-0.5 bg-neutral-200 text-neutral-700 text-[10px] font-bold rounded">
                      {item.variant}
                    </span>
                  )}
                  <p className="text-sm font-bold text-gold-600 mt-0.5">{formatCurrency(item.price)}</p>
                  {/* Quantity Controls */}
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, -1); }}
                      className="min-w-[44px] min-h-[44px] xl:min-w-9 xl:min-h-9 rounded-lg bg-white/30 hover:bg-white/50 flex items-center justify-center transition-colors border border-white/40"
                    >
                      <Minus className="w-4 h-4 text-neutral-700" />
                    </button>
                    <span className="text-sm font-bold text-neutral-800 w-8 text-center tabular-nums">{item.quantity}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, 1); }}
                      className="min-w-[44px] min-h-[44px] xl:min-w-9 xl:min-h-9 rounded-lg bg-brand-600/80 hover:bg-brand-600 flex items-center justify-center transition-colors border border-brand-500/50 backdrop-blur-sm"
                    >
                      <Plus className="w-4 h-4 text-white" />
                    </button>
                  </div>
                </div>
                {/* Line Total + Remove */}
                <div className="flex flex-col items-end gap-1">
                  <p className="text-sm font-bold text-neutral-900">{formatCurrency(item.price * item.quantity)}</p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.uniqueId); }}
                    className="min-w-[44px] min-h-[44px] xl:min-w-9 xl:min-h-9 rounded-md flex items-center justify-center text-neutral-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                    aria-label="Remove line"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Order Summary + CTA */}
        <div className="p-4 lg:p-5 border-t border-white/20 bg-white/10 backdrop-blur-md shrink-0">
          {/* Coupon / Discount — collapsible */}
          <div className="mb-4 relative">
            <button
              type="button"
              onClick={() => setCouponSectionExpanded(prev => !prev)}
              className="w-full flex items-center justify-between gap-2 py-1 -mx-1 rounded-lg hover:bg-neutral-100/80 text-left"
              aria-expanded={couponSectionExpanded}
            >
              <h3 className="text-sm font-semibold text-neutral-800">Coupon / Discount</h3>
              {couponSectionExpanded ? (
                <ChevronDown className="w-4 h-4 shrink-0 text-neutral-500" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 text-neutral-500" />
              )}
            </button>
            {couponSectionExpanded && (
            <>
            <div className="relative mt-2">
              <button
                type="button"
                onClick={() => setCouponDropdownOpen(prev => !prev)}
                className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl border-2 text-left text-sm font-medium transition-all ${
                  appliedDiscount ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-neutral-200 hover:border-neutral-300 text-neutral-600'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Tag className="w-4 h-4 text-neutral-500" />
                  {appliedDiscount ? `${appliedDiscount.name} (${appliedDiscount.type === 'percent' ? `${appliedDiscount.value}%` : formatCurrency(appliedDiscount.value)})` : 'Apply coupon'}
                </span>
                <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${couponDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {couponDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 py-1 glass-floating z-10 max-h-56 overflow-auto">
                  <button
                    type="button"
                    onClick={() => { setAppliedDiscount(null); setCouponDropdownOpen(false); }}
                    className="w-full px-4 py-2.5 text-left text-sm text-neutral-600 hover:bg-neutral-50"
                  >
                    No discount
                  </button>
                  <div className="px-3 py-2 border-t border-neutral-100">
                    <p className="text-xs text-neutral-500 mb-1.5">Or enter amount (e.g. 500 or 10%)</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="text"
                        value={customCouponInput}
                        onChange={e => setCustomCouponInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && applyCustomCoupon()}
                        placeholder="500 or 10%"
                        className="flex-1 px-3 py-2 glass-card text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={applyCustomCoupon}
                        disabled={!customCouponInput.trim()}
                        className="px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                  {discounts.map(d => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => { setAppliedDiscount(d); setCouponDropdownOpen(false); }}
                      className="w-full px-4 py-2.5 text-left text-sm text-neutral-800 hover:bg-brand-50"
                    >
                      {d.name} — {d.type === 'percent' ? `${d.value}%` : formatCurrency(d.value)}
                    </button>
                  ))}
                  {discounts.length === 0 && (
                    <div className="px-4 py-2.5 text-sm text-neutral-400">No presets. Add in Settings → Discounts.</div>
                  )}
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {appliedDiscount && (
                <button
                  type="button"
                  onClick={() => setAppliedDiscount(null)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Remove discount
                </button>
              )}
              {appliedDiscount && (
                <button
                  type="button"
                  onClick={activateCouponForAllOrders}
                  className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                    activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value
                      ? 'border-brand-300 bg-brand-50 text-brand-700'
                      : 'border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100'
                  }`}
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                  {activeCoupon?.id === appliedDiscount?.id && activeCoupon?.value === appliedDiscount?.value ? 'Active for all orders' : 'Activate for all orders'}
                </button>
              )}
              {activeCoupon && (
                <button
                  type="button"
                  onClick={deactivateCouponForAllOrders}
                  className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-600 hover:bg-neutral-100 hover:border-neutral-300"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Mark inactive
                </button>
              )}
            </div>
            </>
            )}
          </div>

          {/* Payment Method — collapsible */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setPaymentMethodSectionExpanded(prev => !prev)}
              className="w-full flex items-center justify-between gap-2 py-1 -mx-1 rounded-lg hover:bg-neutral-100/80 text-left"
              aria-expanded={paymentMethodSectionExpanded}
            >
              <h3 className="text-sm font-semibold text-neutral-800">Payment Method</h3>
              {paymentMethodSectionExpanded ? (
                <ChevronDown className="w-4 h-4 shrink-0 text-neutral-500" />
              ) : (
                <ChevronRight className="w-4 h-4 shrink-0 text-neutral-500" />
              )}
            </button>
            {paymentMethodSectionExpanded && (
            <div className="mt-2">
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setPaymentMethod('Cash')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] relative focus:outline-none focus-visible:z-10 focus-visible:overflow-visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-brand-800 dark:focus-visible:outline-brand-300 ${paymentMethod === 'Cash' ? 'glass-card border-brand-500 text-brand-800' : 'glass-card hover:border-brand-300 text-neutral-500'}`}
              >
                <Banknote className="w-5 h-5" />
                <span className="text-xs font-bold">Cash</span>
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod('Card')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] relative focus:outline-none focus-visible:z-10 focus-visible:overflow-visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-brand-800 dark:focus-visible:outline-brand-300 ${paymentMethod === 'Card' ? 'glass-card border-brand-500 text-brand-800' : 'glass-card hover:border-brand-300 text-neutral-500'}`}
              >
                <CreditCard className="w-5 h-5" />
                <span className="text-xs font-bold">Card</span>
              </button>
              <button
                type="button"
                onClick={() => setPaymentMethod('Online Transfer')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] relative focus:outline-none focus-visible:z-10 focus-visible:overflow-visible focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-brand-800 dark:focus-visible:outline-brand-300 ${paymentMethod === 'Online Transfer' ? 'glass-card border-brand-500 text-brand-800' : 'glass-card hover:border-brand-300 text-neutral-500'}`}
              >
                <Smartphone className="w-5 h-5" />
                <span className="text-[11px] font-bold whitespace-nowrap">Online</span>
              </button>
            </div>
            </div>
            )}
          </div>

          {/* Breakdown */}
          <div className="space-y-2 mb-4">
            <div className="flex justify-between text-sm">
              <span className="text-neutral-500">Subtotal</span>
              <span className="font-medium text-neutral-700">{formatCurrency(subtotal)}</span>
            </div>
            {appliedDiscount && discountAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-neutral-500">Discount ({appliedDiscount.name})</span>
                <span className="font-medium text-gold-600">-{formatCurrency(discountAmount)}</span>
              </div>
            )}
            {taxEnabled && (
              <div className="flex justify-between text-sm">
                <span className="text-neutral-500">Tax ({paymentMethod} — {taxPct}%)</span>
                <span className="font-medium text-neutral-700">{formatCurrency(tax)}</span>
              </div>
            )}
            <div className="h-px bg-neutral-200 my-1" />
            <div className="flex justify-between items-end">
              <span className="text-sm font-semibold text-neutral-600">Total</span>
              <span className="text-2xl font-bold text-brand-700">{formatCurrency(total)}</span>
            </div>
          </div>

          {/* Payment / KOT — dine-in (new order): KOT + payment; editing open tab: update or payment */}
          {orderType === 'dine_in' && !editingOpenSaleId ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleGenerateKot}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="w-full bg-white/90 border-2 border-brand-600 text-brand-800 hover:bg-brand-50 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed py-3.5 rounded-xl font-bold text-sm transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
              >
                <ClipboardList className="w-4.5 h-4.5" />
                {checkoutSubmitting ? 'Working…' : 'Generate KOT'}
              </button>
              <button
                type="button"
                onClick={handleCheckout}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-3.5 rounded-xl font-bold text-sm shadow-sm shadow-brand-700/20 transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
              >
                <ShoppingBag className="w-4.5 h-4.5" />
                {checkoutSubmitting ? 'Processing…' : 'Proceed payment'}
              </button>
            </div>
          ) : editingOpenSaleId ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={submitUpdateOrder}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="w-full bg-white/90 border-2 border-amber-500 text-amber-800 hover:bg-amber-50 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:border-neutral-200 disabled:cursor-not-allowed py-3.5 rounded-xl font-bold text-sm transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
              >
                <ClipboardList className="w-4.5 h-4.5" />
                {checkoutSubmitting ? 'Working…' : 'Update Order'}
              </button>
              <button
                type="button"
                onClick={handleCheckout}
                disabled={cart.length === 0 || checkoutSubmitting}
                className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-3.5 rounded-xl font-bold text-sm shadow-sm shadow-brand-700/20 transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
              >
                <ShoppingBag className="w-4.5 h-4.5" />
                {checkoutSubmitting ? 'Processing…' : 'Proceed payment'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleCheckout}
              disabled={cart.length === 0 || checkoutSubmitting}
              className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-3.5 rounded-xl font-bold text-lg shadow-sm shadow-brand-700/20 transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
            >
              <ShoppingBag className="w-5 h-5" />
              {checkoutSubmitting ? 'Processing…' : 'Proceed to payment'}
            </button>
          )}
        </div>
      </div>

      {/* Option selection modal — portaled to document.body so it is not clipped by main.glass-panel overflow/backdrop */}
      {productForVariants &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[200] flex items-end lg:items-center justify-center glass-overlay px-4 pb-8 lg:p-6">
            <div className="glass-floating rounded-t-3xl lg:rounded-2xl w-full max-w-md lg:max-w-lg animate-slide-up lg:animate-none max-h-[85vh] overflow-y-auto">
              <div className="p-6 border-b border-soot-200/60 flex justify-between items-center bg-white/25">
                <h3 className="text-lg font-bold text-soot-900">Select option</h3>
                <button
                  type="button"
                  onClick={() => setProductForVariants(null)}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-soot-200 transition-colors text-soot-500"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-14 h-14 rounded-xl bg-brand-50 border border-brand-100 flex items-center justify-center overflow-hidden shrink-0">
                    <img src={getProductImageUrl(productForVariants)} alt="" className="w-full h-full object-cover" />
                  </div>
                  <div>
                    <p className="font-semibold text-soot-900">{productForVariants.title}</p>
                    <p className="font-bold text-gold-600">{formatCurrency(productForVariants.base_price)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {productForVariants.variants.map(variant => {
                    const stock = inventory[productForVariants.id.toString()]?.[variant] || 0;
                    const isOutOfStock = stock <= 0;
                    return (
                      <button
                        key={variant}
                        type="button"
                        disabled={isOutOfStock}
                        onClick={() =>
                          handleAddToCart({
                            id: productForVariants.id,
                            title: productForVariants.title,
                            price: productForVariants.base_price,
                            image: getProductImageUrl(productForVariants),
                            variant,
                          })
                        }
                        className={`py-4 px-2 rounded-xl border-2 text-center transition-all flex flex-col items-center justify-center gap-1 ${
                          isOutOfStock
                            ? 'border-neutral-200 bg-neutral-100 text-neutral-400 opacity-60 cursor-not-allowed grayscale'
                            : 'border-soot-200 hover:border-brand-500 hover:bg-brand-50 active:bg-brand-100 text-soot-700 font-bold'
                        }`}
                      >
                        <span className={isOutOfStock ? 'line-through text-sm font-semibold' : 'text-base font-bold'}>{variant}</span>
                        {isOutOfStock ? (
                          <span className="text-[10px] font-bold text-red-500 uppercase">Out of Stock</span>
                        ) : (
                          <span className="text-[10px] font-medium text-neutral-500">{stock} in stock</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}

    </div>
  );
}
