import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { 
  Package, 
  BarChart3, 
  Settings, 
  LogOut, 
  ShoppingBag 
} from 'lucide-react';

const baseNavItems = [
  { icon: ShoppingBag, path: '/dashboard', label: 'Order', allowedRoles: ['owner', 'manager', 'cashier'] },
  { icon: Package, path: '/inventory', label: 'Inventory', allowedRoles: ['owner', 'manager', 'cashier', 'inventory_manager'] },
  { icon: BarChart3, path: '/reports', label: 'Reports', allowedRoles: ['owner'] },
  { icon: Settings, path: '/settings', label: 'Settings', allowedRoles: ['owner', 'manager'] },
];

export default function BaseLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  
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

  if (isAuthPage) {
    return (
      <div className="min-h-screen bg-canvas text-neutral-900 font-sans">
        <Outlet />
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-canvas text-neutral-900 font-sans overflow-hidden">
      {/* Vertical Icon Sidebar */}
      <aside className="w-[72px] bg-brand-900 flex flex-col items-center py-5 shrink-0">
        {/* Logo */}
        <div className="mb-8">
          <img 
            src="/small_logo.png" 
            alt="Soot Shoot" 
            className="w-16 h-16 object-contain"
          />
        </div>

        {/* Nav Icons */}
        <nav className="flex-1 flex flex-col items-center gap-2">
          {navItems.map(item => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={item.label}
                className={`w-11 h-11 flex items-center justify-center rounded-xl transition-all duration-200 group relative ${
                  isActive 
                    ? 'bg-gold-500 text-brand-900 shadow-lg shadow-gold-500/20' 
                    : 'text-brand-300 hover:text-white hover:bg-brand-800'
                }`}
              >
                <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 1.8} />
                {/* Tooltip */}
                <span className="absolute left-full ml-3 px-2.5 py-1 bg-neutral-800 text-white text-xs font-medium rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom: Profile + Logout */}
        <div className="flex flex-col items-center gap-3 mt-auto">
          <div className="w-9 h-9 rounded-full bg-brand-700 flex items-center justify-center text-gold-500 text-sm font-bold border-2 border-brand-600">
            {(() => {
              return user?.username?.charAt(0).toUpperCase() || 'U';
            })()}
          </div>
          <button
            onClick={handleLogout}
            title="Logout"
            className="w-11 h-11 flex items-center justify-center rounded-xl text-brand-400 hover:text-white hover:bg-brand-800 transition-colors"
          >
            <LogOut className="w-5 h-5" strokeWidth={1.8} />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
