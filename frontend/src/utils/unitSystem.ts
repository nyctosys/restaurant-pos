/**
 * Central unit system: same rules as `backend/app/services/units.py`.
 * No per-screen logic — import from here for BOM, PO, stock display, and menu.
 */

export const UNIT_TYPES = {
  WEIGHT: ['kg', 'g'] as const,
  VOLUME: ['ltr', 'ml'] as const,
  COUNT: ['pcs'] as const,
  PACKAGING: ['carton', 'packet'] as const,
};

export const BASE_UNITS = {
  WEIGHT: 'kg',
  VOLUME: 'ltr',
  COUNT: 'pcs',
  PACKAGING: 'pcs',
} as const;

export type IngredientUnitFields = {
  unit?: string | null;
  unitOfMeasure?: string | null;
  unit_conversions?: Record<string, number> | null;
  purchase_unit?: string | null;
  conversion_factor?: number | null;
};

const DEFAULT_LOCALE = 'en-PK';

const CANON: Record<string, string> = {
  ltr: 'l',
  l: 'l',
  liter: 'l',
  litre: 'l',
  ml: 'ml',
  kg: 'kg',
  g: 'g',
  pcs: 'piece',
  pc: 'piece',
  piece: 'piece',
  carton: 'carton',
  packet: 'packet',
};

export function normalizeUnitToken(raw: string | null | undefined): string {
  if (raw == null) return '';
  const s = String(raw).trim().toLowerCase();
  if (!s) return '';
  return CANON[s] ?? s;
}

function storageCategory(
  u: string
): 'weight' | 'volume' | 'count' | 'packaging' | null {
  const t = normalizeUnitToken(u);
  if (t === 'kg' || t === 'g') return 'weight';
  if (t === 'l' || t === 'ml') return 'volume';
  if (t === 'piece') return 'count';
  if (t === 'carton' || t === 'packet') return 'packaging';
  return null;
}

export function effectivePackagingConversions(ing: IngredientUnitFields): Record<string, number> {
  const conv: Record<string, number> = {};
  const raw = ing.unit_conversions;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const key = k.trim().toLowerCase();
      const n = Number(v);
      if (key === 'carton' || key === 'packet') {
        if (Number.isFinite(n) && n > 0) conv[key] = n;
      }
    }
  }
  const pu = (ing.purchase_unit || '').trim().toLowerCase();
  const cf = Number(ing.conversion_factor);
  if ((pu === 'carton' || pu === 'packet') && Number.isFinite(cf) && cf > 0 && conv[pu] == null) {
    conv[pu] = cf;
  }
  return conv;
}

function toGrams(q: number, u: string): number {
  if (u === 'g') return q;
  if (u === 'kg') return q * 1000;
  throw new Error(u);
}

function gramsToUnit(grams: number, u: string): number {
  if (u === 'g') return grams;
  if (u === 'kg') return grams / 1000;
  throw new Error(u);
}

function toMl(q: number, u: string): number {
  if (u === 'ml') return q;
  if (u === 'l') return q * 1000;
  throw new Error(u);
}

function mlToUnit(ml: number, u: string): number {
  if (u === 'ml') return ml;
  if (u === 'l') return ml / 1000;
  throw new Error(u);
}

/**
 * Convert a quantity from `unit` into the ingredient's storage (base) unit.
 * Carton/packet require `unit_conversions` (or legacy purchase_unit + conversion_factor).
 */
export function toBaseUnit(value: number, unit: string, ing: IngredientUnitFields): number {
  if (!Number.isFinite(value)) throw new Error('Quantity must be a finite number');
  const fromU = normalizeUnitToken(unit);
  const baseU = normalizeUnitToken(ing.unit ?? ing.unitOfMeasure ?? '');
  if (!baseU) throw new Error('Ingredient has no base unit');

  if (fromU === baseU) return value;

  if (fromU === 'carton' || fromU === 'packet') {
    const conv = effectivePackagingConversions(ing);
    const perOne = conv[fromU];
    if (perOne == null || perOne <= 0) {
      throw new Error(`Missing positive unit_conversions['${fromU}'] for this ingredient (base ${baseU})`);
    }
    return value * perOne;
  }

  const fromCat = storageCategory(fromU);
  const baseCat = storageCategory(baseU);

  if (fromCat === 'weight' && baseCat === 'weight') {
    const g = toGrams(value, fromU);
    return gramsToUnit(g, baseU);
  }
  if (fromCat === 'volume' && baseCat === 'volume') {
    const ml = toMl(value, fromU);
    return mlToUnit(ml, baseU);
  }
  if (fromCat === 'count' && baseCat === 'count') return value;

  throw new Error(`Cannot convert ${fromU} to ingredient base ${baseU} (invalid category mix)`);
}

/** Human label for the ingredient base unit in packaging prompts (pcs, kg, ltr, …). */
export function storageBaseLabelForPackaging(baseUnitRaw: string | null | undefined): string {
  const t = normalizeUnitToken(baseUnitRaw ?? '');
  if (t === 'kg') return 'kg';
  if (t === 'g') return 'g';
  if (t === 'l') return 'ltr';
  if (t === 'ml') return 'ml';
  if (t === 'piece') return 'pcs';
  return (baseUnitRaw || '').trim() || 'base unit';
}

/** Units allowed in BOM/PO/restock dropdowns for this ingredient (includes carton/packet for inline size entry). */
export function allowedInputUnitsForIngredient(ing: IngredientUnitFields): string[] {
  const base = normalizeUnitToken(ing.unit ?? ing.unitOfMeasure ?? '');
  const cat = storageCategory(base);
  const out: string[] = [];
  if (cat === 'weight') out.push('kg', 'g');
  else if (cat === 'volume') out.push('ltr', 'ml');
  else if (cat === 'count') out.push('pcs');
  else out.push(base || 'pcs');

  if (cat === 'weight' || cat === 'volume' || cat === 'count') {
    out.push('carton', 'packet');
  }
  return out;
}

/** When only the storage unit string is known (e.g. prepared item) — no packaging. */
export function allowedInputUnitsForStorageUnit(baseUnit: string): string[] {
  const base = normalizeUnitToken(baseUnit);
  const cat = storageCategory(base);
  if (cat === 'weight') return ['kg', 'g'];
  if (cat === 'volume') return ['ltr', 'ml'];
  if (cat === 'count') return ['pcs'];
  return [baseUnit?.trim() || 'pcs'];
}

/**
 * @param ingredientOrBase — full ingredient (preferred) or storage unit string for legacy callers.
 */
export function getSelectableInputUnits(ingredientOrBase: IngredientUnitFields | string): string[] {
  if (typeof ingredientOrBase === 'string') {
    return allowedInputUnitsForStorageUnit(ingredientOrBase);
  }
  return allowedInputUnitsForIngredient(ingredientOrBase);
}

/** Static conversions only (mass/volume/count) — for prepared items / RecipePreparedItem rows. */
export function quantityToStorageBase(quantity: number, fromUnit: string, storageUnit: string): number {
  if (!Number.isFinite(quantity)) return NaN;
  const from = normalizeUnitToken(fromUnit);
  const to = normalizeUnitToken(storageUnit);
  if (from === to) return quantity;
  const fc = storageCategory(from);
  const tc = storageCategory(to);
  if (fc === 'weight' && tc === 'weight') {
    const g = toGrams(quantity, from);
    return gramsToUnit(g, to);
  }
  if (fc === 'volume' && tc === 'volume') {
    const ml = toMl(quantity, from);
    return mlToUnit(ml, to);
  }
  if (fc === 'count' && tc === 'count') return quantity;
  throw new Error(`Incompatible units: ${from} → ${to}`);
}

/**
 * Inverse of `quantityToStorageBase`: storage quantity → same amount expressed in `inputUnit`
 * (for editing BOM lines on prepared items).
 */
export function storageBaseToInputQuantity(
  storageQty: number,
  inputUnit: string,
  storageUnit: string
): number {
  if (!Number.isFinite(storageQty)) return NaN;
  return quantityToStorageBase(storageQty, storageUnit, inputUnit);
}

/**
 * Inverse of `toBaseUnit` for editing raw-ingredient BOM lines (includes carton/packet).
 */
export function ingredientBaseToInputQuantity(
  baseQty: number,
  inputUnit: string,
  ing: IngredientUnitFields
): number {
  if (!Number.isFinite(baseQty)) return NaN;
  const fromU = normalizeUnitToken(inputUnit);
  const baseU = normalizeUnitToken(ing.unit ?? ing.unitOfMeasure ?? '');
  if (!baseU) throw new Error('Ingredient has no base unit');
  if (fromU === baseU) return baseQty;
  if (fromU === 'carton' || fromU === 'packet') {
    const conv = effectivePackagingConversions(ing);
    const perOne = conv[fromU as 'carton' | 'packet'];
    if (perOne == null || perOne <= 0) {
      throw new Error(`Missing positive unit_conversions['${fromU}'] for this ingredient (base ${baseU})`);
    }
    return baseQty / perOne;
  }
  return quantityToStorageBase(baseQty, baseU, fromU);
}

/** Static pair conversion (prepared items / legacy). For raw ingredients with packaging use `toBaseUnit`. */
export function quantityToIngredientBase(
  quantity: number,
  fromUnit: string,
  ingredientBaseUnit: string
): number {
  return quantityToStorageBase(quantity, fromUnit, ingredientBaseUnit);
}

function formatQtyNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(4).replace(/\.?0+$/, '');
}

export function formatWeightKg(kg: number, locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(kg)) return '—';
  const grams = kg * 1000;
  return `${formatQtyNum(kg)} kg (${grams.toLocaleString(locale)} g)`;
}

/** Uses "ltr" label per product terminology. */
export function formatVolumeLiters(liters: number, locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(liters)) return '—';
  const ml = liters * 1000;
  return `${formatQtyNum(liters)} ltr (${ml.toLocaleString(locale)} ml)`;
}

type FormatOpts = { locale?: string; ingredient?: IngredientUnitFields };

function resolveFormatOpts(third?: string | FormatOpts, fourth?: string): { locale: string; ingredient?: IngredientUnitFields } {
  if (typeof third === 'string') {
    return { locale: third || DEFAULT_LOCALE, ingredient: undefined };
  }
  if (third && typeof third === 'object') {
    return { locale: third.locale ?? DEFAULT_LOCALE, ingredient: third.ingredient };
  }
  return { locale: fourth ?? DEFAULT_LOCALE, ingredient: undefined };
}

function packagingExtra(
  qtyInBase: number,
  ing: IngredientUnitFields | undefined,
  locale: string
): string {
  if (!ing || !Number.isFinite(qtyInBase) || qtyInBase <= 0) return '';
  const conv = effectivePackagingConversions(ing);
  const parts: string[] = [];
  const displayUnit = String(ing.unit ?? ing.unitOfMeasure ?? 'l');
  const baseTok = normalizeUnitToken(displayUnit);
  for (const key of ['carton', 'packet'] as const) {
    const per = conv[key];
    if (!per || per <= 0) continue;
    if (baseTok === 'piece' && key === 'packet') continue;
    const n = qtyInBase / per;
    if (n < 1e-9) continue;
    if (Math.abs(n - Math.round(n)) < 1e-5) {
      const count = Math.round(n);
      const inner = formatBaseQuantityRaw(qtyInBase, displayUnit, locale);
      parts.push(`${count} ${key} (${inner})`);
    }
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function formatBaseQuantityRaw(
  quantityInBase: number,
  baseUnit: string,
  locale: string,
  ingredient?: IngredientUnitFields
): string {
  const base = normalizeUnitToken(baseUnit);
  if (!Number.isFinite(quantityInBase)) return '—';
  if (base === 'kg') return formatWeightKg(quantityInBase, locale);
  if (base === 'g') {
    const kg = quantityInBase / 1000;
    return `${quantityInBase.toLocaleString(locale)} g (${formatQtyNum(kg)} kg)`;
  }
  if (base === 'l') return formatVolumeLiters(quantityInBase, locale);
  if (base === 'ml') {
    const l = quantityInBase / 1000;
    return `${quantityInBase.toLocaleString(locale)} ml (${formatQtyNum(l)} ltr)`;
  }
  if (base === 'piece') {
    let s = `${formatQtyNum(quantityInBase)} pcs`;
    if (ingredient) {
      const conv = effectivePackagingConversions(ingredient);
      const perPk = conv.packet;
      if (perPk && perPk > 0) {
        const np = quantityInBase / perPk;
        if (np >= 1e-6 && Math.abs(np - Math.round(np)) < 1e-4) {
          const k = Math.round(np);
          s += ` (${k} ${k === 1 ? 'packet' : 'packets'})`;
        }
      }
    }
    return s;
  }
  return `${formatQtyNum(quantityInBase)} ${baseUnit}`.trim();
}

/**
 * Display quantity stored in base unit. Pass `{ ingredient }` for carton/packet hints.
 * Third arg may be locale string (legacy) or `{ locale?, ingredient? }`.
 */
export function formatBaseQuantityGlobal(
  quantityInBase: number,
  baseUnit: string,
  third?: string | FormatOpts,
  fourth?: string
): string {
  const { locale, ingredient } = resolveFormatOpts(third, fourth);
  let primary = formatBaseQuantityRaw(quantityInBase, baseUnit, locale, ingredient);
  primary += packagingExtra(quantityInBase, ingredient, locale);
  return primary;
}

export function purchaseLineToBase(
  quantity: number,
  inputUnit: string,
  pricePerInputUnit: number,
  ingredient: IngredientUnitFields
): { quantityBase: number; unitPricePerBase: number } {
  const qtyBase = toBaseUnit(quantity, inputUnit, ingredient);
  const lineTotal = quantity * pricePerInputUnit;
  const unitPricePerBase = qtyBase > 0 && Number.isFinite(qtyBase) ? lineTotal / qtyBase : pricePerInputUnit;
  return { quantityBase: qtyBase, unitPricePerBase };
}
