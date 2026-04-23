import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { del, get, patch, post, getUserMessage } from '../../api';
import { getTerminalBranchIdString, parseUserFromStorage } from '../../utils/branchContext';
import { showConfirm } from '../ConfirmDialog';
import SearchableSelect from '../SearchableSelect';

type Modifier = {
  id: number;
  name: string;
  price: number | null;
  ingredient_id?: number | null;
  depletion_quantity?: number | null;
};

type IngredientOption = { id: number; name: string };

export default function ModifiersSettings() {
  const [mods, setMods] = useState<Modifier[]>([]);
  const [ingredients, setIngredients] = useState<IngredientOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string>('');

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState<string>('');
  const [newIngredientId, setNewIngredientId] = useState<string>('');
  const [newDepletion, setNewDepletion] = useState<string>('');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingPrice, setEditingPrice] = useState<string>('');
  const [editingIngredientId, setEditingIngredientId] = useState<string>('');
  const [editingDepletion, setEditingDepletion] = useState<string>('');

  const sorted = useMemo(() => [...mods].sort((a, b) => a.name.localeCompare(b.name)), [mods]);

  const ingName = (id: number | null | undefined) =>
    id == null ? null : ingredients.find(i => i.id === id)?.name ?? `#${id}`;

  const load = async () => {
    setLoading(true);
    setFeedback('');
    try {
      const activeBranchId = getTerminalBranchIdString(parseUserFromStorage());
      const ingPath = activeBranchId
        ? `/inventory-advanced/ingredients?branch_id=${activeBranchId}`
        : '/inventory-advanced/ingredients';
      const [modData, ingData] = await Promise.all([
        get<{ modifiers?: Modifier[] }>('/modifiers/'),
        get<{ ingredients?: { id: number; name: string }[] }>(ingPath),
      ]);
      setMods(modData.modifiers ?? []);
      setIngredients((ingData.ingredients ?? []).map(i => ({ id: i.id, name: i.name })));
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
      const body: Record<string, unknown> = {
        name,
        price: Number.isFinite(price as number) ? price : null,
      };
      if (newIngredientId.trim() !== '') {
        const iid = parseInt(newIngredientId, 10);
        if (Number.isFinite(iid)) body.ingredient_id = iid;
      }
      if (newDepletion.trim() !== '') {
        const d = parseFloat(newDepletion);
        if (Number.isFinite(d)) body.depletion_quantity = d;
      }
      await post('/modifiers/', body);
      setNewName('');
      setNewPrice('');
      setNewIngredientId('');
      setNewDepletion('');
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
    setEditingIngredientId(m.ingredient_id != null ? String(m.ingredient_id) : '');
    setEditingDepletion(m.depletion_quantity != null ? String(m.depletion_quantity) : '');
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    const name = editingName.trim();
    if (!name) return;
    setSaving(true);
    setFeedback('');
    try {
      const price = editingPrice.trim() === '' ? null : Number(editingPrice);
      const body: Record<string, unknown> = {
        name,
        price: Number.isFinite(price as number) ? price : null,
      };
      if (editingIngredientId.trim() === '') {
        body.ingredient_id = null;
        body.depletion_quantity = null;
      } else {
        const iid = parseInt(editingIngredientId, 10);
        if (Number.isFinite(iid)) body.ingredient_id = iid;
        if (editingDepletion.trim() === '') {
          body.depletion_quantity = null;
        } else {
          const d = parseFloat(editingDepletion);
          if (Number.isFinite(d)) body.depletion_quantity = d;
        }
      }
      await patch(`/modifiers/${editingId}`, body);
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
        Add-ons at checkout (e.g. extra cheese). Optionally link a modifier to a raw ingredient to deduct stock per
        unit sold (quantity in the ingredient&apos;s unit, default 1).
      </p>

      <div className="glass-card p-4 mb-4 space-y-3">
        <p className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">Add modifier</p>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Name</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void add()}
              placeholder="e.g. Extra cheese"
              className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Price (optional)</label>
            <input
              value={newPrice}
              onChange={e => setNewPrice(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void add()}
              inputMode="decimal"
              placeholder="0"
              className="w-full px-4 py-3 border border-soot-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:outline-none text-sm text-right"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Deduct ingredient (optional)</label>
            <SearchableSelect
              value={newIngredientId}
              onChange={setNewIngredientId}
              placeholder="— None —"
              searchPlaceholder="Search ingredients…"
              options={ingredients.map((ingredient) => ({
                value: String(ingredient.id),
                label: ingredient.name,
              }))}
              className="border-soot-200 bg-white px-4 py-3"
            />
          </div>
          <div className="w-36">
            <label className="block text-xs font-semibold text-neutral-500 mb-1">Qty / unit</label>
            <input
              value={newDepletion}
              onChange={e => setNewDepletion(e.target.value)}
              inputMode="decimal"
              placeholder="1"
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
            <div
              key={m.id}
              className="flex items-center justify-between px-4 py-3 glass-card group hover:border-soot-200 transition-colors"
            >
              {editingId === m.id ? (
                <div className="flex flex-col gap-3 flex-1 w-full">
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex-1 min-w-[160px]">
                      <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Name</label>
                      <input
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && void saveEdit()}
                        className="w-full px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                        autoFocus
                      />
                    </div>
                    <div className="w-40">
                      <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Price</label>
                      <input
                        value={editingPrice}
                        onChange={e => setEditingPrice(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && void saveEdit()}
                        inputMode="decimal"
                        className="w-full px-3 py-2 border border-soot-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none text-right"
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex-1 min-w-[200px]">
                      <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Ingredient</label>
                      <SearchableSelect
                        value={editingIngredientId}
                        onChange={setEditingIngredientId}
                        placeholder="— None —"
                        searchPlaceholder="Search ingredients…"
                        options={ingredients.map((ingredient) => ({
                          value: String(ingredient.id),
                          label: ingredient.name,
                        }))}
                        className="border-soot-200 bg-white px-3 py-2"
                      />
                    </div>
                    <div className="w-36">
                      <label className="block text-[10px] font-bold text-neutral-500 uppercase mb-1">Qty / unit</label>
                      <input
                        value={editingDepletion}
                        onChange={e => setEditingDepletion(e.target.value)}
                        inputMode="decimal"
                        className="w-full px-3 py-2 border border-soot-200 rounded-lg text-sm text-right"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
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
                </div>
              ) : (
                <>
                  <div className="min-w-0">
                    <p className="font-medium text-soot-800 truncate">{m.name}</p>
                    <p className="text-xs text-soot-500">
                      {m.price == null ? 'No extra charge' : `+ ${m.price}`}
                      {m.ingredient_id != null && (
                        <span className="block mt-0.5 text-soot-600">
                          Stock: {ingName(m.ingredient_id)}
                          {m.depletion_quantity != null ? ` × ${m.depletion_quantity}` : ' × 1'} per line unit
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
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
