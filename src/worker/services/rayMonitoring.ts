import type { Env } from "../types";
import { base64ToBytes, base64UrlFromString, sha256Hex, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";
import { authorizeRayMonitor, RayMonitorAuthError } from "./rayMonitoringAuth";

export const RAY_MONITOR_PATH = "/api/monitoring/ray";
const DAY = 86400_000;
const SOURCES = ["wompi_issuance", "intent", "fiscal", "email", "stripe_checkout", "stripe_webhook", "stripe_gift", "stripe_invoice", "stripe_acknowledgment", "stripe_statement"];
const STATES = new Set(["RECEIVED", "PENDING", "LINK_CREATED", "COMPLETED", "EXPIRED", "PROCESSING", "FAILED", "DEAD_LETTERED", "RETRY_QUEUED", "DOCUMENT_CREATED", "IGNORED", "SIGNED", "TRANSMITTED", "TRANSMISSION_PENDING", "ACCEPTED", "REJECTED", "CONTINGENCY_PENDING", "INVALIDATED", "SENT", "CREATING", "OPEN", "COMPLETE", "PROCESSED", "PAID", "PARTIALLY_REFUNDED", "REFUNDED", "RECORDED", "REVIEW"]);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Vary": "Cf-Access-Jwt-Assertion", ...headers
  } });
}

interface ChangeRow { source: string; id: string; observedAt: string; state: string; }
interface Page { from: string; until: string; limit: number; after: [string, string, string] | null; }

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function pageFor(request: Request, now: number): Page {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) if (!["since", "cursor", "limit"].includes(key) || params.getAll(key).length !== 1) throw new Error("Invalid parameters");
  const rawLimit = params.get("limit") ?? "20";
  if (!/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > 50) throw new Error("Invalid limit");
  const limit = Number(rawLimit);
  const until = new Date(now - 2000).toISOString();
  const earliest = now - DAY;
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (params.has("since") || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor");
    const body: unknown = JSON.parse(new TextDecoder().decode(base64ToBytes(cursor.replace(/-/g, "+").replace(/_/g, "/"))));
    if (!isRecord(body) || body.version !== 1 || !timestamp(body.from) || !timestamp(body.until)
      || Date.parse(body.until) < now - 15 * 60_000 || Date.parse(body.from) < Date.parse(body.until) - DAY || body.until > until || body.from > body.until
      || !Array.isArray(body.after) || body.after.length !== 3 || !timestamp(body.after[0])
      || body.after[0] < body.from || body.after[0] > body.until || !SOURCES.includes(body.after[1])
      || typeof body.after[2] !== "string" || !body.after[2] || body.after[2].length > 256) throw new Error("Invalid cursor");
    return { from: body.from, until: body.until, after: body.after as [string, string, string], limit };
  }
  const from = params.get("since") ?? new Date(earliest).toISOString();
  if (!timestamp(from) || Date.parse(from) < earliest || from > until) throw new Error("Invalid since");
  return { from, until, after: null, limit };
}

// Only explicit aggregate/state columns cross this boundary. No payloads, donor
// fields, provider URLs, error strings, or user/session queries are returned.
const SCOPED = `WITH
  monitor_scope AS (SELECT ? AS ambiente, ? AS livemode, ? AS window_from, ? AS window_until),
  w AS (SELECT id,result,amount_cents,received_at,processed_at,issuance_status,issuance_last_attempt_at,issuance_failed_at,issuance_dead_lettered_at FROM wompi_events WHERE environment = (SELECT ambiente FROM monitor_scope)),
  d AS (SELECT id,status,accepted_at,post_accept_finalized_at,updated_at FROM dte_documents WHERE environment = (SELECT ambiente FROM monitor_scope)),
  e AS (SELECT e.id,e.status,e.outcome_class,e.sent_at,e.created_at,e.finalized_at,e.claim_attempted_at FROM email_deliveries e JOIN d ON d.id=e.document_id
    WHERE NOT EXISTS (SELECT 1 FROM email_deliveries newer WHERE newer.document_id=e.document_id
      AND newer.email_type IS e.email_type AND (newer.attempt_no>e.attempt_no
        OR (newer.attempt_no=e.attempt_no AND (newer.created_at, newer.id)>(e.created_at, e.id))))),
  attributed_gifts AS (SELECT g.id,g.frequency,g.amount_cents,g.refunded_amount_cents,g.status,g.settled_at,g.updated_at, CASE
    WHEN c.livemode IS NOT NULL AND i.invoice_livemode IS NOT NULL AND c.livemode<>i.invoice_livemode THEN NULL
    ELSE COALESCE(c.livemode, i.invoice_livemode) END AS mode
    FROM stripe_gifts g LEFT JOIN stripe_checkout_sessions c ON c.id=g.checkout_id
    LEFT JOIN stripe_invoice_settlements i ON i.gift_id=g.id),
  g AS (SELECT * FROM attributed_gifts WHERE mode = (SELECT livemode FROM monitor_scope)),
  c AS (SELECT id,status,updated_at FROM stripe_checkout_sessions WHERE livemode = (SELECT livemode FROM monitor_scope)),
  h AS (SELECT id,status,updated_at FROM stripe_webhook_events WHERE livemode = (SELECT livemode FROM monitor_scope)),
  i AS (SELECT invoice_id,status,updated_at FROM stripe_invoice_settlements
    WHERE COALESCE(invoice_livemode, payment_livemode) = (SELECT livemode FROM monitor_scope)
      AND (invoice_livemode IS NULL OR payment_livemode IS NULL OR invoice_livemode=payment_livemode)),
  a AS (SELECT a.id,a.status,a.updated_at FROM stripe_acknowledgment_deliveries a JOIN g ON g.id=a.gift_id
    WHERE NOT EXISTS (SELECT 1 FROM stripe_acknowledgment_deliveries newer WHERE newer.gift_id=a.gift_id AND newer.revision>a.revision)),
  s AS (SELECT s.id,s.status,s.updated_at FROM stripe_annual_statement_deliveries s WHERE s.livemode = (SELECT livemode FROM monitor_scope)
    AND NOT EXISTS (SELECT 1 FROM stripe_annual_statement_deliveries newer WHERE newer.year=s.year
      AND newer.donor_key=s.donor_key AND newer.livemode=s.livemode AND newer.revision>s.revision))`;

type Counts = Record<string, number | string | null>;
async function summary(db: D1Database, ambiente: string, mode: number, now: string): Promise<Record<string, unknown>> {
  const from = new Date(Date.parse(now) - DAY).toISOString();
  const read = async (sql: string): Promise<Counts> => {
    const row = await db.prepare(`${SCOPED} ${sql}`).bind(ambiente, mode, from, now).first<Counts>();
    if (!row) throw new Error("Missing aggregate");
    return row;
  };
  const [wompi, intents, fiscal, email, gifts, stripe] = await Promise.all([
    read(`SELECT
      COUNT(CASE WHEN result<>'ExitosaAprobada' AND received_at>=(SELECT window_from FROM monitor_scope) AND received_at<=(SELECT window_until FROM monitor_scope) THEN 1 END) AS unapproved24h,
      COUNT(CASE WHEN result='ExitosaAprobada' AND received_at>=(SELECT window_from FROM monitor_scope) AND received_at<=(SELECT window_until FROM monitor_scope) THEN 1 END) AS confirmedCount,
      COALESCE(SUM(CASE WHEN result='ExitosaAprobada' AND received_at>=(SELECT window_from FROM monitor_scope) AND received_at<=(SELECT window_until FROM monitor_scope) THEN amount_cents ELSE 0 END),0) AS grossCents,
      MAX(CASE WHEN result='ExitosaAprobada' THEN received_at END) AS lastConfirmedAt,
      COUNT(CASE WHEN result='ExitosaAprobada' AND (issuance_status IN ('PROCESSING','RETRY_QUEUED') OR (issuance_status IS NULL AND processed_at IS NULL)) THEN 1 END) AS issuancePending,
      COUNT(CASE WHEN result='ExitosaAprobada' AND issuance_status IN ('FAILED','DEAD_LETTERED') THEN 1 END) AS issuanceFailed,
      MIN(CASE WHEN result='ExitosaAprobada' AND (issuance_status IN ('PROCESSING','RETRY_QUEUED') OR (issuance_status IS NULL AND processed_at IS NULL)) THEN received_at END) AS oldestPendingAt
      FROM w`),
    read(`SELECT COUNT(CASE WHEN paid_at IS NOT NULL THEN 1 END) AS paid,
      COUNT(CASE WHEN status='COMPLETED' THEN 1 END) AS completed,
      COUNT(CASE WHEN paid_at IS NULL AND status IN ('PENDING','LINK_CREATED') AND expires_at>(SELECT window_until FROM monitor_scope) THEN 1 END) AS pending
      FROM donation_intents`),
    read(`SELECT COUNT(CASE WHEN accepted_at>=(SELECT window_from FROM monitor_scope) AND accepted_at<=(SELECT window_until FROM monitor_scope) THEN 1 END) AS accepted24h,
      COUNT(CASE WHEN status IN ('PENDING','SIGNED','TRANSMITTED','TRANSMISSION_PENDING','CONTINGENCY_PENDING') THEN 1 END) AS pending,
      COUNT(CASE WHEN status IN ('REJECTED','FAILED') THEN 1 END) AS failed,
      COUNT(CASE WHEN status='ACCEPTED' AND post_accept_finalized_at IS NULL THEN 1 END) AS finalizationPending,
      MAX(accepted_at) AS lastAcceptedAt FROM d`),
    read(`SELECT COUNT(CASE WHEN status='PENDING' THEN 1 END) AS pending,
      COUNT(CASE WHEN status='FAILED' THEN 1 END) AS failed,
      COUNT(CASE WHEN status<>'SENT' AND outcome_class='UNKNOWN' THEN 1 END) AS uncertain,
      COUNT(CASE WHEN status='SENT' AND sent_at>=(SELECT window_from FROM monitor_scope) AND sent_at<=(SELECT window_until FROM monitor_scope) THEN 1 END) AS sent24h,
      MAX(CASE WHEN status='SENT' THEN sent_at END) AS lastSentAt FROM e`),
    read(`SELECT COUNT(CASE WHEN settled_at>=(SELECT window_from FROM monitor_scope) AND settled_at<=(SELECT window_until FROM monitor_scope) THEN 1 END) AS count,
      COALESCE(SUM(CASE WHEN settled_at>=(SELECT window_from FROM monitor_scope) AND settled_at<=(SELECT window_until FROM monitor_scope) THEN amount_cents ELSE 0 END),0) AS grossCents,
      COALESCE(SUM(CASE WHEN settled_at>=(SELECT window_from FROM monitor_scope) AND settled_at<=(SELECT window_until FROM monitor_scope) THEN refunded_amount_cents ELSE 0 END),0) AS refundedCents,
      COUNT(CASE WHEN settled_at>=(SELECT window_from FROM monitor_scope) AND settled_at<=(SELECT window_until FROM monitor_scope) AND frequency='MONTHLY' THEN 1 END) AS monthlyCount,
      MAX(settled_at) AS lastSettledAt FROM g`),
    read(`SELECT
      (SELECT COUNT(*) FROM attributed_gifts WHERE mode IS NULL) AS unattributedGiftCount,
      (SELECT COUNT(*) FROM c WHERE status IN ('CREATING','OPEN')) AS pendingCheckouts,
      (SELECT COUNT(*) FROM c WHERE status='FAILED') AS failedCheckouts,
      (SELECT COUNT(*) FROM h WHERE status='PROCESSING') AS pendingWebhooks,
      (SELECT COUNT(*) FROM h WHERE status='FAILED') AS failedWebhooks,
      (SELECT COUNT(*) FROM i WHERE status='PENDING') AS pendingInvoices,
      (SELECT COUNT(*) FROM i WHERE status='REVIEW') AS reviewInvoices,
      (SELECT COUNT(*) FROM a WHERE status IN ('PENDING','PROCESSING')) AS pendingAcknowledgments,
      (SELECT COUNT(*) FROM a WHERE status IN ('FAILED','REVIEW')) AS failedAcknowledgments,
      (SELECT COUNT(*) FROM s WHERE status IN ('PENDING','PROCESSING')) AS pendingStatements,
      (SELECT COUNT(*) FROM s WHERE status IN ('FAILED','REVIEW')) AS failedStatements`)
  ]);
  return {
    wompi: { unapproved24h: wompi.unapproved24h, confirmed24h: { count: wompi.confirmedCount, grossCents: wompi.grossCents, lastConfirmedAt: wompi.lastConfirmedAt }, issuancePending: wompi.issuancePending, issuanceFailed: wompi.issuanceFailed, oldestPendingAt: wompi.oldestPendingAt },
    intents: { ...intents, scope: "database_unscoped" }, fiscal, email,
    stripe: { ...stripe, gifts24h: { ...gifts, netCents: Number(gifts.grossCents) - Number(gifts.refundedCents) } }
  };
}

const CHANGES = `, changes AS (
  SELECT 'wompi_issuance' AS source, id, MAX(received_at, COALESCE(processed_at,''), COALESCE(issuance_last_attempt_at,''), COALESCE(issuance_failed_at,''), COALESCE(issuance_dead_lettered_at,'')) AS changed_at, COALESCE(issuance_status,'RECEIVED') AS state FROM w
  UNION ALL SELECT 'intent', id, updated_at, status FROM donation_intents
  UNION ALL SELECT 'fiscal', id, updated_at, status FROM d
  UNION ALL SELECT 'email', id, MAX(created_at, COALESCE(sent_at,''), COALESCE(finalized_at,''), COALESCE(claim_attempted_at,'')), CASE WHEN status<>'SENT' AND outcome_class='UNKNOWN' THEN 'REVIEW' ELSE status END FROM e
  UNION ALL SELECT 'stripe_checkout', id, updated_at, status FROM c
  UNION ALL SELECT 'stripe_webhook', id, updated_at, status FROM h
  UNION ALL SELECT 'stripe_gift', id, updated_at, status FROM g
  UNION ALL SELECT 'stripe_invoice', invoice_id, updated_at, status FROM i
  UNION ALL SELECT 'stripe_acknowledgment', id, updated_at, status FROM a
  UNION ALL SELECT 'stripe_statement', id, updated_at, status FROM s
), normalized AS (SELECT source, id, strftime('%Y-%m-%dT%H:%M:%fZ', changed_at) AS observedAt, state FROM changes)`;

async function changes(db: D1Database, ambiente: string, mode: number, page: Page): Promise<Record<string, unknown>> {
  const [afterAt, afterSource, afterId] = page.after ?? ["", "", ""];
  const result = await db.prepare(`${SCOPED}${CHANGES}
    SELECT source, id, observedAt, state FROM normalized
    WHERE observedAt>=(SELECT window_from FROM monitor_scope) AND observedAt<=(SELECT window_until FROM monitor_scope) AND (observedAt,source,id)>(?,?,?)
    ORDER BY observedAt,source,id LIMIT ?`)
    .bind(ambiente, mode, page.from, page.until, afterAt, afterSource, afterId, page.limit + 1).all<ChangeRow>();
  const rows = result.results;
  if (!Array.isArray(rows)) throw new Error("Missing change rows");
  const selected = rows.slice(0, page.limit);
  const items = await Promise.all(selected.map(async row => {
    const state = STATES.has(row.state) ? row.state : "UNKNOWN";
    const actionableCode = ["FAILED", "REJECTED", "DEAD_LETTERED", "REVIEW", "UNKNOWN"].includes(state) ? `${row.source}_needs_review` : null;
    return { key: await sha256Hex(utf8Bytes(JSON.stringify([row.source, row.id, row.observedAt, state]))), source: row.source, state, observedAt: row.observedAt, actionableCode };
  }));
  const last = selected.at(-1);
  return {
    from: page.from, until: page.until, items,
    nextCursor: rows.length > page.limit && last ? base64UrlFromString(JSON.stringify({ version: 1, from: page.from, until: page.until, after: [last.observedAt, last.source, last.id] })) : null,
    resumeSince: new Date(Date.parse(page.until) - 10_000).toISOString()
  };
}

export async function handleRayMonitoring(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "monitor_method_not_allowed" }, 405, { Allow: "GET" });
  const now = Date.now();
  let expiresAt: string;
  try { expiresAt = await authorizeRayMonitor(request, env, now); } catch (error) {
    if (error instanceof RayMonitorAuthError) return json({ error: error.code }, error.status);
    return json({ error: "monitor_auth_unavailable" }, 503);
  }
  try {
    if (!(await env.RAY_MONITOR_RATE_LIMITER!.limit({ key: `ray-monitor:${env.RAY_MONITOR_ACCESS_CLIENT_ID}` })).success) return json({ error: "monitor_rate_limited" }, 429, { "Retry-After": "60" });
  } catch { return json({ error: "monitor_rate_limiter_unavailable" }, 503); }
  let page: Page;
  try { page = pageFor(request, now); } catch { return json({ error: "monitor_invalid_query" }, 400); }
  const ambiente = env.APP_ENV === "production" ? "01" : "00";
  const mode = env.APP_ENV === "production" ? 1 : 0;
  const generatedAt = new Date(now).toISOString();
  try {
    const snapshot = await summary(env.DB, ambiente, mode, generatedAt);
    const feed = await changes(env.DB, ambiente, mode, page);
    const w = snapshot.wompi as Counts;
    const f = snapshot.fiscal as Counts;
    const e = snapshot.email as Counts;
    const s = snapshot.stripe as Counts;
    const intakeEnabled = env.DONATION_INTAKE_DISABLED !== "true";
    const attention = !intakeEnabled || Number(w.issuanceFailed) > 0 || Number(f.failed) > 0 || Number(e.failed) > 0 || Number(e.uncertain) > 0
      || ["failedCheckouts", "failedWebhooks", "reviewInvoices", "failedAcknowledgments", "failedStatements", "unattributedGiftCount"].some(key => Number(s[key]) > 0);
    return json({
      version: 1, generatedAt, environment: env.APP_ENV,
      authorization: { expiresAt },
      health: { app: "ok", database: "ok", providers: "not_probed", intakeEnabled, severity: attention ? "attention" : "ok" },
      freshness: { databaseReadAt: new Date().toISOString(), monetaryWindowFrom: new Date(now - DAY).toISOString(), monetaryWindowUntil: generatedAt },
      summary: snapshot, changes: feed
    });
  } catch { return json({ error: "monitor_database_unavailable" }, 503); }
}
