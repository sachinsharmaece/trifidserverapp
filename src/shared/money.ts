/** ₹1,234.50 from 123450 paise (Indian grouping). For text the server writes, like history notes. */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
