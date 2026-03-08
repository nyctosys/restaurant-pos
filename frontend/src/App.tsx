import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import BaseLayout from './layouts/BaseLayout';
import AuthGuard from './components/AuthGuard';
import Setup from './pages/Setup';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Inventory from './pages/Inventory';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
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
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<div className="p-4 text-center">Under Construction</div>} />
          </Route>
        </Route>
      </Routes>
      <ToastContainer />
      <ConfirmDialogProvider />
      </ScannerProvider>
    </BrowserRouter>
  );
}
