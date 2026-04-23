const SKU_SEED_LIMIT = 18;

function sanitizeSkuSeed(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SKU_SEED_LIMIT);
}

export function generateAutoSku(prefix: string, label: string, existingSkus: Array<string | null | undefined>): string {
  const normalizedPrefix = sanitizeSkuSeed(prefix) || 'SKU';
  const normalizedLabel = sanitizeSkuSeed(label);
  const baseSku = normalizedLabel ? `${normalizedPrefix}-${normalizedLabel}` : normalizedPrefix;
  const used = new Set(existingSkus.map((sku) => (sku || '').trim().toUpperCase()).filter(Boolean));

  if (!used.has(baseSku)) {
    return baseSku;
  }

  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${baseSku}-${String(counter).padStart(3, '0')}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${baseSku}-${Date.now().toString().slice(-6)}`;
}
