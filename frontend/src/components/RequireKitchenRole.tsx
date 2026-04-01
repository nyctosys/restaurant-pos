import { Navigate, Outlet } from 'react-router-dom';

/** Kitchen display (KDS) — users with role `kitchen` or `owner` */
export default function RequireKitchenRole() {
  const raw = localStorage.getItem('user');
  let role = '';
  try {
    role = raw ? (JSON.parse(raw) as { role?: string }).role ?? '' : '';
  } catch {
    role = '';
  }
  if (role !== 'kitchen' && role !== 'owner') {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
