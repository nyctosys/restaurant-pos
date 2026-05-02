import { useState, useEffect, useLayoutEffect, useSyncExternalStore, useRef } from 'react';
import { Plus, Trash2, Loader2, Moon, Sun, ScrollText, Copy, Trash, Download, ChevronDown, ChevronUp, Archive, ArchiveRestore, LayoutGrid, List } from 'lucide-react';
import UsersSettings from '../components/settings/UsersSettings';
import ReceiptSettings from '../components/settings/ReceiptSettings';
import BranchesSettings from '../components/settings/BranchesSettings';
import TablesSettings from '../components/settings/TablesSettings';
import ModifiersSettings from '../components/settings/ModifiersSettings';
import appLogger, { type LogEntry } from '../utils/logger';
import { get, put, post, getUserMessage, getUserMessageWithRef } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import { showConfirm } from '../components/ConfirmDialog';
import SearchableSelect from '../components/SearchableSelect';

type SettingsResponse = { config?: Record<string, unknown> };

export default function Settings() {
  const [activeTab, setActiveTab] = useState('general');
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const settingsNavScrollRef = useRef<HTMLDivElement>(null);

  // ── Sections state ──
  const [sections, setSections] = useState<string[]>([]);
  const [newSection, setNewSection] = useState('');
  const [sectionsLoading, setSectionsLoading] = useState(false);
  const [sectionsSaving, setSectionsSaving] = useState(false);
  const [sectionsFeedback, setSectionsFeedback] = useState('');

  // ── General settings state ──
  const [generalLoading, setGeneralLoading] = useState(false);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [generalFeedback, setGeneralFeedback] = useState('');
  const [dashboardMenuLayout, setDashboardMenuLayout] = useState<'grid' | 'list'>('list');

  // ── Variants state ──
  const [variants, setVariants] = useState<string[]>([]);
  const [newVariant, setNewVariant] = useState('');
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantsSaving, setVariantsSaving] = useState(false);
  const [variantsFeedback, setVariantsFeedback] = useState('');
  const [editingVariantIndex, setEditingVariantIndex] = useState<number | null>(null);
  const [editingVariantValue, setEditingVariantValue] = useState('');
  
  // ── Tax settings state ──
  const [taxEnabled, setTaxEnabled] = useState<boolean>(true);
  const [taxPercentage, setTaxPercentage] = useState<number>(0);
  const [taxRatesByPaymentMethod, setTaxRatesByPaymentMethod] = useState<Record<string, number>>({
    Cash: 0,
    Card: 8,
    'Online Transfer': 8,
  });
  const [taxLoading, setTaxLoading] = useState(false);
  const [taxSaving, setTaxSaving] = useState(false);
  const [taxFeedback, setTaxFeedback] = useState('');
  const PAYMENT_METHODS = ['Cash', 'Card', 'Online Transfer'];

  // ── Hardware settings state ──
  const [hardware, setHardware] = useState({
    receipt_printer_mode: 'lan',
    receipt_printer_ip: '',
    receipt_printer_port: 9100,
    receipt_printer_vendor_id: '',
    receipt_printer_product_id: '',
    kot_printer_mode: 'lan',
    kot_printer_ip: '',
    kot_printer_port: 9100,
    kot_printer_vendor_id: '',
    kot_printer_product_id: '',
    paper_width: '80mm',
  });
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [hardwareSaving, setHardwareSaving] = useState(false);
  const [hardwareFeedback, setHardwareFeedback] = useState('');
  const [testPrintLoading, setTestPrintLoading] = useState(false);
  const [testKotPrintLoading, setTestKotPrintLoading] = useState(false);

  // ── Discounts state ──
  type DiscountItem = { id: string; name: string; type: 'percent' | 'fixed'; value: number; archived?: boolean };
  const [discounts, setDiscounts] = useState<DiscountItem[]>([]);
  const [discountsLoading, setDiscountsLoading] = useState(false);
  const [discountsSaving, setDiscountsSaving] = useState(false);
  const [discountsFeedback, setDiscountsFeedback] = useState('');
  const [discountsIncludeArchived, setDiscountsIncludeArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<DiscountItem | null>(null);
  const [newDiscount, setNewDiscount] = useState<{ name: string; type: 'percent' | 'fixed'; value: number }>({ name: '', type: 'percent', value: 0 });

  // Basic role check
  useEffect(() => {
    const userStr = localStorage.getItem('user');
    const user = userStr ? JSON.parse(userStr) : null;
    if (user?.role !== 'owner' && user?.role !== 'manager') {
      window.location.href = '/dashboard'; // Redirect non-owners/managers
    }
  }, []);

  /** Avoid scroll restoration leaving the tab list scrolled to “App Logs” at the bottom */
  useLayoutEffect(() => {
    settingsNavScrollRef.current?.scrollTo(0, 0);
  }, []);

  const user = parseUserFromStorage();
  const isOwner = user?.role === 'owner';
  const activeBranchId = getTerminalBranchIdString(user);

  const tabs = ['General', 'Receipt', 'Hardware', 'Categories', 'Variants', 'Tables', 'Modifiers', 'Tax & Rates', 'Discounts'];
  if (isOwner) {
    tabs.push('Users');
  }
  if (isOwner || user?.role === 'manager') {
    tabs.push('Branches');
  }
  tabs.push('App Logs');

  // Fetch settings on mount
  useEffect(() => {
    if (activeTab === 'general') {
      void fetchGeneralSettings();
    } else if (activeTab === 'categories') {
      fetchSections();
    } else if (activeTab === 'variants') {
      fetchVariants();
    } else if (activeTab === 'taxrates') {
      fetchTaxSettings();
    } else if (activeTab === 'hardware') {
      fetchHardwareSettings();
    } else if (activeTab === 'discounts') {
      fetchDiscounts();
    }
  }, [activeTab]);

  const fetchGeneralSettings = async () => {
    setGeneralLoading(true);
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const config = (data?.config ?? {}) as Record<string, unknown>;
      setDashboardMenuLayout(config.dashboard_menu_layout === 'grid' ? 'grid' : 'list');
    } catch {
      setDashboardMenuLayout('list');
    } finally {
      setGeneralLoading(false);
    }
  };

  const saveGeneralSettings = async () => {
    setGeneralSaving(true);
    setGeneralFeedback('');
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: {
          ...currentConfig,
          dashboard_menu_layout: dashboardMenuLayout,
        },
      };
      if (activeBranchId) {
        payload.branch_id = parseInt(activeBranchId, 10);
      }
      await put('/settings/', payload);
      setGeneralFeedback('General settings saved!');
      setTimeout(() => setGeneralFeedback(''), 2000);
    } catch (e) {
      setGeneralFeedback('error:' + getUserMessage(e));
    } finally {
      setGeneralSaving(false);
    }
  };

  const fetchSections = async () => {
    setSectionsLoading(true);
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const sectionsList = data.config?.sections;
      setSections(Array.isArray(sectionsList) ? sectionsList : []);
    } catch {
      setSections([]);
    } finally {
      setSectionsLoading(false);
    }
  };

  const saveSections = async (updatedSections: string[]) => {
    setSectionsSaving(true);
    setSectionsFeedback('');
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: { ...currentConfig, sections: updatedSections },
      };
      if (activeBranchId) {
        payload.branch_id = parseInt(activeBranchId, 10);
      }
      await put('/settings/', payload);
      setSections(updatedSections);
      setSectionsFeedback('Categories saved!');
      setTimeout(() => setSectionsFeedback(''), 2000);
    } catch (e) {
      setSectionsFeedback('error:' + getUserMessage(e));
    } finally {
      setSectionsSaving(false);
    }
  };

  const handleAddSection = () => {
    const trimmed = newSection.trim();
    if (!trimmed || sections.includes(trimmed)) return;
    const updated = [...sections, trimmed];
    setNewSection('');
    saveSections(updated);
  };

  const handleRemoveSection = (section: string) => {
    const updated = sections.filter(s => s !== section);
    saveSections(updated);
  };

  const fetchVariants = async () => {
    setVariantsLoading(true);
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const list = data.config?.variants;
      setVariants(Array.isArray(list) ? list : []);
      setEditingVariantIndex(null);
    } catch {
      setVariants([]);
    } finally {
      setVariantsLoading(false);
    }
  };

  const saveVariants = async (updated: string[]) => {
    setVariantsSaving(true);
    setVariantsFeedback('');
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: { ...currentConfig, variants: updated },
      };
      if (activeBranchId) {
        payload.branch_id = parseInt(activeBranchId, 10);
      }
      await put('/settings/', payload);
      setVariants(updated);
      setVariantsFeedback('Variants saved!');
      setTimeout(() => setVariantsFeedback(''), 2000);
      setEditingVariantIndex(null);
    } catch (e) {
      setVariantsFeedback('error:' + getUserMessage(e));
    } finally {
      setVariantsSaving(false);
    }
  };

  const handleAddVariant = () => {
    const trimmed = newVariant.trim();
    if (!trimmed || variants.includes(trimmed)) return;
    saveVariants([...variants, trimmed]);
    setNewVariant('');
  };

  const handleRemoveVariant = (variant: string) => {
    saveVariants(variants.filter(v => v !== variant));
  };

  const handleStartEditVariant = (index: number) => {
    setEditingVariantIndex(index);
    setEditingVariantValue(variants[index] ?? '');
  };

  const handleUpdateVariant = () => {
    const trimmed = editingVariantValue.trim();
    if (editingVariantIndex === null || !trimmed) return;
    if (variants.some((v, i) => i !== editingVariantIndex && v === trimmed)) {
      setVariantsFeedback('error: A variant with this name already exists.');
      return;
    }
    const updated = [...variants];
    updated[editingVariantIndex] = trimmed;
    saveVariants(updated);
    setEditingVariantIndex(null);
  };

  const fetchDiscounts = async () => {
    setDiscountsLoading(true);
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const list = data.config?.discounts;
      setDiscounts(Array.isArray(list) ? list : []);
    } catch {
      setDiscounts([]);
    } finally {
      setDiscountsLoading(false);
    }
  };

  const saveDiscounts = async (updatedList: DiscountItem[]) => {
    setDiscountsSaving(true);
    setDiscountsFeedback('');
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: { ...currentConfig, discounts: updatedList },
      };
      if (activeBranchId) {
        payload.branch_id = parseInt(activeBranchId, 10);
      }
      await put('/settings/', payload);
      setDiscounts(updatedList);
      setDiscountsFeedback('Discounts saved!');
      setTimeout(() => setDiscountsFeedback(''), 2000);
      setEditingId(null);
    } catch (e) {
      setDiscountsFeedback('error:' + getUserMessage(e));
    } finally {
      setDiscountsSaving(false);
    }
  };

  const handleAddDiscount = () => {
    const name = newDiscount.name.trim();
    if (!name) return;
    const value = newDiscount.type === 'percent' ? Math.min(100, Math.max(0, newDiscount.value)) : Math.max(0, newDiscount.value);
    const id = crypto.randomUUID ? crypto.randomUUID() : `discount-${Date.now()}`;
    const updated = [...discounts, { id, name, type: newDiscount.type, value }];
    setNewDiscount({ name: '', type: 'percent', value: 0 });
    saveDiscounts(updated);
  };

  const handleStartEditDiscount = (d: DiscountItem) => {
    setEditingId(d.id);
    setEditingDraft({ ...d });
  };

  const handleUpdateDiscount = (updatedList: DiscountItem[]) => {
    saveDiscounts(updatedList);
    setEditingId(null);
    setEditingDraft(null);
  };

  const handleArchiveDiscount = (d: DiscountItem) => {
    saveDiscounts(discounts.map(x => x.id === d.id ? { ...x, archived: true } : x));
    setEditingId(null);
  };

  const handleRestoreDiscount = (d: DiscountItem) => {
    saveDiscounts(discounts.map(x => x.id === d.id ? { ...x, archived: false } : x));
    setEditingId(null);
  };

  const handlePermanentDeleteDiscount = async (d: DiscountItem) => {
    const confirmed = await showConfirm({
      title: 'Permanently delete discount?',
      message: `"${d.name}" will be removed from the list. This cannot be undone.`,
      relatedEffects: ['This discount will no longer be available at checkout.'],
      confirmLabel: 'Delete permanently',
      variant: 'danger',
    });
    if (!confirmed) return;
    saveDiscounts(discounts.filter(x => x.id !== d.id));
    setEditingId(null);
  };

  const fetchTaxSettings = async () => {
    setTaxLoading(true);
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const config = (data?.config ?? {}) as Record<string, unknown>;
      setTaxEnabled(config.tax_enabled !== false);
      setTaxPercentage((config.tax_percentage as number) ?? 8);
      const rates = config.tax_rates_by_payment_method as Record<string, number> | undefined;
      setTaxRatesByPaymentMethod({
        Cash: rates?.Cash ?? 0,
        Card: rates?.Card ?? 8,
        'Online Transfer': rates?.['Online Transfer'] ?? 8,
      });
    } catch {
      setTaxRatesByPaymentMethod({ Cash: 0, Card: 8, 'Online Transfer': 8 });
    } finally {
      setTaxLoading(false);
    }
  };

  const saveTaxSettings = async () => {
    setTaxSaving(true);
    setTaxFeedback('');
    try {
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: {
          ...currentConfig,
          tax_enabled: taxEnabled,
          tax_percentage: taxPercentage,
          tax_rates_by_payment_method: { ...taxRatesByPaymentMethod },
        },
      };
      if (activeBranchId) payload.branch_id = parseInt(activeBranchId, 10);
      await put('/settings/', payload);
      setTaxFeedback('Tax settings saved!');
      setTimeout(() => setTaxFeedback(''), 2000);
    } catch (e) {
      setTaxFeedback('error:' + getUserMessage(e));
    } finally {
      setTaxSaving(false);
    }
  };

  const fetchHardwareSettings = async () => {
    setHardwareLoading(true);
    try {
      const data = await get<SettingsResponse>('/settings/?global_only=1');
      const h = data.config?.hardware as Record<string, string | number | undefined> | undefined;
      const legacyMode = (String(h?.printer_connection_type || '').toLowerCase() === 'lan') ? 'lan' : 'usb';
      const receiptMode = (String(h?.receipt_printer_mode || '').toLowerCase() === 'usb')
        ? 'usb'
        : (String(h?.receipt_printer_mode || '').toLowerCase() === 'lan' ? 'lan' : legacyMode || 'lan');
      const kotModeRaw = String(h?.kot_printer_mode || '').toLowerCase();
      const kotMode = kotModeRaw === 'usb' || kotModeRaw === 'lan' ? kotModeRaw : receiptMode;
      setHardware({
        receipt_printer_mode: receiptMode,
        receipt_printer_ip: String(h?.receipt_printer_ip ?? ''),
        receipt_printer_port: Number(h?.receipt_printer_port ?? 9100) || 9100,
        receipt_printer_vendor_id: String(h?.receipt_printer_vendor_id ?? h?.printer_vendor_id ?? ''),
        receipt_printer_product_id: String(h?.receipt_printer_product_id ?? h?.printer_product_id ?? ''),
        kot_printer_mode: kotMode,
        kot_printer_ip: String(h?.kot_printer_ip ?? h?.receipt_printer_ip ?? ''),
        kot_printer_port: Number(h?.kot_printer_port ?? h?.receipt_printer_port ?? 9100) || 9100,
        kot_printer_vendor_id: String(h?.kot_printer_vendor_id ?? h?.receipt_printer_vendor_id ?? h?.printer_vendor_id ?? ''),
        kot_printer_product_id: String(h?.kot_printer_product_id ?? h?.receipt_printer_product_id ?? h?.printer_product_id ?? ''),
        paper_width: String(h?.paper_width ?? '80mm'),
      });
    } catch {
      setHardware({
        receipt_printer_mode: 'lan',
        receipt_printer_ip: '',
        receipt_printer_port: 9100,
        receipt_printer_vendor_id: '',
        receipt_printer_product_id: '',
        kot_printer_mode: 'lan',
        kot_printer_ip: '',
        kot_printer_port: 9100,
        kot_printer_vendor_id: '',
        kot_printer_product_id: '',
        paper_width: '80mm',
      });
    } finally {
      setHardwareLoading(false);
    }
  };

  const saveHardwareSettings = async () => {
    setHardwareSaving(true);
    setHardwareFeedback('');
    try {
      const existing = await get<SettingsResponse>('/settings/?global_only=1');
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      await put('/settings/', { config: { ...currentConfig, hardware }, branch_id: null });
      setHardwareFeedback('Hardware settings saved!');
      setTimeout(() => setHardwareFeedback(''), 2000);
    } catch (e) {
      setHardwareFeedback('error:' + getUserMessage(e));
    } finally {
      setHardwareSaving(false);
    }
  };

  const handleTestPrint = async () => {
    setTestPrintLoading(true);
    setHardwareFeedback('');
    try {
      await saveHardwareSettings();
      const data = await post<{ success?: boolean; message?: string }>('/printer/test-print', {});
      if (data?.success) {
        setHardwareFeedback('Test print job sent successfully!');
      } else {
        setHardwareFeedback('error:' + (data?.message ?? 'Printer not reachable'));
      }
    } catch (e) {
      setHardwareFeedback('error:' + getUserMessage(e));
    } finally {
      setTestPrintLoading(false);
    }
  };

  const handleTestKotPrint = async () => {
    setTestKotPrintLoading(true);
    setHardwareFeedback('');
    try {
      await saveHardwareSettings();
      const data = await post<{ success?: boolean; message?: string }>('/printer/test-kot-print', {});
      if (data?.success) {
        setHardwareFeedback('Test KOT print job sent successfully!');
      } else {
        setHardwareFeedback('error:' + (data?.message ?? 'KOT printer not reachable'));
      }
    } catch (e) {
      setHardwareFeedback('error:' + getUserMessage(e));
    } finally {
      setTestKotPrintLoading(false);
    }
  };

  return (
    <div className="flex h-full max-h-full min-h-0 flex-col overflow-hidden bg-transparent 2xl:flex-row">
      
      {/* Sidebar Nav — scrollable on short viewports; xl+ wider rail */}
      <div
        ref={settingsNavScrollRef}
        className="w-full shrink-0 overflow-x-auto border-b border-white/20 p-3 2xl:m-2 2xl:min-h-0 2xl:w-64 2xl:min-w-64 2xl:overflow-x-hidden 2xl:overflow-y-auto 2xl:border-b-0 2xl:border-r 2xl:p-4 glass-card"
      >
        <h2 className="sr-only 2xl:not-sr-only 2xl:text-lg 2xl:font-bold 2xl:text-soot-900 2xl:mb-6 2xl:px-4">System Settings</h2>
        <nav className="flex min-w-max gap-2 2xl:min-w-0 2xl:flex-col 2xl:gap-1" aria-label="System settings sections">
          {tabs.map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab.toLowerCase().replace(/ & | /g, ''))}
              className={`min-h-[44px] whitespace-nowrap rounded-lg px-3 py-2.5 text-center font-medium transition-colors sm:px-4 2xl:w-full 2xl:text-left 2xl:py-3 ${
                activeTab === tab.toLowerCase().replace(/ & | /g, '')
                  ? 'bg-soot-200 text-soot-900'
                  : 'text-soot-600 hover:bg-soot-100'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* Main Settings Area */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain page-padding 2xl:py-8">
        
        {activeTab === 'general' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-6">General Settings</h3>
            <div className="space-y-6">
              <div className="glass-card p-4 sm:p-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h4 className="font-semibold text-soot-900 mb-1">Global Theme</h4>
                  <p className="text-sm text-soot-500">Toggle between light and dark modes across the app.</p>
                </div>
                <button 
                  onClick={() => {
                     const html = document.documentElement;
                     if(html.classList.contains('dark')) {
                        html.classList.remove('dark');
                        localStorage.theme = 'light';
                        setIsDark(false);
                     } else {
                        html.classList.add('dark');
                        localStorage.theme = 'dark';
                        setIsDark(true);
                     }
                  }}
                  className="p-3 glass-card text-soot-700 hover:bg-white/35 transition-colors"
                  title="Toggle Theme"
                >
                  {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                </button>
              </div>

              <div className="glass-card p-4 sm:p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb-4">
                  <div>
                    <h4 className="font-semibold text-soot-900 mb-1">Dashboard Menu Layout</h4>
                    <p className="text-sm text-soot-500">Choose the default menu presentation for the Dashboard.</p>
                  </div>
                  {generalLoading && (
                    <div className="flex items-center gap-2 text-sm text-soot-400">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading…
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setDashboardMenuLayout('list')}
                    className={`rounded-xl border px-4 py-4 text-left transition-all ${dashboardMenuLayout === 'list' ? 'border-brand-500 bg-brand-50 text-brand-800 shadow-sm' : 'border-soot-200 bg-white/70 text-soot-600 hover:border-brand-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <List className="w-4 h-4" />
                      <span className="font-semibold">List view</span>
                    </div>
                    <p className="text-sm text-current/80">Best for faster scanning and denser menu browsing.</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDashboardMenuLayout('grid')}
                    className={`rounded-xl border px-4 py-4 text-left transition-all ${dashboardMenuLayout === 'grid' ? 'border-brand-500 bg-brand-50 text-brand-800 shadow-sm' : 'border-soot-200 bg-white/70 text-soot-600 hover:border-brand-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <LayoutGrid className="w-4 h-4" />
                      <span className="font-semibold">Card view</span>
                    </div>
                    <p className="text-sm text-current/80">Shows larger item cards and photos in a grid.</p>
                  </button>
                </div>

                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className={`text-sm ${generalFeedback.startsWith('error:') ? 'text-red-600' : 'text-soot-500'}`}>
                    {generalFeedback ? (generalFeedback.startsWith('error:') ? generalFeedback.replace(/^error:/, '') : generalFeedback) : 'Saved per branch terminal settings.'}
                  </div>
                  <button
                    type="button"
                    onClick={saveGeneralSettings}
                    disabled={generalSaving || generalLoading}
                    className="min-h-[44px] px-4 py-2.5 rounded-lg bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-60 transition-colors"
                  >
                    {generalSaving ? 'Saving…' : 'Save layout'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'receipt' && <ReceiptSettings />}
        {activeTab === 'users' && <UsersSettings />}
        {activeTab === 'branches' && <BranchesSettings />}
        {activeTab === 'tables' && <TablesSettings />}
        {activeTab === 'modifiers' && <ModifiersSettings />}

        {activeTab === 'hardware' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-6">Hardware Configuration</h3>
            <div className="space-y-6">
              <div className="glass-card p-4 sm:p-6">
                <h4 className="font-semibold text-soot-900 mb-4">Thermal Printers (Receipt + KOT)</h4>
                
                {hardwareLoading ? (
                  <div className="flex items-center gap-2 text-soot-400 py-6">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Loading hardware config…
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-soot-500 mb-4">
                      Configure dedicated printers for customer receipts and KOT tickets. LAN mode supports separate network printers (recommended), and USB mode remains available for local setups.
                    </p>

                    <div className="rounded-lg border border-soot-200 p-4 space-y-3">
                      <h5 className="text-sm font-semibold text-soot-900">Order Receipt Printer</h5>
                      <div>
                        <label className="block text-sm font-medium text-soot-800 mb-1">Connection Type</label>
                        <SearchableSelect
                          value={hardware.receipt_printer_mode}
                          onChange={(value) => setHardware({ ...hardware, receipt_printer_mode: value })}
                          searchPlaceholder="Search connection types…"
                          options={[
                            { value: 'lan', label: 'LAN (IP + Port)' },
                            { value: 'usb', label: 'USB (Vendor/Product ID)' },
                          ]}
                          className="glass-card border-0 px-4 py-3"
                        />
                      </div>

                      {hardware.receipt_printer_mode === 'lan' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">Printer IP / Host</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.receipt_printer_ip}
                              onChange={e => setHardware({ ...hardware, receipt_printer_ip: e.target.value })}
                              placeholder="e.g. 192.168.1.50"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">Port</label>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              value={hardware.receipt_printer_port}
                              onChange={e => setHardware({ ...hardware, receipt_printer_port: Number(e.target.value) || 9100 })}
                              placeholder="9100"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">USB Vendor ID</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.receipt_printer_vendor_id}
                              onChange={e => setHardware({ ...hardware, receipt_printer_vendor_id: e.target.value })}
                              placeholder="e.g. 0x04b8"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">USB Product ID</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.receipt_printer_product_id}
                              onChange={e => setHardware({ ...hardware, receipt_printer_product_id: e.target.value })}
                              placeholder="e.g. 0x0202"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-soot-200 p-4 space-y-3 mt-4">
                      <h5 className="text-sm font-semibold text-soot-900">KOT Printer</h5>
                      <div>
                        <label className="block text-sm font-medium text-soot-800 mb-1">Connection Type</label>
                        <SearchableSelect
                          value={hardware.kot_printer_mode}
                          onChange={(value) => setHardware({ ...hardware, kot_printer_mode: value })}
                          searchPlaceholder="Search connection types…"
                          options={[
                            { value: 'lan', label: 'LAN (IP + Port)' },
                            { value: 'usb', label: 'USB (Vendor/Product ID)' },
                          ]}
                          className="glass-card border-0 px-4 py-3"
                        />
                      </div>

                      {hardware.kot_printer_mode === 'lan' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">Printer IP / Host</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.kot_printer_ip}
                              onChange={e => setHardware({ ...hardware, kot_printer_ip: e.target.value })}
                              placeholder="e.g. 192.168.1.51"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">Port</label>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={1}
                              value={hardware.kot_printer_port}
                              onChange={e => setHardware({ ...hardware, kot_printer_port: Number(e.target.value) || 9100 })}
                              placeholder="9100"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">USB Vendor ID</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.kot_printer_vendor_id}
                              onChange={e => setHardware({ ...hardware, kot_printer_vendor_id: e.target.value })}
                              placeholder="e.g. 0x04b8"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-soot-800 mb-1">USB Product ID</label>
                            <input
                              type="text"
                              inputMode="text"
                              value={hardware.kot_printer_product_id}
                              onChange={e => setHardware({ ...hardware, kot_printer_product_id: e.target.value })}
                              placeholder="e.g. 0x0202"
                              className="w-full px-4 py-3 glass-card font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="mt-4">
                   <div>
                     <label className="block text-sm font-medium text-soot-800 mb-1">Paper Width</label>
                     <SearchableSelect
                       value={hardware.paper_width}
                       onChange={(value) => setHardware({ ...hardware, paper_width: value })}
                       searchPlaceholder="Search paper widths…"
                       options={[
                         { value: '58mm', label: '58mm' },
                         { value: '80mm', label: '80mm' },
                       ]}
                       className="glass-card border-0 px-4 py-3"
                     />
                   </div>
                </div>

                {hardwareFeedback && (
                  <div className={`mt-6 text-sm font-medium rounded-lg px-4 py-3 border ${
                    hardwareFeedback.startsWith('error:')
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : 'bg-brand-50 text-brand-700 border-brand-200'
                  }`}>
                    {hardwareFeedback.replace('error:', '')}
                  </div>
                )}

                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                  <button 
                    onClick={saveHardwareSettings}
                    disabled={hardwareSaving}
                    className="min-h-[44px] justify-center bg-brand-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm flex items-center gap-2"
                  >
                    {hardwareSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                    Save Hardware Config
                  </button>
                  <button 
                    onClick={handleTestPrint}
                    disabled={testPrintLoading || testKotPrintLoading || hardwareSaving}
                    className="min-h-[44px] justify-center bg-white border text-soot-700 border-soot-300 px-6 py-2 rounded-lg text-sm font-medium hover:bg-soot-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                  >
                    {testPrintLoading && <Loader2 className="w-4 h-4 animate-spin text-soot-500" />}
                    Test Receipt Printer
                  </button>
                  <button 
                    onClick={handleTestKotPrint}
                    disabled={testKotPrintLoading || testPrintLoading || hardwareSaving}
                    className="min-h-[44px] justify-center bg-white border text-soot-700 border-soot-300 px-6 py-2 rounded-lg text-sm font-medium hover:bg-soot-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                  >
                    {testKotPrintLoading && <Loader2 className="w-4 h-4 animate-spin text-soot-500" />}
                    Test KOT Printer
                  </button>
                </div>
                </>
              )}
              </div>

              <div className="glass-card p-4 sm:p-6 text-sm">
                <h4 className="font-semibold text-soot-900 mb-2 border-b border-soot-200 pb-2">Barcode Scanner Tips</h4>
                <p className="text-soot-600 mb-3">
                  This POS supports standard USB barcode scanners acting as a <strong>keyboard wedge</strong>. 
                </p>
                <ul className="list-disc pl-5 space-y-1 text-soot-600">
                   <li>Ensure the scanner is connected via USB to the POS terminal.</li>
                   <li>The scanner must be configured to append a <strong>Carriage Return (Enter)</strong> after scanning payloads.</li>
                   <li>No special driver installation is required within the app. Just plug, and start scanning!</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ───────── Sections Management ───────── */}
        {activeTab === 'categories' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-2">Menu Categories</h3>
            <p className="text-sm text-soot-500 mb-6">Manage the menu categories that appear on the Order and Stock pages.</p>

            {/* Add new category */}
            <div className="flex flex-col gap-2 mb-6 sm:flex-row">
              <input
                type="text"
                inputMode="text"
                value={newSection}
                onChange={e => setNewSection(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddSection()}
                placeholder="e.g. Mains, Sides, Drinks…"
                className="flex-1 px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
              />
              <button
                onClick={handleAddSection}
                disabled={!newSection.trim() || sectionsSaving}
                className="flex min-h-[44px] items-center justify-center gap-2 bg-brand-700 text-white px-5 py-3 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {/* Feedback */}
            {sectionsFeedback && (
              <div className={`mb-4 text-sm font-medium rounded-lg px-4 py-2 ${
                sectionsFeedback.startsWith('error:')
                  ? 'text-red-700 bg-red-50 border border-red-200'
                  : 'text-brand-700 bg-brand-50 border border-brand-200'
              }`}>
                {sectionsFeedback.replace('error:', '')}
              </div>
            )}

            {/* List */}
            {sectionsLoading ? (
              <div className="flex items-center gap-2 text-soot-400 py-6">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading categories…
              </div>
            ) : sections.length === 0 ? (
              <div className="text-soot-400 py-8 text-center border border-dashed border-soot-200 rounded-xl">
                No categories yet. Add your first category above.
              </div>
            ) : (
              <div className="space-y-2">
                {sections.map(sec => (
                  <div
                    key={sec}
                    className="flex items-center justify-between gap-3 px-4 py-3 glass-card group hover:border-soot-200 transition-colors"
                  >
                    <span className="font-medium text-soot-800">{sec}</span>
                    <button
                      onClick={() => handleRemoveSection(sec)}
                      disabled={sectionsSaving}
                      className="text-soot-300 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50"
                      title={`Remove ${sec}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ───────── Variants Management ───────── */}
        {activeTab === 'variants' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-2">Product Variants (Options)</h3>
            <p className="text-sm text-soot-500 mb-6">Manage variant names (e.g. Small, Medium, Large) used when adding or editing menu items. These options appear in Inventory when assigning variants to products.</p>

            <div className="flex flex-col gap-2 mb-6 sm:flex-row">
              <input
                type="text"
                inputMode="text"
                value={newVariant}
                onChange={e => setNewVariant(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddVariant()}
                placeholder="e.g. Small, Medium, Large…"
                className="flex-1 px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
              />
              <button
                onClick={handleAddVariant}
                disabled={!newVariant.trim() || variantsSaving || variants.includes(newVariant.trim())}
                className="flex min-h-[44px] items-center justify-center gap-2 bg-brand-700 text-white px-5 py-3 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {variantsFeedback && (
              <div className={`mb-4 text-sm font-medium rounded-lg px-4 py-2 ${
                variantsFeedback.startsWith('error:')
                  ? 'text-red-700 bg-red-50 border border-red-200'
                  : 'text-brand-700 bg-brand-50 border border-brand-200'
              }`}>
                {variantsFeedback.replace('error:', '')}
              </div>
            )}

            {variantsLoading ? (
              <div className="flex items-center gap-2 text-soot-400 py-6">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading variants…
              </div>
            ) : variants.length === 0 ? (
              <div className="text-soot-400 py-8 text-center border border-dashed border-soot-200 rounded-xl">
                No variants yet. Add variant names above; they will be available when creating or editing menu items.
              </div>
            ) : (
              <div className="space-y-2">
                {variants.map((v, index) => (
                  <div
                    key={`${v}-${index}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 glass-card group hover:border-soot-200 transition-colors"
                  >
                    {editingVariantIndex === index ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="text"
                          inputMode="text"
                          value={editingVariantValue}
                          onChange={e => setEditingVariantValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleUpdateVariant();
                            if (e.key === 'Escape') setEditingVariantIndex(null);
                          }}
                          className="flex-1 px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                          autoFocus
                        />
                        <button
                          onClick={handleUpdateVariant}
                          disabled={variantsSaving || !editingVariantValue.trim()}
                          className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                        >
                          Done
                        </button>
                        <button
                          onClick={() => setEditingVariantIndex(null)}
                          className="text-sm text-soot-500 hover:text-soot-700"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="font-medium text-soot-800">{v}</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleStartEditVariant(index)}
                            disabled={variantsSaving}
                            className="text-soot-400 hover:text-brand-600 p-1 rounded-md hover:bg-brand-50 text-sm"
                            title="Rename"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleRemoveVariant(v)}
                            disabled={variantsSaving}
                            className="text-soot-300 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50"
                            title={`Remove ${v}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ───────── Tax & Rates Management ───────── */}
        {activeTab === 'taxrates' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-2">Tax & Rates</h3>
            <p className="text-sm text-soot-500 mb-6">Enable or disable tax. When on, set a tax rate per payment method; tax is calculated at checkout and printed on receipts.</p>

            {taxLoading ? (
              <div className="flex items-center gap-2 text-soot-400 py-6">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading settings…
              </div>
            ) : (
              <div className="space-y-6">
                {/* Taxes on/off toggle */}
                <div className="glass-card p-4 sm:p-6">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-soot-800">Taxes enabled</p>
                      <p className="text-xs text-soot-500 mt-0.5">When off, no tax is applied or shown on receipts.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={taxEnabled}
                      onClick={() => setTaxEnabled(v => !v)}
                      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                        taxEnabled ? 'bg-brand-600 border-brand-600' : 'bg-soot-200 border-soot-200'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${
                          taxEnabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                        style={{ marginTop: 2 }}
                      />
                    </button>
                  </div>
                </div>

                {/* Per–payment method rates (only when tax enabled) */}
                {taxEnabled && (
                  <div className="glass-card p-4 sm:p-6 space-y-4">
                    <label className="block text-sm font-semibold text-soot-800">Tax rate by payment method (%)</label>
                    <p className="text-xs text-soot-500 -mt-2">Each payment method can have a different tax percentage.</p>
                    {PAYMENT_METHODS.map(method => (
                      <div key={method} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <span className="text-sm font-medium text-soot-700">{method}</span>
                        <div className="flex items-center gap-2 sm:justify-end">
                          <input
                            type="number"
                            inputMode="decimal"
                            step="0.01"
                            min="0"
                            value={taxRatesByPaymentMethod[method] ?? 0}
                            onChange={(e) => setTaxRatesByPaymentMethod(prev => ({ ...prev, [method]: parseFloat(e.target.value) || 0 }))}
                            className="w-full sm:w-24 px-3 py-2 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-right font-medium"
                          />
                          <span className="text-soot-400 font-medium">%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {taxFeedback && (
                  <div className={`text-sm font-medium rounded-lg px-4 py-2 ${
                    taxFeedback.startsWith('error:')
                      ? 'text-red-700 bg-red-50 border border-red-200'
                      : 'text-brand-700 bg-brand-50 border border-brand-200'
                  }`}>
                    {taxFeedback.replace('error:', '')}
                  </div>
                )}

                <button 
                  onClick={saveTaxSettings}
                  disabled={taxSaving}
                  className="min-h-[44px] justify-center bg-brand-700 text-white px-8 py-3 rounded-lg font-bold hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-sm flex items-center gap-2"
                >
                  {taxSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Save Tax Configuration
                </button>
              </div>
            )}
          </div>
        )}

        {/* ───────── Discounts Management ───────── */}
        {activeTab === 'discounts' && (
          <div className="max-w-2xl xl:max-w-3xl">
            <h3 className="text-2xl font-bold text-soot-900 mb-2">Discounts</h3>
            <p className="text-sm text-soot-500 mb-6">Reusable discount presets for use at checkout.</p>

            <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-soot-700 mb-4">
              <input type="checkbox" checked={discountsIncludeArchived} onChange={() => setDiscountsIncludeArchived(v => !v)} className="rounded border-soot-300 text-brand-600 focus:ring-brand-500" />
              Include archived
            </label>

            {/* Add new discount */}
            <div className="flex flex-wrap gap-3 mb-6 items-end">
              <input
                type="text"
                inputMode="text"
                value={newDiscount.name}
                onChange={e => setNewDiscount(prev => ({ ...prev, name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && handleAddDiscount()}
                placeholder="e.g. Happy Hour 10%"
                className="flex-1 min-w-[140px] px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
              />
              <div className="min-w-[12rem]">
                <SearchableSelect
                  value={newDiscount.type}
                  onChange={value => setNewDiscount(prev => ({ ...prev, type: value as 'percent' | 'fixed' }))}
                  searchPlaceholder="Search discount types…"
                  options={[
                    { value: 'fixed', label: 'Fixed amount' },
                    { value: 'percent', label: 'Percent' },
                  ]}
                  className="border-soot-200 px-4 py-3 text-sm"
                />
              </div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={newDiscount.type === 'percent' ? 100 : undefined}
                  step={newDiscount.type === 'percent' ? 1 : 0.01}
                  value={newDiscount.value || ''}
                  onChange={e => setNewDiscount(prev => ({ ...prev, value: parseFloat(e.target.value) || 0 }))}
                  placeholder={newDiscount.type === 'percent' ? '10' : '5'}
                  className="w-24 px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm text-right"
                />
                <span className="text-soot-500 text-sm">{newDiscount.type === 'percent' ? '%' : 'currency'}</span>
              </div>
              <button
                onClick={handleAddDiscount}
                disabled={!newDiscount.name.trim() || discountsSaving}
                className="flex items-center gap-2 bg-brand-700 text-white px-5 py-3 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {discountsFeedback && (
              <div className={`mb-4 text-sm font-medium rounded-lg px-4 py-2 ${
                discountsFeedback.startsWith('error:')
                  ? 'text-red-700 bg-red-50 border border-red-200'
                  : 'text-brand-700 bg-brand-50 border border-brand-200'
              }`}>
                {discountsFeedback.replace('error:', '')}
              </div>
            )}

            {discountsLoading ? (
              <div className="flex items-center gap-2 text-soot-400 py-6">
                <Loader2 className="w-5 h-5 animate-spin" />
                Loading discounts…
              </div>
            ) : (() => {
              const displayList = discountsIncludeArchived ? discounts : discounts.filter(d => !d.archived);
              return displayList.length === 0 ? (
                <div className="text-soot-400 py-8 text-center border border-dashed border-soot-200 rounded-xl">
                  {discounts.length === 0 ? 'No discounts yet. Add your first discount above.' : "No active discounts. Enable 'Include archived' to see archived ones."}
                </div>
              ) : (
                <div className="space-y-2">
                  {displayList.map(d => (
                    <div
                      key={d.id}
                    className={`flex flex-col gap-3 px-4 py-3 rounded-lg border transition-colors sm:flex-row sm:items-center sm:justify-between ${d.archived ? 'bg-soot-50/70 border-soot-100 opacity-90' : 'bg-soot-50 border-soot-100 group hover:border-soot-200'}`}
                    >
                      {editingId === d.id && editingDraft ? (
                        <div className="flex flex-wrap gap-2 items-center flex-1">
                          <input
                            type="text"
                            inputMode="text"
                            value={editingDraft.name}
                            onChange={e => setEditingDraft(prev => prev ? { ...prev, name: e.target.value } : null)}
                            className="px-3 py-1.5 border border-soot-200 rounded text-sm w-32"
                          />
                          <div className="min-w-[10rem]">
                            <SearchableSelect
                              value={editingDraft.type}
                              onChange={value => setEditingDraft(prev => prev ? { ...prev, type: value as 'percent' | 'fixed' } : null)}
                              searchPlaceholder="Search discount types…"
                              options={[
                                { value: 'fixed', label: 'Fixed' },
                                { value: 'percent', label: 'Percent' },
                              ]}
                              className="border-soot-200 px-3 py-1.5 text-sm"
                            />
                          </div>
                          <input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            max={editingDraft.type === 'percent' ? 100 : undefined}
                            step={editingDraft.type === 'percent' ? 1 : 0.01}
                            value={editingDraft.value}
                            onChange={e => setEditingDraft(prev => prev ? { ...prev, value: parseFloat(e.target.value) || 0 } : null)}
                            className="px-3 py-1.5 border border-soot-200 rounded text-sm w-20 text-right"
                          />
                          <button
                            onClick={() => handleUpdateDiscount(discounts.map(x => x.id === editingDraft.id ? editingDraft : x))}
                            disabled={discountsSaving || !editingDraft.name.trim()}
                            className="text-sm text-brand-600 font-medium disabled:opacity-50"
                          >
                            Done
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="font-medium text-soot-800">{d.name}</span>
                            <span className="text-sm text-soot-500">
                              {d.type === 'percent' ? `${d.value}%` : `Rs.${d.value}`}
                            </span>
                            {d.archived && <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200">Archived</span>}
                          </div>
                          <div className="flex items-center gap-1">
                            {!d.archived && (
                              <button onClick={() => handleStartEditDiscount(d)} className="text-soot-400 hover:text-brand-600 p-1 rounded text-sm" title="Edit">Edit</button>
                            )}
                            {d.archived ? (
                              <>
                                <button onClick={() => handleRestoreDiscount(d)} disabled={discountsSaving} className="text-soot-400 hover:text-brand-600 p-1 rounded text-sm" title="Restore"><ArchiveRestore className="w-4 h-4 inline" /></button>
                                <button onClick={() => handlePermanentDeleteDiscount(d)} disabled={discountsSaving} className="text-soot-300 hover:text-red-500 p-1 rounded hover:bg-red-50" title="Delete permanently"><Trash2 className="w-4 h-4" /></button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => handleArchiveDiscount(d)} disabled={discountsSaving} className="text-soot-400 hover:text-amber-600 p-1 rounded text-sm" title="Archive"><Archive className="w-4 h-4 inline" /></button>
                                <button onClick={() => handlePermanentDeleteDiscount(d)} disabled={discountsSaving} className="text-soot-300 hover:text-red-500 p-1 rounded hover:bg-red-50" title="Delete permanently"><Trash2 className="w-4 h-4" /></button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        )}

        {activeTab === 'applogs' && <AppLogsPanel />}

        {/* Fallback for other tabs */}
        {!['general', 'hardware', 'categories', 'variants', 'tables', 'modifiers', 'taxrates', 'receipt', 'users', 'branches', 'applogs', 'discounts'].includes(activeTab) && (
           <div className="text-soot-500">Settings panel for {activeTab} coming soon.</div>
        )}

      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// App Logs Panel
// ────────────────────────────────────────────────────────

const LEVEL_STYLES: Record<string, string> = {
  info:  'text-blue-700 bg-blue-50 border-blue-200',
  warn:  'text-amber-700 bg-amber-50 border-amber-200',
  error: 'text-red-700 bg-red-50 border-red-200',
};

const LEVEL_DOT: Record<string, string> = {
  info:  'bg-blue-500',
  warn:  'bg-amber-500',
  error: 'bg-red-500',
};

type ServerAppEvent = {
  id: number;
  created_at: string | null;
  severity: string;
  source: string;
  category: string | null;
  message: string;
  requestId: string | null;
  user_id: number | null;
  branch_id: number | null;
  route: string | null;
  exc_type: string | null;
  stack_trace: string | null;
  context: unknown;
};

function serverEventToLogEntry(e: ServerAppEvent): LogEntry {
  const sev = e.severity === 'warn' || e.severity === 'info' || e.severity === 'error' ? e.severity : 'error';
  return {
    id: 1_000_000_000 + e.id,
    timestamp: e.created_at ?? new Date().toISOString(),
    level: sev,
    source: e.source === 'frontend' ? 'Server · client' : 'Server · backend',
    message: e.message,
    data: {
      route: e.route,
      category: e.category,
      exc_type: e.exc_type,
      stack_trace: e.stack_trace,
      context: e.context,
      user_id: e.user_id,
      branch_id: e.branch_id,
    },
    origin: 'server',
    requestId: e.requestId ?? undefined,
  };
}

function AppLogsPanel() {
  const getSnapshot = () => appLogger.getEntries();
  const subscribe = (cb: () => void) => appLogger.subscribe(cb);
  const getServerSnapshot = () => [] as LogEntry[];
  const localEntries = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const [serverEvents, setServerEvents] = useState<ServerAppEvent[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const [filter, setFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [originFilter, setOriginFilter] = useState<'all' | 'local' | 'server'>('all');
  const [requestIdQ, setRequestIdQ] = useState('');
  const [textQ, setTextQ] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadServer = () => {
    setServerLoading(true);
    setServerError(null);
    const params = new URLSearchParams();
    params.set('limit', '200');
    if (requestIdQ.trim()) params.set('requestId', requestIdQ.trim());
    if (textQ.trim()) params.set('q', textQ.trim());
    void get<{ events: ServerAppEvent[]; total: number }>(`/settings/app-events?${params.toString()}`)
      .then(data => {
        setServerEvents(data.events);
        setServerTotal(data.total);
      })
      .catch(err => {
        setServerError(getUserMessageWithRef(err));
      })
      .finally(() => setServerLoading(false));
  };

  useEffect(() => {
    loadServer();
  }, []);

  const serverEntries = serverEvents.map(serverEventToLogEntry);
  const merged = [...localEntries, ...serverEntries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const filtered = merged.filter(e => {
    if (filter !== 'all' && e.level !== filter) return false;
    if (originFilter === 'local' && e.origin === 'server') return false;
    if (originFilter === 'server' && e.origin !== 'server') return false;
    if (requestIdQ.trim() && e.origin === 'local' && !(e.requestId ?? '').includes(requestIdQ.trim())) return false;
    if (textQ.trim()) {
      const t = textQ.trim().toLowerCase();
      const blob = `${e.message} ${e.source} ${JSON.stringify(e.data ?? '')}`.toLowerCase();
      if (!blob.includes(t)) return false;
    }
    return true;
  });
  const displayed = filtered.slice(0, 300);

  const exportMergedText = () =>
    merged
      .map(e => {
        const d = e.data !== undefined ? ' | ' + JSON.stringify(e.data) : '';
        const ref = e.requestId ? ` [ref:${e.requestId}]` : '';
        const origin = e.origin === 'server' ? '[server]' : '[device]';
        return `[${e.timestamp}] [${e.level.toUpperCase()}] ${origin} [${e.source}] ${e.message}${ref}${d}`;
      })
      .join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportMergedText());
      setCopyFeedback('Copied!');
    } catch {
      setCopyFeedback('Failed');
    }
    setTimeout(() => setCopyFeedback(''), 1500);
  };

  const handleDownload = () => {
    const blob = new Blob([exportMergedText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `app-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadJson = () => {
    const blob = new Blob([JSON.stringify({ local: localEntries, server: serverEvents, exportedAt: new Date().toISOString() }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `app-logs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    appLogger.clear();
  };

  const formatTime = (iso: string) => {
    try { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    catch { return iso; }
  };

  return (
    <div className="max-w-4xl xl:max-w-5xl">
      <div className="flex flex-col gap-4 mb-6 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h3 className="text-2xl font-bold text-soot-900 flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-soot-400" />
            App Logs
          </h3>
          <p className="text-sm text-soot-500 mt-1">
            {localEntries.length} on this device · {serverTotal} on server (matched)
            {serverLoading && ' · loading…'}
          </p>
          {serverError && (
            <p className="text-xs text-red-600 mt-2 font-medium">Server log fetch: {serverError}</p>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={() => loadServer()}
            disabled={serverLoading}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-soot-600 bg-white border border-soot-200 rounded-lg hover:bg-soot-50 transition-colors disabled:opacity-50"
          >
            <Loader2 className={`w-3.5 h-3.5 ${serverLoading ? 'animate-spin' : ''}`} />
            Refresh server
          </button>
          <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-soot-600 bg-white border border-soot-200 rounded-lg hover:bg-soot-50 transition-colors">
            <Copy className="w-3.5 h-3.5" />
            {copyFeedback || 'Copy All'}
          </button>
          <button onClick={handleDownload} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-soot-600 bg-white border border-soot-200 rounded-lg hover:bg-soot-50 transition-colors">
            <Download className="w-3.5 h-3.5" />
            Export .txt
          </button>
          <button onClick={handleDownloadJson} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-soot-600 bg-white border border-soot-200 rounded-lg hover:bg-soot-50 transition-colors">
            <Download className="w-3.5 h-3.5" />
            Export JSON
          </button>
          <button onClick={handleClear} className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            <Trash className="w-3.5 h-3.5" />
            Clear device
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'info', 'warn', 'error'] as const).map(level => (
            <button
              key={level}
              type="button"
              onClick={() => setFilter(level)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
                filter === level
                  ? 'bg-soot-800 text-white border-soot-800'
                  : 'bg-white text-soot-500 border-soot-200 hover:bg-soot-50'
              }`}
            >
              {level === 'all' ? `All (${merged.length})` : `${level.charAt(0).toUpperCase() + level.slice(1)} (${merged.filter(e => e.level === level).length})`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-soot-500">Origin:</span>
          {(['all', 'local', 'server'] as const).map(o => (
            <button
              key={o}
              type="button"
              onClick={() => setOriginFilter(o)}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold border ${
                originFilter === o ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-soot-600 border-soot-200'
              }`}
            >
              {o}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={requestIdQ}
            onChange={e => setRequestIdQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadServer()}
            placeholder="Request ID (server filter — Enter to refresh)"
            className="flex-1 min-w-[200px] px-3 py-2 text-xs rounded-lg border border-soot-200 bg-white/80"
          />
          <input
            type="text"
            value={textQ}
            onChange={e => setTextQ(e.target.value)}
            placeholder="Search text (client-side filter)"
            className="flex-1 min-w-[200px] px-3 py-2 text-xs rounded-lg border border-soot-200 bg-white/80"
          />
        </div>
      </div>

      {/* Log list */}
      <div className="glass-card overflow-hidden">
        {displayed.length === 0 ? (
          <div className="py-16 text-center text-soot-400">
            <ScrollText className="w-10 h-10 mx-auto mb-3 stroke-1" />
            <p className="font-medium">No logs yet</p>
            <p className="text-xs mt-1">Events will appear here as the app runs. Use Refresh server to load backend errors.</p>
          </div>
        ) : (
          <div className="divide-y divide-soot-100 max-h-[60vh] overflow-auto">
            {displayed.map(entry => (
              <LogRow
                key={`${entry.origin ?? 'local'}-${entry.id}`}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                formatTime={formatTime}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry, expanded, onToggle, formatTime }: { entry: LogEntry; expanded: boolean; onToggle: () => void; formatTime: (s: string) => string }) {
  const hasData = entry.data !== undefined && entry.data !== null;
  const dotClass = LEVEL_DOT[entry.level] ?? LEVEL_DOT.error;
  const levelPillClass = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.error;
  return (
    <div className="group">
      <button type="button" onClick={onToggle} className="w-full text-left px-3 py-2.5 flex min-w-0 flex-wrap items-start gap-2 hover:bg-white/60 transition-colors sm:flex-nowrap sm:px-4">
        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dotClass}`} />
        <span className="text-[11px] font-mono text-soot-400 shrink-0 mt-0.5 w-16">{formatTime(entry.timestamp)}</span>
        <span className={`text-[11px] font-bold uppercase shrink-0 mt-0.5 px-1.5 py-0.5 rounded border ${levelPillClass}`}>{entry.level}</span>
        {entry.origin === 'server' && (
          <span className="text-[10px] font-bold uppercase shrink-0 mt-0.5 px-1 py-0.5 rounded bg-brand-100 text-brand-800 border border-brand-200">srv</span>
        )}
        {entry.requestId && (
          <span className="text-[10px] font-mono text-soot-500 shrink-0 mt-0.5 max-w-[7rem] truncate" title={entry.requestId}>
            {entry.requestId.slice(0, 12)}…
          </span>
        )}
        <span className="text-xs font-semibold text-soot-600 shrink-0 mt-0.5">[{entry.source}]</span>
        <span className="min-w-[12rem] flex-1 text-xs text-soot-700 mt-0.5 break-words sm:truncate">{entry.message}</span>
        {hasData && (
          expanded ? <ChevronUp className="w-3.5 h-3.5 text-soot-400 shrink-0 mt-0.5" /> : <ChevronDown className="w-3.5 h-3.5 text-soot-400 shrink-0 mt-0.5" />
        )}
      </button>
      {expanded && hasData && (
        <pre className="mx-4 mb-3 p-3 bg-soot-900 text-brand-400 rounded-lg text-[11px] font-mono overflow-auto max-h-48">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
