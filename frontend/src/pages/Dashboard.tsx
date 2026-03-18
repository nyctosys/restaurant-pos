import { useState, useEffect } from 'react';
import { useScanner } from '../hooks/useScanner';
import { ShoppingBag, Plus, Minus, Trash2, Search, Loader2, CreditCard, Banknote, Smartphone, LayoutGrid, List, X, Printer, Usb, Tag, ChevronDown, ChevronRight, CheckCircle, XCircle } from 'lucide-react';
import { formatCurrency } from '../utils/formatCurrency';
import { get, post, getUserMessage } from '../api';

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

const PRODUCT_PLACEHOLDER_IMAGE = '/product-placeholder.svg';

function getProductImageUrl(product: Product): string {
  return (product.image_url && product.image_url.trim()) ? product.image_url.trim() : PRODUCT_PLACEHOLDER_IMAGE;
}

export default function Dashboard() {
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

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    
    // Map fontend cart model to backend expected items
    const items = cart.map(item => ({
      product_id: item.id,
      variant_sku_suffix: item.variant || '',
      quantity: item.quantity
    }));

    try {
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const data = await post<{ sale_id?: number; total?: number; message?: string; print_success?: boolean }>('/orders/checkout', {
        payment_method: paymentMethod,
        items,
        branch_id: parseInt(activeBranchId, 10),
        discount: appliedDiscount ? { id: appliedDiscount.id, name: appliedDiscount.name, type: appliedDiscount.type, value: appliedDiscount.value } : null,
        order_type: 'counter',
      });
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
      fetchData(); // Refresh stock
    } catch (e) {
      setNotification({ type: 'error', msg: getUserMessage(e) });
      setTimeout(() => setNotification(null), 4000);
    }
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
    <div className="flex h-full">

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed top-5 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-semibold transition-all ${
          notification.type === 'ok'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white'
        }`}>
          {notification.msg}
        </div>
      )}
      
      {/* Center: Menu grid */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-5 pb-0">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h1 className="text-2xl font-bold text-neutral-900">Order</h1>
            </div>
            <div className="flex items-center gap-2">
              {/* Scanner Status */}
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                scannerStatus === 'active'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
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
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
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
          <div className="flex items-center gap-3 mb-5">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-neutral-400" />
              <input 
                type="text"
                inputMode="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search menu"
                className="w-full pl-11 pr-4 py-2.5 bg-surface border border-neutral-200 rounded-xl text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-shadow"
              />
            </div>
            <button 
              onClick={() => setLayoutView(prev => prev === 'grid' ? 'list' : 'grid')}
              className="w-10 h-10 flex items-center justify-center bg-surface border border-neutral-200 rounded-xl hover:bg-neutral-50 transition-colors"
              title="Toggle Layout"
            >
              {layoutView === 'grid' ? <List className="w-4.5 h-4.5 text-neutral-500" /> : <LayoutGrid className="w-4.5 h-4.5 text-neutral-500" />}
            </button>
          </div>

          {/* Category tabs — from Settings → Categories */}
          <div className="flex items-center gap-1 border-b border-neutral-200 overflow-x-auto no-scrollbar">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeCategory === cat
                    ? 'border-gold-500 text-gold-700'
                    : 'border-transparent text-neutral-500 hover:text-neutral-700'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Menu grid */}
        <div className="flex-1 overflow-auto p-5">
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
            <div className={layoutView === 'grid' ? "grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4" : "flex flex-col gap-3"}>
              {filteredProducts.map(product => (
                <button
                  key={product.id}
                  onClick={() => handleProductClick(product)}
                  className={`bg-surface border overflow-hidden transition-all duration-200 group text-left ${
                    layoutView === 'grid' ? 'flex flex-col rounded-2xl' : 'rounded-xl flex items-center p-3'
                  } ${
                    (!product.variants || product.variants.length === 0) && (inventory[product.id.toString()]?.[''] || 0) <= 0
                      ? 'opacity-50 grayscale cursor-not-allowed border-neutral-200'
                      : 'border-neutral-100 hover:shadow-md hover:border-neutral-200 active:scale-[0.97]'
                  }`}
                >
                  {/* Product Image Area — aspect-square so size scales with card width (responsive), consistent across all cards */}
                  <div className={`${layoutView === 'grid' ? 'w-full aspect-square shrink-0' : 'w-16 h-16 shrink-0 rounded-lg'} flex items-center justify-center overflow-hidden transition-colors ${
                    (!product.variants || product.variants.length === 0) && (inventory[product.id.toString()]?.[''] || 0) <= 0
                      ? 'bg-neutral-100'
                      : 'bg-gradient-to-br from-brand-50 to-brand-100 group-hover:from-brand-100 group-hover:to-brand-200'
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

      {/* Right: Order Sidebar */}
      <div className="w-[360px] bg-surface border-l border-neutral-200 flex flex-col shrink-0">
        {/* Order Header */}
        <div className="p-5 border-b border-neutral-100">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-bold text-neutral-900">Current Order</h2>
            <span className="text-xs text-neutral-400 font-mono">{orderId}</span>
          </div>
          <p className="text-xs text-neutral-400 font-medium">{orderDateStr} &bull; {orderTimeStr}</p>
          
          <div className="mt-3 flex items-center gap-2.5 px-3 py-2 bg-brand-50 rounded-lg border border-brand-100">
            <div className="w-7 h-7 rounded-full bg-brand-700 flex items-center justify-center text-gold-500 text-xs font-bold">
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <span className="text-sm font-medium text-brand-800">{user?.username || 'Operator'}</span>
          </div>
        </div>

        {/* Cart Items */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {cart.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-300">
              <ShoppingBag className="w-16 h-16 mb-3 stroke-1" />
              <p className="text-sm font-medium text-neutral-400">No items yet</p>
              <p className="text-xs text-neutral-300 mt-1">Tap an item to add it</p>
            </div>
          ) : (
            cart.map(item => (
              <div key={item.uniqueId} className="flex items-start gap-3 p-3 bg-neutral-50 rounded-xl border border-neutral-100">
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded-lg bg-brand-50 flex items-center justify-center overflow-hidden shrink-0 border border-brand-100">
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
                      onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, -1); }}
                      className="w-7 h-7 rounded-lg bg-neutral-200 hover:bg-neutral-300 flex items-center justify-center transition-colors"
                    >
                      <Minus className="w-3.5 h-3.5 text-neutral-600" />
                    </button>
                    <span className="text-sm font-bold text-neutral-800 w-6 text-center">{item.quantity}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleUpdateQuantity(item.uniqueId, 1); }}
                      className="w-7 h-7 rounded-lg bg-brand-700 hover:bg-brand-600 flex items-center justify-center transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 text-white" />
                    </button>
                  </div>
                </div>
                {/* Line Total + Remove */}
                <div className="flex flex-col items-end gap-1">
                  <p className="text-sm font-bold text-neutral-900">{formatCurrency(item.price * item.quantity)}</p>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemoveItem(item.uniqueId); }}
                    className="w-6 h-6 rounded-md flex items-center justify-center text-neutral-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Order Summary + CTA */}
        <div className="p-5 border-t border-neutral-100 bg-neutral-50/50">
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
                <div className="absolute top-full left-0 right-0 mt-1 py-1 bg-white border border-neutral-200 rounded-xl shadow-lg z-10 max-h-56 overflow-auto">
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
                        className="flex-1 px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
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
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
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
                onClick={() => setPaymentMethod('Cash')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] ${paymentMethod === 'Cash' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-neutral-200 hover:border-brand-300 text-neutral-500'}`}
              >
                <Banknote className="w-5 h-5" />
                <span className="text-xs font-bold">Cash</span>
              </button>
              <button
                onClick={() => setPaymentMethod('Card')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] ${paymentMethod === 'Card' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-neutral-200 hover:border-brand-300 text-neutral-500'}`}
              >
                <CreditCard className="w-5 h-5" />
                <span className="text-xs font-bold">Card</span>
              </button>
              <button
                onClick={() => setPaymentMethod('Online Transfer')}
                className={`py-2 px-1 flex flex-col items-center justify-center gap-1 rounded-xl border-2 transition-all active:scale-[0.98] ${paymentMethod === 'Online Transfer' ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-neutral-200 hover:border-brand-300 text-neutral-500'}`}
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
                <span className="font-medium text-emerald-600">-{formatCurrency(discountAmount)}</span>
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

          {/* Payment Button */}
          <button
            onClick={handleCheckout}
            disabled={cart.length === 0}
            className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:cursor-not-allowed text-white py-3.5 rounded-xl font-bold text-sm shadow-sm shadow-brand-700/20 transition-all active:scale-[0.98] touch-target flex items-center justify-center gap-2"
          >
            <ShoppingBag className="w-4.5 h-4.5" />
            Proceed Payment
          </button>
        </div>
      </div>

      {/* Option selection modal */}
      {productForVariants && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm px-4 pb-8 sm:p-0">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-slide-up sm:animate-none">
            <div className="p-6 border-b border-soot-200 flex justify-between items-center bg-soot-50">
              <h3 className="text-lg font-bold text-soot-900">Select option</h3>
              <button 
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
                      disabled={isOutOfStock}
                      onClick={() => handleAddToCart({
                        id: productForVariants.id,
                        title: productForVariants.title,
                        price: productForVariants.base_price,
                        image: getProductImageUrl(productForVariants),
                        variant
                      })}
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
        </div>
      )}

    </div>
  );
}
