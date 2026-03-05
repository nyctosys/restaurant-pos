import { useState, useEffect } from 'react';
import { Calendar, Loader2, RefreshCw } from 'lucide-react';
import TransactionDetailsModal from '../components/TransactionDetailsModal';
import { formatCurrency } from '../utils/formatCurrency';
import { get, getUserMessage } from '../api';
import { showToast } from '../components/Toast';

type SaleInfo = {
  id: number;
  total_amount: number;
  created_at: string;
  payment_method: string;
  user_id: number;
  status: string;
  archived_at?: string | null;
};

type Analytics = {
  total_sales: number;
  total_transactions: number;
  most_selling_product: { id: number; title: string; total_sold: number } | null;
};

export default function Reports() {
  const [timeFilter, setTimeFilter] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [sales, setSales] = useState<SaleInfo[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);
  const [branches, setBranches] = useState<{id: number, name: string}[]>([]);
  const [branchFilter, setBranchFilter] = useState<string>(localStorage.getItem('active_branch_id') ?? 'all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const userStr = localStorage.getItem('user');
  const user = userStr ? JSON.parse(userStr) : null;
  const isOwner = user?.role === 'owner';

  useEffect(() => {
    // If custom is selected, we only fetch if both dates are present
    if (timeFilter === 'custom' && (!customStart || !customEnd)) {
      return;
    }
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeFilter, customStart, customEnd, branchFilter, includeArchived]);

  useEffect(() => {
      if (isOwner) {
          fetchBranches();
      }
  }, [isOwner]);

  const fetchBranches = async () => {
    try {
      const data = await get<{ branches?: { id: number; name: string }[] }>('/auth/branches');
      setBranches(data?.branches ?? []);
    } catch {
      setBranches([]);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    let queryParams = `?time_filter=${timeFilter}`;
    if (timeFilter === 'custom') {
      queryParams += `&start_date=${customStart}&end_date=${customEnd}`;
    }
    if (branchFilter !== 'all') {
      queryParams += `&branch_id=${branchFilter}`;
    }
    if (includeArchived) {
      queryParams += '&include_archived=1';
    }

    try {
      const [sData, aData] = await Promise.all([
        get<{ sales?: SaleInfo[] }>(`/sales/${queryParams}`),
        get<Analytics>(`/sales/analytics${queryParams}`),
      ]);
      setSales(sData?.sales ?? []);
      setAnalytics(aData ?? null);
    } catch (e) {
      setSales([]);
      setAnalytics(null);
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const getFormatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <>
      <div className="flex flex-col h-full bg-white rounded-xl shadow-sm border border-soot-200">
        
        {/* Header & Filters */}
        <div className="p-6 border-b border-soot-200 flex flex-col sm:flex-row sm:justify-between sm:items-center bg-soot-50 gap-4">
          <h2 className="text-xl font-bold text-soot-900 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-soot-500" /> Sales & Reporting
          </h2>
          
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-soot-700">
              <input type="checkbox" checked={includeArchived} onChange={() => setIncludeArchived(v => !v)} className="rounded border-soot-300 text-brand-600 focus:ring-brand-500" />
              Include archived
            </label>
            <select 
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value)}
              className="bg-white border border-soot-200 text-sm font-medium text-soot-700 rounded-lg px-3 py-2 flex-1 focus:ring-2 focus:ring-brand-500 focus:outline-none"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="year">This Year</option>
              <option value="custom">Custom Range</option>
            </select>

            {isOwner && (
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="bg-white border border-soot-200 text-sm font-medium text-soot-700 rounded-lg px-3 py-2 flex-1 focus:ring-2 focus:ring-brand-500 focus:outline-none"
              >
                <option value="all">All Branches</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            )}

            {timeFilter === 'custom' && (
              <div className="flex items-center gap-2">
                <input 
                  type="date" 
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="bg-white border border-soot-200 rounded-lg px-2 py-1.5 text-sm"
                />
                <span className="text-soot-400">-</span>
                <input 
                  type="date" 
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="bg-white border border-soot-200 rounded-lg px-2 py-1.5 text-sm"
                />
              </div>
            )}

            <button onClick={fetchData} className="p-2 ml-1 text-soot-500 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors border border-transparent hover:border-brand-100">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Analytics Overview */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-soot-50 p-6 rounded-xl border border-soot-200 shadow-sm relative overflow-hidden">
            <div className="text-soot-500 font-semibold mb-1 uppercase tracking-widest text-xs">Total Sales</div>
            <div className="text-3xl font-bold text-soot-900">
              {loading ? '...' : formatCurrency(analytics?.total_sales || 0)}
            </div>
          </div>
          <div className="bg-soot-50 p-6 rounded-xl border border-soot-200 shadow-sm relative overflow-hidden">
            <div className="text-soot-500 font-semibold mb-1 uppercase tracking-widest text-xs">Transactions</div>
            <div className="text-3xl font-bold text-soot-900">
              {loading ? '...' : analytics?.total_transactions || 0}
            </div>
          </div>
          <div className="bg-soot-50 p-6 rounded-xl border border-soot-200 shadow-sm relative overflow-hidden flex flex-col justify-center">
            <div className="text-soot-500 font-semibold mb-1 uppercase tracking-widest text-xs">Top Selling Product</div>
            <div className="text-xl font-bold text-brand-700 truncate" title={analytics?.most_selling_product?.title}>
              {loading ? '...' : (analytics?.most_selling_product ? analytics.most_selling_product.title : 'None')}
            </div>
            {analytics?.most_selling_product && (
              <div className="text-sm font-medium text-soot-500 mt-1">
                {analytics.most_selling_product.total_sold} units sold
              </div>
            )}
          </div>
          
          {/* Recent Transactions */}
          <div className="col-span-full mt-2">
            <h3 className="text-lg font-bold text-soot-900 mb-4">Transactions</h3>
            {loading && sales.length === 0 ? (
               <div className="py-12 flex justify-center text-soot-400">
                 <Loader2 className="w-6 h-6 animate-spin" />
               </div>
            ) : sales.length === 0 ? (
              <div className="text-center py-12 text-soot-400 bg-soot-50 rounded-xl border border-soot-200">
                <p className="font-medium">No transactions found for this period.</p>
              </div>
            ) : (
              <div className="border border-soot-200 rounded-xl overflow-hidden bg-white">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-soot-50 border-b border-soot-200 text-xs uppercase text-soot-500 font-semibold tracking-wider">
                      <th className="py-3 px-4">Transaction ID</th>
                      <th className="py-3 px-4">Date & Time</th>
                      <th className="py-3 px-4">Method</th>
                      <th className="py-3 px-4 text-center">Status</th>
                      <th className="py-3 px-4 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map((sale) => (
                      <tr 
                        key={sale.id} 
                        onClick={() => setSelectedSaleId(sale.id)}
                        className={`border-b border-soot-100 hover:bg-soot-50 cursor-pointer transition-colors ${sale.status === 'refunded' ? 'opacity-60' : ''} ${sale.archived_at ? 'bg-soot-50/70' : ''}`}
                      >
                        <td className="py-3 px-4 text-sm font-medium text-soot-900">#ORD-{sale.id}</td>
                        <td className="py-3 px-4 text-sm text-soot-600">{getFormatDate(sale.created_at)}</td>
                        <td className="py-3 px-4 text-sm text-soot-600 font-medium">{sale.payment_method}</td>
                        <td className="py-3 px-4 text-sm text-center">
                          {sale.status === 'refunded' ? (
                            <span className="bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded text-xs font-bold">REFUNDED</span>
                          ) : (
                            <span className="bg-emerald-50 text-emerald-600 border border-emerald-200 px-2 py-0.5 rounded text-xs font-bold">COMPLETED</span>
                          )}
                        </td>
                        <td className={`py-3 px-4 text-right font-medium text-soot-900 ${sale.status === 'refunded' ? 'line-through' : ''}`}>
                          {formatCurrency(sale.total_amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
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
