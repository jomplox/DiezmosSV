import type { StripeGiftRecord } from "./stripeDonations";

export interface StripeAnnualStatementGift extends StripeGiftRecord {
  net_amount_cents: number;
}

export interface StripeAnnualStatementDonorTarget {
  donorKey: string;
  donorName: string;
  donorEmail: string | null;
  count: number;
  grossCents: number;
  refundedCents: number;
  netCents: number;
}

const SEARCH_CANDIDATE_PAGE_SIZE = 100;

interface StripeAnnualStatementTargetRow {
  donor_key: string;
  donor_name: string;
  donor_email: string | null;
  gift_count: number;
  gross_cents: number;
  refunded_cents: number;
  net_cents: number;
}

interface StripeAnnualStatementSearchTargetRow extends StripeAnnualStatementTargetRow {
  donor_names_json: string;
}

export async function listStripeAnnualStatementDonorTargets(
  db: D1Database,
  range: { startIso: string; endIso: string },
  options: { livemode: boolean; afterDonorKey: string | null; limit: number; donorKey?: string | null; query?: string | null }
): Promise<StripeAnnualStatementDonorTarget[]> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError("Stripe annual statement target limit must be a positive integer");
  }
  const impossibleNet = await db.prepare(
    `SELECT gift.id
       FROM stripe_gifts AS gift
       JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
      WHERE gift.settled_at >= ? AND gift.settled_at < ?
        AND checkout.livemode = ?
        AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND gift.amount_cents - gift.refunded_amount_cents < 0
      LIMIT 1`
  ).bind(range.startIso, range.endIso, options.livemode ? 1 : 0).first<{ id: string }>();
  if (impossibleNet) {
    throw new Error("Stripe annual statement contains a negative net amount");
  }
  const pageSize = Math.min(options.limit, 50);
  const query = normalizedSearch(options.query);
  if (query) {
    return listSearchTargets(db, range, options, pageSize, query);
  }
  const bindings: Array<string | number> = [range.startIso, range.endIso, options.livemode ? 1 : 0];
  let targetFilter = "";
  if (options.donorKey) {
    targetFilter = "WHERE donor_key = ?";
    bindings.push(options.donorKey);
  } else if (options.afterDonorKey) {
    targetFilter = "WHERE donor_key > ?";
    bindings.push(options.afterDonorKey);
  }
  const rows = await db.prepare(
    `/* stripe_annual_statement_targets */
     WITH filtered AS (
       SELECT gift.id,
              NULLIF(LOWER(TRIM(gift.donor_email)), '') AS normalized_email,
              NULLIF(TRIM(gift.donor_name), '') AS normalized_name,
              gift.amount_cents,
              gift.refunded_amount_cents,
              gift.settled_at,
              CASE
                WHEN NULLIF(TRIM(gift.donor_email), '') IS NULL THEN 'gift:' || gift.id
                ELSE LOWER(TRIM(gift.donor_email))
              END AS donor_key
         FROM stripe_gifts AS gift
         JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
        WHERE gift.settled_at >= ? AND gift.settled_at < ?
          AND checkout.livemode = ?
          AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
     ),
     ranked AS (
       SELECT filtered.*,
              ROW_NUMBER() OVER (PARTITION BY donor_key ORDER BY settled_at, id) AS donor_row
         FROM filtered
     ),
     grouped AS (
       SELECT donor_key,
              MAX(CASE WHEN donor_row = 1
                THEN COALESCE(normalized_name, normalized_email, 'Donante') END) AS donor_name,
              MAX(CASE WHEN donor_row = 1 THEN normalized_email END) AS donor_email,
              COUNT(*) AS gift_count,
              SUM(amount_cents) AS gross_cents,
              SUM(refunded_amount_cents) AS refunded_cents,
              SUM(amount_cents - refunded_amount_cents) AS net_cents
         FROM ranked
        GROUP BY donor_key
     )
     SELECT donor_key, donor_name, donor_email, gift_count,
            gross_cents, refunded_cents, net_cents
       FROM grouped
       ${targetFilter}
      ORDER BY donor_key
      LIMIT ?`
  ).bind(...bindings, pageSize + 1).all<StripeAnnualStatementTargetRow>();
  return (rows.results ?? []).map(targetFromRow);
}

async function listSearchTargets(
  db: D1Database,
  range: { startIso: string; endIso: string },
  options: { livemode: boolean; afterDonorKey: string | null; limit: number; donorKey?: string | null },
  pageSize: number,
  query: string
): Promise<StripeAnnualStatementDonorTarget[]> {
  const targets: StripeAnnualStatementDonorTarget[] = [];
  let afterDonorKey = options.donorKey ? null : options.afterDonorKey;
  do {
    const bindings: Array<string | number> = [range.startIso, range.endIso, options.livemode ? 1 : 0];
    const targetFilter = options.donorKey
      ? "WHERE donor_key = ?"
      : afterDonorKey
        ? "WHERE donor_key > ?"
        : "";
    if (options.donorKey) bindings.push(options.donorKey);
    else if (afterDonorKey) bindings.push(afterDonorKey);
    const rows = await db.prepare(
      `/* stripe_annual_statement_search_targets */
       WITH filtered AS (
         SELECT gift.id,
                NULLIF(LOWER(TRIM(gift.donor_email)), '') AS normalized_email,
                NULLIF(TRIM(gift.donor_name), '') AS normalized_name,
                gift.amount_cents,
                gift.refunded_amount_cents,
                gift.settled_at,
                CASE
                  WHEN NULLIF(TRIM(gift.donor_email), '') IS NULL THEN 'gift:' || gift.id
                  ELSE LOWER(TRIM(gift.donor_email))
                END AS donor_key
           FROM stripe_gifts AS gift
           JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
          WHERE gift.settled_at >= ? AND gift.settled_at < ?
            AND checkout.livemode = ?
            AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
       ),
       ranked AS (
         SELECT filtered.*,
                ROW_NUMBER() OVER (PARTITION BY donor_key ORDER BY settled_at, id) AS donor_row
           FROM filtered
       ),
       grouped AS (
         SELECT donor_key,
                MAX(CASE WHEN donor_row = 1
                  THEN COALESCE(normalized_name, normalized_email, 'Donante') END) AS donor_name,
                MAX(CASE WHEN donor_row = 1 THEN normalized_email END) AS donor_email,
                json_group_array(normalized_name) AS donor_names_json,
                COUNT(*) AS gift_count,
                SUM(amount_cents) AS gross_cents,
                SUM(refunded_amount_cents) AS refunded_cents,
                SUM(amount_cents - refunded_amount_cents) AS net_cents
           FROM ranked
          GROUP BY donor_key
       )
       SELECT donor_key, donor_name, donor_email, donor_names_json, gift_count,
              gross_cents, refunded_cents, net_cents
         FROM grouped
         ${targetFilter}
        ORDER BY donor_key
        LIMIT ?`
    ).bind(...bindings, SEARCH_CANDIDATE_PAGE_SIZE).all<StripeAnnualStatementSearchTargetRow>();
    const candidates = rows.results ?? [];
    for (const candidate of candidates) {
      if (matchesSearchTarget(candidate, query)) {
        targets.push(targetFromRow(candidate));
        if (targets.length > pageSize) return targets;
      }
    }
    if (options.donorKey || candidates.length < SEARCH_CANDIDATE_PAGE_SIZE) return targets;
    afterDonorKey = candidates.at(-1)?.donor_key ?? null;
  } while (afterDonorKey);
  return targets;
}

function normalizedSearch(value: string | null | undefined): string {
  return (value ?? "").trim().normalize("NFKC").toLocaleLowerCase();
}

function matchesSearchTarget(row: StripeAnnualStatementSearchTargetRow, query: string): boolean {
  if (normalizedSearch(row.donor_email).includes(query)) return true;
  try {
    const names = JSON.parse(row.donor_names_json) as Array<string | null>;
    return names.some((name) => normalizedSearch(name).includes(query));
  } catch {
    throw new Error("Stripe annual statement search candidate names are invalid");
  }
}

function targetFromRow(row: StripeAnnualStatementTargetRow): StripeAnnualStatementDonorTarget {
  const netCents = Number(row.net_cents);
  if (netCents < 0) throw new Error("Stripe annual statement contains a negative net amount");
  return {
    donorKey: row.donor_key,
    donorName: row.donor_name,
    donorEmail: row.donor_email,
    count: Number(row.gift_count),
    grossCents: Number(row.gross_cents),
    refundedCents: Number(row.refunded_cents),
    netCents
  };
}

export async function listStripeAnnualStatementDonorGifts(
  db: D1Database,
  range: { startIso: string; endIso: string },
  livemode: boolean,
  donorKey: string
): Promise<StripeAnnualStatementGift[]> {
  const rows = await db.prepare(
    `/* stripe_annual_statement_gifts */
     SELECT gift.*, gift.amount_cents - gift.refunded_amount_cents AS net_amount_cents
       FROM stripe_gifts AS gift
       JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
      WHERE gift.settled_at >= ? AND gift.settled_at < ?
        AND checkout.livemode = ?
        AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND CASE
              WHEN NULLIF(TRIM(gift.donor_email), '') IS NULL THEN 'gift:' || gift.id
              ELSE LOWER(TRIM(gift.donor_email))
            END = ?
      ORDER BY gift.settled_at, gift.id`
  ).bind(range.startIso, range.endIso, livemode ? 1 : 0, donorKey)
    .all<StripeAnnualStatementGift>();
  const gifts = rows.results ?? [];
  if (gifts.some((gift) => Number(gift.net_amount_cents) < 0)) {
    throw new Error("Stripe annual statement contains a negative net amount");
  }
  return gifts;
}

export interface StripeAnnualStatementDeliveryRecord {
  id: string;
  year: number;
  livemode: 0 | 1;
  donor_key: string;
  donor_name: string;
  donor_email: string | null;
  snapshot_hash: string;
  snapshot_json: string;
  revision: number;
  supersedes_delivery_id: string | null;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED" | "REVIEW";
  attempt_count: number;
  processing_claim_id: string | null;
  lease_expires_at: string | null;
  dispatch_started_at: string | null;
  provider_id_hash: string | null;
  failure_code: string | null;
  retry_safe: 0 | 1;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export class StripeAnnualStatementReservationFenceError extends Error {
  constructor(readonly status: StripeAnnualStatementDeliveryRecord["status"]) {
    super(status === "REVIEW"
      ? "Stripe annual statement has an unresolved review for this donor and year"
      : "Stripe annual statement already has an active delivery for this donor and year");
    this.name = "StripeAnnualStatementReservationFenceError";
  }
}

export async function reserveStripeAnnualStatementDelivery(
  db: D1Database,
  input: {
    id: string;
    year: number;
    livemode: boolean;
    donorKey: string;
    donorName: string;
    donorEmail: string | null;
    snapshotHash: string;
    snapshotJson: string;
    now: string;
  }
): Promise<StripeAnnualStatementDeliveryRecord> {
  const staleBefore = processingStaleBefore(input.now);
  await db.batch([
    db.prepare(
      `UPDATE stripe_annual_statement_deliveries
          SET status = 'FAILED', processing_claim_id = NULL,
              lease_expires_at = NULL, failure_code = 'superseded_stale_pre_dispatch',
              retry_safe = 0, updated_at = ?
        WHERE year = ? AND livemode = ? AND donor_key = ?
          AND snapshot_hash <> ?
          AND (
            (status = 'PENDING' AND updated_at < ?)
            OR (status = 'PROCESSING' AND dispatch_started_at IS NULL
              AND lease_expires_at <= ?)
          )`
    ).bind(
      input.now,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.snapshotHash,
      staleBefore,
      input.now
    ),
    db.prepare(
      `INSERT OR IGNORE INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
       status, attempt_count, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE((
              SELECT MAX(revision) FROM stripe_annual_statement_deliveries
               WHERE year = ? AND livemode = ? AND donor_key = ?
            ), 0) + 1,
            (
              SELECT id FROM stripe_annual_statement_deliveries
               WHERE year = ? AND livemode = ? AND donor_key = ? AND status = 'SENT'
               ORDER BY revision DESC LIMIT 1
            ),
            'PENDING', 0, ?, ?
      WHERE NOT EXISTS (
       SELECT 1 FROM stripe_annual_statement_deliveries AS fence
        WHERE fence.year = ? AND fence.livemode = ? AND fence.donor_key = ?
          AND fence.status IN ('PENDING', 'PROCESSING', 'REVIEW')
     ) AND NOT EXISTS (
       SELECT 1 FROM stripe_annual_statement_deliveries AS latest
        WHERE latest.year = ? AND latest.livemode = ? AND latest.donor_key = ?
          AND latest.snapshot_hash = ?
          AND latest.revision = (
            SELECT MAX(revision) FROM stripe_annual_statement_deliveries
             WHERE year = ? AND livemode = ? AND donor_key = ?
          )
     ) AND NOT EXISTS (
       SELECT 1 FROM stripe_annual_statement_deliveries AS latest_sent
        WHERE latest_sent.year = ? AND latest_sent.livemode = ? AND latest_sent.donor_key = ?
          AND latest_sent.status = 'SENT' AND latest_sent.snapshot_hash = ?
          AND latest_sent.revision = (
            SELECT MAX(revision) FROM stripe_annual_statement_deliveries
             WHERE year = ? AND livemode = ? AND donor_key = ? AND status = 'SENT'
          )
     )`
    ).bind(
      input.id,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.donorName,
      input.donorEmail,
      input.snapshotHash,
      input.snapshotJson,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.now,
      input.now,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.snapshotHash,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey,
      input.snapshotHash,
      input.year,
      input.livemode ? 1 : 0,
      input.donorKey
    )
  ]);
  let row = await db.prepare(
    `SELECT * FROM stripe_annual_statement_deliveries
      WHERE year = ? AND livemode = ? AND donor_key = ?
      ORDER BY revision DESC LIMIT 1`
  ).bind(
    input.year,
    input.livemode ? 1 : 0,
    input.donorKey
  ).first<StripeAnnualStatementDeliveryRecord>();
  if (!row || row.snapshot_hash !== input.snapshotHash) {
    const fence = await db.prepare(
      `SELECT status FROM stripe_annual_statement_deliveries
        WHERE year = ? AND livemode = ? AND donor_key = ?
          AND status IN ('PENDING', 'PROCESSING', 'REVIEW')
        ORDER BY CASE status WHEN 'REVIEW' THEN 0 WHEN 'PROCESSING' THEN 1 ELSE 2 END,
                 revision DESC
        LIMIT 1`
    ).bind(input.year, input.livemode ? 1 : 0, input.donorKey)
      .first<Pick<StripeAnnualStatementDeliveryRecord, "status">>();
    if (fence) throw new StripeAnnualStatementReservationFenceError(fence.status);
    row = await db.prepare(
      `SELECT * FROM stripe_annual_statement_deliveries
        WHERE year = ? AND livemode = ? AND donor_key = ? AND status = 'SENT'
        ORDER BY revision DESC LIMIT 1`
    ).bind(input.year, input.livemode ? 1 : 0, input.donorKey)
      .first<StripeAnnualStatementDeliveryRecord>();
    if (!row || row.snapshot_hash !== input.snapshotHash) {
      throw new Error("Stripe annual statement reservation could not be read");
    }
  }
  if (
    row.year !== input.year
    || row.livemode !== (input.livemode ? 1 : 0)
    || row.donor_key !== input.donorKey
    || row.donor_name !== input.donorName
    || row.donor_email !== input.donorEmail
    || row.snapshot_hash !== input.snapshotHash
    || row.snapshot_json !== input.snapshotJson
  ) {
    throw new Error("Stripe annual statement snapshot identity conflicts with its durable reservation");
  }
  return row;
}

export async function claimStripeAnnualStatementDelivery(
  db: D1Database,
  input: { id: string; claimId: string; now: string }
): Promise<StripeAnnualStatementDeliveryRecord | null> {
  await db.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = 'REVIEW', processing_claim_id = NULL,
            lease_expires_at = NULL,
            failure_code = 'provider_outcome_unknown_after_claim_timeout',
            retry_safe = 0, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING'
        AND dispatch_started_at IS NOT NULL AND lease_expires_at <= ?`
  ).bind(input.now, input.id, input.now).run();
  const leaseExpiresAt = processingLeaseExpiresAt(input.now);
  return db.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = 'PROCESSING', processing_claim_id = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1, dispatch_started_at = NULL,
            provider_id_hash = NULL, failure_code = NULL, retry_safe = 0,
            updated_at = ?
      WHERE id = ? AND (
        status = 'PENDING'
        OR (status = 'FAILED' AND retry_safe = 1)
        OR (status = 'PROCESSING' AND dispatch_started_at IS NULL AND lease_expires_at <= ?)
      ) AND NOT EXISTS (
        SELECT 1 FROM stripe_annual_statement_deliveries AS fence
         WHERE fence.year = stripe_annual_statement_deliveries.year
           AND fence.livemode = stripe_annual_statement_deliveries.livemode
           AND fence.donor_key = stripe_annual_statement_deliveries.donor_key
           AND fence.id <> stripe_annual_statement_deliveries.id
           AND fence.status IN ('PENDING', 'PROCESSING', 'REVIEW')
      )
      RETURNING *`
  ).bind(input.claimId, leaseExpiresAt, input.now, input.id, input.now)
    .first<StripeAnnualStatementDeliveryRecord>();
}

export async function markStripeAnnualStatementDispatchStarted(
  db: D1Database,
  input: {
    id: string;
    claimId: string;
    snapshotHash: string;
    snapshotJson: string;
    range: { startIso: string; endIso: string };
    livemode: boolean;
    donorKey: string;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `WITH current_gifts AS (
       SELECT gift.id, gift.source_id, gift.frequency, gift.gift_type,
              gift.amount_cents, gift.refunded_amount_cents,
              gift.donor_name, gift.donor_email, gift.settled_at
         FROM stripe_gifts AS gift
         JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
        WHERE gift.settled_at >= ? AND gift.settled_at < ?
          AND checkout.livemode = ?
          AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
          AND CASE
                WHEN NULLIF(TRIM(gift.donor_email), '') IS NULL THEN 'gift:' || gift.id
                ELSE LOWER(TRIM(gift.donor_email))
              END = ?
     )
     UPDATE stripe_annual_statement_deliveries
        SET dispatch_started_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING'
        AND processing_claim_id = ? AND dispatch_started_at IS NULL
        AND lease_expires_at > ?
        AND snapshot_hash = ? AND snapshot_json = ?
        AND donor_key = ?
        AND donor_key IS json_extract(snapshot_json, '$.donor.key')
        AND (SELECT COALESCE(
               NULLIF(TRIM(gift.donor_name), ''),
               NULLIF(LOWER(TRIM(gift.donor_email)), ''),
               'Donante'
             ) FROM current_gifts AS gift ORDER BY gift.settled_at, gift.id LIMIT 1)
            IS json_extract(snapshot_json, '$.donor.name')
        AND (SELECT NULLIF(LOWER(TRIM(gift.donor_email)), '')
               FROM current_gifts AS gift ORDER BY gift.settled_at, gift.id LIMIT 1)
            IS json_extract(snapshot_json, '$.donor.email')
        AND (SELECT COUNT(*) FROM current_gifts)
            = json_array_length(json_extract(snapshot_json, '$.items'))
        AND NOT EXISTS (
          SELECT 1 FROM current_gifts AS gift
           WHERE NOT EXISTS (
             SELECT 1 FROM json_each(snapshot_json, '$.items') AS item
              WHERE json_extract(item.value, '$.sourceId') = gift.source_id
                AND json_extract(item.value, '$.settledAt') = strftime('%Y-%m-%dT%H:%M:%fZ', gift.settled_at)
                AND json_extract(item.value, '$.giftType') = gift.gift_type
                AND json_extract(item.value, '$.frequency') = gift.frequency
                AND json_extract(item.value, '$.grossAmountCents') = gift.amount_cents
                AND json_extract(item.value, '$.refundedAmountCents') = gift.refunded_amount_cents
                AND json_extract(item.value, '$.netAmountCents') = gift.amount_cents - gift.refunded_amount_cents
           )
        )
        AND (SELECT value FROM app_settings WHERE key = 'branding_display_name')
            IS json_extract(snapshot_json, '$.document.settings.brandingDisplayName')
        AND (SELECT value FROM app_settings WHERE key = 'branding_accent_color')
            IS json_extract(snapshot_json, '$.document.settings.brandingAccentColor')
        AND (SELECT value FROM app_settings WHERE key = 'branding_support_email')
            IS json_extract(snapshot_json, '$.document.settings.brandingSupportEmail')
        AND (SELECT value FROM app_settings WHERE key = 'branding_logo')
            IS json_extract(snapshot_json, '$.document.settings.brandingLogo')
        AND (SELECT value FROM app_settings WHERE key = 'branding_donor_logo')
            IS json_extract(snapshot_json, '$.document.settings.brandingDonorLogo')
        AND (SELECT value FROM app_settings WHERE key = 'email_sender_name')
            IS json_extract(snapshot_json, '$.document.settings.emailSenderName')
        AND (SELECT value FROM app_settings WHERE key = 'email_reply_to')
            IS json_extract(snapshot_json, '$.document.settings.emailReplyTo')`
  ).bind(
    input.range.startIso,
    input.range.endIso,
    input.livemode ? 1 : 0,
    input.donorKey,
    input.now,
    processingLeaseExpiresAt(input.now),
    input.now,
    input.id,
    input.claimId,
    input.now,
    input.snapshotHash,
    input.snapshotJson,
    input.donorKey
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function finalizeStripeAnnualStatementDelivery(
  db: D1Database,
  input: {
    id: string;
    claimId: string;
    outcome: "SENT" | "FAILED" | "REVIEW";
    providerIdHash?: string | null;
    failureCode?: string | null;
    retrySafe: boolean;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = ?, processing_claim_id = NULL, lease_expires_at = NULL,
            provider_id_hash = ?,
            failure_code = ?, retry_safe = ?, sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING' AND processing_claim_id = ?`
  ).bind(
    input.outcome,
    input.providerIdHash ?? null,
    input.failureCode ?? null,
    input.retrySafe ? 1 : 0,
    input.outcome === "SENT" ? input.now : null,
    input.now,
    input.id,
    input.claimId
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

function processingStaleBefore(now: string): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("Stripe annual statement claim timestamp is invalid");
  return new Date(timestamp - 5 * 60 * 1000).toISOString();
}

function processingLeaseExpiresAt(now: string): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("Stripe annual statement claim timestamp is invalid");
  return new Date(timestamp + 5 * 60 * 1000).toISOString();
}
