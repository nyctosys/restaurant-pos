import { get } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';

export const routeLoaders = {
  setup: () => import('../pages/Setup'),
  login: () => import('../pages/Login'),
  dashboard: () => import('../pages/Dashboard'),
  dineIn: () => import('../pages/ActiveDineIn'),
  menu: () => import('../pages/MenuManagement'),
  inventory: () => import('../pages/Inventory'),
  reports: () => import('../pages/Reports'),
  settings: () => import('../pages/Settings'),
  kitchen: () => import('../pages/KitchenKds'),
};

const routeLoaderByPath: Record<string, () => Promise<unknown>> = {
  '/setup': routeLoaders.setup,
  '/login': routeLoaders.login,
  '/dashboard': routeLoaders.dashboard,
  '/dine-in': routeLoaders.dineIn,
  '/menu': routeLoaders.menu,
  '/inventory': routeLoaders.inventory,
  '/reports': routeLoaders.reports,
  '/settings': routeLoaders.settings,
  '/kitchen': routeLoaders.kitchen,
};

function ignorePreload<T>(promise: Promise<T>): void {
  void promise.catch(() => {});
}

export function preloadRouteModule(path: string): void {
  const loader = routeLoaderByPath[path];
  if (loader) {
    ignorePreload(loader());
  }
}

export function preloadRouteData(path: string): void {
  const user = parseUserFromStorage();
  const branchId = getTerminalBranchIdString(user);
  const settingsPath = branchId ? `/settings/?branch_id=${branchId}` : '/settings/';

  if (path === '/dashboard') {
    ignorePreload(get('/menu-items/'));
    ignorePreload(get('/menu/deals/'));
    ignorePreload(get('/modifiers/'));
    ignorePreload(get(settingsPath));
    return;
  }
  if (path === '/menu') {
    ignorePreload(get('/menu-items/'));
    ignorePreload(get(settingsPath));
    return;
  }
  if (path === '/inventory') {
    ignorePreload(get('/inventory-advanced/ingredients'));
    ignorePreload(get('/inventory-advanced/suppliers'));
    ignorePreload(get('/inventory-advanced/prepared-items'));
    ignorePreload(get('/inventory-advanced/purchase-orders'));
    return;
  }
  if (path === '/settings') {
    ignorePreload(get(settingsPath));
    return;
  }
  if (path === '/reports') {
    ignorePreload(get('/stock/transactions?time_filter=today'));
  }
}

export function preloadAppRoute(path: string): void {
  preloadRouteModule(path);
  preloadRouteData(path);
}

export function preloadAfterLogin(role?: string): void {
  preloadAppRoute(role === 'kitchen' ? '/kitchen' : '/dashboard');
  if (role && ['owner', 'manager', 'cashier'].includes(role)) {
    preloadAppRoute('/dine-in');
  }
  if (role && ['owner', 'manager', 'cashier', 'inventory_manager'].includes(role)) {
    preloadAppRoute('/menu');
    preloadAppRoute('/inventory');
  }
  if (role && ['owner', 'manager'].includes(role)) {
    preloadAppRoute('/settings');
  }
}
