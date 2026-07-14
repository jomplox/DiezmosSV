import type { WompiIssuanceFailureItem } from "./types";

export function filterPreCdeFailures(
  items: WompiIssuanceFailureItem[],
  query: string
): WompiIssuanceFailureItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return items;
  }

  return items.filter((item) =>
    [
      item.donor_name ?? "",
      item.donor_email ?? "",
      item.reserved_numero_control ?? "",
      item.issuance_error_code ?? "",
      item.issuance_error_message ?? "",
      (item.amount_cents / 100).toFixed(2)
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  );
}
