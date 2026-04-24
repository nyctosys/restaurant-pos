import { useState } from 'react';
import IngredientsTab from '../components/inventory/IngredientsTab';
import PreparedItemsTab from '../components/inventory/PreparedItemsTab';
import RecipesTab from '../components/inventory/RecipesTab';
import SuppliersTab from '../components/inventory/SuppliersTab';
import PurchaseOrdersTab from '../components/inventory/PurchaseOrdersTab';

type TabId = 'ingredients' | 'prepared_items' | 'recipes' | 'suppliers' | 'purchase_orders';

export default function InventoryPage() {
  const [activeTab, setActiveTab] = useState<TabId>('ingredients');

  const tabs: { id: TabId; label: string }[] = [
    { id: 'ingredients', label: 'Ingredients' },
    { id: 'prepared_items', label: 'Marinations & Sauces' },
    { id: 'recipes', label: 'Recipes (BOM)' },
    { id: 'suppliers', label: 'Suppliers' },
    { id: 'purchase_orders', label: 'Purchase Orders' },
  ];

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent">
      {/* Header & Tabs Navigation */}
      <div className="page-padding border-b border-soot-200/60 bg-white/25 shrink-0 flex flex-col gap-4 pt-4 lg:pt-6">
        <h2 className="text-2xl font-bold text-soot-900">Inventory</h2>
        <p className="text-sm text-soot-500 -mt-2">Ingredient stock, recipes (BOM), purchasing — deals/combos are under Menu.</p>
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

      {/* Tab Content Area */}
      <div className="flex-1 min-h-0 relative">
        <div className="absolute inset-0 overflow-y-auto page-padding py-6">
          {activeTab === 'ingredients' && <IngredientsTab />}
          {activeTab === 'prepared_items' && <PreparedItemsTab />}
          {activeTab === 'recipes' && <RecipesTab />}
          {activeTab === 'suppliers' && <SuppliersTab />}
          {activeTab === 'purchase_orders' && <PurchaseOrdersTab />}
        </div>
      </div>
    </div>
  );
}
