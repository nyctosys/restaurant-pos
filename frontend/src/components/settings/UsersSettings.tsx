import { useState, useEffect } from 'react';
import { Plus, Trash2, Edit2, Loader2, X, Building2, Archive, ArchiveRestore } from 'lucide-react';
import { showToast } from '../Toast';
import { showConfirm } from '../ConfirmDialog';
import { get, post, put, patch, del, getUserMessage } from '../../api';
import { getTerminalBranchId, parseUserFromStorage } from '../../utils/branchContext';

type User = {
  id: number;
  username: string;
  role: string;
  branch_id: number | null;
  branch_name: string;
  created_at: string;
  archived_at?: string | null;
};

export default function UsersSettings() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  
  // Form State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('cashier');
  const [saving, setSaving] = useState(false);

  // Filters & External Data
  const [includeArchived, setIncludeArchived] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) setCurrentUser(JSON.parse(userStr));
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [includeArchived]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const query = includeArchived ? '?include_archived=1' : '';
      const data = await get<User[]>(`/users/${query}`);
      setUsers(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  const openModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setUsername(user.username);
      setPassword(''); // Don't pre-fill password
      setRole(user.role);
    } else {
      setEditingUser(null);
      setUsername('');
      setPassword('');
      setRole('cashier');
    }
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingUser(null);
  };

  const handleSaveUser = async () => {
    if (!username.trim() || (!editingUser && !password)) {
      showToast('Username and password are required for new users.', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload: { username: string; role: string; branch_id?: number | null; password?: string } = {
        username: username.trim(),
        role,
      };
      if (!editingUser) {
        payload.branch_id = getTerminalBranchId(parseUserFromStorage()) ?? currentUser?.branch_id ?? null;
      }
      if (password) payload.password = password;

      if (editingUser) {
        await put(`/users/${editingUser.id}`, payload);
      } else {
        await post('/users/', payload);
      }
      showToast(editingUser ? 'User updated successfully' : 'User created successfully', 'success');
      closeModal();
      fetchUsers();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveUser = async (user: User) => {
    try {
      await patch(`/users/${user.id}/archive`, null);
      showToast('User archived', 'success');
      fetchUsers();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleRestoreUser = async (user: User) => {
    try {
      await patch(`/users/${user.id}/unarchive`, null);
      showToast('User restored', 'success');
      fetchUsers();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const handleDeleteUser = async (user: User) => {
    const confirmed = await showConfirm({
      title: 'Permanently delete user?',
      message: `${user.username} will be removed. They will no longer be able to sign in.`,
      relatedEffects: ['Cannot delete a user who has transactions. Archive them instead if needed.'],
      confirmLabel: 'Delete permanently',
      variant: 'danger'
    });
    if (!confirmed) return;
    try {
      await del(`/users/${user.id}`);
      showToast('User deleted permanently', 'success');
      fetchUsers();
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    }
  };

  const terminalId = getTerminalBranchId(parseUserFromStorage());
  const filteredUsers =
    terminalId == null ? users : users.filter(u => u.branch_id === terminalId);

  return (
    <div className="max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-2xl font-bold text-soot-900">User Management</h3>
          <p className="text-sm text-soot-500 mt-1">Manage staff access and roles.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-soot-700">
            <input type="checkbox" checked={includeArchived} onChange={() => setIncludeArchived(v => !v)} className="rounded border-soot-300 text-brand-600 focus:ring-brand-500" />
            Include archived
          </label>
          <button
            onClick={() => openModal()}
            className="flex items-center gap-2 bg-brand-700 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-brand-600 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" /> Add User
          </button>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        {loading ? (
          <div className="p-8 flex justify-center text-soot-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-soot-500 border border-dashed border-soot-200 m-4 rounded-xl">
            No users found.
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-white/20 border-b border-soot-200">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold text-soot-500 uppercase tracking-wider">Username</th>
                <th className="px-6 py-3 text-xs font-semibold text-soot-500 uppercase tracking-wider">Branch</th>
                <th className="px-6 py-3 text-xs font-semibold text-soot-500 uppercase tracking-wider">Role</th>
                <th className="px-6 py-3 text-xs font-semibold text-soot-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-soot-100">
              {filteredUsers.map((user) => (
                <tr key={user.id} className={`hover:bg-white/25 transition-colors ${user.archived_at ? 'bg-white/20 opacity-90' : ''}`}>
                  <td className="px-6 py-4 font-medium text-soot-900">
                    {user.username}
                    {user.archived_at && <span className="ml-2 text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded border border-amber-200">Archived</span>}
                  </td>
                  <td className="px-6 py-4">
                    <span className="flex items-center gap-1.5 text-sm text-soot-600">
                      <Building2 className="w-3.5 h-3.5" />
                      {user.branch_name || 'Global'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize border ${
                      user.role === 'owner'
                        ? 'bg-brand-50 text-brand-700 border-brand-200'
                        : 'bg-soot-100 text-soot-700 border-soot-200'
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {!user.archived_at && (
                        <button onClick={() => openModal(user)} className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors" title="Edit User">
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                      {user.archived_at ? (
                        <>
                          <button onClick={() => handleRestoreUser(user)} className="p-1.5 text-soot-400 hover:text-brand-600 hover:bg-brand-50 rounded transition-colors" title="Restore">
                            <ArchiveRestore className="w-4 h-4" />
                          </button>
                          <button onClick={() => handleDeleteUser(user)} className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete permanently">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        currentUser?.id !== user.id && (
                          <>
                            <button onClick={() => handleArchiveUser(user)} className="p-1.5 text-soot-400 hover:text-amber-600 hover:bg-amber-50 rounded transition-colors" title="Archive">
                              <Archive className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleDeleteUser(user)} className="p-1.5 text-soot-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Delete permanently">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center glass-overlay p-4 lg:p-6">
          <div className="glass-floating w-full max-w-md lg:max-w-lg animate-scale-in max-h-[min(90vh,800px)] overflow-y-auto flex flex-col">
            <div className="flex items-center justify-between px-5 lg:px-6 py-4 border-b border-soot-100 shrink-0">
              <h3 className="text-lg font-bold text-soot-900">
                {editingUser ? 'Edit User' : 'Create New User'}
              </h3>
              <button type="button" onClick={closeModal} className="min-w-[44px] min-h-[44px] flex items-center justify-center text-soot-400 hover:text-soot-600 rounded-lg hover:bg-soot-100" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-5 lg:p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Username</label>
                <input
                  type="text"
                  inputMode="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="e.g. jsmith"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Password {editingUser && '(Leave blank to keep)'}</label>
                <input
                  type="password"
                  inputMode="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                  placeholder="••••••••"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-soot-700 mb-1">Role</label>
                {editingUser?.role === 'owner' ? (
                  <>
                    <input
                      type="text"
                      value="Owner"
                      disabled
                      className="w-full px-4 py-2 bg-soot-100 border border-soot-200 rounded-lg text-soot-500 cursor-not-allowed"
                    />
                    <p className="mt-1 text-xs text-soot-500">
                      Owner role cannot be changed.
                    </p>
                  </>
                ) : (
                  <>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    >
                      <option value="manager">Manager</option>
                      <option value="cashier">Cashier</option>
                      <option value="inventory_manager">Inventory Manager</option>
                      <option value="kitchen">Kitchen (display only)</option>
                    </select>
                    <p className="mt-1 text-xs text-soot-500">
                      Kitchen users only see the kitchen display after login — scoped to this terminal&apos;s branch.
                    </p>
                  </>
                )}
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
                onClick={handleSaveUser}
                disabled={saving || !username.trim()}
                className="flex items-center justify-center gap-2 min-h-[44px] bg-brand-700 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {editingUser ? 'Save Changes' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
