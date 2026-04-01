import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { del, get, patch, post, getUserMessage } from '../../api';
import { showConfirm } from '../ConfirmDialog';

type Modifier = { id: number; name: string; price: number | null };

export default function ModifiersSettings() {
  const [mods, setMods] = useState<Modifier[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string>('');

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState<string>('');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingPrice, setEditingPrice] = useState<string>('');

  const sorted = useMemo(() => [...mods].sort((a, b) => a.name.localeCompare(b.name)), [mods]);

  const load = async () => {
    setLoading(true);
    setFeedback('');
    try {
      const data = await get<{ modifiers?: Modifier[] }>('/modifiers/');
      setMods(data.modifiers ?? []);
    } catch (e) {
      setFeedback('error:' + getUserMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setFeedback('');
    try {
      const price = newPrice.trim() === '' ? null : Number(newPrice);
      await post('/modifiers/', { name, price: Number.isFinite(price as number) ? price : null });
      setNewName('');
      setNewPrice('');
      await load();
      setFeedback('Modifier created!');
      setTimeout(() => setFeedback(''), 1500);
    } catch (e) {
      setFeedback('error:' + getUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (m: Modifier) => {
    setEditingId(m.id);
    setEditingName(m.name);
    setEditingPrice(m.price == null ? '' : String(m.price));
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    const name = editingName.trim();
    if (!name) return;
    setSaving(true);
    setFeedback('');
    try {
      const price = editingPrice.trim() === '' ? null : Number(editingPrice);
      await patch(`/modifiers/${editingId}`, { name, price: Number.isFinite(price as number) ? price : null });
      setEditingId(null);
      await load();
      setFeedback('Modifier updated!');
      setTimeout(() => setFeedback(''), 1500);
    } catch (e) {
      setFeedback('error:' + getUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m: Modifier) => {
    const ok = await showConfirm({
      title: 'Delete modifier?',
      message: `"${m.name}" will no longer be available at checkout.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
    });
    if (!ok) return;
    setSaving(true);
    setFeedback('');
    try {
      await del(`/modifiers/${m.id}`);
      await load();
    } catch (e) {
      setFeedback('error:' + getUserMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl xl:max-w-3xl">
      <h3 className="text-2xl font-bold text-soot-900 mb-2">Modifiers</h3>
      <p className="text-sm text-soot-500 mb-6">
        Create add-ons like Mayo, Masala, Garlic, Onion, Cheese. Cashiers can attach modifiers to specific cart items.
      </p>

      <div className="glass-card p-4 mb-4">
        <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide mb-2">Add modifier</p>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Name</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
              placeholder="e.g. Mayo"
              className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Price (optional)</label>
            <input
              value={newPrice}
              onChange={e => setNewPrice(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && add()}
              inputMode="decimal"
              placeholder="0"
              className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm text-right"
            />
          </div>
          <button
            type="button"
            onClick={() => void add()}
            disabled={saving || !newName.trim()}
            className="flex items-center gap-2 bg-brand-700 text-white px-5 py-3 rounded-lg font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </div>
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
          Loading modifiers…
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-soot-400 py-8 text-center border border-dashed border-soot-200 rounded-xl">
          No modifiers yet. Add your first modifier above.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(m => (
            <div key={m.id} className="flex items-center justify-between px-4 py-3 glass-card group hover:border-soot-200 transition-colors">
              {editingId === m.id ? (
                <div className="flex flex-wrap gap-2 items-end flex-1">
                  <div className="flex-1 min-w-[160px]">
                    <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Name</label>
                    <input
                      value={editingName}
                      onChange={e => setEditingName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveEdit()}
                      className="w-full px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div className="w-40">
                    <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Price</label>
                    <input
                      value={editingPrice}
                      onChange={e => setEditingPrice(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveEdit()}
                      inputMode="decimal"
                      className="w-full px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none text-right"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveEdit()}
                    disabled={saving || !editingName.trim()}
                    className="text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50 px-2 py-2"
                  >
                    Done
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} className="text-sm text-soot-500 hover:text-soot-700 px-2 py-2">
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="font-medium text-soot-800 truncate">{m.name}</p>
                    <p className="text-xs text-soot-500">
                      {m.price == null ? 'No extra charge' : `+ ${m.price}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(m)}
                      disabled={saving}
                      className="text-soot-400 hover:text-brand-600 p-1 rounded-md hover:bg-brand-50 text-sm"
                      title="Edit"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(m)}
                      disabled={saving}
                      className="text-soot-300 hover:text-red-500 transition-colors p-1 rounded-md hover:bg-red-50"
                      title="Delete"
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

