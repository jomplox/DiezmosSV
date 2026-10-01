import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { DatabaseSync } from "node:sqlite";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { base64UrlFromBytes, base64UrlFromString, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { SqliteD1 } from "./support/sqliteD1";

const NOW = "2026-09-30T12:00:00.000Z";
const RECENT = "2026-09-30T11:00:00.000Z";
const OLD = "2026-09-28T11:00:00.000Z";
const PATH = "https://example.org/api/monitoring/ray";
const EXPIRES = "2026-10-01T00:00:00.000Z";
const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../docs/ray-monitoring.openapi.json"), "utf8")).components.schemas.Snapshot;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validSnapshot = ajv.compile(schema);
const PII = "private-donor@example.org";
let signingKey: CryptoKey;
let publicKey: JsonWebKey & { kid: string; alg: string; use: string };
let teamNumber = 0;

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingKey = keys.privateKey;
  publicKey = { ...await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey, kid: "synthetic-key", alg: "RS256", use: "sig" };
});

function insert(db: DatabaseSync, table: string, row: Record<string, string | number | null>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

function seed(db: DatabaseSync): void {
  for (const [id, environment, result, amount, issuance] of [
    ["approved", "01", "ExitosaAprobada", 2500, "FAILED"],
    ["declined", "01", "Denegada", 99900, "IGNORED"],
    ["test-approved", "00", "ExitosaAprobada", 50000, "RETRY_QUEUED"]
  ] as const) insert(db, "wompi_events", { id, transaction_id: `tx-${id}`, environment, result, amount_cents: amount, issuance_status: issuance, raw_body: PII, donor_email: PII, received_at: RECENT, issuance_error_message: PII });
  for (const [id, environment, status] of [["accepted", "01", "ACCEPTED"], ["rejected", "01", "REJECTED"], ["test-doc", "00", "FAILED"]] as const) insert(db, "dte_documents", {
    id, environment, status, codigo_generacion: `code-${id}`, numero_control: `control-${id}`, plain_json: PII,
    amount_cents: 2500, issued_at: RECENT, created_at: RECENT, updated_at: RECENT,
    accepted_at: status === "ACCEPTED" ? RECENT : null
  });
  insert(db, "donation_intents", { id: "paid-intent", status: "LINK_CREATED", amount_cents: 99900, donor_document_type: "13", donor_email: PII, expires_at: EXPIRES, paid_at: RECENT, created_at: RECENT, updated_at: RECENT });
  // A later success supersedes the old failed attempt for the same receipt.
  for (const [id, document, attempt, status] of [["old-email", "accepted", 1, "FAILED"], ["new-email", "accepted", 2, "SENT"], ["bad-email", "rejected", 1, "FAILED"]] as const) insert(db, "email_deliveries", {
    id, document_id: document, to_email: PII, attempt_no: attempt, status, email_type: "ACCEPTED", created_at: RECENT,
    sent_at: status === "SENT" ? RECENT : null, failure_code: PII, provider_response_json: PII
  });
  for (const [id, mode] of [["live-checkout", 1], ["test-checkout", 0]] as const) insert(db, "stripe_checkout_sessions", {
    id, request_id: id, request_fingerprint: id, frequency: "MONTHLY", amount_cents: 3000, livemode: mode, status: "COMPLETE", payment_status: "PAID", gift_type: "TITHE", created_at: RECENT, updated_at: RECENT
  });
  for (const [id, checkout, amount, refund, settled] of [["monthly", "live-checkout", 3000, 1000, RECENT], ["test-gift", "test-checkout", 99900, 0, RECENT], ["legacy", null, 4000, 0, RECENT], ["old-gift", "live-checkout", 9000, 0, OLD]] as const) insert(db, "stripe_gifts", {
    id, checkout_id: checkout, source_type: "INVOICE", source_id: `invoice-${id}`, stripe_invoice_id: `invoice-${id}`, stripe_subscription_id: "synthetic-subscription", frequency: "MONTHLY", gift_type: "TITHE", amount_cents: amount,
    status: refund ? "PARTIALLY_REFUNDED" : "PAID", refunded_amount_cents: refund, settled_at: settled, donor_email: PII, created_at: settled, updated_at: settled
  });
  insert(db, "stripe_gifts", { id: "unlinked-invoice", checkout_id: null, source_type: "INVOICE", source_id: "invoice-unlinked", stripe_invoice_id: "invoice-unlinked", stripe_subscription_id: "synthetic-subscription", frequency: "MONTHLY", gift_type: "TITHE", amount_cents: 2000, status: "REFUNDED", refunded_amount_cents: 2000, settled_at: RECENT, created_at: RECENT, updated_at: RECENT });
  insert(db, "stripe_invoice_settlements", { invoice_id: "invoice-unlinked", gift_id: "unlinked-invoice", invoice_livemode: 1, status: "RECORDED", recorded_at: RECENT, created_at: RECENT, updated_at: RECENT });
  insert(db, "stripe_invoice_settlements", { invoice_id: "pending-invoice", invoice_livemode: 1, status: "PENDING", created_at: RECENT, updated_at: RECENT });
  insert(db, "stripe_webhook_events", { id: "failed-hook", event_type: "invoice.paid", livemode: 1, status: "FAILED", processing_claim_id: "claim", failure_code: PII, received_at: RECENT, updated_at: RECENT });
  for (const [id, revision, status] of [["old-ack", 1, "REVIEW"], ["new-ack", 2, "SENT"]] as const) insert(db, "stripe_acknowledgment_deliveries", {
    id, gift_id: "monthly", revision, kind: revision === 1 ? "ORIGINAL" : "PARTIAL_REFUND", evidence_refunded_amount_cents: revision === 1 ? 0 : 1000, status, failure_code: status === "REVIEW" ? PII : null, sent_at: status === "SENT" ? RECENT : null, dispatch_started_at: status === "SENT" ? RECENT : null, created_at: RECENT, updated_at: RECENT
  });
}

describe("Ray monitoring HTTP contract", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let testEnv: Env;
  let limiter: Mock<(options: { key: string }) => Promise<{ success: boolean }>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let issuer: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    database = migratedDatabase();
    d1 = new SqliteD1(database);
    issuer = `https://synthetic-ray-${++teamNumber}.cloudflareaccess.com`;
    limiter = vi.fn().mockResolvedValue({ success: true });
    testEnv = env(new InMemoryD1(), {
      DB: d1.database, APP_ENV: "production",
      RAY_MONITOR_ACCESS_TEAM_DOMAIN: new URL(issuer).hostname,
      RAY_MONITOR_ACCESS_AUD: "synthetic-monitor-audience", RAY_MONITOR_ACCESS_CLIENT_ID: "synthetic-ray.access",
      RAY_MONITOR_NOT_AFTER: EXPIRES, RAY_MONITOR_RATE_LIMITER: { limit: limiter }
    });
    fetchMock = vi.fn(async (url: string) => {
      if (url !== `${issuer}/cdn-cgi/access/certs`) throw new Error("Unexpected outbound request");
      return new Response(JSON.stringify({ keys: [publicKey] }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { database.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
    const now = Date.parse(NOW) / 1000;
    const body = {
      type: "app", aud: ["synthetic-monitor-audience"], iss: issuer, common_name: "synthetic-ray.access", sub: "", iat: now - 10, exp: now + 300, ...overrides
    };
    const message = `${base64UrlFromString(JSON.stringify({ alg: "RS256", kid: "synthetic-key", ...header }))}.${base64UrlFromString(JSON.stringify(body))}`;
    return `${message}.${base64UrlFromBytes(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, utf8Bytes(message))))}`;
  }
  async function get(query = "", jwt?: string): Promise<Response> {
    return worker.fetch(new Request(PATH + query, { headers: { "Cf-Access-Jwt-Assertion": jwt ?? await token() } }), testEnv);
  }

  it("is disabled by default and never invokes user authentication or D1", async () => {
    const response = await worker.fetch(new Request(PATH, { headers: { Cookie: "session=admin", Authorization: "Bearer admin" } }), env(new InMemoryD1(), { DB: d1.database, APP_ENV: "production" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "monitor_disabled" });
    expect(d1.statements).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])("rejects %s without auth, writes, or provider calls", async (method) => {
    const response = await worker.fetch(new Request(PATH, { method }), testEnv);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(d1.statements).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong audience", { aud: ["admin-audience"] }], ["wrong issuer", { iss: "https://evil.example" }],
    ["different machine", { common_name: "another.access" }], ["human identity", { sub: "human", email: PII }],
    ["expired", { exp: Date.parse(NOW) / 1000 }], ["future issuance", { iat: Date.parse(NOW) / 1000 + 60 }],
    ["future not-before", { nbf: Date.parse(NOW) / 1000 + 60 }], ["organization token", { type: "org" }],
    ["missing expiry", { exp: null }], ["extra audience", { aud: ["synthetic-monitor-audience", "admin-audience"] }]
  ])("rejects a signed JWT with %s before any D1 access", async (_name, claims) => {
    expect((await get("", await token(claims))).status).toBe(401);
    expect(d1.statements).toHaveLength(0);
    expect(limiter).not.toHaveBeenCalled();
  });

  it("rejects missing, malformed, forged, unknown-key, and algorithm-substitution tokens", async () => {
    const valid = await token();
    const [header, , signature] = valid.split(".");
    const forged = `${header}.${base64UrlFromString(JSON.stringify({ sub: "", type: "app", common_name: "synthetic-ray.access", aud: ["synthetic-monitor-audience"], iss: issuer, iat: Date.parse(NOW) / 1000, exp: Date.parse(NOW) / 1000 + 600 }))}.${signature}`;
    for (const jwt of ["", "not-a-jwt", forged, await token({}, { alg: "none" }), await token({}, { kid: "untrusted" })]) expect((await get("", jwt)).status).toBe(401);
    expect(d1.statements).toHaveLength(0);
    // A missing kid must not cause repeated JWKS fetches on a warm isolate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["expired configuration", "missing limiter", "invalid team", "local environment"])("fails closed for %s", async (fault) => {
    if (fault === "expired configuration") Object.assign(testEnv, { RAY_MONITOR_NOT_AFTER: NOW });
    if (fault === "missing limiter") Object.assign(testEnv, { RAY_MONITOR_RATE_LIMITER: undefined });
    if (fault === "invalid team") Object.assign(testEnv, { RAY_MONITOR_ACCESS_TEAM_DOMAIN: "evil.example/path" });
    if (fault === "local environment") Object.assign(testEnv, { APP_ENV: "local" });
    expect((await get()).status).toBe(503);
    expect(d1.statements).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate limits the authenticated machine and fails closed if the limiter fails", async () => {
    limiter.mockResolvedValueOnce({ success: false });
    const denied = await get();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
    limiter.mockRejectedValueOnce(new Error(PII));
    const failed = await get();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(PII);
    expect(d1.statements).toHaveLength(0);
    expect(limiter.mock.calls[0]).toEqual(limiter.mock.calls[1]);
  });

  it("reports real aggregates without equating gift confirmation, fiscal acceptance, or email dispatch", async () => {
    seed(database);
    const before = database.prepare("SELECT total_changes() AS n").get();
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ version: 1, environment: "production", health: { app: "ok", database: "ok", providers: "not_probed", severity: "attention" }, generatedAt: NOW });
    expect(body.summary.wompi).toMatchObject({ confirmed24h: { count: 1, grossCents: 2500, lastConfirmedAt: RECENT }, issuanceFailed: 1, unapproved24h: 1 });
    expect(body.summary.intents).toMatchObject({ paid: 1, completed: 0, scope: "database_unscoped" });
    expect(body.summary.fiscal).toMatchObject({ accepted24h: 1, failed: 1, finalizationPending: 1 });
    expect(body.summary.email).toMatchObject({ failed: 1, sent24h: 1 });
    expect(body.summary.stripe).toMatchObject({ gifts24h: { count: 2, grossCents: 5000, refundedCents: 3000, netCents: 2000, monthlyCount: 2 }, unattributedGiftCount: 1, pendingInvoices: 1, failedWebhooks: 1, failedAcknowledgments: 0 });
    expect(validSnapshot(body), JSON.stringify(validSnapshot.errors)).toBe(true);
    expect(validSnapshot({ ...body, donorEmail: PII })).toBe(false);
    expect(body.authorization.expiresAt).toBe("2026-09-30T12:05:00.000Z");
    expect(JSON.stringify(body)).not.toContain(PII);
    expect(body.changes.items.every((item: any) => /^[a-f0-9]{64}$/.test(item.key))).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(d1.statements.every(s => /^\s*(SELECT|WITH)\b/.test(s.sql))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // JWKS only; no recovery/provider probes.
  });

  it("returns an empty observation with null historical successes without claiming live availability", async () => {
    const body = await (await get()).json() as any;
    expect(validSnapshot(body), JSON.stringify(validSnapshot.errors)).toBe(true);
    expect(body.health).toEqual({ app: "ok", database: "ok", providers: "not_probed", intakeEnabled: true, severity: "ok" });
    expect(body.summary.wompi.confirmed24h).toEqual({ count: 0, grossCents: 0, lastConfirmedAt: null });
    expect(body.summary.stripe.gifts24h).toMatchObject({ count: 0, grossCents: 0, refundedCents: 0, netCents: 0, lastSettledAt: null });
    expect(body.changes.items).toEqual([]);
    Object.assign(testEnv, { DONATION_INTAKE_DISABLED: "true" });
    expect((await (await get()).json() as any).health).toMatchObject({ intakeEnabled: false, severity: "attention" });
  });

  it("scopes staging aggregates to test providers while explicitly marking unscoped intents", async () => {
    seed(database);
    Object.assign(testEnv, { APP_ENV: "staging" });
    const body = await (await get()).json() as any;
    expect(validSnapshot(body), JSON.stringify(validSnapshot.errors)).toBe(true);
    expect(body.environment).toBe("staging");
    expect(body.summary.wompi.confirmed24h).toMatchObject({ count: 1, grossCents: 50000 });
    expect(body.summary.wompi.issuancePending).toBe(1);
    expect(body.summary.fiscal).toMatchObject({ accepted24h: 0, failed: 1 });
    expect(body.summary.email).toMatchObject({ sent24h: 0, failed: 0 });
    expect(body.summary.stripe.gifts24h).toMatchObject({ count: 1, grossCents: 99900 });
    expect(body.summary.intents).toMatchObject({ paid: 1, scope: "database_unscoped" });
  });

  it("excludes conflicting Stripe mode evidence instead of adding it to live gift totals", async () => {
    seed(database);
    database.prepare("UPDATE stripe_gifts SET checkout_id='test-checkout' WHERE id='unlinked-invoice'").run();
    const body = await (await get()).json() as any;
    expect(body.summary.stripe).toMatchObject({ unattributedGiftCount: 2, gifts24h: { count: 1, grossCents: 3000, refundedCents: 1000, netCents: 2000 } });
  });

  it("enforces local expiry and identity revocation even with cached valid signing keys", async () => {
    Object.assign(testEnv, { RAY_MONITOR_NOT_AFTER: "2026-09-30T12:02:00.000Z" });
    const jwt = await token();
    const first = await get("", jwt);
    expect(first.status).toBe(200);
    expect((await first.json() as any).authorization.expiresAt).toBe("2026-09-30T12:02:00.000Z");
    const reads = d1.statements.length;
    Object.assign(testEnv, { RAY_MONITOR_ACCESS_CLIENT_ID: "replacement.access" });
    expect((await get("", jwt)).status).toBe(401);
    expect(d1.statements).toHaveLength(reads);
    Object.assign(testEnv, { RAY_MONITOR_ACCESS_CLIENT_ID: "synthetic-ray.access" });
    vi.setSystemTime(new Date("2026-09-30T12:02:00.000Z"));
    expect((await get("", jwt)).status).toBe(503);
    expect(d1.statements).toHaveLength(reads);
  });

  it("refreshes rotated signing keys after bounded cache expiry", async () => {
    expect((await get()).status).toBe(200);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ keys: [{ ...publicKey, kid: "rotated" }] })));
    const rotated = await token({}, { kid: "rotated" });
    expect((await get("", rotated)).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.parse(NOW) + 61_000));
    expect((await get("", rotated)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches failed certificates for five seconds after a slow failure completes", async () => {
    fetchMock.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.parse(NOW) + 4000));
      return new Response(null, { status: 500 });
    });
    expect((await get()).status).toBe(503);
    vi.setSystemTime(new Date(Date.parse(NOW) + 6000));
    expect((await get()).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d1.statements).toHaveLength(0);
    vi.setSystemTime(new Date(Date.parse(NOW) + 10_000));
    expect((await get()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["oversized", "redirect", "wrong key type"])("fails closed on %s certificate responses", async (fault) => {
    if (fault === "oversized") fetchMock.mockResolvedValueOnce(new Response(" ".repeat(65537)));
    if (fault === "redirect") fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.example" } }));
    if (fault === "wrong key type") fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ keys: [{ kid: "synthetic-key", kty: "oct", k: "secret" }] })));
    expect((await get()).status).toBe(503);
    expect(d1.statements).toHaveLength(0);
  });

  it("flags uncertain email dispatch without guessing inbox delivery or leaking provider evidence", async () => {
    insert(database, "dte_documents", { id: "uncertain-doc", environment: "01", status: "ACCEPTED", codigo_generacion: "synthetic-code", numero_control: "synthetic-control", plain_json: "{}", amount_cents: 100, issued_at: RECENT, created_at: RECENT, updated_at: RECENT, accepted_at: RECENT });
    insert(database, "email_deliveries", { id: "uncertain-email", document_id: "uncertain-doc", to_email: PII, status: "PENDING", outcome_class: "UNKNOWN", provider_response_json: PII, failure_code: PII, created_at: RECENT, finalized_at: RECENT });
    const body = await (await get()).json() as any;
    expect(body.summary.email).toMatchObject({ pending: 1, uncertain: 1, failed: 0, sent24h: 0 });
    expect(body.health.severity).toBe("attention");
    expect(body.changes.items).toContainEqual(expect.objectContaining({ source: "email", state: "REVIEW", actionableCode: "email_needs_review" }));
    expect(JSON.stringify(body)).not.toContain(PII);
  });

  it("reports current Stripe backlogs including the latest annual statement revision without counting superseded failures", async () => {
    seed(database);
    database.prepare("UPDATE stripe_checkout_sessions SET status='FAILED' WHERE id='live-checkout'").run();
    database.prepare("UPDATE stripe_checkout_sessions SET status='OPEN' WHERE id='test-checkout'").run();
    insert(database, "stripe_acknowledgment_deliveries", { id: "failed-ack", gift_id: "old-gift", revision: 1, kind: "ORIGINAL", evidence_refunded_amount_cents: 0, status: "FAILED", failure_code: PII, created_at: RECENT, updated_at: RECENT });
    for (const [id, revision, kind, refunded, status] of [["original-refund-ack", 1, "ORIGINAL", 0, "SENT"], ["pending-refund-ack", 2, "FULL_REFUND", 2000, "PENDING"]] as const) insert(database, "stripe_acknowledgment_deliveries", {
      id, gift_id: "unlinked-invoice", revision, kind, evidence_refunded_amount_cents: refunded, status,
      sent_at: status === "SENT" ? RECENT : null, dispatch_started_at: status === "SENT" ? RECENT : null, created_at: RECENT, updated_at: RECENT
    });
    for (const [id, donor, mode, revision, status] of [["superseded", "donor-a", 1, 1, "REVIEW"], ["latest-sent", "donor-a", 1, 2, "SENT"], ["latest-failed", "donor-b", 1, 1, "FAILED"], ["latest-pending", "donor-c", 1, 1, "PENDING"], ["test-review", "donor-d", 0, 1, "REVIEW"]] as const) insert(database, "stripe_annual_statement_deliveries", {
      id, year: 2025, livemode: mode, donor_key: donor, donor_name: PII, donor_email: PII, snapshot_hash: "a".repeat(64), snapshot_json: JSON.stringify({ donor: PII }), revision, status,
      failure_code: ["FAILED", "REVIEW"].includes(status) ? PII : null,
      sent_at: status === "SENT" ? RECENT : null, dispatch_started_at: status === "SENT" ? RECENT : null, provider_id_hash: status === "SENT" ? "provider-id" : null, created_at: RECENT, updated_at: RECENT
    });
    const body = await (await get("?limit=50")).json() as any;
    expect(validSnapshot(body), JSON.stringify(validSnapshot.errors)).toBe(true);
    expect(body.summary.stripe).toMatchObject({ failedCheckouts: 1, pendingCheckouts: 0, pendingAcknowledgments: 1, failedAcknowledgments: 1, pendingStatements: 1, failedStatements: 1 });
    expect(body.changes.items.filter((item: any) => item.source === "stripe_statement").map((item: any) => item.state).sort()).toEqual(["FAILED", "PENDING", "SENT"]);
    expect(body.changes.items).toContainEqual(expect.objectContaining({ source: "stripe_acknowledgment", state: "FAILED", actionableCode: "stripe_acknowledgment_needs_review" }));
    expect(JSON.stringify(body)).not.toContain(PII);
  });

  it("pages tied timestamps without losing rows and supplies an overlapping next-poll checkpoint", async () => {
    seed(database);
    const keys: string[] = [];
    let query = "?limit=2";
    let resumeSince = "";
    let pages = 0;
    do {
      expect(++pages).toBeLessThan(30);
      const response = await get(query);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.changes.items.length).toBeLessThanOrEqual(2);
      keys.push(...body.changes.items.map((item: any) => item.key));
      resumeSince = body.changes.resumeSince;
      query = body.changes.nextCursor ? `?limit=2&cursor=${body.changes.nextCursor}` : "";
    } while (query);
    expect(keys.length).toBeGreaterThan(10);
    expect(new Set(keys).size).toBe(keys.length);
    expect(resumeSince).toBe("2026-09-30T11:59:48.000Z");
    database.prepare("UPDATE wompi_events SET issuance_status='RETRY_QUEUED', issuance_last_attempt_at=? WHERE id='approved'").run("2026-09-30T11:59:49.000Z");
    const changes = (await (await get(`?since=${resumeSince}`)).json() as any).changes.items;
    expect(changes.some((item: any) => item.source === "wompi_issuance" && item.state === "RETRY_QUEUED")).toBe(true);
  });

  it("keeps a paginated window stable beyond ten seconds and rejects an expired or expanded cursor", async () => {
    seed(database);
    const first = await (await get("?limit=1")).json() as any;
    const cursor = first.changes.nextCursor;
    vi.setSystemTime(new Date(Date.parse(NOW) + 30_000));
    const next = await (await get(`?limit=1&cursor=${cursor}`)).json() as any;
    expect(next.changes.from).toBe(first.changes.from);
    expect(next.changes.until).toBe(first.changes.until);
    const expanded = base64UrlFromString(JSON.stringify({ version: 1, from: "1990-01-01T00:00:00.000Z", until: first.changes.until, after: [RECENT, "fiscal", "accepted"] }));
    expect((await get(`?cursor=${expanded}`)).status).toBe(400);
    expect((await get(`?cursor=${cursor}&since=${RECENT}`)).status).toBe(400);
    vi.setSystemTime(new Date(Date.parse(NOW) + 16 * 60_000));
    const jwt = await token({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
    expect((await get(`?cursor=${cursor}`, jwt)).status).toBe(400);
  });

  it.each(["?limit=0", "?limit=51", "?limit=2.5", "?limit=1&limit=2", "?extra=1", "?cursor=bad", "?since=1990-01-01T00:00:00.000Z", "?since=2027-01-01T00:00:00.000Z", "?since=not-a-date"])("rejects unbounded or malformed query %s", async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(d1.statements).toHaveLength(0);
  });

  it("returns unavailable, not an empty healthy snapshot, on DB or JWKS failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream secret", { status: 500 }));
    const authFailed = await get();
    expect(authFailed.status).toBe(503);
    expect(await authFailed.json()).toEqual({ error: "monitor_auth_unavailable" });
    // After the failed-key cache expires, storage failures must not leak exception contents.
    vi.setSystemTime(new Date(Date.parse(NOW) + 6000));
    database.close();
    database = migratedDatabase();
    Object.assign(testEnv, { DB: { prepare() { throw new Error(PII); } } });
    const dbFailed = await get();
    expect(dbFailed.status).toBe(503);
    expect(await dbFailed.json()).toEqual({ error: "monitor_database_unavailable" });
  });
});
