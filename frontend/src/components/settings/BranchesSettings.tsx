import { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Loader2, X, ChevronDown, ChevronRight, MapPin, Phone, Users, Archive, ArchiveRestore } from 'lucide-react';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import BranchSwitcher from '../BranchSwitcher';
import { get, post, put, patch, del, getUserMessage } from '../../api';

type Branch = {
  id: number;
  name: string;
  address: string;
  phone: string;
  user_count: number;
  archived_at?: string | null;
};

type BranchUser = {
  id: number;
  username: string;
  role: string;
  created_at: string;
};

export default function BranchesSettings() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [expandedBranch, setExpandedBranch] = useState<number | null>(null);
  const [branchUsers, setBranchUsers] = useState<BranchUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchBranches();
  }, [includeArchived]);

  const fetchBranches = async () => {
    try {
      setLoading(true);
      const query = includeArchived ? '?include_archived=1' : '';
      const data = await get<Branch[]>(`/branches/${query}`);
      setBranches(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchBranchUsers = async (branchId: number) => {
    try {
      setUsersLoading(true);
      const data = await get<BranchUser[]>(`/branches/${branchId}/users`);
      setBranchUsers(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setUsersLoading(false);
    }
  };

  const toggleExpand = (branchId: number) => {
    if (expandedBranch === branchId) {
      setExpandedBranch(null);
      setBranchUsers([]);
    } else {
      setExpandedBranch(branchId);
      fetchBranchUsers(branchId);
    }
  };

  const openModal = (branch?: Branch) => {
    if (branch) {
      setEditingBranch(branch);
      setName(branch.name);
      setAddress(branch.address);
      setPhone(branch.phone);
    } else {
      setEditingBranch(null);
      setName('');
      setAddress('');
      setPhone('');
    }
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingBranch(null);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      showToast('Branch name is required.', 'error');
      return;
    }

    setSaving(true);
    try {
      const body = { name: name.trim(), address: address.trim(), phone: phone.trim() };
      if (editingBranch) {
        await put(`/branches/${editingBranch.id}`, body);
      } else {
        await post('/branches/', body);
      }
      showToast(editingBranch ? 'Branch updated' : 'Branch created', 'success');
      closeModal();
      fetchBranches();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (branch: Branch) => {
    try {
      await patch(`/branches/${branch.id}/archive`, null);
      showToast('Branch archived', 'success');
      if (expandedBranch === branch.id) setExpandedBranch(null);
      fetchBranches();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleRestore = async (branch: Branch) => {
    try {
      await patch(`/branches/${branch.id}/unarchive`, null);
      showToast('Branch restored', 'success');
      fetchBranches();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleDelete = async (branch: Branch) => {
    const hasUsersOrInventory = branch.user_count > 0;
    const confirmed = await showConfirm({
      title: hasUsersOrInventory ? 'Permanent delete with cascade?' : 'Permanently delete branch?',
      message: hasUsersOrInventory
        ? `"${branch.name}" has ${branch.user_count} user(s), inventory, and possibly sales. Permanently deleting will reassign users (to no branch), delete all inventory and sales for this branch, then remove the branch. This cannot be undone.`
        : `"${branch.name}" will be removed forever. This cannot be undone.`,
      relatedEffects: hasUsersOrInventory
        ? ['Users will be unassigned from this branch.', 'All inventory records for this branch will be deleted.', 'All transactions for this branch will be deleted.']
        : undefined,
      confirmLabel: 'Delete permanently',
      variant: 'danger'
    });
    if (!confirmed) return;
    try {
      const url = hasUsersOrInventory ? `/branches/${branch.id}?cascade=1` : `/branches/${branch.id}`;
      await del(url);
      showToast('Branch deleted permanently', 'success');
      if (expandedBranch === branch.id) setExpandedBranch(null);
      fetchBranches();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const roleBadge = (role: string) => {
    const styles = role === 'owner'
      ? 'bg-brand-50 text-brand-700 border-brand-200'
      : role === 'manager'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-soot-100 text-soot-700 border-soot-200';
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize border ${styles}`}>
        {role}
      </span>
    );
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-2xl font-bold text-soot-900">Branch Management</h3>
          <p className="text-sm text-soot-500 mt-1">Manage store locations and view assigned staff.</p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-soot-700">
            <input type="checkbox" checked={includeArchived} onChange={() => setIncludeArchived(v => !v)} className="rounded border-soot-300 text-brand-600 focus:ring-brand-500" />
            Include archived
          </label>
          {/* Active Branch Switching Control */}
          <div className="w-56">
            <BranchSwitcher />
          </div>
          <button
            onClick={() => openModal()}
            className="flex items-center gap-2 bg-brand-700 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-brand-600 transition-colors shrink-0"
          >
            <Plus className="w-4 h-4" /> Add Branch
          </button>
        </div>
      </div>

      {/* Branch List */}
      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center text-soot-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : branches.length === 0 ? (
          <div className="p-8 text-center text-soot-500 border border-dashed border-soot-200 m-4 rounded-xl">
            No branches found. Create your first branch above.
          </div>
        ) : (
          <div className="divide-y divide-soot-100">
            {branches.map((branch) => (
              <div key={branch.id}>
                {/* Branch Row */}
                <div className={`flex items-center gap-4 px-6 py-4 hover:bg-white/25 transition-colors ${branch.archived_at ? 'bg-white/20 opacity-90' : ''}`}>
                  {/* Expand Toggle */}
                  <button
                    onClick={() => toggleExpand(branch.id)}
                    className="p-1 text-soot-400 hover:text-soot-700 transition-colors rounded-md hover:bg-soot-100"
                    title="View users"
                  >
                    {expandedBranch === branch.id
                      ? <ChevronDown className="w-4 h-4" />
                      : <ChevronRight className="w-4 h-4" />
                    }
                  </button>

                  {/* Branch Info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-soot-900 truncate">
                      {branch.name}
                      {branch.archived_at && <span className="ml-2 text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200">Archived</span>}
                    </p>
                    <div className="flex items-center gap-4 mt-0.5 text-xs text-soot-500">
                      {branch.address && (
                        <span className="flex items-center gap-1 truncate">
                          <MapPin className="w-3 h-3 shrink-0" /> {branch.address}
                        </span>
                      )}
                      {branch.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="w-3 h-3 shrink-0" /> {branch.phone}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* User Count Badge */}
                  <span className="flex items-center gap-1.5 text-xs font-medium text-soot-600 bg-soot-100 px-2.5 py-1 rounded-full border border-soot-200">
                    <Users className="w-3.5 h-3.5" />
                    {branch.user_count}
                  </span>

                  {/* Actions */}
                  <div className="flex items-center gap-1">
                    {!branch.archived_at && (
                      <button onClick={() => openModal(branch)} className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors" title="Edit Branch">
                        <Edit2 className="w-4 h-4" />
                      </button>
                    )}
                    {branch.archived_at ? (
                      <>
                        <button onClick={() => handleRestore(branch)} className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors" title="Restore">
                          <ArchiveRestore className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(branch)} className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete permanently">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => handleArchive(branch)} className="p-1.5 text-soot-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors" title="Archive">
                          <Archive className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(branch)} className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete permanently">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Expanded Users Panel */}
                {expandedBranch === branch.id && (
                  <div className="bg-soot-50/70 border-t border-soot-100 px-6 py-4 ml-10">
                    <h4 className="text-xs font-semibold text-soot-500 uppercase tracking-wider mb-3">
                      Assigned Users ({branch.user_count})
                    </h4>
                    {usersLoading ? (
                      <div className="flex items-center gap-2 text-soot-400 text-sm py-2">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                      </div>
                    ) : branchUsers.length === 0 ? (
                      <p className="text-sm text-soot-400 italic">No users assigned to this branch.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {branchUsers.map((u) => (
                          <div key={u.id} className="flex items-center justify-between glass-card px-4 py-2.5 rounded-lg">
                            <span className="text-sm font-medium text-soot-800">{u.username}</span>
                            {roleBadge(u.role)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center glass-overlay p-4 lg:p-6">
          <div className="glass-floating w-full max-w-md lg:max-w-lg animate-scale-in max-h-[min(90vh,720px)] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between px-5 lg:px-6 py-4 border-b border-soot-100 shrink-0">
              <h3 className="text-lg font-bold text-soot-900">
                {editingBranch ? 'Edit Branch' : 'New Branch'}
              </h3>
              <button type="button" onClick={closeModal} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-soot-400 hover:text-soot-600 rounded-lg hover:bg-soot-100" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 lg:p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Branch Name *</label>
                <input
                  type="text"
                  inputMode="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="e.g. Downtown Store"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Address</label>
                <input
                  type="text"
                  inputMode="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="123 Main St, City"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Phone</label>
                <input
                  type="text"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="+92 300 1234567"
                />
              </div>
            </div>

            <div className="px-5 lg:px-6 py-4 bg-white/20 border-t border-soot-100 flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 rounded-b-2xl shrink-0">
              <button
                type="button"
                onClick={closeModal}
                className="min-h-[44px] px-5 py-2.5 text-soot-700 font-medium hover:bg-soot-200 rounded-lg transition-colors"
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="flex items-center justify-center gap-2 min-h-[44px] bg-brand-700 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingBranch ? 'Save Changes' : 'Create Branch'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
