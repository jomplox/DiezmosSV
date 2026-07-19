// Formato monetario canónico compartido entre worker y cliente: dólares US con
// separador de miles y siempre dos decimales ("$1,234.56").
const USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

export function formatCents(amountCents: number): string {
  return USD_FORMAT.format(amountCents / 100);
}
