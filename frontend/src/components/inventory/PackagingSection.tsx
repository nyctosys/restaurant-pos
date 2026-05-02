import {
  normalizeUnitToken,
  quantityToStorageBase,
  storageBaseLabelForPackaging,
} from '../../utils/unitConversion';

/** One packaging line: quantity in a chosen unit, converted to ingredient base before save */
export type PackagingLineForm = {
  qty: string;
  unit: string;
};

export type PackagingFormValue = {
  carton: PackagingLineForm;
  packet: PackagingLineForm;
};

// eslint-disable-next-line react-refresh/only-export-components
export function defaultPackagingUnitForStorage(storageUnitRaw: string): string {
  const t = normalizeUnitToken(storageUnitRaw);
  if (t === 'kg' || t === 'g') return 'g';
  if (t === 'l' || t === 'ml') return 'ml';
  if (t === 'piece') return 'pcs';
  return 'g';
}

/** Pick list options for “size” entry: kg/g, ltr/ml, or pcs — matches ingredient storage category */
// eslint-disable-next-line react-refresh/only-export-components
export function packagingSizeUnitOptions(storageUnitRaw: string): { value: string; label: string }[] {
  const t = normalizeUnitToken(storageUnitRaw);
  if (t === 'kg' || t === 'g') {
    return [
      { value: 'kg', label: 'kg' },
      { value: 'g', label: 'g' },
    ];
  }
  if (t === 'l' || t === 'ml') {
    return [
      { value: 'ltr', label: 'ltr' },
      { value: 'ml', label: 'ml' },
    ];
  }
  if (t === 'piece') {
    return [{ value: 'pcs', label: 'pcs' }];
  }
  return [
    { value: 'kg', label: 'kg' },
    { value: 'g', label: 'g' },
  ];
}

function storageDisplaySelectUnit(baseTok: string): string {
  if (baseTok === 'kg' || baseTok === 'g') return 'kg';
  if (baseTok === 'l' || baseTok === 'ml') return 'ltr';
  if (baseTok === 'piece') return 'pcs';
  return 'kg';
}

// eslint-disable-next-line react-refresh/only-export-components
export function emptyPackagingForm(storageUnitRaw: string): PackagingFormValue {
  const u = defaultPackagingUnitForStorage(storageUnitRaw);
  return {
    carton: { qty: '', unit: u },
    packet: { qty: '', unit: u },
  };
}

/** Prefill from saved API `unit_conversions` (always stored in ingredient base units). */
// eslint-disable-next-line react-refresh/only-export-components
export function packagingFromSavedConversions(
  uc: Record<string, number> | undefined | null,
  storageUnitRaw: string
): PackagingFormValue {
  const def = defaultPackagingUnitForStorage(storageUnitRaw);
  const baseTok = normalizeUnitToken(storageUnitRaw);
  const displayUnit = storageDisplaySelectUnit(baseTok);
  const fmt = (n: number) =>
    Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : String(Number(n.toFixed(8))).replace(/\.?0+$/, '');
  return {
    carton:
      uc?.carton != null && uc.carton > 0
        ? { qty: fmt(uc.carton), unit: displayUnit }
        : { qty: '', unit: def },
    packet:
      uc?.packet != null && uc.packet > 0
        ? { qty: fmt(uc.packet), unit: displayUnit }
        : { qty: '', unit: def },
  };
}

/** Convert packaging lines to API `unit_conversions` (base units per 1 carton/packet). */
// eslint-disable-next-line react-refresh/only-export-components
export function packagingLinesToUnitConversions(
  p: PackagingFormValue,
  ingredientStorageUnitRaw: string
): Record<string, number> | undefined {
  const uc: Record<string, number> = {};
  const tryLine = (line: PackagingLineForm, key: 'carton' | 'packet') => {
    const q = parseFloat(String(line.qty).trim());
    if (!Number.isFinite(q) || q <= 0) return;
    try {
      const baseAmt = quantityToStorageBase(q, line.unit, ingredientStorageUnitRaw);
      if (Number.isFinite(baseAmt) && baseAmt > 0) uc[key] = baseAmt;
    } catch {
      /* incompatible units */
    }
  };
  tryLine(p.carton, 'carton');
  tryLine(p.packet, 'packet');
  return Object.keys(uc).length ? uc : undefined;
}

function PackagingQtyUnitRow({
  titleTop,
  titleBottom,
  line,
  onLineChange,
  storageUnit,
  idPrefix,
  fieldKey,
}: {
  titleTop: string;
  titleBottom: string;
  line: PackagingLineForm;
  onLineChange: (next: PackagingLineForm) => void;
  storageUnit: string;
  idPrefix: string;
  fieldKey: 'carton' | 'packet';
}) {
  const opts = packagingSizeUnitOptions(storageUnit);
  return (
    <div className="rounded-lg border border-neutral-200/60 bg-white/25 p-2.5 space-y-2">
      <p className="text-xs font-medium text-neutral-800">{titleTop}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[5.5rem]">
          <label className="block text-[11px] text-neutral-500 mb-0.5" htmlFor={`${idPrefix}-${fieldKey}-qty`}>
            Quantity
          </label>
          <input
            id={`${idPrefix}-${fieldKey}-qty`}
            type="number"
            step="any"
            min="0"
            value={line.qty}
            onChange={(e) => onLineChange({ ...line, qty: e.target.value })}
            className="w-full px-2.5 py-2 glass-card text-sm tabular-nums"
            placeholder="0"
          />
        </div>
        <div className="w-[6.5rem]">
          <label className="block text-[11px] text-neutral-500 mb-0.5" htmlFor={`${idPrefix}-${fieldKey}-unit`}>
            Unit
          </label>
          <select
            id={`${idPrefix}-${fieldKey}-unit`}
            value={line.unit}
            onChange={(e) => onLineChange({ ...line, unit: e.target.value })}
            className="w-full px-2 py-2 glass-card text-sm font-medium"
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-neutral-600">{titleBottom}</p>
    </div>
  );
}

/**
 * Optional master data: carton + packet sizes for future PO/restock (converted to base on save).
 */
export function PackagingMasterOptional({
  value,
  onChange,
  storageUnit,
  idPrefix = 'pkg',
}: {
  value: PackagingFormValue;
  onChange: (next: PackagingFormValue) => void;
  storageUnit: string;
  idPrefix?: string;
}) {
  const baseWord = storageBaseLabelForPackaging(storageUnit);
  return (
    <div className="col-span-2 rounded-lg border border-neutral-200/50 bg-white/20 p-2.5 space-y-3">
      <p className="text-xs font-semibold text-neutral-800">Packaging (optional)</p>
      <p className="text-[11px] text-neutral-500">
        Enter how much stock (in {baseWord} or compatible units) is in one carton or one packet. Values are converted to
        your material base unit ({baseWord}) before saving.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PackagingQtyUnitRow
          titleTop="How many"
          titleBottom={`in 1 carton? (stored as ${baseWord} per carton)`}
          line={value.carton}
          onLineChange={(next) => onChange({ ...value, carton: next })}
          storageUnit={storageUnit}
          idPrefix={idPrefix}
          fieldKey="carton"
        />
        <PackagingQtyUnitRow
          titleTop="How many"
          titleBottom={`in 1 packet? (stored as ${baseWord} per packet)`}
          line={value.packet}
          onLineChange={(next) => onChange({ ...value, packet: next })}
          storageUnit={storageUnit}
          idPrefix={idPrefix}
          fieldKey="packet"
        />
      </div>
    </div>
  );
}

/**
 * When line unit is carton/packet (restock / PO): qty + unit for “size of one carton/packet”, converted to base for API.
 */
export function PackagingInputForSelectedUnit({
  storageUnit,
  selectedUnit,
  value,
  onChange,
  override,
  onOverrideChange,
  idPrefix = 'pkg',
}: {
  storageUnit: string;
  selectedUnit: string;
  value?: PackagingFormValue;
  onChange?: (next: PackagingFormValue) => void;
  override?: PackagingLineForm;
  onOverrideChange?: (next: PackagingLineForm) => void;
  idPrefix?: string;
}) {
  const sel = normalizeUnitToken(selectedUnit);
  const packagingKind = sel === 'carton' ? 'carton' : sel === 'packet' ? 'packet' : null;
  if (!packagingKind) return null;

  const line =
    override ??
    (packagingKind === 'carton' ? value?.carton : value?.packet) ??
    ({ qty: '', unit: defaultPackagingUnitForStorage(storageUnit) } satisfies PackagingLineForm);

  const setLine = (next: PackagingLineForm) => {
    if (onOverrideChange) {
      onOverrideChange(next);
      return;
    }
    if (value && onChange) {
      if (packagingKind === 'carton') onChange({ ...value, carton: next });
      else onChange({ ...value, packet: next });
    }
  };

  const titleBottom = packagingKind === 'carton' ? 'in 1 carton?' : 'in 1 packet?';
  const labelBase = storageBaseLabelForPackaging(storageUnit);

  return (
    <div className="rounded-lg border border-neutral-200/60 bg-white/30 p-2.5 space-y-2">
      <p className="text-xs font-medium text-neutral-800">How many</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[5.5rem]">
          <label className="block text-[11px] text-neutral-500 mb-0.5" htmlFor={`${idPrefix}-line-qty`}>
            Quantity
          </label>
          <input
            id={`${idPrefix}-line-qty`}
            type="number"
            step="any"
            min="0"
            value={line.qty}
            onChange={(e) => setLine({ ...line, qty: e.target.value })}
            className="w-full px-2.5 py-2 glass-card text-sm tabular-nums"
            placeholder="e.g. 1000"
          />
        </div>
        <div className="w-[6.5rem]">
          <label className="block text-[11px] text-neutral-500 mb-0.5" htmlFor={`${idPrefix}-line-unit`}>
            Unit
          </label>
          <select
            id={`${idPrefix}-line-unit`}
            value={line.unit}
            onChange={(e) => setLine({ ...line, unit: e.target.value })}
            className="w-full px-2 py-2 glass-card text-sm font-medium"
          >
            {packagingSizeUnitOptions(storageUnit).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-xs text-neutral-700">
        {titleBottom} <span className="text-neutral-400">(→ {labelBase} per {packagingKind}, saved on receive)</span>
      </p>
      <p className="text-[11px] text-neutral-500">
        Required if this material has no saved carton/packet size yet. Uses kg/g, ltr/ml, or pcs for your storage type.
      </p>
    </div>
  );
}
