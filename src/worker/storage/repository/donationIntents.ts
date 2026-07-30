import type {
  DonationGiftType,
  DonationIntentDocumentType,
  DonationIntentListItem,
  DonationIntentRecord,
  WompiPaymentLink
} from "../../types";
import { nowIso } from "../../utils/dates";

interface DonationIntentHost {
  getDonationIntent(id: string): Promise<DonationIntentRecord | null>;
}

export const INTENT_EXPIRY_SWEEP_LIMIT = 100;
export const INTENT_RECONCILIATION_SWEEP_LIMIT = 25;

export interface CreateDonationIntentInput {
  id: string;
  amountCents: number;
  // Name and email are collected on Wompi's sheet (not the /donar form), so both
  // are nullable; donorName carries the razón social for NIT (36) intents only.
  donorName: string | null;
  donorDocumentType: DonationIntentDocumentType;
  // Document + address are nullable so a DRAFT intent (background link mint on
  // Paso 1→2, before the fiscal data exists) can be persisted; the /datos endpoint
  // fills them in later. A full create passes them all non-null.
  donorDocument: string | null;
  donorEmail: string | null;
  donorPhone: string | null;
  direccionDepartamento: string | null;
  direccionMunicipio: string | null;
  direccionDistrito: string | null;
  direccionComplemento: string | null;
  // CAT-020 country for the foreign path (00/00/00 geography); null domestic.
  donorPais: string | null;
  // Diezmo/Ofrenda (SV flow only); null for legacy and US paths.
  giftType: DonationGiftType | null;
  clientIp: string | null;
  expiresAt: string;
  datosTokenHash: string | null;
  rateLimitClaimId: string;
}

export interface IntentDatosInput {
  donorDocumentType: DonationIntentDocumentType;
  donorDocument: string;
  donorName: string | null;
  donorPhone: string | null;
  direccionDepartamento: string;
  direccionMunicipio: string;
  direccionDistrito: string;
  direccionComplemento: string | null;
  donorPais: string | null;
}

export async function createDonationIntent(
  db: D1Database,
  host: DonationIntentHost,
  input: CreateDonationIntentInput
): Promise<DonationIntentRecord> {
  // Capability hash is appended after gift_type so the established donor-field
  // bindings remain stable. Full creates pass NULL; only drafts receive a hash.
  await db
    .prepare(
      `INSERT INTO donation_intents (
          id, status, amount_cents, donor_name, donor_document_type, donor_document, donor_email, donor_phone,
          direccion_departamento, direccion_municipio, direccion_distrito, direccion_complemento, donor_pais, client_ip, expires_at, gift_type,
          datos_token_hash, rate_limit_claim_id
        ) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      input.amountCents,
      input.donorName,
      input.donorDocumentType,
      input.donorDocument,
      input.donorEmail,
      input.donorPhone,
      input.direccionDepartamento,
      input.direccionMunicipio,
      input.direccionDistrito,
      input.direccionComplemento,
      input.donorPais,
      input.clientIp,
      input.expiresAt,
      input.giftType,
      input.datosTokenHash,
      input.rateLimitClaimId
    )
    .run();
  const record = await host.getDonationIntent(input.id);
  if (!record) {
    throw new Error("No se pudo leer la intención de donación creada");
  }
  return record;
}

export async function getDonationIntent(
  db: D1Database,
  id: string
): Promise<DonationIntentRecord | null> {
  return db.prepare("SELECT * FROM donation_intents WHERE id = ?").bind(id).first<DonationIntentRecord>();
}

export async function attachIntentLink(
  db: D1Database,
  id: string,
  link: WompiPaymentLink
): Promise<void> {
  await db
    .prepare(
      `UPDATE donation_intents
         SET wompi_id_enlace = ?, wompi_url_enlace = ?, wompi_url_enlace_largo = ?, status = 'LINK_CREATED', updated_at = ?
         WHERE id = ?`
    )
    .bind(link.idEnlace, link.urlEnlace, link.urlEnlaceLargo, nowIso(), id)
    .run();
}

// Attaches the donor's fiscal data to a minted draft (the /datos completion). Amount,
// gift type, status, and the Wompi link are deliberately NOT in the SET clause: those
// were locked when the link was minted, and datos must never move them.
export async function applyIntentDatosWithCapability(
  db: D1Database,
  id: string,
  datosTokenHash: string,
  data: IntentDatosInput
): Promise<{ id: string; urlEnlace: string; urlEnlaceLargo: string } | null> {
  const changedAt = nowIso();
  const updated = await db
    .prepare(
      `UPDATE donation_intents
         SET donor_document_type = ?, donor_document = ?, donor_name = ?, donor_phone = ?,
             direccion_departamento = ?, direccion_municipio = ?, direccion_distrito = ?,
             direccion_complemento = ?, donor_pais = ?, datos_token_hash = NULL, updated_at = ?
         WHERE id = ?
           AND datos_token_hash = ?
           AND status = 'LINK_CREATED'
           AND paid_at IS NULL
           AND donor_document IS NULL
           AND expires_at > ?
         RETURNING id, wompi_url_enlace, wompi_url_enlace_largo`
    )
    .bind(
      data.donorDocumentType,
      data.donorDocument,
      data.donorName,
      data.donorPhone,
      data.direccionDepartamento,
      data.direccionMunicipio,
      data.direccionDistrito,
      data.direccionComplemento,
      data.donorPais,
      changedAt,
      id,
      datosTokenHash,
      changedAt
    )
    .first<{
      id: string;
      wompi_url_enlace: string | null;
      wompi_url_enlace_largo: string | null;
    }>();
  if (
    updated?.id !== id ||
    !updated.wompi_url_enlace ||
    !updated.wompi_url_enlace_largo
  ) {
    return null;
  }
  return {
    id: updated.id,
    urlEnlace: updated.wompi_url_enlace,
    urlEnlaceLargo: updated.wompi_url_enlace_largo
  };
}

export async function markIntentCompleted(
  db: D1Database,
  id: string,
  documentId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE donation_intents
            SET status = 'COMPLETED', document_id = ?, updated_at = ?
          WHERE id = ?
            AND (
              (status IN ('LINK_CREATED', 'EXPIRED') AND document_id IS NULL)
              OR (status = 'COMPLETED' AND document_id = ?)
            )`
    )
    .bind(documentId, nowIso(), id, documentId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function completeIntentForPostAcceptOwner(
  db: D1Database,
  id: string,
  documentId: string,
  claimId: string
): Promise<boolean> {
  const updatedAt = nowIso();
  const row = await db
    .prepare(
      `UPDATE donation_intents
            SET status = 'COMPLETED', document_id = ?, updated_at = ?
          WHERE id = ?
            AND (
              (status IN ('LINK_CREATED', 'EXPIRED') AND document_id IS NULL)
              OR (status = 'COMPLETED' AND document_id = ?)
            )
            AND EXISTS (
              SELECT 1 FROM dte_documents
               WHERE id = ? AND status = 'ACCEPTED'
                 AND post_accept_finalized_at IS NULL
                 AND fiscal_operation_claim_id IS NULL
                 AND post_accept_finalization_claim_id = ?
            )
          RETURNING id`
    )
    .bind(documentId, updatedAt, id, documentId, documentId, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

// Stamp the donor's payment (migration 0016). Called by the Wompi webhook when an
// approved payment correlates to this intent. Deliberately does NOT touch status:
// COMPLETED stays reserved for MH acceptance of the CDE. The `paid_at IS NULL` guard
// makes it idempotent — a webhook replay never moves the timestamp, and an unknown or
// already-paid intent simply matches nothing (no-op, no error).
// donorPhone/direccionComplemento carry the contact data Wompi's hosted sheet collected:
// /donar stopped asking for either once Wompi began forcing them, so the webhook is the
// only source and the contacts/CRM export still reads both columns off this row. COALESCE
// means a value the donor or an admin did supply is never overwritten; the caller passes
// already-normalized values so this stays free of Wompi payload semantics.
export async function markIntentPaid(
  db: D1Database,
  id: string,
  expectedLinkId: number,
  donorPhone: string | null = null,
  direccionComplemento: string | null = null
): Promise<void> {
  await db
    .prepare(
      `UPDATE donation_intents
            SET paid_at = ?,
                updated_at = ?,
                donor_phone = COALESCE(donor_phone, ?),
                direccion_complemento = COALESCE(direccion_complemento, ?)
          WHERE id = ?
            AND wompi_id_enlace = ?
            AND status IN ('LINK_CREATED', 'EXPIRED')
            AND paid_at IS NULL`
    )
    .bind(nowIso(), nowIso(), donorPhone, direccionComplemento, id, expectedLinkId)
    .run();
}

// Bounded recovery candidates for successful Wompi transactions whose webhook has
// not reached us yet. LINK_CREATED covers active checkouts and EXPIRED covers the
// late/missing-callback incident class seen in production. updated_at doubles as the
// last-check timestamp so an unpaid link is queried at most once per stale window,
// without a launch-day schema migration.
export async function listIntentsForWompiReconciliation(
  db: D1Database,
  createdAfter: string,
  checkedBefore: string,
  limit = INTENT_RECONCILIATION_SWEEP_LIMIT
): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type" | "updated_at">>> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), INTENT_RECONCILIATION_SWEEP_LIMIT));
  const result = await db
    .prepare(
      `SELECT id, wompi_id_enlace, amount_cents, status, gift_type, updated_at
         FROM donation_intents
        WHERE status IN ('LINK_CREATED','EXPIRED')
          AND wompi_id_enlace IS NOT NULL
          AND paid_at IS NULL
          AND created_at >= ?
          AND updated_at < ?
        ORDER BY updated_at ASC, id ASC
        LIMIT ?`
    )
    .bind(createdAfter, checkedBefore, safeLimit)
    .all<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type" | "updated_at">>();
  return result.results;
}

export async function touchIntentWompiReconciliationCheck(
  db: D1Database,
  id: string,
  expectedLinkId: number,
  observedUpdatedAt: string,
  checkedAt: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE donation_intents
          SET updated_at = ?
        WHERE id = ?
          AND wompi_id_enlace = ?
          AND status IN ('LINK_CREATED','EXPIRED')
          AND paid_at IS NULL
          AND updated_at = ?`
    )
    .bind(checkedAt, id, expectedLinkId, observedUpdatedAt)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

// The intents the next expireUnpaidIntentsBefore(nowIso) call will flip: same
// (status, expires_at) predicate as the UPDATE, so the sweep can deactivate the
// Wompi links of exactly the rows it is about to expire. Read this BEFORE the
// UPDATE (afterwards the rows no longer match) — its results feed
// WompiApiService.deactivatePaymentLink.
export async function listIntentsExpiringBefore(
  db: D1Database,
  nowIso: string,
  limit = INTENT_EXPIRY_SWEEP_LIMIT
): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>> {
  // gift_type is projected so the deactivation sweep can resend the SAME
  // nombreProducto the create sent (a PUT replaces the whole link object). The page
  // is capped and ordered oldest-first so attacker-created expired intents cannot
  // force one cron invocation to snapshot (or deactivate) an unbounded row set; the
  // next tick continues from the remaining PENDING/LINK_CREATED rows.
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), INTENT_EXPIRY_SWEEP_LIMIT));
  const result = await db
    .prepare("SELECT id, wompi_id_enlace, amount_cents, status, gift_type FROM donation_intents WHERE status IN ('PENDING','LINK_CREATED') AND paid_at IS NULL AND expires_at < ? ORDER BY expires_at ASC, id ASC LIMIT ?")
    .bind(nowIso, safeLimit)
    .all<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>();
  return result.results;
}

// Marks only the bounded page the cron sweep just snapshotted as EXPIRED, so link
// deactivation and status expiry stay in the same capped unit of work and a later
// tick can continue from rows this one did not process.
export async function expireDonationIntentsByIds(
  db: D1Database,
  ids: string[],
  updatedAt: string
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  await db
    .prepare(`UPDATE donation_intents SET status = 'EXPIRED', updated_at = ? WHERE status IN ('PENDING','LINK_CREATED') AND paid_at IS NULL AND id IN (${placeholders})`)
    .bind(updatedAt, ...ids)
    .run();
}

// Newest-first listing for the admin "Donaciones en línea" panel (Task 5). The
// LEFT JOIN exposes the emitted CDE's numero_control AND its donor_name for
// COMPLETED intents (which carry document_id) and leaves both null for every other
// status. The donante shown in the panel comes from the document (lifted from the
// webhook), since the intent no longer stores name/email.
export async function listRecentDonationIntents(
  db: D1Database,
  limit = 50
): Promise<DonationIntentListItem[]> {
  // Least privilege: allowlist only the columns the admin "Donaciones en línea" panel
  // renders (status, tipo, amount, donante-from-document, numero de control, fecha).
  // A prior `SELECT donation_intents.*` shipped donor PII (donor_document, donor_email),
  // the client IP, and the Wompi payment-link URLs to the browser even though nothing
  // renders them.
  const rows = await db
    .prepare(
      `SELECT donation_intents.id,
                donation_intents.status,
                donation_intents.amount_cents,
                donation_intents.document_id,
                donation_intents.gift_type,
                donation_intents.created_at,
                dte_documents.numero_control AS numero_control,
                dte_documents.donor_name AS document_donor_name
         FROM donation_intents
         LEFT JOIN dte_documents ON dte_documents.id = donation_intents.document_id
         ORDER BY donation_intents.created_at DESC, donation_intents.id DESC
         LIMIT ?`
    )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 100))
    .all<DonationIntentListItem>();
  return rows.results ?? [];
}

// Single indexed lookup (idx_donation_intents_document_id, migration 0009) for the
// document detail's donor-data-verified badge: is there a COMPLETED intent that
// produced this CDE?
export async function getCompletedIntentForDocument(
  db: D1Database,
  documentId: string
): Promise<{ id: string } | null> {
  return db
    .prepare("SELECT id FROM donation_intents WHERE document_id = ? AND status = 'COMPLETED' LIMIT 1")
    .bind(documentId)
    .first<{ id: string }>();
}

export async function hasAuditAction(
  db: D1Database,
  action: string,
  entityType: string,
  entityId: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM audit_logs WHERE action = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
    .bind(action, entityType, entityId)
    .first<{ id: string }>();
  return Boolean(row);
}
