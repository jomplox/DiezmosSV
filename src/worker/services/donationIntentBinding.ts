import type { DonationIntentRecord, WompiWebhook } from "../types";
import type { Repository } from "../storage/repository";

export type DonationIntentBinding =
  | { kind: "legacy" }
  | { kind: "bound"; intent: DonationIntentRecord }
  | {
      kind: "unbound";
      intentId: string;
      reason:
        | "missing_canonical_commerce_id"
        | "commerce_id_mismatch"
        | "intent_not_found"
        | "ineligible_status"
        | "missing_payload_link_id"
        | "missing_stored_link_id"
        | "link_id_mismatch";
      expectedLinkId: number | null;
      payloadLinkId: number | null;
    };

const INTENT_ID_PREFIX = "di_";

export async function resolveDonationIntentBinding(repo: Repository, payload: WompiWebhook): Promise<DonationIntentBinding> {
  const canonicalId = payload.EnlacePago?.IdentificadorEnlaceComercio?.trim() ?? "";
  const externalId = payload.IdExterno?.trim() ?? "";
  const payloadLinkId = payload.EnlacePago?.Id ?? null;

  if (!canonicalId.startsWith(INTENT_ID_PREFIX)) {
    if (externalId.startsWith(INTENT_ID_PREFIX)) {
      return unbound(externalId, "missing_canonical_commerce_id", null, payloadLinkId);
    }
    return { kind: "legacy" };
  }

  if (externalId && externalId !== canonicalId) {
    return unbound(canonicalId, "commerce_id_mismatch", null, payloadLinkId);
  }

  const intent = await repo.getDonationIntent(canonicalId);
  if (!intent) {
    return unbound(canonicalId, "intent_not_found", null, payloadLinkId);
  }
  if (intent.status !== "LINK_CREATED" && intent.status !== "EXPIRED") {
    return unbound(canonicalId, "ineligible_status", intent.wompi_id_enlace, payloadLinkId);
  }
  if (payloadLinkId === null) {
    return unbound(canonicalId, "missing_payload_link_id", intent.wompi_id_enlace, null);
  }
  if (intent.wompi_id_enlace === null) {
    return unbound(canonicalId, "missing_stored_link_id", null, payloadLinkId);
  }
  if (payloadLinkId !== intent.wompi_id_enlace) {
    return unbound(canonicalId, "link_id_mismatch", intent.wompi_id_enlace, payloadLinkId);
  }
  return { kind: "bound", intent };
}

function unbound(
  intentId: string,
  reason: Extract<DonationIntentBinding, { kind: "unbound" }>["reason"],
  expectedLinkId: number | null,
  payloadLinkId: number | null
): Extract<DonationIntentBinding, { kind: "unbound" }> {
  return { kind: "unbound", intentId, reason, expectedLinkId, payloadLinkId };
}
