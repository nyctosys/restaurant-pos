import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import log from '../utils/logger';
import { post, getUserMessage } from '../api';

type SetupResponse = { token: string; user: { id: number; username: string; role: string; branch_id?: number; branch_name?: string } };

export default function Setup() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    username: '',
    password: '',
    branch_name: 'Main Branch',
    branch_address: '',
    branch_phone: ''
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      log.info('Setup', 'Initializing system', { username: formData.username, branch: formData.branch_name });
      const data = await post<SetupResponse>('/auth/setup', formData);
      log.info('Setup', 'System initialized successfully', { userId: data?.user?.id });
      if (data?.token) localStorage.setItem('auth_token', data.token);
      if (data?.user) localStorage.setItem('user', JSON.stringify(data.user));
      navigate('/dashboard');
    } catch (err) {
      const msg = getUserMessage(err);
      log.error('Setup', 'Setup failed', { message: msg });
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-canvas">
      <div className="bg-surface rounded-2xl shadow-2xl border border-neutral-100 max-w-md w-full overflow-hidden">
        
        {/* Brand Header */}
        <div className="bg-brand-900 py-6 flex flex-col items-center justify-center border-b border-white/10">
          <img src="/logo_full.png" alt="Soot Shoot Logo" className="w-80 h-auto object-contain drop-shadow-xl" />
        </div>
        
        <div className="p-8">
          <h2 className="text-2xl font-bold text-center text-neutral-900 mb-1">First-Time Setup</h2>
          <p className="text-sm text-neutral-500 text-center mb-6">
            Welcome to Soot Shoot POS. Register the owner account to get started.
          </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm font-medium border border-red-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Owner Username</label>
            <input 
              required
              type="text"
              inputMode="text"
              autoComplete="username"
              name="username"
              value={formData.username}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-shadow"
              placeholder="admin"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Password</label>
            <input 
              required
              type="password"
              inputMode="text"
              autoComplete="new-password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-shadow"
              placeholder="••••••••"
            />
          </div>
          
          <div className="pt-4 border-t border-neutral-100 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Initial Branch Details
          </div>
          
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Branch Name</label>
            <input 
              required
              type="text"
              inputMode="text"
              autoComplete="organization"
              name="branch_name"
              value={formData.branch_name}
              onChange={handleChange}
              className="w-full px-4 py-3 border border-neutral-200 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:outline-none transition-shadow"
            />
          </div>
          
          <button 
            type="submit" 
            disabled={loading}
            className="w-full bg-brand-700 hover:bg-brand-600 disabled:bg-neutral-200 disabled:text-neutral-400 text-white py-3.5 rounded-xl font-semibold transition-colors mt-4 flex justify-center items-center shadow-sm shadow-brand-700/20"
          >
            {loading ? 'Initializing...' : 'Complete Setup'}
          </button>
        </form>
        </div>
      </div>
    </div>
  );
}
