import { formatBaseQuantityGlobal, type IngredientUnitFields } from './unitConversion';

type FormatOpts = { locale?: string; ingredient?: IngredientUnitFields };

/** Quantity is always in storage/base unit; gram/ml breakdown is derived for display. */
export function formatQuantityWithUnit(
  quantity: number,
  unit?: string | null,
  opts?: FormatOpts
): string {
  const normalizedUnit = (unit || '').trim();
  if (!normalizedUnit) {
    return `${quantity} (unit missing)`;
  }
  return formatBaseQuantityGlobal(quantity, normalizedUnit, opts);
}
