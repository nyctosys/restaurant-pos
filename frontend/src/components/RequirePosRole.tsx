import { Navigate, Outlet } from 'react-router-dom';

/** POS terminals: not the kitchen-only display role */
export default function RequirePosRole() {
  const raw = localStorage.getItem('user');
  let role = '';
  try {
    role = raw ? (JSON.parse(raw) as { role?: string }).role ?? '' : '';
  } catch {
    role = '';
  }
  if (role === 'kitchen') {
    return <Navigate to="/kitchen" replace />;
  }
  return <Outlet />;
}
