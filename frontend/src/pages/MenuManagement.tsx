import { useState } from 'react';
import MenuItemsTab from '../components/inventory/MenuItemsTab';
import DealsTab from '../components/inventory/DealsTab';

/** Menu catalog (pricing, categories, images) — separate from back-of-house inventory. */
export default function MenuManagementPage() {
  type TabId = 'menu_items' | 'deals';
  const [activeTab, setActiveTab] = useState<TabId>('menu_items');

  const tabs: { id: TabId; label: string }[] = [
    { id: 'menu_items', label: 'Menu Items' },
    { id: 'deals', label: 'Deals & Combos' },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent">
      <div className="page-padding border-b border-soot-200/60 bg-white/25 shrink-0 flex flex-col gap-4 pt-4 lg:pt-6">
        <h2 className="text-2xl font-bold text-soot-900">Menu</h2>
        <p className="text-sm text-soot-500 -mt-2">Menu pricing and promotions. Inventory is managed under Ingredients.</p>
        <div className="flex items-center gap-6 overflow-x-auto hide-scrollbar">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === t.id
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-soot-500 hover:text-soot-700 hover:border-soot-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto page-padding py-6">
          {activeTab === 'menu_items' && <MenuItemsTab />}
          {activeTab === 'deals' && <DealsTab />}
        </div>
      </div>
    </div>
  );
}
