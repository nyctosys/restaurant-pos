import { useState, useEffect } from 'react';
import { Loader2, MapPin, Phone, Users } from 'lucide-react';
import { showToast } from '../Toast';
import { get, put, getUserMessage } from '../../api';
import { getTerminalBranchId, parseUserFromStorage } from '../../utils/branchContext';

type Branch = {
  id: number;
  name: string;
  address: string;
  phone: string;
  user_count?: number;
};

type BranchUser = {
  id: number;
  username: string;
  role: string;
};

/**
 * Single-branch POS: show and edit only the terminal's branch (no list, archive, delete, or switching).
 */
export default function BranchesSettings() {
  const user = parseUserFromStorage();
  const terminalBranchId = getTerminalBranchId(user);
  const canEdit = user?.role === 'owner' || user?.role === 'manager';

  const [branch, setBranch] = useState<Branch | null>(null);
  const [branchUsers, setBranchUsers] = useState<BranchUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (terminalBranchId == null) {
        setLoading(false);
        setBranch(null);
        return;
      }
      try {
        setLoading(true);
        const list = await get<Branch[]>('/branches/');
        const b = Array.isArray(list) ? list.find((x) => x.id === terminalBranchId) ?? null : null;
        if (b) {
          setBranch(b);
          setName(b.name);
          setAddress(b.address || '');
          setPhone(b.phone || '');
        } else {
          setBranch(null);
        }
      } catch (e) {
        showToast(getUserMessage(e), 'error');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [terminalBranchId]);

  useEffect(() => {
    const loadUsers = async () => {
      if (terminalBranchId == null || !branch) return;
      try {
        setUsersLoading(true);
        const data = await get<BranchUser[]>(`/branches/${terminalBranchId}/users`);
        setBranchUsers(Array.isArray(data) ? data : []);
      } catch {
        setBranchUsers([]);
      } finally {
        setUsersLoading(false);
      }
    };
    void loadUsers();
  }, [terminalBranchId, branch?.id]);

  const handleSave = async () => {
    if (!branch || !name.trim()) {
      showToast('Branch name is required.', 'error');
      return;
    }
    if (!canEdit) return;
    setSaving(true);
    try {
      await put(`/branches/${branch.id}`, {
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim(),
      });
      showToast('Branch updated', 'success');
      setBranch({ ...branch, name: name.trim(), address: address.trim(), phone: phone.trim() });
    } catch (e) {
      showToast(getUserMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (terminalBranchId == null) {
    return (
      <div className="max-w-4xl glass-card p-6 text-soot-600">
        <p className="font-medium">No branch is assigned to this user. Contact an administrator.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h3 className="text-2xl font-bold text-soot-900">Branch</h3>
        <p className="text-sm text-soot-500 mt-1">This terminal is bound to a single branch. Update contact details below.</p>
      </div>

      {loading ? (
        <div className="glass-card p-8 flex justify-center text-soot-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : !branch ? (
        <div className="glass-card p-8 text-center text-soot-500">Branch not found.</div>
      ) : (
        <div className="space-y-6">
          <div className="glass-card p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-soot-700 mb-1">Branch name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canEdit}
                className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-soot-700 mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                disabled={!canEdit}
                className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-soot-700 mb-1">Phone</label>
              <input
                type="text"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={!canEdit}
                className="w-full px-4 py-2 glass-card focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:opacity-60"
              />
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !name.trim()}
                className="flex items-center gap-2 bg-brand-700 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Save
              </button>
            )}
          </div>

          <div className="glass-card p-6">
            <h4 className="text-sm font-semibold text-soot-700 mb-3 flex items-center gap-2">
              <Users className="w-4 h-4" /> Staff on this branch
            </h4>
            {usersLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-soot-400" />
            ) : branchUsers.length === 0 ? (
              <p className="text-sm text-soot-500">No users listed.</p>
            ) : (
              <ul className="space-y-2">
                {branchUsers.map((u) => (
                  <li key={u.id} className="flex justify-between items-center text-sm glass-card px-3 py-2 rounded-lg">
                    <span className="font-medium text-soot-800">{u.username}</span>
                    <span className="text-xs capitalize text-soot-600">{u.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="text-xs text-soot-500 flex flex-wrap gap-4">
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" /> Branch ID: {branch.id}
            </span>
            {branch.phone && (
              <span className="flex items-center gap-1">
                <Phone className="w-3 h-3" /> {branch.phone}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
