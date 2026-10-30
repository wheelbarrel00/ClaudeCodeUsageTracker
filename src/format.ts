const formatters = new Map<string, Intl.NumberFormat | null>();

export function formatCurrency(value: number, currency: string, decimals: number): string {
  const d = Math.min(20, Math.max(0, Math.round(decimals)));
  const key = `${currency}|${d}`;
  let format = formatters.get(key);
  if (format === undefined) {
    try {
      format = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
    } catch {
      format = null;
    }
    formatters.set(key, format);
  }
  return format ? format.format(value) : `$${value.toFixed(d)}`;
}
