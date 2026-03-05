import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import log from '../utils/logger';
import { get } from '../api';

export default function AuthGuard() {
  const [status, setStatus] = useState<'loading' | 'needs_setup' | 'needs_login' | 'authenticated'>('loading');

  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        const data = await get<{ initialized?: boolean }>('/auth/status');
        if (!data?.initialized) {
          log.info('AuthGuard', 'System not initialized → redirecting to /setup');
          setStatus('needs_setup');
          return;
        }

        const token = localStorage.getItem('auth_token');
        if (!token) {
          log.info('AuthGuard', 'No auth token → redirecting to /login');
          setStatus('needs_login');
          return;
        }

        log.info('AuthGuard', 'Authenticated successfully');
        setStatus('authenticated');
      } catch {
        setStatus('needs_login');
      }
    };

    checkAuthStatus();
  }, []);

  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-soot-400">Verifying System Status...</div>;
  }

  if (status === 'needs_setup') {
    return <Navigate to="/setup" replace />;
  }

  if (status === 'needs_login') {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />; // authenticated
}
