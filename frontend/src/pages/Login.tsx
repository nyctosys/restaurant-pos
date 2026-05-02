import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import log from '../utils/logger';
import { post, getUserMessage } from '../api';
import { preloadAfterLogin } from '../routes/preload';

type LoginResponse = { token: string; user: { id: number; username: string; role: string; branch_id?: string; branch_name?: string } };

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      log.info('Login', 'Attempting login', { username: formData.username });
      const data = await post<LoginResponse>('/auth/login', formData);
      log.info('Login', 'Login successful', { userId: data?.user?.id, role: data?.user?.role });
      if (data?.token) localStorage.setItem('auth_token', data.token);
      if (data?.user) localStorage.setItem('user', JSON.stringify(data.user));
      preloadAfterLogin(data?.user?.role);
      navigate(data?.user?.role === 'kitchen' ? '/kitchen' : '/dashboard');
    } catch (err) {
      const msg = getUserMessage(err);
      log.warn('Login', 'Login failed', { message: msg });
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center w-full p-4">
      <div className="glass-floating max-w-md w-full p-8 lg:p-10">
        <div className="mb-8 flex flex-col items-center text-center">
          <img
            src="/app-logo.svg"
            alt=""
            width={320}
            height={320}
            className="h-20 w-auto max-w-[72%] object-contain"
            decoding="async"
          />
          <h2 className="mt-8 text-[34px] leading-[1.12] font-semibold text-neutral-900 tracking-[-0.374px]">Terminal Login</h2>
          <p className="mt-2 text-[15px] leading-6 text-neutral-500">
            Enter your operator credentials to access the POS.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-[8px] text-sm font-medium border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Operator ID</label>
            <input 
              required
              type="text"
              inputMode="text"
              autoComplete="username"
              name="username"
              value={formData.username}
              onChange={handleChange}
              className="w-full px-4 py-3 glass-card focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-colors"
              placeholder="Username"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Passcode</label>
            <input 
              required
              type="password"
              inputMode="text"
              autoComplete="current-password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              className="w-full px-4 py-3 glass-card focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-colors"
              placeholder="••••••••"
            />
          </div>
          
          <button 
            type="submit" 
            disabled={loading}
            className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 text-white py-3.5 rounded-[11px] font-semibold transition-colors mt-4 flex justify-center items-center"
          >
            {loading ? 'Authenticating...' : 'Access Terminal'}
          </button>
        </form>
      </div>
    </div>
  );
}
