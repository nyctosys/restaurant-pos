import { useState, useEffect } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import { get } from '../api';

type Branch = {
  id: number;
  name: string;
};

export default function BranchSwitcher() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const u = JSON.parse(userStr);
      setUser(u);
      
      // Initialize active branch from localStorage or user's assigned branch
      const saved = localStorage.getItem('active_branch_id');
      if (saved) {
        setActiveBranchId(parseInt(saved));
      } else {
        setActiveBranchId(u.branch_id || 1); // Fallback to 1 if no branch assigned
      }
    }

    fetchBranches();
  }, []);

  const fetchBranches = async () => {
    try {
      const data = await get<Branch[]>('/branches/');
      setBranches(Array.isArray(data) ? data : []);
    } catch {
      setBranches([]);
    }
  };

  const handleSwitch = (id: number) => {
    setActiveBranchId(id);
    localStorage.setItem('active_branch_id', id.toString());
    setIsOpen(false);
    // Reload the page to refresh all data contextually
    window.location.reload();
  };

  if (!user || user.role !== 'owner') return null;

  const activeBranch = branches.find(b => b.id === activeBranchId);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 w-full px-4 py-2.5 rounded-lg bg-white border border-soot-200 hover:border-brand-500 hover:ring-1 hover:ring-brand-500/20 transition-all text-left"
      >
        <div className="w-8 h-8 rounded-md bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4" />
        </div>
        <div className="flex-1 overflow-hidden">
          <p className="text-[10px] font-bold uppercase tracking-wider text-soot-500 leading-none mb-1">Active Branch</p>
          <p className="text-sm font-semibold truncate leading-none text-soot-900">
            {activeBranch?.name || 'Loading...'}
          </p>
        </div>
        <ChevronDown className={`w-4 h-4 text-soot-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute left-0 right-0 mt-2 z-50 bg-white rounded-xl shadow-xl border border-soot-200 overflow-hidden animate-in fade-in slide-in-from-top-2">
            <div className="p-3 border-b border-soot-100 bg-soot-50">
              <span className="text-[10px] font-bold text-soot-500 uppercase tracking-widest">Switch Branch Context</span>
            </div>
            <div className="max-h-64 overflow-auto">
              {branches.map(branch => (
                <button
                  key={branch.id}
                  onClick={() => handleSwitch(branch.id)}
                  className={`w-full flex items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-brand-50 ${
                    activeBranchId === branch.id ? 'bg-brand-50 text-brand-700 font-bold' : 'text-soot-700'
                  }`}
                >
                  {branch.name}
                  {activeBranchId === branch.id && <Check className="w-4 h-4" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
