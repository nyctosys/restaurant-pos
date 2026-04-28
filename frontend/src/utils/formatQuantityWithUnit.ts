function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value - Math.round(value)) < 0.0001) {
    return String(Math.round(value));
  }
  return value.toFixed(2).replace(/\.?0+$/, '');
}

export function formatQuantityWithUnit(quantity: number, unit?: string | null): string {
  const normalizedUnit = (unit || '').trim();
  const qty = formatQuantity(quantity);
  if (!normalizedUnit) {
    return `${qty} (unit missing)`;
  }
  return `${qty} ${normalizedUnit}`;
}
