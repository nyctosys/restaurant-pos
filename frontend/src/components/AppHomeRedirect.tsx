import { Navigate } from 'react-router-dom';

export default function AppHomeRedirect() {
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
  return <Navigate to="/dashboard" replace />;
}
