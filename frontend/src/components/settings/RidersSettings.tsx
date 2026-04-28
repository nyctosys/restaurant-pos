import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { get, put, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';

type SettingsResponse = { config?: Record<string, unknown> };

export default function RidersSettings() {
  const [riders, setRiders] = useState<string[]>([]);
  const [newRider, setNewRider] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const fetchRiders = async () => {
    setLoading(true);
    try {
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const data = await get<SettingsResponse>(`/settings/${query}`);
      const list = data.config?.riders;
      setRiders(Array.isArray(list) ? (list as string[]) : []);
      setEditingIndex(null);
    } catch {
      setRiders([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRiders();
  }, []);

  const saveRiders = async (updated: string[]) => {
    setSaving(true);
    setFeedback('');
    try {
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const query = activeBranchId ? `?branch_id=${activeBranchId}` : '';
      const existing = await get<SettingsResponse>(`/settings/${query}`);
      const currentConfig = (existing?.config ?? {}) as Record<string, unknown>;
      const payload: { config: Record<string, unknown>; branch_id?: number } = {
        config: { ...currentConfig, riders: updated },
      };
      if (activeBranchId) {
        payload.branch_id = parseInt(activeBranchId, 10);
      }
      await put('/settings/', payload);
      setRiders(updated);
      setFeedback('Riders saved!');
      setTimeout(() => setFeedback(''), 2000);
      setEditingIndex(null);
    } catch (e) {
      setFeedback('error:' + getUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    const trimmed = newRider.trim();
    if (!trimmed || riders.includes(trimmed)) return;
    void saveRiders([...riders, trimmed]);
    setNewRider('');
  };

  const handleRemove = (name: string) => {
    void saveRiders(riders.filter(rider => rider !== name));
  };

  const handleStartEdit = (index: number) => {
    setEditingIndex(index);
    setEditingValue(riders[index] ?? '');
  };

  const handleUpdate = () => {
    const trimmed = editingValue.trim();
    if (editingIndex === null || !trimmed) return;
    if (riders.some((rider, index) => index !== editingIndex && rider === trimmed)) {
      setFeedback('error:A rider with this name already exists.');
      return;
    }
    const updated = [...riders];
    updated[editingIndex] = trimmed;
    void saveRiders(updated);
  };

  return (
    <div className="max-w-2xl xl:max-w-3xl">
      <h3 className="text-2xl font-bold text-soot-900 mb-2">Delivery riders</h3>
      <p className="text-sm text-soot-500 mb-6">
        Register rider names for this branch. Cashiers can assign delivery orders on Order, and assigned riders stay busy until that order closes.
      </p>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          inputMode="text"
          value={newRider}
          onChange={e => setNewRider(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="e.g. Hamza, Bilal..."
          className="flex-1 px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={!newRider.trim() || saving || riders.includes(newRider.trim())}
          className="flex items-center gap-2 bg-brand-700 text-white px-5 py-3 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
        >
          <Plus className="w-4 h-4" />
          Add
        </button>
      </div>

      {feedback && (
        <div
          className={`mb-4 text-sm font-medium rounded-lg px-4 py-2 ${
            feedback.startsWith('error:')
              ? 'text-red-700 bg-red-50 border border-red-200'
              : 'text-brand-700 bg-brand-50 border border-brand-200'
          }`}
        >
          {feedback.replace('error:', '')}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-soot-400 py-6">
          <Loader2 className="w-5 h-5 animate-spin" />
          Loading riders...
        </div>
      ) : riders.length === 0 ? (
        <div className="text-soot-400 py-8 text-center border border-dashed border-soot-200 rounded-xl">
          No riders yet. Add names above so staff can assign delivery orders.
        </div>
      ) : (
        <div className="space-y-2">
          {riders.map((rider, index) => (
            <div
              key={`${rider}-${index}`}
              className="flex items-center justify-between px-4 py-3 glass-card group hover:border-soot-200 transition-colors"
            >
              {editingIndex === index ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="text"
                    inputMode="text"
                    value={editingValue}
                    onChange={e => setEditingValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleUpdate();
                      if (e.key === 'Escape') setEditingIndex(null);
                    }}
                    className="flex-1 px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleUpdate}
                    disabled={saving || !editingValue.trim()}
                    className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                  >
                    Done
                  </button>
                  <button type="button" onClick={() => setEditingIndex(null)} className="text-sm text-soot-500 hover:text-soot-700">
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <span className="font-medium text-soot-800">{rider}</span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(index)}
                      disabled={saving}
                      className="text-soot-400 hover:text-brand-600 p-1 rounded-md hover:bg-brand-50 text-sm"
                      title="Rename"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(rider)}
                      disabled={saving}
                      className="text-soot-300 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50"
                      title={`Remove ${rider}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
