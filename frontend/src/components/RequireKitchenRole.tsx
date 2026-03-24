import { Navigate, Outlet } from 'react-router-dom';

/** Kitchen display (KDS) — only users with role `kitchen` */
export default function RequireKitchenRole() {
  const raw = localStorage.getItem('user');
  let role = '';
  try {
    role = raw ? (JSON.parse(raw) as { role?: string }).role ?? '' : '';
  } catch {
    role = '';
  }
  if (role !== 'kitchen') {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
