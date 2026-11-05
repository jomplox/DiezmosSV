// Formato monetario canónico compartido entre worker y cliente: dólares US con
// separador de miles y siempre dos decimales ("$1,234.56").
const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

export function formatCents(amountCents: number): string {
  return USD_FORMAT.format(amountCents / 100);
}

// Montos que llegan como decimal en texto (el JSON del DTE, el F960) se muestran con el
// mismo formato. Un valor no numérico se muestra tal cual en lugar de inventar un monto.
export function formatUsdAmount(amount: string | number): string {
  const value = Number(amount);
  return Number.isFinite(value) ? formatCents(Math.round(value * 100)) : `$${amount}`;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}
