import { useState, useEffect, useMemo } from 'react';
import { Calendar, Loader2, RefreshCw, Package, ArrowUpDown, ArrowUp, ArrowDown, Banknote, CreditCard, Smartphone, Truck, UtensilsCrossed, ShoppingBag, ReceiptText } from 'lucide-react';
import SearchableSelect from '../components/SearchableSelect';
import TransactionDetailsModal from '../components/TransactionDetailsModal';
import { formatCurrency } from '../utils/formatCurrency';
import { get, getUserMessage } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import { showToast } from '../components/Toast';

type StockTransactionInfo = {
  id: number;
  ingredient_id?: number | null;
  ingredient_name?: string | null;
  product_id?: number | null;
  product_title?: string | null;
  variant_sku_suffix?: string;
  delta: number;
  reason: string;
  movement_type?: string | null;
  reference_type: string | null;
  reference_id: number | null;
  created_at: string;
};

type SaleInfo = {
  id: number;
  total_amount: number;
  created_at: string;
  payment_method: string;
  user_id: number;
  status: string;
  order_type?: string | null;
  archived_at?: string | null;
};

type ReportMetric = {
  orders: number;
  amount: number;
};

type DetailedReport = {
  totals: {
    orders: number;
    received_amount: number;
    profit_amount?: number;
    discount_amount: number;
    tax_amount: number;
    delivery_charge: number;
    service_charge: number;
    refunded_orders: number;
    refunded_amount: number;
    open_orders: number;
    open_amount: number;
  };
  payment_methods: Record<string, ReportMetric | undefined>;
  order_types: Record<string, ReportMetric | undefined>;
  most_selling_product: { id: number; title: string; total_sold: number } | null;
};

type SalesSortKey = 'id' | 'created_at' | 'payment_method' | 'status' | 'total_amount';
type StockSortKey = 'created_at' | 'ingredient_name' | 'delta' | 'movement_type';
type SortDirection = 'asc' | 'desc';

export default function Reports() {
  const [timeFilter, setTimeFilter] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [sales, setSales] = useState<SaleInfo[]>([]);
  const [report, setReport] = useState<DetailedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [stockTransactions, setStockTransactions] = useState<StockTransactionInfo[]>([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [salesSortKey, setSalesSortKey] = useState<SalesSortKey>('created_at');
  const [salesSortDirection, setSalesSortDirection] = useState<SortDirection>('asc');
  const [stockSortKey, setStockSortKey] = useState<StockSortKey>('created_at');
  const [stockSortDirection, setStockSortDirection] = useState<SortDirection>('asc');
  const user = parseUserFromStorage();
  const isOwner = user?.role === 'owner';
  const terminalBranchId = getTerminalBranchIdString(user);

  useEffect(() => {
    // If custom is selected, we only fetch if both dates are present
    if (timeFilter === 'custom' && (!customStart || !customEnd)) {
      return;
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeFilter, customStart, customEnd, includeArchived, terminalBranchId]);

  const fetchData = async () => {
    setLoading(true);
    let queryParams = `?time_filter=${timeFilter}`;
    if (timeFilter === 'custom') {
      queryParams += `&start_date=${customStart}&end_date=${customEnd}`;
    }
    if (terminalBranchId) {
      queryParams += `&branch_id=${terminalBranchId}`;
    }
    if (includeArchived) {
      queryParams += '&include_archived=1';
    }

    try {
      const [sData, aData] = await Promise.all([
        get<{ sales?: SaleInfo[] }>(`/orders/${queryParams}&limit=500`),
        get<DetailedReport>(`/orders/report${queryParams}`),
      ]);
      setSales(sData?.sales ?? []);
      setReport(aData ?? null);
    } catch (e) {
      const userMsg = getUserMessage(e);

      setSales([]);
      setReport(null);
      showToast(userMsg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchStockTransactions = async () => {
    if (timeFilter === 'custom' && (!customStart || !customEnd)) return;
    setStockLoading(true);
    let q = `?time_filter=${timeFilter}`;
    if (timeFilter === 'custom') q += `&start_date=${customStart}&end_date=${customEnd}`;
    if (terminalBranchId) q += `&branch_id=${terminalBranchId}`;
    try {
      const data = await get<{ transactions?: StockTransactionInfo[] }>(`/stock/transactions${q}`);
      setStockTransactions(data?.transactions ?? []);
    } catch {
      setStockTransactions([]);
    } finally {
      setStockLoading(false);
    }
  };

  useEffect(() => {
    if (timeFilter === 'custom' && (!customStart || !customEnd)) return;
    fetchStockTransactions();
  }, [timeFilter, customStart, customEnd, terminalBranchId]);

  const getFormatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const handleSalesSort = (key: SalesSortKey) => {
    if (salesSortKey === key) {
      setSalesSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSalesSortKey(key);
    setSalesSortDirection('asc');
  };

  const handleStockSort = (key: StockSortKey) => {
    if (stockSortKey === key) {
      setStockSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setStockSortKey(key);
    setStockSortDirection('asc');
  };

  const sortedSales = useMemo(() => {
    const direction = salesSortDirection === 'asc' ? 1 : -1;
    return sales
      .map((sale, index) => ({ sale, index }))
      .sort((a, b) => {
        const left = a.sale;
        const right = b.sale;

        let result = 0;
        switch (salesSortKey) {
          case 'id':
            result = left.id - right.id;
            break;
          case 'created_at':
            result = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
            break;
          case 'total_amount':
            result = left.total_amount - right.total_amount;
            break;
          case 'payment_method':
          case 'status':
            result = left[salesSortKey].localeCompare(right[salesSortKey], undefined, { sensitivity: 'base' });
            break;
        }

        if (result !== 0) return result * direction;
        return a.index - b.index;
      })
      .map(entry => entry.sale);
  }, [sales, salesSortDirection, salesSortKey]);

  const sortedStockTransactions = useMemo(() => {
    const direction = stockSortDirection === 'asc' ? 1 : -1;
    return stockTransactions
      .map((tx, index) => ({ tx, index }))
      .sort((a, b) => {
        const left = a.tx;
        const right = b.tx;
        const leftName = left.ingredient_name ?? (left.product_title ? left.product_title : left.ingredient_id != null ? `#${left.ingredient_id}` : '—');
        const rightName = right.ingredient_name ?? (right.product_title ? right.product_title : right.ingredient_id != null ? `#${right.ingredient_id}` : '—');
        const leftType = (left.movement_type || left.reason || '').replace(/_/g, ' ');
        const rightType = (right.movement_type || right.reason || '').replace(/_/g, ' ');

        let result = 0;
        switch (stockSortKey) {
          case 'created_at':
            result = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
            break;
          case 'delta':
            result = left.delta - right.delta;
            break;
          case 'ingredient_name':
            result = leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
            break;
          case 'movement_type':
            result = leftType.localeCompare(rightType, undefined, { sensitivity: 'base' });
            break;
        }

        if (result !== 0) return result * direction;
        return a.index - b.index;
      })
      .map(entry => entry.tx);
  }, [stockSortDirection, stockSortKey, stockTransactions]);

  const renderSortIcon = (active: boolean, direction: SortDirection) => {
    if (!active) return <ArrowUpDown className="w-3.5 h-3.5 text-soot-400" aria-hidden="true" />;
    return direction === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />
      : <ArrowDown className="w-3.5 h-3.5 text-brand-700" aria-hidden="true" />;
  };

  const metric = (group: Record<string, ReportMetric | undefined> | undefined, key: string): ReportMetric =>
    group?.[key] ?? { orders: 0, amount: 0 };

  const orderTypeLabel = (value?: string | null) => {
    if (value === 'delivery') return 'Delivery';
    if (value === 'dine_in') return 'Dine-in';
    if (value === 'takeaway') return 'Takeaway';
    return 'Unspecified';
  };

  const MetricCard = ({
    title,
    amount,
    orders,
    icon: Icon,
    tone = 'brand',
    detail,
  }: {
    title: string;
    amount: number;
    orders?: number;
    icon: typeof Banknote;
    tone?: 'brand' | 'cash' | 'online' | 'delivery';
    detail?: string;
  }) => {
    const toneClass = {
      brand: 'bg-brand-50 text-brand-700 border-brand-100',
      cash: 'bg-emerald-50 text-emerald-700 border-emerald-100',
      online: 'bg-sky-50 text-sky-700 border-sky-100',
      delivery: 'bg-amber-50 text-amber-800 border-amber-100',
    }[tone];

    return (
      <div className="glass-card border border-white/60 bg-white/75 p-4 lg:p-5 min-h-[128px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-bold uppercase tracking-wide text-soot-600">{title}</div>
            <div className="mt-2 text-2xl lg:text-3xl font-bold tabular-nums leading-tight text-soot-900">
              {loading ? '...' : formatCurrency(amount)}
            </div>
          </div>
          <div className={`shrink-0 rounded-[8px] border p-2 ${toneClass}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <div className="mt-3 text-sm font-semibold text-soot-600">
          {loading ? '...' : orders != null ? `${orders} orders` : detail}
        </div>
        {detail && orders != null && !loading && <div className="mt-1 text-xs font-medium text-soot-500">{detail}</div>}
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col h-full min-h-0 bg-transparent">
        
        {/* Header & Filters — tablet-first stack; xl+ aligns toolbar in one row */}
        <div className="page-padding border-b border-soot-200/60 flex flex-col lg:flex-row lg:justify-between lg:items-start xl:items-center bg-white/25 gap-4 shrink-0">
          <h2 className="text-xl font-bold text-soot-900 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-soot-600" /> Orders & reporting
          </h2>
          
          <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto lg:justify-end">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-soot-700 min-h-[44px]">
              <input type="checkbox" checked={includeArchived} onChange={() => setIncludeArchived(v => !v)} className="rounded border-soot-300 text-brand-600 focus:ring-brand-500" />
              Include archived
            </label>
            <div className="flex-1 min-w-[140px] lg:flex-initial lg:min-w-[160px]">
              <SearchableSelect
                value={timeFilter}
                onChange={setTimeFilter}
                searchPlaceholder="Search time filters…"
                options={[
                  { value: 'custom', label: 'Custom Range' },
                  { value: 'month', label: 'This Month' },
                  { value: 'today', label: 'Today' },
                  { value: 'week', label: 'This Week' },
                  { value: 'year', label: 'This Year' },
                ]}
                className="glass-card border-0 min-h-[44px] rounded-[8px] px-3 py-2.5 text-sm font-medium text-soot-700"
              />
            </div>

            {timeFilter === 'custom' && (
              <div className="flex items-center gap-2 flex-wrap">
                <input 
                  type="date" 
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="glass-card rounded-[8px] px-2 py-2 min-h-[44px] text-sm"
                />
                <span className="text-soot-400">-</span>
                <input 
                  type="date" 
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="glass-card rounded-[8px] px-2 py-2 min-h-[44px] text-sm"
                />
              </div>
            )}

            <button type="button" onClick={() => { fetchData(); fetchStockTransactions(); }} className="touch-target p-2 ml-1 text-soot-500 hover:text-brand-600 hover:bg-brand-50 rounded-[8px] transition-colors border border-transparent hover:border-brand-100" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Analytics + tables */}
        <div className="page-padding flex-1 min-h-0 overflow-auto flex flex-col gap-8 lg:gap-10">
          <section className="flex shrink-0 flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 lg:gap-5 shrink-0">
              <MetricCard title="Received amount" amount={report?.totals.received_amount ?? 0} orders={report?.totals.orders ?? 0} icon={ReceiptText} />
              <MetricCard title="Profit" amount={report?.totals.profit_amount ?? 0} icon={Package} detail="Sell price − base price" />
              <MetricCard title="Cash orders" amount={metric(report?.payment_methods, 'cash').amount} orders={metric(report?.payment_methods, 'cash').orders} icon={Banknote} tone="cash" />
              <MetricCard title="Card orders" amount={metric(report?.payment_methods, 'card').amount} orders={metric(report?.payment_methods, 'card').orders} icon={CreditCard} tone="online" />
              <MetricCard title="Online transfer" amount={metric(report?.payment_methods, 'online_transfer').amount} orders={metric(report?.payment_methods, 'online_transfer').orders} icon={Smartphone} tone="online" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 lg:gap-5 shrink-0">
              <MetricCard title="Delivery orders" amount={metric(report?.order_types, 'delivery').amount} orders={metric(report?.order_types, 'delivery').orders} icon={Truck} tone="delivery" detail={`Delivery charges: ${formatCurrency(report?.totals.delivery_charge ?? 0)}`} />
              <MetricCard title="Dine-in orders" amount={metric(report?.order_types, 'dine_in').amount} orders={metric(report?.order_types, 'dine_in').orders} icon={UtensilsCrossed} detail={`Service charges: ${formatCurrency(report?.totals.service_charge ?? 0)}`} />
              <MetricCard title="Takeaway orders" amount={metric(report?.order_types, 'takeaway').amount} orders={metric(report?.order_types, 'takeaway').orders} icon={ShoppingBag} />
              <div className="glass-card border border-white/60 bg-white/75 p-4 lg:p-5 min-h-[128px]">
                <div className="text-[12px] font-bold uppercase tracking-wide text-soot-600">Top selling item</div>
                <div className="mt-2 text-lg lg:text-xl font-bold text-brand-800 leading-snug line-clamp-2" title={report?.most_selling_product?.title || undefined}>
                  {loading ? '...' : report?.most_selling_product?.title?.trim() ? report.most_selling_product.title : '-'}
                </div>
                <div className="mt-3 text-sm font-semibold text-soot-600">
                  {loading ? '...' : report?.most_selling_product ? `${report.most_selling_product.total_sold} units sold` : 'No item sales yet'}
                </div>
                {!loading && (report?.totals.refunded_orders || report?.totals.open_orders) ? (
                  <div className="mt-1 text-xs font-medium text-soot-500">
                    {report.totals.refunded_orders} refunded / {report.totals.open_orders} unpaid open
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          {/* Recent Transactions */}
          <section className="shrink-0">
            <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-soot-900">
              <ReceiptText className="h-5 w-5 text-soot-600" /> Recent transactions
            </h3>
            {loading && sales.length === 0 ? (
               <div className="py-12 flex justify-center text-soot-400">
                 <Loader2 className="w-6 h-6 animate-spin" />
               </div>
            ) : sales.length === 0 ? (
              <div className="text-center py-12 text-soot-400 glass-card">
                <p className="font-medium">No transactions found for this period.</p>
              </div>
            ) : (
              <div className="glass-card app-table-shell">
                <div className="app-table-scroll">
                <table className="app-table min-w-[760px]">
                  <thead>
                    <tr>
                      <th aria-sort={salesSortKey === 'id' ? (salesSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleSalesSort('id')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Transaction ID</span>
                          {renderSortIcon(salesSortKey === 'id', salesSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={salesSortKey === 'created_at' ? (salesSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleSalesSort('created_at')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Date & Time</span>
                          {renderSortIcon(salesSortKey === 'created_at', salesSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={salesSortKey === 'payment_method' ? (salesSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleSalesSort('payment_method')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Method</span>
                          {renderSortIcon(salesSortKey === 'payment_method', salesSortDirection)}
                        </button>
                      </th>
                      <th className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">Order type</th>
                      <th aria-sort={salesSortKey === 'status' ? (salesSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px] text-center">
                        <button type="button" onClick={() => handleSalesSort('status')} className="mx-auto flex items-center gap-2 text-center transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Status</span>
                          {renderSortIcon(salesSortKey === 'status', salesSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={salesSortKey === 'total_amount' ? (salesSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px] text-right">
                        <button type="button" onClick={() => handleSalesSort('total_amount')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Total</span>
                          {renderSortIcon(salesSortKey === 'total_amount', salesSortDirection)}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSales.map((sale) => (
                      <tr 
                        key={sale.id} 
                        onClick={() => setSelectedSaleId(sale.id)}
                        className={`cursor-pointer transition-colors min-h-[48px] xl:min-h-0 ${sale.status === 'refunded' ? 'opacity-60' : ''} ${sale.archived_at ? 'bg-white/20' : ''}`}
                      >
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm font-medium text-soot-900">#ORD-{sale.id}</td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-soot-600">{getFormatDate(sale.created_at)}</td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-soot-600 font-medium">{sale.payment_method}</td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-soot-600 font-medium">{orderTypeLabel(sale.order_type)}</td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-center">
                          {sale.status === 'refunded' ? (
                            <span className="bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded text-xs font-bold">REFUNDED</span>
                          ) : (
                            <span className="bg-brand-50 text-brand-600 border border-brand-200 px-2 py-0.5 rounded text-xs font-bold">COMPLETED</span>
                          )}
                        </td>
                        <td className={`py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-right font-medium tabular-nums text-soot-900 ${sale.status === 'refunded' ? 'line-through' : ''}`}>
                          {formatCurrency(sale.total_amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </section>

          {/* Stock transactions */}
          <section className="shrink-0">
            <h3 className="text-lg font-bold text-soot-900 mb-4 flex items-center gap-2">
              <Package className="w-5 h-5 text-soot-600" /> Ingredient stock movements
            </h3>
            {stockLoading && stockTransactions.length === 0 ? (
              <div className="py-12 flex justify-center text-soot-400">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : stockTransactions.length === 0 ? (
              <div className="text-center py-12 text-soot-400 glass-card">
                <p className="font-medium">No stock movements for this period.</p>
              </div>
            ) : (
              <div className="glass-card app-table-shell">
                <div className="app-table-scroll">
                <table className="app-table min-w-[520px]">
                  <thead>
                    <tr>
                      <th aria-sort={stockSortKey === 'created_at' ? (stockSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleStockSort('created_at')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Date & time</span>
                          {renderSortIcon(stockSortKey === 'created_at', stockSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={stockSortKey === 'ingredient_name' ? (stockSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleStockSort('ingredient_name')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Ingredient</span>
                          {renderSortIcon(stockSortKey === 'ingredient_name', stockSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={stockSortKey === 'delta' ? (stockSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px] text-right">
                        <button type="button" onClick={() => handleStockSort('delta')} className="ml-auto flex items-center gap-2 text-right transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Change</span>
                          {renderSortIcon(stockSortKey === 'delta', stockSortDirection)}
                        </button>
                      </th>
                      <th aria-sort={stockSortKey === 'movement_type' ? (stockSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 xl:text-[11px]">
                        <button type="button" onClick={() => handleStockSort('movement_type')} className="flex items-center gap-2 text-left transition-colors hover:text-soot-700 focus:outline-none focus-visible:text-soot-900">
                          <span>Type</span>
                          {renderSortIcon(stockSortKey === 'movement_type', stockSortDirection)}
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStockTransactions.map((tx) => (
                      <tr key={tx.id} className="min-h-[48px] xl:min-h-0">
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-soot-600">{getFormatDate(tx.created_at)}</td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm font-medium text-soot-900">
                          {tx.ingredient_name ?? (tx.product_title ? tx.product_title : tx.ingredient_id != null ? `#${tx.ingredient_id}` : '—')}
                        </td>
                        <td className={`py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-right text-sm font-medium tabular-nums ${tx.delta >= 0 ? 'text-brand-600' : 'text-red-600'}`}>
                          {tx.delta >= 0 ? '+' : ''}{tx.delta}
                        </td>
                        <td className="py-3 px-3 lg:px-4 xl:py-2 xl:px-3 text-sm text-soot-600 capitalize">
                          {(tx.movement_type || tx.reason || '').replace(/_/g, ' ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {selectedSaleId && (
        <TransactionDetailsModal
          saleId={selectedSaleId}
          onClose={() => setSelectedSaleId(null)}
          onRefresh={fetchData}
          canArchive
          canDeletePermanent={isOwner}
        />
      )}
    </>
  );
}
