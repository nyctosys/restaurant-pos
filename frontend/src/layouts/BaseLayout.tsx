import { useCallback, useEffect, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../utils/branchContext';
import { preloadAppRoute } from '../routes/preload';
import { 
  Package, 
  BarChart3, 
  Settings, 
  LogOut, 
  ShoppingBag,
  UtensilsCrossed,
  BookOpen,
} from 'lucide-react';

const baseNavItems = [
  { icon: ShoppingBag, path: '/dashboard', label: 'Order', allowedRoles: ['owner', 'manager', 'cashier'] },
  { icon: UtensilsCrossed, path: '/dine-in', label: 'Open Orders', allowedRoles: ['owner', 'manager', 'cashier'] },
  { icon: BookOpen, path: '/menu', label: 'Menu', allowedRoles: ['owner', 'manager', 'cashier', 'inventory_manager'] },
  { icon: Package, path: '/inventory', label: 'Inventory', allowedRoles: ['owner', 'manager', 'cashier', 'inventory_manager'] },
  { icon: BarChart3, path: '/reports', label: 'Reports', allowedRoles: ['owner'] },
  { icon: Settings, path: '/settings', label: 'Settings', allowedRoles: ['owner', 'manager'] },
];

export default function BaseLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeDineInCount, setActiveDineInCount] = useState<number | null>(null);

  const isAuthPage = ['/login', '/setup'].includes(location.pathname);

  const handleLogout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const userStr = localStorage.getItem('user');
  let user: ReturnType<typeof parseUserFromStorage> = null;
  try {
    user = userStr ? JSON.parse(userStr) : null;
  } catch {
    localStorage.removeItem('user');
    localStorage.removeItem('auth_token');
  }
  const userRole = user?.role || 'cashier';

  const navItems = baseNavItems.filter(item => item.allowedRoles.includes(userRole));

  const refreshActiveDineInCount = useCallback(async () => {
    if (isAuthPage || !user) return;
    if (!['owner', 'manager', 'cashier'].includes(userRole)) return;
    try {
      const activeBranchId = getTerminalBranchIdString(user);
      const q = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<{ sales?: unknown[] }>(`/orders/active${q}`);
      setActiveDineInCount((data.sales ?? []).length);
    } catch {
      setActiveDineInCount(null);
    }
  }, [isAuthPage, user, userRole]);

  useEffect(() => {
    const id = window.setTimeout(() => void refreshActiveDineInCount(), 0);
    return () => window.clearTimeout(id);
  }, [refreshActiveDineInCount, location.pathname]);

  useEffect(() => {
    if (isAuthPage) return;
    const id = window.setInterval(() => void refreshActiveDineInCount(), 30000);
    return () => window.clearInterval(id);
  }, [isAuthPage, refreshActiveDineInCount]);

  /** Kitchen display (KDS): full viewport — no POS rail; same layout, Apple chrome */
  if (location.pathname === '/kitchen') {
    return (
      <div className="h-screen min-h-[100dvh] flex bg-canvas text-neutral-900 font-sans overflow-hidden relative">
        <main className="flex-1 min-h-0 min-w-0 overflow-hidden m-2 lg:m-3 xl:m-4 glass-panel z-10">
          <Outlet />
        </main>
      </div>
    );
  }

  if (isAuthPage) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-canvas text-neutral-900 font-sans flex items-stretch justify-center p-4 lg:p-6 relative overflow-hidden">
        <div className="w-full max-w-md lg:max-w-lg flex items-center justify-center z-10">
          <Outlet />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen min-h-[100dvh] flex bg-canvas text-neutral-900 font-sans overflow-hidden relative">
      {/* Vertical rail: iPad landscape-first (lg) touch targets; xl+ shows icon labels */}
      <aside className="w-[84px] min-w-[84px] xl:w-[108px] xl:min-w-[108px] bg-black text-white border border-black rounded-[18px] flex flex-col items-center py-4 lg:py-5 shrink-0 m-2 lg:m-3 xl:m-4 z-10">
        {/* App mark — first nav item is role-appropriate “home” (e.g. Order vs Menu) */}
        <div className="mb-6 lg:mb-8">
          <Link
            to={navItems[0]?.path ?? '/dashboard'}
            className="block rounded-[11px] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            aria-label={navItems[0] ? `${navItems[0].label} — home` : 'Home'}
          >
            <img
              src="/app-logo.svg"
              alt=""
              width={64}
              height={64}
              className="w-14 h-14 xl:w-16 xl:h-16 object-contain"
              decoding="async"
            />
          </Link>
        </div>

        <nav className="flex-1 flex flex-col items-center xl:items-stretch gap-2 lg:gap-2.5 w-full px-1.5 xl:px-2">
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            const dineInBadge =
              item.path === '/dine-in' && activeDineInCount != null && activeDineInCount > 0;
            const navLabel =
              dineInBadge
                ? `${item.label}, ${activeDineInCount} active ${activeDineInCount === 1 ? 'order' : 'orders'}`
                : item.label;
            return (
              <Link
                key={item.path}
                to={item.path}
                aria-label={navLabel}
                onMouseEnter={() => preloadAppRoute(item.path)}
                onFocus={() => preloadAppRoute(item.path)}
                onTouchStart={() => preloadAppRoute(item.path)}
                className={`touch-target flex flex-col items-center justify-center gap-0.5 rounded-[11px] transition-colors duration-200 relative ${
                  isActive
                    ? 'bg-white text-brand-700 border border-white p-3 xl:p-2 w-14 h-14 xl:w-full xl:h-auto'
                    : 'text-white/78 hover:text-white hover:bg-white/12 active:bg-white/18 p-3 xl:p-2 w-14 h-14 xl:w-full xl:h-auto'
                }`}
              >
                <span className="relative inline-flex shrink-0">
                  <Icon className="w-5 h-5 shrink-0 xl:w-[22px] xl:h-[22px]" strokeWidth={isActive ? 2.5 : 1.8} />
                  {dineInBadge && (
                    <span
                      className="absolute -top-1.5 -right-2 min-w-[1.125rem] h-[1.125rem] px-0.5 flex items-center justify-center rounded-full bg-gold-600 text-[9px] font-bold text-white leading-none border border-white/30 dark:border-brand-900/40"
                      aria-hidden
                    >
                      {activeDineInCount > 99 ? '99+' : activeDineInCount}
                    </span>
                  )}
                </span>
                <span
                  className="hidden xl:block text-[10px] font-semibold leading-tight text-center max-w-[5.5rem] truncate"
                  aria-hidden
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-col items-center gap-3 mt-auto w-full px-0.5 min-w-0">
          <div className="flex flex-col items-center gap-1 w-full min-w-0">
            <div
              className="w-10 h-10 xl:w-11 xl:h-11 rounded-full bg-white/10 border border-white/16 flex items-center justify-center text-white text-sm font-semibold shrink-0"
              aria-hidden
            >
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <p
              className="w-full text-center text-[9px] xl:text-[10px] font-semibold leading-snug text-white/78 truncate px-0.5"
              title={user?.username || 'Operator'}
            >
              {user?.username || 'Operator'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Logout"
            className="touch-target flex items-center justify-center rounded-[11px] text-white/78 hover:text-white hover:bg-white/12 transition-colors"
          >
            <LogOut className="w-5 h-5 xl:w-[22px] xl:h-[22px]" strokeWidth={1.8} />
          </button>
        </div>
      </aside>

      <main className="flex-1 min-h-0 min-w-0 overflow-hidden m-2 ml-0 lg:m-3 lg:ml-0 xl:m-4 xl:ml-0 glass-panel z-10">
        <Outlet />
      </main>
    </div>
  );
}
