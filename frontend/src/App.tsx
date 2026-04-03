import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import BaseLayout from './layouts/BaseLayout';
import AuthGuard from './components/AuthGuard';
import Setup from './pages/Setup';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import MenuManagement from './pages/MenuManagement';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import ActiveDineIn from './pages/ActiveDineIn';
import KitchenKds from './pages/KitchenKds';
import RequirePosRole from './components/RequirePosRole';
import RequireKitchenRole from './components/RequireKitchenRole';
import AppHomeRedirect from './components/AppHomeRedirect';
import { ScannerProvider } from './hooks/useScanner';
import ToastContainer from './components/Toast';
import ConfirmDialogProvider from './components/ConfirmDialog';

export default function App() {
  // Initialize theme from localStorage on app load
  useEffect(() => {
    if (localStorage.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  // On touch devices: scroll focused input/textarea into view so the virtual keyboard opens reliably
  useEffect(() => {
    const handleFocus = (e: FocusEvent) => {
      const el = e.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    document.addEventListener('focusin', handleFocus, true);
    return () => document.removeEventListener('focusin', handleFocus, true);
  }, []);

  return (
    <BrowserRouter>
      <ScannerProvider>
        <Routes>
          <Route element={<BaseLayout />}>
            {/* Public / Setup Routes */}
          <Route path="/setup" element={<Setup />} />
          <Route path="/login" element={<Login />} />
          
          {/* Protected Routes */}
          <Route element={<AuthGuard />}>
            <Route element={<RequireKitchenRole />}>
              <Route path="/kitchen" element={<KitchenKds />} />
            </Route>
            <Route element={<RequirePosRole />}>
              <Route path="/" element={<AppHomeRedirect />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/dine-in" element={<ActiveDineIn />} />
              <Route path="/menu" element={<MenuManagement />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<div className="p-4 text-center">Under Construction</div>} />
            </Route>
          </Route>
        </Route>
      </Routes>
      <ToastContainer />
      <ConfirmDialogProvider />
      </ScannerProvider>
    </BrowserRouter>
  );
}
