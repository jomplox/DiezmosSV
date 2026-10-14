// Unified admin "Donaciones" ledger: every gift received through either door,
// newest first. The two lanes stay in their own tables (Stripe data must never
// enter the MH issuance lifecycle); they are only merged here, at read time.
//
// - SV: donation intents whose payment was observed (paid_at), or that reached
//   COMPLETED before paid_at existed (migration 0016). Unpaid and expired
//   intents are abandoned attempts, not gifts. Plus Wompi CDEs paid through the
//   static payment link, which never had an intent. Hand-issued CDEs are not
//   online gifts and stay in Documentos only.
// - US: stripe_gifts, which only ever holds settled gifts.

export type DonationLane = "SV" | "US";

export interface DonationLedgerFilters {
  lane?: DonationLane;
  q?: string;
  // Inclusive El Salvador calendar days, YYYY-MM-DD.
  from?: string;
  to?: string;
  cursor?: string | null;
  limit: number;
}

export interface DonationLedgerRow {
  id: string;
  lane: DonationLane;
  receivedAt: string;
  amountCents: number;
  refundedAmountCents: number;
  frequency: "ONCE" | "MONTHLY";
  giftType: "DIEZMO" | "OFRENDA" | null;
  donorName: string | null;
  donorEmail: string | null;
  documentId: string | null;
  numeroControl: string | null;
  documentStatus: string | null;
  giftStatus: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | null;
  acknowledgmentStatus: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "REVIEW" | "SUPPRESSED" | null;
}

export interface DonationLedgerPage {
  donations: DonationLedgerRow[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

interface DonationLedgerSqlRow {
  id: string;
  lane: DonationLane;
  received_at: string;
  amount_cents: number;
  refunded_amount_cents: number;
  frequency: DonationLedgerRow["frequency"];
  gift_type: DonationLedgerRow["giftType"];
  donor_name: string | null;
  donor_email: string | null;
  document_id: string | null;
  numero_control: string | null;
  document_status: string | null;
  gift_status: DonationLedgerRow["giftStatus"];
  acknowledgment_status: DonationLedgerRow["acknowledgmentStatus"];
}

// El Salvador has no DST: a calendar day there starts at 06:00 UTC (same fixed
// offset as the analytics bucketing).
function elSalvadorDayStartIso(day: string, addDays = 0): string {
  const start = new Date(`${day}T06:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() + addDays);
  return start.toISOString();
}

export function isLedgerDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function encodeLedgerCursor(row: DonationLedgerSqlRow): string {
  return `${encodeURIComponent(row.received_at)}|${encodeURIComponent(row.id)}`;
}

export function parseLedgerCursor(value: string | null | undefined): { receivedAt: string; id: string } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return { receivedAt: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

export async function listDonations(
  db: D1Database,
  filters: DonationLedgerFilters
): Promise<DonationLedgerPage> {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (filters.lane) {
    conditions.push("lane = ?");
    bindings.push(filters.lane);
  }
  const q = filters.q?.trim().toLowerCase() ?? "";
  if (q) {
    conditions.push(`(
      instr(LOWER(COALESCE(donor_name, '')), ?) > 0
      OR instr(LOWER(COALESCE(donor_email, '')), ?) > 0
      OR instr(LOWER(COALESCE(numero_control, '')), ?) > 0
    )`);
    bindings.push(q, q, q);
  }
  if (filters.from) {
    conditions.push("received_at >= ?");
    bindings.push(elSalvadorDayStartIso(filters.from));
  }
  if (filters.to) {
    conditions.push("received_at < ?");
    bindings.push(elSalvadorDayStartIso(filters.to, 1));
  }
  const cursor = parseLedgerCursor(filters.cursor);
  if (cursor) {
    conditions.push("(received_at < ? OR (received_at = ? AND id < ?))");
    bindings.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await db
    .prepare(
      `WITH ledger AS (
         SELECT intent.id,
                'SV' AS lane,
                COALESCE(intent.paid_at, intent.created_at) AS received_at,
                intent.amount_cents,
                0 AS refunded_amount_cents,
                'ONCE' AS frequency,
                intent.gift_type,
                COALESCE(NULLIF(TRIM(document.donor_name), ''), NULLIF(TRIM(intent.donor_name), '')) AS donor_name,
                COALESCE(NULLIF(TRIM(document.donor_email), ''), NULLIF(TRIM(intent.donor_email), '')) AS donor_email,
                document.id AS document_id,
                document.numero_control,
                document.status AS document_status,
                NULL AS gift_status,
                NULL AS acknowledgment_status
           FROM donation_intents AS intent
           LEFT JOIN dte_documents AS document ON document.id = intent.document_id
          WHERE intent.paid_at IS NOT NULL OR intent.status = 'COMPLETED'
         UNION ALL
         SELECT document.id,
                'SV',
                document.created_at,
                document.amount_cents,
                0,
                'ONCE',
                NULL,
                NULLIF(TRIM(document.donor_name), ''),
                NULLIF(TRIM(document.donor_email), ''),
                document.id,
                document.numero_control,
                document.status,
                NULL,
                NULL
           FROM dte_documents AS document
          WHERE document.wompi_event_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM donation_intents AS linked WHERE linked.document_id = document.id
            )
         UNION ALL
         SELECT gift.id,
                'US',
                gift.settled_at,
                gift.amount_cents,
                gift.refunded_amount_cents,
                gift.frequency,
                CASE gift.gift_type WHEN 'TITHE' THEN 'DIEZMO' WHEN 'OFFERING' THEN 'OFRENDA' END,
                NULLIF(TRIM(gift.donor_name), ''),
                NULLIF(TRIM(gift.donor_email), ''),
                NULL,
                NULL,
                NULL,
                gift.status,
                CASE WHEN gift.acknowledgment_suppressed = 1 THEN 'SUPPRESSED' ELSE acknowledgment.status END
           FROM stripe_gifts AS gift
           LEFT JOIN stripe_acknowledgment_deliveries AS acknowledgment
             ON acknowledgment.gift_id = gift.id AND acknowledgment.revision = 1
       )
       SELECT * FROM ledger
       ${where}
       ORDER BY received_at DESC, id DESC
       LIMIT ?`
    )
    .bind(...bindings, filters.limit + 1)
    .all<DonationLedgerSqlRow>();

  const rows = result.results ?? [];
  const pageRows = rows.slice(0, filters.limit);
  const hasMore = rows.length > filters.limit;
  return {
    donations: pageRows.map((row): DonationLedgerRow => ({
      id: row.id,
      lane: row.lane,
      receivedAt: row.received_at,
      amountCents: Number(row.amount_cents),
      refundedAmountCents: Number(row.refunded_amount_cents),
      frequency: row.frequency,
      giftType: row.gift_type,
      donorName: row.donor_name,
      donorEmail: row.donor_email,
      documentId: row.document_id,
      numeroControl: row.numero_control,
      documentStatus: row.document_status,
      giftStatus: row.gift_status,
      acknowledgmentStatus: row.acknowledgment_status
    })),
    hasMore,
    nextCursor: hasMore && pageRows.length > 0 ? encodeLedgerCursor(pageRows[pageRows.length - 1]) : null,
    limit: filters.limit
  };
}
