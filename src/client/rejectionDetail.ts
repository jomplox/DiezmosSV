import type { AuditRow, DteDocument } from "./types";

export interface RejectionDetail {
  reasons: string[];
  rejectedAt: string | null;
}

type RejectionDocument = Pick<DteDocument, "status" | "mh_observaciones_json" | "mh_estado">;
type RejectionAuditRow = Pick<AuditRow, "action" | "created_at">;

const REJECTION_AUDIT_ACTIONS = new Set(["DTE_REJECTED", "ADVANCED_CDE_REJECTED", "DTE_RETRIED"]);

export function rejectionDetailForDocument(document: RejectionDocument, audit: RejectionAuditRow[]): RejectionDetail | null {
  if (document.status !== "REJECTED") return null;

  const reasons = rejectionReasons(document.mh_observaciones_json);
  if (reasons.length === 0) {
    reasons.push(document.mh_estado?.trim() || "Motivo no disponible");
  }

  const rejectionEvent = audit.find(
    (row) => REJECTION_AUDIT_ACTIONS.has(row.action) && validTimestamp(row.created_at)
  );
  return { reasons, rejectedAt: rejectionEvent?.created_at ?? null };
}

function rejectionReasons(value: string): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  let observations: unknown;
  try {
    observations = JSON.parse(value);
  } catch {
    return reasons;
  }
  if (!Array.isArray(observations)) return reasons;
  for (const observation of observations) collectObservation(observation, reasons, seen);
  return reasons;
}

function collectObservation(value: unknown, reasons: string[], seen: Set<string>): void {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      collectMhRecord(parsed, reasons, seen);
      return;
    }
  } catch {
    // Ordinary MH observation, not nested JSON.
  }
  addReason(text, reasons, seen);
}

function collectMhRecord(value: Record<string, unknown>, reasons: string[], seen: Set<string>): void {
  const candidates = [value, isRecord(value.body) ? value.body : null].filter(isRecord);
  for (const candidate of candidates) {
    const code = textValue(candidate.codigoMsg);
    const description = textValue(candidate.descripcionMsg);
    if (code || description) addReason([code, description].filter(Boolean).join(": "), reasons, seen);
    if (!Array.isArray(candidate.observaciones)) continue;
    for (const observation of candidate.observaciones) {
      const observationText = textValue(observation);
      if (observationText && observationText !== description) addReason(observationText, reasons, seen);
    }
  }
}

function addReason(value: string, reasons: string[], seen: Set<string>): void {
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  reasons.push(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}
