import { useCallback, useEffect, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../api';
import { 
  Package, 
  BarChart3, 
  Settings, 
  LogOut, 
  ShoppingBag,
  UtensilsCrossed,
} from 'lucide-react';

const baseNavItems = [
  { icon: ShoppingBag, path: '/dashboard', label: 'Order', allowedRoles: ['owner', 'manager', 'cashier'] },
  { icon: UtensilsCrossed, path: '/dine-in', label: 'Dine-in', allowedRoles: ['owner', 'manager', 'cashier'] },
  { icon: Package, path: '/inventory', label: 'Stock', allowedRoles: ['owner', 'manager', 'cashier', 'inventory_manager'] },
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
  let user: any = null;
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
      const activeBranchId = localStorage.getItem('active_branch_id') ?? user?.branch_id ?? '1';
      const q = user?.role === 'owner' ? `?branch_id=${activeBranchId}` : '';
      const data = await get<{ sales?: unknown[] }>(`/orders/active${q}`);
      setActiveDineInCount((data.sales ?? []).length);
    } catch {
      setActiveDineInCount(null);
    }
  }, [isAuthPage, user, userRole]);

  useEffect(() => {
    void refreshActiveDineInCount();
  }, [refreshActiveDineInCount, location.pathname]);

  useEffect(() => {
    if (isAuthPage) return;
    const id = window.setInterval(() => void refreshActiveDineInCount(), 30000);
    return () => window.clearInterval(id);
  }, [isAuthPage, refreshActiveDineInCount]);

  /** Kitchen display (KDS): full viewport — no POS rail; same canvas + glass chrome as POS */
  if (location.pathname === '/kitchen') {
    return (
      <div className="h-screen min-h-[100dvh] flex bg-canvas/40 text-neutral-900 font-sans overflow-hidden relative">
        <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
          <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-brand-200/50 mix-blend-multiply filter blur-[100px] animate-blob dark:bg-brand-500/18 dark:mix-blend-screen dark:opacity-90" />
          <div className="absolute top-[20%] right-[-10%] w-[45vw] h-[45vw] rounded-full bg-gold-200/50 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-2000 dark:bg-gold-600/15 dark:mix-blend-screen dark:opacity-90" />
          <div className="absolute bottom-[-20%] left-[20%] w-[60vw] h-[60vw] rounded-full bg-brand-300/40 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-4000 dark:bg-brand-400/12 dark:mix-blend-screen dark:opacity-85" />
        </div>
        <main className="flex-1 min-h-0 min-w-0 overflow-hidden m-2 lg:m-3 xl:m-4 glass-panel z-10">
          <Outlet />
        </main>
      </div>
    );
  }

  if (isAuthPage) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-canvas/40 text-neutral-900 font-sans flex items-stretch justify-center p-4 lg:p-6 relative overflow-hidden">
        {/* Ambient wash — multiply reads muddy on dark; use soft additive glows */}
        <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
          <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-brand-200/50 mix-blend-multiply filter blur-[100px] animate-blob dark:bg-brand-500/18 dark:mix-blend-screen dark:opacity-90" />
          <div className="absolute top-[20%] right-[-10%] w-[45vw] h-[45vw] rounded-full bg-gold-200/50 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-2000 dark:bg-gold-600/15 dark:mix-blend-screen dark:opacity-90" />
          <div className="absolute bottom-[-20%] left-[20%] w-[60vw] h-[60vw] rounded-full bg-brand-300/40 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-4000 dark:bg-brand-400/12 dark:mix-blend-screen dark:opacity-85" />
        </div>
        <div className="w-full max-w-md lg:max-w-lg flex items-center justify-center z-10">
          <Outlet />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen min-h-[100dvh] flex bg-canvas/40 text-neutral-900 font-sans overflow-hidden relative">
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-brand-200/50 mix-blend-multiply filter blur-[100px] animate-blob dark:bg-brand-500/18 dark:mix-blend-screen dark:opacity-90" />
        <div className="absolute top-[20%] right-[-10%] w-[45vw] h-[45vw] rounded-full bg-gold-200/50 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-2000 dark:bg-gold-600/15 dark:mix-blend-screen dark:opacity-90" />
        <div className="absolute bottom-[-20%] left-[20%] w-[60vw] h-[60vw] rounded-full bg-brand-300/40 mix-blend-multiply filter blur-[100px] animate-blob animation-delay-4000 dark:bg-brand-400/12 dark:mix-blend-screen dark:opacity-85" />
      </div>
      
      {/* Vertical rail: iPad landscape-first (lg) touch targets; xl+ shows icon labels */}
      <aside className="w-[84px] min-w-[84px] xl:w-[108px] xl:min-w-[108px] glass-panel glass-hover flex flex-col items-center py-4 lg:py-5 shrink-0 m-2 lg:m-3 xl:m-4 z-10">
        {/* App mark */}
        <div className="mb-6 lg:mb-8">
          <img
            src="/app-logo.svg"
            alt=""
            width={64}
            height={64}
            className="w-14 h-14 xl:w-16 xl:h-16 object-contain drop-shadow-md"
            decoding="async"
          />
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
                className={`touch-target flex flex-col items-center justify-center gap-0.5 rounded-xl transition-all duration-200 relative ${
                  isActive
                    ? 'glass-card text-brand-900 shadow-lg shadow-gold-500/20 border-gold-300/70 p-3 xl:p-2 w-14 h-14 xl:w-full xl:h-auto'
                    : 'text-brand-700/90 hover:text-brand-900 hover:bg-white/20 active:bg-white/25 p-3 xl:p-2 w-14 h-14 xl:w-full xl:h-auto'
                }`}
              >
                <span className="relative inline-flex shrink-0">
                  <Icon className="w-5 h-5 shrink-0 xl:w-[22px] xl:h-[22px]" strokeWidth={isActive ? 2.5 : 1.8} />
                  {dineInBadge && (
                    <span
                      className="absolute -top-1.5 -right-2 min-w-[1.125rem] h-[1.125rem] px-0.5 flex items-center justify-center rounded-full bg-gold-600 text-[9px] font-bold text-white leading-none shadow-sm border border-white/30 dark:border-brand-900/40"
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
              className="w-10 h-10 xl:w-11 xl:h-11 rounded-full glass-card flex items-center justify-center text-gold-600 text-sm font-bold border-gold-300/60 shrink-0"
              aria-hidden
            >
              {user?.username?.charAt(0).toUpperCase() || 'U'}
            </div>
            <p
              className="w-full text-center text-[9px] xl:text-[10px] font-semibold leading-snug text-brand-800 truncate px-0.5"
              title={user?.username || 'Operator'}
            >
              {user?.username || 'Operator'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Logout"
            className="touch-target flex items-center justify-center rounded-xl text-brand-700/90 hover:text-brand-900 hover:bg-white/20 transition-colors"
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
