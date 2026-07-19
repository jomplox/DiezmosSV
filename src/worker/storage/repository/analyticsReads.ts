import type { Ambiente, DonationIntentRecord, DteDocumentRecord } from "../../types";

export async function earliestDteDocumentCreatedAt(
  db: D1Database
): Promise<string | null> {
  const row = await db.prepare("SELECT MIN(created_at) AS earliest FROM dte_documents").first<{ earliest: string | null }>();
  return row?.earliest ?? null;
}

export async function listWompiLaneDocumentsForAnalytics(
  db: D1Database,
  range: { startIso: string; endIso: string },
  environment: Ambiente,
  cursor: { issuedAt: string; id: string } | null,
  limit: number
): Promise<
  Array<
    Pick<
      DteDocumentRecord,
      "id" | "wompi_event_id" | "environment" | "status" | "donor_email" | "donor_name" | "amount_cents" | "issued_at" | "accepted_at" | "transmission_deferred_at"
    > & { direccion_departamento: string | null; donor_pais: string | null; gift_type: string | null }
  >
> {
  const conditions = [
    "d.wompi_event_id IS NOT NULL",
    "d.fiscal_operation_claim_id IS NULL",
    "d.environment = ?",
    "d.issued_at >= ?",
    "d.issued_at < ?"
  ];
  const bindings: Array<string | number> = [environment, range.startIso, range.endIso];
  if (cursor) {
    conditions.push("(d.issued_at, d.id) > (?, ?)");
    bindings.push(cursor.issuedAt, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT d.id, d.wompi_event_id, d.environment, d.status, d.donor_email, d.donor_name,
              d.amount_cents, d.issued_at, d.accepted_at, d.transmission_deferred_at,
              i.direccion_departamento AS direccion_departamento, i.donor_pais AS donor_pais, i.gift_type AS gift_type
       FROM dte_documents d
       LEFT JOIN donation_intents i ON i.document_id = d.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.issued_at ASC, d.id ASC LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<
      Pick<
        DteDocumentRecord,
        "id" | "wompi_event_id" | "environment" | "status" | "donor_email" | "donor_name" | "amount_cents" | "issued_at" | "accepted_at" | "transmission_deferred_at"
      > & { direccion_departamento: string | null; donor_pais: string | null; gift_type: string | null }
    >();
  return rows.results ?? [];
}

export async function listDonationIntentsForAnalytics(
  db: D1Database,
  range: { startIso: string; endIso: string },
  environment: Ambiente,
  cursor: { createdAt: string; id: string } | null,
  limit: number
): Promise<
  Array<
    Pick<DonationIntentRecord, "id" | "status" | "document_id" | "donor_document" | "gift_type" | "created_at" | "paid_at"> & { direccion_departamento: string | null; donor_pais: string | null }
  >
> {
  // Intent belongs to the requested ambiente when its emitted document is in that
  // ambiente; intents that never produced a document (PENDING/LINK_CREATED/EXPIRED)
  // have no environment column, so they are attributed to the requested ambiente
  // only when it matches the active emission environment the endpoint passes. To keep
  // the funnel honest per-ambiente we require: either the joined doc is in `environment`,
  // or there is no joined doc (unpaid/abandoned) — those are lane intents of the active
  // ambiente the endpoint is scoped to.
  const conditions = ["i.created_at >= ?", "i.created_at < ?", "(d.environment = ? OR d.id IS NULL)"];
  const bindings: Array<string | number> = [range.startIso, range.endIso, environment];
  if (cursor) {
    conditions.push("(i.created_at, i.id) > (?, ?)");
    bindings.push(cursor.createdAt, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT i.id, i.status, i.document_id, i.donor_document, i.gift_type, i.created_at, i.paid_at,
              i.direccion_departamento AS direccion_departamento, i.donor_pais AS donor_pais
       FROM donation_intents i
       LEFT JOIN dte_documents d ON d.id = i.document_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY i.created_at ASC, i.id ASC LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<
      Pick<DonationIntentRecord, "id" | "status" | "document_id" | "donor_document" | "gift_type" | "created_at" | "paid_at"> & { direccion_departamento: string | null; donor_pais: string | null }
    >();
  return rows.results ?? [];
}

export async function listEmailDeliveriesForAnalytics(
  db: D1Database,
  range: { startIso: string; endIso: string },
  environment: Ambiente,
  cursor: { createdAt: string; id: string } | null,
  limit: number
): Promise<Array<{ id: string; document_id: string; status: string; created_at: string }>> {
  const conditions = ["e.created_at >= ?", "e.created_at < ?", "d.wompi_event_id IS NOT NULL", "d.environment = ?"];
  const bindings: Array<string | number> = [range.startIso, range.endIso, environment];
  if (cursor) {
    conditions.push("(e.created_at, e.id) > (?, ?)");
    bindings.push(cursor.createdAt, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT e.id, e.document_id, e.status, e.created_at
       FROM email_deliveries e
       JOIN dte_documents d ON d.id = e.document_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.created_at ASC, e.id ASC LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<{ id: string; document_id: string; status: string; created_at: string }>();
  return rows.results ?? [];
}
