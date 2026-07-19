import type { WompiIssuanceFailureItem } from "./types";
import { formatCents } from "../shared/money";

export function createLatestRequestGate() {
  let generation = 0;

  return {
    start() {
      const requestGeneration = ++generation;
      return {
        commit(update: () => void): boolean {
          if (requestGeneration !== generation) {
            return false;
          }
          update();
          return true;
        }
      };
    },
    invalidate() {
      generation += 1;
    }
  };
}

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
      formatCents(item.amount_cents),
      (item.amount_cents / 100).toFixed(2)
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  );
}

export function isPreCdeRetryInFlight(
  item: Pick<WompiIssuanceFailureItem, "issuance_status" | "processed_at">
): boolean {
  return item.processed_at === null
    && (
      item.issuance_status === "RETRY_QUEUED"
      || item.issuance_status === "PROCESSING"
    );
}

export function preCdeActionLabel(
  item: Pick<WompiIssuanceFailureItem, "issuance_status" | "processed_at">,
  correctable: boolean,
  reviewRequired = false
): string {
  if (reviewRequired) return "Revisión necesaria";
  const retryInFlight = isPreCdeRetryInFlight(item);
  if (correctable) {
    if (!retryInFlight) return "Corregir y reintentar";
    return item.issuance_status === "RETRY_QUEUED"
      ? "Corrección en cola"
      : "Procesando corrección";
  }
  return retryInFlight ? "Reintento en cola" : "Reintentar creación";
}
