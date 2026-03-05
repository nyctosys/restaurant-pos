/**
 * Format a number as Pakistani Rupees (Rs.)
 * Example: formatCurrency(2500) => "Rs. 2,500"
 */
export function formatCurrency(amount: number): string {
  return `Rs. ${amount.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
}
