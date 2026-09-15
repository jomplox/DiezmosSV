import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { EmailService } from "../../src/worker/services/email";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

const origin = "https://example.org";
const requestId = "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5";

describe("Stripe public donation routes", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let workerEnv: Env;

  beforeEach(() => {
    database = migratedDatabase();
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('branding_display_name', 'Organización de Prueba')"
    ).run();
    workerEnv = {
      ...env(new InMemoryD1()),
      DB: sqliteD1(database),
      APP_ENV: "local",
      APP_ORIGIN: origin,
      STRIPE_MOCK_MODE: "1"
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    database.close();
  });

  it("creates one idempotent Embedded Checkout Session without touching the Wompi lane", async () => {
    const first = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({
      sessionId: expect.stringMatching(/^cs_test_stripe_checkout_/),
      clientSecret: expect.stringMatching(/^cs_test_stripe_checkout_.+_secret_mock$/),
      publishableKey: "pk_test_mock",
      mock: true
    });
    expect(first.body).not.toHaveProperty("url");

    const replay = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM stripe_checkout_sessions"
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE provider = 'STRIPE'"
    ).get()).toEqual({ count: 1 });
    const reservationEvidence = database.prepare(
      `SELECT rate_limit_claim_id, provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId) as {
      rate_limit_claim_id: string | null;
      provider_creation_claim_id: string | null;
    };
    expect(reservationEvidence.rate_limit_claim_id).toBeNull();
    expect(reservationEvidence.provider_creation_claim_id).toMatch(/^provider_create_/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM donation_intents").get())
      .toEqual({ count: 0 });

    const conflict = await createCheckout(workerEnv, {
      requestId,
      amount: 75,
      frequency: "once"
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: "stripe_checkout_request_conflict" });

    const giftTypeConflict = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once",
      giftType: "offering"
    });
    expect(giftTypeConflict.response.status).toBe(409);
  });

  it("releases a Stripe provider claim when reservation persistence fails", async () => {
    workerEnv = { ...workerEnv, DB: withFailingStripeReservation(database) };

    const result = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(result.response.status).toBe(500);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM stripe_checkout_sessions"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE provider = 'STRIPE'"
    ).get()).toEqual({ count: 0 });
  });

  it("reclaims a failed Session reservation with the same request identity", async () => {
    const first = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(first.response.status).toBe(201);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'FAILED', stripe_session_id = NULL,
              expires_at = NULL, error_code = 'simulated_transient_failure'
        WHERE request_id = ?`
    ).run(requestId);

    const retry = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(retry.response.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(database.prepare(
      `SELECT status, creation_attempt_count, error_code
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      creation_attempt_count: 2,
      error_code: null
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE provider = 'STRIPE'"
    ).get()).toEqual({ count: 1 });
  });

  it("resumes a stale Session creation with the same idempotency identity", async () => {
    const first = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(first.response.status).toBe(201);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'CREATING', stripe_session_id = NULL,
              expires_at = NULL, updated_at = '2000-01-01T00:00:00.000Z'
        WHERE request_id = ?`
    ).run(requestId);

    const retry = await createCheckout(workerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(retry.response.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(database.prepare(
      `SELECT status, creation_attempt_count, error_code
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      creation_attempt_count: 2,
      error_code: null
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE provider = 'STRIPE'"
    ).get()).toEqual({ count: 1 });
  });

  it("keeps ambiguous Checkout retries on one Stripe idempotency key", async () => {
    const creationKeys: string[] = [];
    const creationBodies: string[] = [];
    let listCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/checkout/sessions") {
        listCalls += 1;
        return stripeJson({ object: "list", data: [], has_more: false, url: "/v1/checkout/sessions" });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/checkout/sessions") {
        throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
      }
      creationKeys.push(request.headers.get("idempotency-key") ?? "");
      const body = await request.text();
      creationBodies.push(body);
      const params = new URLSearchParams(body);
      if (creationKeys.length <= 2) {
        return stripeJson({ error: { type: "api_error", message: "ambiguous fixture" } }, 500, {
          "stripe-should-retry": "false"
        });
      }
      const checkoutId = params.get("client_reference_id")!;
      const sessionId = `cs_test_${checkoutId}`;
      return stripeJson({
        id: sessionId,
        object: "checkout.session",
        client_reference_id: checkoutId,
        client_secret: `${sessionId}_secret_fixture`,
        url: null,
        created: 1_700_000_000,
        livemode: false,
        status: "open",
        payment_status: "unpaid",
        mode: params.get("mode"),
        amount_total: Number(params.get("line_items[0][price_data][unit_amount]")),
        currency: "usd",
        customer: null,
        subscription: null,
        payment_intent: null,
        customer_details: null,
        customer_email: null,
        metadata: {
          checkout_id: params.get("metadata[checkout_id]"),
          frequency: params.get("metadata[frequency]"),
          lane: params.get("metadata[lane]"),
          gift_type: params.get("metadata[gift_type]")
        },
        expires_at: 1_786_370_400
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const proxyEnv: Env = {
      ...workerEnv,
      STRIPE_MOCK_MODE: undefined,
      STRIPE_RESTRICTED_KEY: "rk_test_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_PHONE: "+1 (555) 010-0200",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Example Street\nExample City, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Example Treasurer",
      STRIPE_US_SIGNER_TITLE: "Treasurer",
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    };

    const first = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(first.response.status).toBe(502);
    const retainedClaim = database.prepare(
      `SELECT claims.id
         FROM provider_creation_claims AS claims
         JOIN stripe_checkout_sessions AS checkout
           ON checkout.provider_creation_claim_id = claims.id
        WHERE checkout.request_id = ?`
    ).get(requestId) as { id: string } | undefined;
    expect(retainedClaim?.id).toMatch(/^provider_create_/);
    const second = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(second.response.status).toBe(502);
    const third = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(third.response.status).toBe(201);
    expect(listCalls).toBe(0);
    expect(creationKeys).toHaveLength(3);
    expect(new Set(creationKeys)).toEqual(new Set([`stripe-checkout:${requestId}`]));
    expect(new Set(creationBodies)).toEqual(new Set([creationBodies[0]]));
    expect(database.prepare(
      `SELECT status, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      creation_outcome_class: null,
      idempotency_generation: 1
    });
  });

  it("fails closed under the original key when provider request or account config drifts after a network failure", async () => {
    const providerRequests: Array<{
      authorization: string;
      body: string;
      idempotencyKey: string;
      url: string;
    }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      providerRequests.push({
        authorization: request.headers.get("authorization") ?? "",
        body: await request.text(),
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        url: request.url
      });
      throw new TypeError("simulated transport disconnect");
    });
    vi.stubGlobal("fetch", fetchMock);
    const originalEnv = stripeProxyEnv(workerEnv);

    const first = await createCheckout(originalEnv, { requestId, amount: 50, frequency: "once" });
    expect(first.response.status).toBe(502);
    expect(providerRequests).toHaveLength(3);
    expect(new Set(providerRequests.map((request) => request.idempotencyKey)))
      .toEqual(new Set([`stripe-checkout:${requestId}`]));
    expect(new Set(providerRequests.map((request) => request.body)))
      .toEqual(new Set([providerRequests[0].body]));
    expect(new Set(providerRequests.map((request) => request.authorization)))
      .toEqual(new Set(["Bearer rk_test_fixture"]));
    expect(new Set(providerRequests.map((request) => request.url)))
      .toEqual(new Set(["http://127.0.0.1:8791/v1/checkout/sessions"]));
    const originalProviderCallCount = providerRequests.length;

    const driftCases: Array<{
      name: string;
      env?: Env;
      setUp?: () => void;
      tearDown?: () => void;
    }> = [
      {
        name: "branding",
        setUp: () => {
          database.prepare(
            "UPDATE app_settings SET value = 'Otra Organización' WHERE key = 'branding_display_name'"
          ).run();
        },
        tearDown: () => {
          database.prepare(
            "UPDATE app_settings SET value = 'Organización de Prueba' WHERE key = 'branding_display_name'"
          ).run();
        }
      },
      { name: "origin", env: { ...originalEnv, APP_ORIGIN: "https://changed.example" } },
      {
        name: "payment method configuration",
        env: { ...originalEnv, STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_changed_fixture" }
      },
      { name: "proxy", env: { ...originalEnv, STRIPE_API_PROXY_URL: "http://127.0.0.1:8792" } },
      { name: "restricted key", env: { ...originalEnv, STRIPE_RESTRICTED_KEY: "rk_test_changed_fixture" } },
      { name: "publishable key", env: { ...originalEnv, STRIPE_PUBLISHABLE_KEY: "pk_test_changed_fixture" } }
    ];

    for (const drift of driftCases) {
      drift.setUp?.();
      const retry = await createCheckout(drift.env ?? originalEnv, {
        requestId,
        amount: 50,
        frequency: "once"
      });
      drift.tearDown?.();
      expect(retry.response.status, drift.name).toBe(409);
      expect(retry.body, drift.name).toMatchObject({ error: "stripe_checkout_indeterminate" });
      expect(providerRequests, drift.name).toHaveLength(originalProviderCallCount);
    }

    expect(database.prepare(
      `SELECT status, creation_attempt_count, creation_outcome_class, idempotency_generation,
              request_fingerprint
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "FAILED",
      creation_attempt_count: 1,
      creation_outcome_class: "AMBIGUOUS",
      idempotency_generation: 1,
      request_fingerprint: expect.stringMatching(/^v2:[0-9a-f]{64}$/)
    });
  });

  it("keeps an exhausted ambiguous Checkout indeterminate on the same identity", async () => {
    const creationKeys: string[] = [];
    const creationBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      creationKeys.push(request.headers.get("idempotency-key") ?? "");
      creationBodies.push(await request.text());
      return stripeJson({ error: { type: "api_error", message: "ambiguous fixture" } }, 500, {
        "stripe-should-retry": "false"
      });
    }));
    const proxyEnv = stripeProxyEnv(workerEnv);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
      expect(failed.response.status).toBe(502);
    }
    const fourth = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    const fifth = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });

    expect(fourth.response.status).toBe(409);
    expect(fourth.body).toMatchObject({ error: "stripe_checkout_indeterminate" });
    expect(fifth.response.status).toBe(409);
    expect(fifth.body).toMatchObject({ error: "stripe_checkout_indeterminate" });
    expect(creationKeys).toHaveLength(3);
    expect(new Set(creationKeys)).toEqual(new Set([`stripe-checkout:${requestId}`]));
    expect(new Set(creationBodies)).toEqual(new Set([creationBodies[0]]));
    expect(database.prepare(
      `SELECT status, creation_attempt_count, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "FAILED",
      creation_attempt_count: 3,
      creation_outcome_class: "AMBIGUOUS",
      idempotency_generation: 1
    });
  });

  it("rereads durable state after losing a concurrent Checkout reclaim", async () => {
    let providerCalls = 0;
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerBarrier = new Promise<void>((resolve) => { releaseProvider = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      providerCalls += 1;
      await request.text();
      if (providerCalls > 1) {
        markProviderStarted();
        await providerBarrier;
      }
      return stripeJson({ error: { type: "api_error", message: "ambiguous fixture" } }, 500, {
        "stripe-should-retry": "false"
      });
    }));
    const proxyEnv = stripeProxyEnv(workerEnv);
    expect((await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" })).response.status)
      .toBe(502);

    const concurrent = withSynchronizedStripeReservationReads(database);
    const concurrentEnv = { ...proxyEnv, DB: concurrent.db };
    concurrent.synchronizeNextPair();
    const firstRetry = createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" });
    const secondRetry = createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" });
    await providerStarted;
    const loser = await Promise.race([firstRetry, secondRetry]);

    expect(loser.response.status).toBe(409);
    expect(loser.body).toMatchObject({ error: "stripe_checkout_in_progress" });
    expect(providerCalls).toBe(2);

    releaseProvider();
    const settled = await Promise.all([firstRetry, secondRetry]);
    expect(settled.map((result) => result.response.status).sort()).toEqual([409, 502]);
    expect(providerCalls).toBe(2);
  });

  it("advances the Checkout idempotency generation after a definite pre-execution rejection", async () => {
    const creationKeys: string[] = [];
    const creationBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== "/v1/checkout/sessions") {
        throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
      }
      creationKeys.push(request.headers.get("idempotency-key") ?? "");
      const body = await request.text();
      creationBodies.push(body);
      if (creationKeys.length === 1) {
        return stripeJson({
          error: {
            type: "invalid_request_error",
            code: "parameter_invalid_integer",
            message: "definite fixture",
            param: "line_items[0][price_data][unit_amount]"
          }
        }, 400, { "stripe-should-retry": "false" });
      }
      return stripeCheckoutJson(new URLSearchParams(body));
    });
    vi.stubGlobal("fetch", fetchMock);
    const proxyEnv = stripeProxyEnv(workerEnv);

    expect((await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" })).response.status)
      .toBe(502);
    expect((await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" })).response.status)
      .toBe(201);
    expect(creationKeys).toEqual([
      `stripe-checkout:${requestId}`,
      `stripe-checkout:${requestId}:generation:2`
    ]);
    expect(creationBodies[1]).toBe(creationBodies[0]);
    expect(database.prepare(
      `SELECT status, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      creation_outcome_class: null,
      idempotency_generation: 2
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE stripe_request_id = ?"
    ).get(requestId)).toEqual({ count: 1 });
  });

  it("reuses an active attached claim for a definite retry without charging twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    seedDefiniteFailureCheckout(database, {
      claimId: "active_retry_claim",
      claimedAt: "2026-07-04T11:55:00.000Z",
      expiresAt: "2026-07-04T12:10:00.000Z"
    });
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(201);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      `SELECT id, claimed_at, expires_at FROM provider_creation_claims
        WHERE stripe_request_id = ?`
    ).get(requestId)).toEqual({
      id: "active_retry_claim",
      claimed_at: "2026-07-04T11:55:00.000Z",
      expires_at: "2026-07-04T12:10:00.000Z"
    });
    expect(database.prepare(
      `SELECT status, idempotency_generation, provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      idempotency_generation: 2,
      provider_creation_claim_id: "active_retry_claim"
    });
  });

  it("admits a definite retry with a new claim after the expired claim was swept", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: "swept_retry_claim" });
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(201);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const claim = database.prepare(
      `SELECT id, claimed_at, expires_at FROM provider_creation_claims
        WHERE stripe_request_id = ?`
    ).get(requestId) as { id: string; claimed_at: string; expires_at: string } | undefined;
    expect(claim).toEqual({
      id: expect.stringMatching(/^provider_create_/),
      claimed_at: "2026-07-04T12:16:00.000Z",
      expires_at: "2026-07-04T12:31:00.000Z"
    });
    expect(claim?.id).not.toBe("swept_retry_claim");
    expect(database.prepare(
      "SELECT provider_creation_claim_id FROM stripe_checkout_sessions WHERE request_id = ?"
    ).get(requestId)).toEqual({ provider_creation_claim_id: claim?.id });
  });

  it("atomically refreshes an unswept expired claim before a definite retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, {
      claimId: "expired_retry_claim",
      claimedAt: "2026-07-04T12:00:00.000Z",
      expiresAt: "2026-07-04T12:15:00.000Z"
    });
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(201);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      `SELECT id, claimed_at, expires_at FROM provider_creation_claims
        WHERE stripe_request_id = ?`
    ).get(requestId)).toEqual({
      id: "expired_retry_claim",
      claimed_at: "2026-07-04T12:16:00.000Z",
      expires_at: "2026-07-04T12:31:00.000Z"
    });
    expect(database.prepare(
      `SELECT status, idempotency_generation, provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      idempotency_generation: 2,
      provider_creation_claim_id: "expired_retry_claim"
    });
  });

  it.each([
    ["provider", 600],
    ["global", 1000]
  ] as const)("blocks a definite retry at the exhausted %s ceiling before Stripe", async (dimension, count) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: `${dimension}_old_retry_claim` });
    seedProviderCreationCapacity(database, dimension, count, "2026-07-04T12:16:00.000Z");
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    }, "198.51.100.250");

    expect(retry.response.status).toBe(503);
    expect(retry.body).toEqual({
      error: "donation_service_busy",
      message: "No pudimos preparar su entrega en este momento. Intente de nuevo en unos minutos."
    });
    expect(retry.response.headers.get("Cache-Control")).toBe("no-store");
    expect(providerFetch).not.toHaveBeenCalled();
    expect(database.prepare(
      `SELECT status, idempotency_generation, provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "FAILED",
      idempotency_generation: 1,
      provider_creation_claim_id: `${dimension}_old_retry_claim`
    });
  });

  it("admits and attaches only one claim across concurrent definite retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: "concurrent_old_retry_claim" });
    const providerFetch = stubSuccessfulStripeCreation();
    const synchronized = withSynchronizedStripeReservationReads(database);
    synchronized.synchronizeNextPair();
    const concurrentEnv = { ...stripeProxyEnv(workerEnv), DB: synchronized.db };

    const results = await Promise.all([
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" }),
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" })
    ]);

    expect(results.map((result) => result.response.status).sort()).toEqual([201, 409]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const claims = database.prepare(
      "SELECT id FROM provider_creation_claims WHERE stripe_request_id = ?"
    ).all(requestId) as Array<{ id: string }>;
    expect(claims).toHaveLength(1);
    expect(database.prepare(
      `SELECT status, idempotency_generation, provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      idempotency_generation: 2,
      provider_creation_claim_id: claims[0]?.id
    });
  });

  it("releases an unattached fresh claim when the definite retry CAS loses", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: "lost_cas_old_retry_claim" });
    const providerFetch = stubSuccessfulStripeCreation();
    const losing = withLosingDefiniteRetryCas(database);

    const retry = await createCheckout({
      ...stripeProxyEnv(workerEnv),
      DB: losing.db
    }, {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_unavailable" });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(losing.releaseAttempts()).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE stripe_request_id = ?"
    ).get(requestId)).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT status, creation_outcome_class, idempotency_generation,
              provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "FAILED",
      creation_outcome_class: "DEFINITE_FAILURE",
      idempotency_generation: 1,
      provider_creation_claim_id: "lost_cas_old_retry_claim"
    });
  });

  it("retries lost-CAS claim cleanup once after the first release throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: "lost_cas_retry_cleanup_old_claim" });
    const providerFetch = stubSuccessfulStripeCreation();
    const losing = withLosingDefiniteRetryCas(database, 1);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const retry = await createCheckout({
      ...stripeProxyEnv(workerEnv),
      DB: losing.db
    }, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    const cleanupEvents = errorLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => (entry as { event?: string }).event?.startsWith("stripe_checkout_claim_cleanup_"));
    errorLog.mockRestore();

    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_unavailable" });
    expect(losing.releaseAttempts()).toBe(2);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE stripe_request_id = ?"
    ).get(requestId)).toEqual({ count: 0 });
    expect(cleanupEvents).toEqual([{
      event: "stripe_checkout_claim_cleanup_retry",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    }]);
  });

  it("bounds lost-CAS claim cleanup at two attempts and relies on expiry when both throw", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, { claimId: "lost_cas_deferred_cleanup_old_claim" });
    const providerFetch = stubSuccessfulStripeCreation();
    const losing = withLosingDefiniteRetryCas(database, 2);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const retry = await createCheckout({
      ...stripeProxyEnv(workerEnv),
      DB: losing.db
    }, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    const cleanupEvents = errorLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => (entry as { event?: string }).event?.startsWith("stripe_checkout_claim_cleanup_"));
    errorLog.mockRestore();

    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_unavailable" });
    expect(losing.releaseAttempts()).toBe(2);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE stripe_request_id = ?"
    ).get(requestId)).toEqual({ count: 1 });
    expect(cleanupEvents).toEqual([
      {
        event: "stripe_checkout_claim_cleanup_retry",
        app_env: "local",
        error_name: "error",
        error_code: "unknown"
      },
      {
        event: "stripe_checkout_claim_cleanup_deferred",
        app_env: "local",
        error_name: "error",
        error_code: "unknown"
      }
    ]);
  });

  it("retains an attached refreshed claim when the definite retry provider call fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedDefiniteFailureCheckout(database, {
      claimId: "failed_refreshed_retry_claim",
      claimedAt: "2026-07-04T12:00:00.000Z",
      expiresAt: "2026-07-04T12:15:00.000Z"
    });
    const providerFetch = vi.fn<typeof fetch>(async () => stripeJson({
      error: {
        type: "invalid_request_error",
        code: "parameter_invalid_integer",
        message: "definite retry fixture",
        param: "line_items[0][price_data][unit_amount]"
      }
    }, 400, { "stripe-should-retry": "false" }));
    vi.stubGlobal("fetch", providerFetch);

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(502);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      `SELECT id, claimed_at, expires_at FROM provider_creation_claims
        WHERE stripe_request_id = ?`
    ).get(requestId)).toEqual({
      id: "failed_refreshed_retry_claim",
      claimed_at: "2026-07-04T12:16:00.000Z",
      expires_at: "2026-07-04T12:31:00.000Z"
    });
    expect(database.prepare(
      `SELECT status, creation_outcome_class, idempotency_generation,
              provider_creation_claim_id
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "FAILED",
      creation_outcome_class: "DEFINITE_FAILURE",
      idempotency_generation: 2,
      provider_creation_claim_id: "failed_refreshed_retry_claim"
    });
  });

  it("keeps an active unattached Stripe claim in progress before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    seedStripeProviderClaim(database, {
      id: "active_unattached_claim",
      claimedAt: "2026-07-04T11:55:00.000Z",
      expiresAt: "2026-07-04T12:10:00.000Z"
    });
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_in_progress" });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_sessions").get())
      .toEqual({ count: 0 });
  });

  it("refreshes an expired unattached Stripe claim instead of waiting for cron", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:16:00.000Z") });
    seedStripeProviderClaim(database, {
      id: "expired_unattached_claim",
      claimedAt: "2026-07-04T12:00:00.000Z",
      expiresAt: "2026-07-04T12:15:00.000Z"
    });
    const providerFetch = stubSuccessfulStripeCreation();

    const retry = await createCheckout(stripeProxyEnv(workerEnv), {
      requestId,
      amount: 50,
      frequency: "once"
    });

    expect(retry.response.status).toBe(201);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      `SELECT id, claimed_at, expires_at FROM provider_creation_claims
        WHERE stripe_request_id = ?`
    ).get(requestId)).toEqual({
      id: "expired_unattached_claim",
      claimed_at: "2026-07-04T12:16:00.000Z",
      expires_at: "2026-07-04T12:31:00.000Z"
    });
    expect(database.prepare(
      "SELECT provider_creation_claim_id FROM stripe_checkout_sessions WHERE request_id = ?"
    ).get(requestId)).toEqual({ provider_creation_claim_id: "expired_unattached_claim" });
  });

  it("recovers a returned Session after deferred D1 attachment", async () => {
    let providerSession: Record<string, unknown> | null = null;
    let createCalls = 0;
    let retrieveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        createCalls += 1;
        providerSession = stripeCheckoutObject(new URLSearchParams(await request.text()));
        return stripeJson(providerSession);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
        retrieveCalls += 1;
        if (!providerSession) throw new Error("Provider Session fixture is missing");
        return stripeJson(providerSession);
      }
      throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const deferred = withDeferredStripeAttachment(database);
    const proxyEnv = stripeProxyEnv({ ...workerEnv, DB: deferred.db });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const created = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      sessionId: expect.stringMatching(/^cs_test_stripe_checkout_/),
      clientSecret: expect.stringMatching(/^cs_test_stripe_checkout_.+_secret_fixture$/)
    });
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "stripe_checkout_finalize_deferred"
    }));
    expect(database.prepare(
      `SELECT status, stripe_session_id, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "CREATING",
      stripe_session_id: null,
      creation_outcome_class: null,
      idempotency_generation: 1
    });

    deferred.allowAttachments();
    const recovered = await worker.fetch(new Request(
      `${origin}/api/donations/stripe/session/${String(created.body.sessionId)}`
    ), { ...proxyEnv, DONATION_INTAKE_DISABLED: "true" });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({
      status: "OPEN",
      frequency: "ONCE",
      giftType: "TITHE",
      amountCents: 5000,
      currency: "usd",
      canManageRecurring: false,
      recurringStatus: null
    });
    expect(createCalls).toBe(1);
    expect(retrieveCalls).toBe(1);
    expect(database.prepare(
      `SELECT status, stripe_session_id, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      stripe_session_id: created.body.sessionId,
      creation_outcome_class: null,
      idempotency_generation: 1
    });
  });

  it("bounds OPEN replay provider reads and fences concurrent recovery for one request identity", async () => {
    let providerSession: Record<string, unknown> | null = null;
    let retrieveCalls = 0;
    let releaseRetrieve!: () => void;
    let markRetrieveStarted!: () => void;
    let holdRetrieve = false;
    const retrieveStarted = new Promise<void>((resolve) => { markRetrieveStarted = resolve; });
    const retrieveBarrier = new Promise<void>((resolve) => { releaseRetrieve = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        providerSession = stripeCheckoutObject(new URLSearchParams(await request.text()));
        return stripeJson(providerSession);
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/checkout/sessions/")) {
        retrieveCalls += 1;
        if (holdRetrieve) {
          markRetrieveStarted();
          await retrieveBarrier;
        }
        return stripeJson(providerSession);
      }
      throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
    }));
    const proxyEnv = stripeProxyEnv(workerEnv);
    expect((await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" })).response.status)
      .toBe(201);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" })).response.status)
        .toBe(200);
    }
    const limited = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(limited.response.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "stripe_recovery_rate_limited" });
    expect(retrieveCalls).toBe(5);

    database.prepare("DELETE FROM stripe_provider_recovery_reads").run();
    holdRetrieve = true;
    const first = createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    await retrieveStarted;
    const second = createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    const secondResult = await Promise.race([
      second,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("concurrent recovery claim did not fail fast")),
        500
      ))
    ]);
    releaseRetrieve();
    expect(secondResult.response.status).toBe(409);
    const firstResult = await first;
    expect(firstResult.response.status).toBe(200);
    expect(retrieveCalls).toBe(6);
  });

  it("bounds arbitrary valid Session recovery reads by caller IP", async () => {
    let retrieveCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      retrieveCalls += 1;
      return stripeJson({ error: { type: "invalid_request_error", message: "missing fixture" } }, 404);
    }));
    const proxyEnv = stripeProxyEnv(workerEnv);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await worker.fetch(new Request(
        `${origin}/api/donations/stripe/session/cs_test_unknown_${String(attempt).padStart(8, "0")}`,
        { headers: { "CF-Connecting-IP": "203.0.113.199" } }
      ), proxyEnv);
      expect(response.status).toBe(404);
    }
    const limited = await worker.fetch(new Request(
      `${origin}/api/donations/stripe/session/cs_test_unknown_99999999`,
      { headers: { "CF-Connecting-IP": "203.0.113.199" } }
    ), proxyEnv);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: "stripe_recovery_rate_limited" });
    expect(retrieveCalls).toBe(20);
  });

  it("returns only donor-safe Session status and gates recurring management", async () => {
    const created = await createCheckout(workerEnv, {
      requestId,
      amount: 25,
      frequency: "monthly"
    });
    const sessionId = String(created.body.sessionId);
    const portalCookie = cookieHeaderFrom(created.response);
    const setCookie = created.response.headers.get("set-cookie") ?? "";
    expect(portalCookie).toMatch(/^diezmossv_stripe_portal_/);
    expect(setCookie).toContain("Path=/api/donations/stripe/portal");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const storedCapability = database.prepare(
      `SELECT portal_capability_hash, portal_capability_expires_at,
              portal_capability_revoked_at
         FROM stripe_checkout_sessions
        WHERE stripe_session_id = ?`
    ).get(sessionId) as Record<string, unknown>;
    expect(storedCapability).toEqual({
      portal_capability_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      portal_capability_expires_at: expect.any(String),
      portal_capability_revoked_at: null
    });
    const rawCapability = portalCookie.split("=", 2)[1];
    expect(rawCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedCapability.portal_capability_hash).not.toBe(rawCapability);

    const open = await worker.fetch(
      new Request(`${origin}/api/donations/stripe/session/${sessionId}`),
      { ...workerEnv, DONATION_INTAKE_DISABLED: "true" }
    );
    expect(open.status).toBe(200);
    await expect(open.json()).resolves.toEqual({
      status: "OPEN",
      frequency: "MONTHLY",
      giftType: "TITHE",
      amountCents: 2500,
      currency: "usd",
      canManageRecurring: false,
      recurringStatus: null
    });

    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'COMPLETE', payment_status = 'PAID',
              stripe_customer_id = 'cus_fixture', subscription_status = 'ACTIVE'
        WHERE stripe_session_id = ?`
    ).run(sessionId);
    const completed = await worker.fetch(
      new Request(`${origin}/api/donations/stripe/session/${sessionId}`),
      { ...workerEnv, DONATION_INTAKE_DISABLED: "true" }
    );
    await expect(completed.json()).resolves.toEqual({
      status: "PAID",
      frequency: "MONTHLY",
      giftType: "TITHE",
      amountCents: 2500,
      currency: "usd",
      canManageRecurring: true,
      recurringStatus: "ACTIVE"
    });

    const sessionOnly = await worker.fetch(new Request(`${origin}/api/donations/stripe/portal`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId })
    }), { ...workerEnv, DONATION_INTAKE_DISABLED: "true" });
    expect(sessionOnly.status).toBe(403);

    const portal = await worker.fetch(new Request(`${origin}/api/donations/stripe/portal`, {
      method: "POST",
      headers: { ...jsonHeaders(), Cookie: portalCookie },
      body: JSON.stringify({ sessionId })
    }), { ...workerEnv, DONATION_INTAKE_DISABLED: "true" });
    expect(portal.status).toBe(200);
    await expect(portal.json()).resolves.toEqual({
      url: "https://billing.stripe.test/session/cus_fixture"
    });
  });

  it("rotates the monthly portal capability on a safe Checkout replay", async () => {
    const first = await createCheckout(workerEnv, {
      requestId,
      amount: 25,
      frequency: "monthly"
    });
    const replay = await createCheckout(workerEnv, {
      requestId,
      amount: 25,
      frequency: "monthly"
    });
    const sessionId = String(first.body.sessionId);
    const firstCookie = cookieHeaderFrom(first.response);
    const replayCookie = cookieHeaderFrom(replay.response);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replayCookie).not.toBe(firstCookie);

    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'COMPLETE', payment_status = 'PAID',
              stripe_customer_id = 'cus_rotated', subscription_status = 'ACTIVE'
        WHERE stripe_session_id = ?`
    ).run(sessionId);

    expect((await createPortal(workerEnv, sessionId, firstCookie)).status).toBe(403);
    expect((await createPortal(workerEnv, sessionId, replayCookie)).status).toBe(200);
  });

  it("rejects cross-checkout, expired, and revoked portal capabilities", async () => {
    const first = await createCheckout(workerEnv, {
      requestId,
      amount: 25,
      frequency: "monthly"
    });
    const second = await createCheckout(workerEnv, {
      requestId: "1c2e2165-edb7-4e4b-bc50-95a7fa3cdfe6",
      amount: 25,
      frequency: "monthly"
    }, "203.0.113.2");
    const firstSessionId = String(first.body.sessionId);
    const secondSessionId = String(second.body.sessionId);
    const firstCookie = cookieHeaderFrom(first.response);
    const secondCookie = cookieHeaderFrom(second.response);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'COMPLETE', payment_status = 'PAID',
              stripe_customer_id = 'cus_first', subscription_status = 'ACTIVE'
        WHERE stripe_session_id = ?`
    ).run(firstSessionId);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'COMPLETE', payment_status = 'PAID',
              stripe_customer_id = 'cus_second', subscription_status = 'ACTIVE'
        WHERE stripe_session_id = ?`
    ).run(secondSessionId);

    const crossCheckout = await createPortal(workerEnv, secondSessionId, firstCookie);
    expect(crossCheckout.status).toBe(403);

    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET portal_capability_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE stripe_session_id = ?`
    ).run(secondSessionId);
    expect((await createPortal(workerEnv, secondSessionId, secondCookie)).status).toBe(403);

    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET portal_capability_expires_at = '2099-01-01T00:00:00.000Z',
              portal_capability_revoked_at = '2026-08-16T00:00:00.000Z'
        WHERE stripe_session_id = ?`
    ).run(secondSessionId);
    expect((await createPortal(workerEnv, secondSessionId, secondCookie)).status).toBe(403);
  });

  it("enforces a customer-wide portal budget across changing caller IPs", async () => {
    const created = await createCheckout(workerEnv, {
      requestId,
      amount: 25,
      frequency: "monthly"
    });
    const sessionId = String(created.body.sessionId);
    const cookie = cookieHeaderFrom(created.response);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET status = 'COMPLETE', payment_status = 'PAID',
              stripe_customer_id = 'cus_limited', subscription_status = 'ACTIVE'
        WHERE stripe_session_id = ?`
    ).run(sessionId);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await createPortal(workerEnv, sessionId, cookie, `203.0.113.${attempt + 10}`)).status).toBe(200);
    }
    const limited = await createPortal(workerEnv, sessionId, cookie, "203.0.113.99");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: "too_many_attempts" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM stripe_portal_rate_limit_claims"
    ).get()).toEqual({ count: 5 });
  });

  it("rejects unsafe mutations, invalid input, and new intake during shutdown", async () => {
    const textResponse = await worker.fetch(new Request(
      `${origin}/api/donations/stripe/checkout`,
      { method: "POST", body: "{}" }
    ), workerEnv);
    expect(textResponse.status).toBe(415);

    const crossOrigin = await worker.fetch(new Request(
      `${origin}/api/donations/stripe/checkout`,
      {
        method: "POST",
        headers: { ...jsonHeaders(), Origin: "https://attacker.example" },
        body: JSON.stringify({ requestId, amount: 50, frequency: "once" })
      }
    ), workerEnv);
    expect(crossOrigin.status).toBe(403);

    const invalid = await createCheckout(workerEnv, {
      requestId: "invalid",
      amount: 50,
      frequency: "once"
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: "invalid_request_id" });

    const disabled = await createCheckout({
      ...workerEnv,
      DONATION_INTAKE_DISABLED: "true"
    }, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    expect(disabled.response.status).toBe(503);
    expect(disabled.body).toEqual({ error: "donation_intake_disabled" });
  });

  it("shares the bounded public donation creation budget per caller IP", async () => {
    for (let index = 0; index < 5; index += 1) {
      const created = await createCheckout(workerEnv, {
        requestId: `0000000${index}-0000-4000-8000-00000000000${index}`,
        amount: 10,
        frequency: "once"
      }, "203.0.113.10");
      expect(created.response.status).toBe(201);
    }
    const limited = await createCheckout(workerEnv, {
      requestId: "00000005-0000-4000-8000-000000000005",
      amount: 10,
      frequency: "once"
    }, "203.0.113.10");
    expect(limited.response.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "too_many_attempts" });
    expect(limited.response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("blocks distinct clients at the Stripe provider ceiling before reservation or provider work", async () => {
    const now = "2026-07-04T12:00:00.000Z";
    for (let index = 0; index < 600; index += 1) {
      database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES (?, 'STRIPE', ?, ?, ?, ?)`
      ).run(
        `stripe_provider_seed_${index}`,
        `stripe-client-${index}`,
        `stripe-request-${index}`,
        now,
        "2026-07-04T12:15:00.000Z"
      );
    }
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('alert_email', 'owner@example.org')"
    ).run();
    const alertSend = vi.spyOn(EmailService.prototype, "sendOperationalAlert")
      .mockImplementation(async (_input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        return { messageId: "capacity-alert" };
      });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", providerFetch);
    try {
      const limited = await createCheckout(stripeProxyEnv(workerEnv), {
        requestId,
        amount: 50,
        frequency: "once"
      }, "198.51.100.200");

      expect(limited.response.status).toBe(503);
      expect(limited.body).toEqual({
        error: "donation_service_busy",
        message: "No pudimos preparar su entrega en este momento. Intente de nuevo en unos minutos."
      });
      expect(limited.response.headers.get("Cache-Control")).toBe("no-store");
      expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_sessions").get())
        .toEqual({ count: 0 });
      expect(providerFetch).not.toHaveBeenCalled();
      expect(alertSend).toHaveBeenCalledTimes(1);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
          WHERE action = 'PROVIDER_CREATION_CAPACITY_EXHAUSTED'
            AND entity_type = 'provider_creation_capacity'`
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
          WHERE action = 'ALERT_SENT:PROVIDER_CREATION_CAPACITY_EXHAUSTED'
            AND entity_type = 'provider_creation_capacity'`
      ).get()).toEqual({ count: 1 });
    } finally {
      alertSend.mockRestore();
      vi.useRealTimers();
    }
  });

  it("admits the 101st site-wide creation attempt when provider capacity remains", async () => {
    const now = "2026-07-04T12:00:00.000Z";
    for (let index = 0; index < 100; index += 1) {
      const stripe = index % 2 === 1;
      database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        `global_seed_${index}`,
        stripe ? "STRIPE" : "WOMPI",
        `global-client-${index}`,
        stripe ? `global-request-${index}` : null,
        now,
        "2026-07-04T12:15:00.000Z"
      );
    }
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const providerFetch = stubSuccessfulStripeCreation();
    try {
      const created = await createCheckout(stripeProxyEnv(workerEnv), {
        requestId,
        amount: 50,
        frequency: "once"
      }, "198.51.100.201");

      expect(created.response.status).toBe(201);
      expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_sessions").get())
        .toEqual({ count: 1 });
      expect(providerFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports, audits, and alerts at the shared emergency capacity ceiling", async () => {
    const now = "2026-07-04T12:00:00.000Z";
    const insert = database.prepare(
      `INSERT INTO provider_creation_claims (
         id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let index = 0; index < 1000; index += 1) {
      const stripe = index % 2 === 1;
      insert.run(
        `emergency_global_seed_${index}`,
        stripe ? "STRIPE" : "WOMPI",
        `emergency-global-client-${index}`,
        stripe ? `emergency-global-request-${index}` : null,
        now,
        "2026-07-04T12:15:00.000Z"
      );
    }
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('alert_email', 'owner@example.org')"
    ).run();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const alertSend = vi.spyOn(EmailService.prototype, "sendOperationalAlert")
      .mockImplementation(async (_input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        return { messageId: "capacity-alert" };
      });
    const providerFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", providerFetch);
    try {
      const limited = await createCheckout(stripeProxyEnv(workerEnv), {
        requestId,
        amount: 50,
        frequency: "once"
      }, "198.51.100.202");

      expect(limited.response.status).toBe(503);
      expect(limited.body).toEqual({
        error: "donation_service_busy",
        message: "No pudimos preparar su entrega en este momento. Intente de nuevo en unos minutos."
      });
      expect(limited.response.headers.get("Cache-Control")).toBe("no-store");
      expect(providerFetch).not.toHaveBeenCalled();
      expect(alertSend).toHaveBeenCalledTimes(1);
      expect(database.prepare(
        `SELECT metadata_json FROM audit_logs
          WHERE action = 'PROVIDER_CREATION_CAPACITY_EXHAUSTED'`
      ).get()).toEqual({
        metadata_json: JSON.stringify({
          scope: "GLOBAL",
          provider: "STRIPE",
          windowMinutes: 15,
          limit: 1000
        })
      });
    } finally {
      alertSend.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses one claim and one provider call when fresh concurrent requests share a request id", async () => {
    let providerCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      providerCalls += 1;
      const request = input instanceof Request ? input : new Request(input, init);
      return stripeCheckoutJson(new URLSearchParams(await request.text()));
    }));
    const concurrent = withSynchronizedStripeReservationReads(database);
    concurrent.synchronizeNextPair();
    const concurrentEnv = { ...stripeProxyEnv(workerEnv), DB: concurrent.db };
    const [first, second] = await Promise.all([
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" }, "203.0.113.55"),
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" }, "203.0.113.55")
    ]);

    expect([first.response.status, second.response.status].sort()).toEqual([201, 409]);
    expect([first.body.error, second.body.error]).toContain("stripe_checkout_in_progress");
    expect(providerCalls).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE provider = 'STRIPE'"
    ).get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_sessions").get())
      .toEqual({ count: 1 });
  });
});

async function createCheckout(
  workerEnv: Env,
  body: Record<string, unknown>,
  ip = "203.0.113.1"
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await worker.fetch(new Request(
    `${origin}/api/donations/stripe/checkout`,
    {
      method: "POST",
      headers: { ...jsonHeaders(), "CF-Connecting-IP": ip },
      body: JSON.stringify({ giftType: "tithe", ...body })
    }
  ), workerEnv);
  return {
    response,
    body: await response.json() as Record<string, unknown>
  };
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Origin: origin };
}

function cookieHeaderFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";", 1)[0] ?? "";
}

function createPortal(workerEnv: Env, sessionId: string, cookie: string, ip = "203.0.113.9"): Promise<Response> {
  return worker.fetch(new Request(`${origin}/api/donations/stripe/portal`, {
    method: "POST",
    headers: { ...jsonHeaders(), Cookie: cookie, "CF-Connecting-IP": ip },
    body: JSON.stringify({ sessionId })
  }), { ...workerEnv, DONATION_INTAKE_DISABLED: "true" });
}

function stripeJson(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Request-Id": "req_fixture", ...headers }
  });
}

function stripeProxyEnv(workerEnv: Env): Env {
  return {
    ...workerEnv,
    STRIPE_MOCK_MODE: undefined,
    STRIPE_RESTRICTED_KEY: "rk_test_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
    STRIPE_US_LEGAL_NAME: "Example Nonprofit",
    STRIPE_US_EIN: "12-3456789",
    STRIPE_US_PHONE: "+1 (555) 010-0200",
    STRIPE_US_WEBSITE: "https://example.org",
    STRIPE_US_MAILING_ADDRESS: "100 Example Street\nExample City, NY 10001, USA",
    STRIPE_US_SIGNER_NAME: "Example Treasurer",
    STRIPE_US_SIGNER_TITLE: "Treasurer",
    STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
  };
}

function stripeCheckoutJson(params: URLSearchParams): Response {
  return stripeJson(stripeCheckoutObject(params));
}

function stripeCheckoutObject(params: URLSearchParams): Record<string, unknown> {
  const checkoutId = params.get("client_reference_id")!;
  const sessionId = `cs_test_${checkoutId}`;
  return {
    id: sessionId,
    object: "checkout.session",
    client_reference_id: checkoutId,
    client_secret: `${sessionId}_secret_fixture`,
    url: null,
    created: 1_700_000_000,
    livemode: false,
    status: "open",
    payment_status: "unpaid",
    mode: params.get("mode"),
    amount_total: Number(params.get("line_items[0][price_data][unit_amount]")),
    currency: "usd",
    customer: null,
    subscription: null,
    payment_intent: null,
    customer_details: null,
    customer_email: null,
    metadata: {
      checkout_id: params.get("metadata[checkout_id]"),
      frequency: params.get("metadata[frequency]"),
      lane: params.get("metadata[lane]"),
      gift_type: params.get("metadata[gift_type]")
    },
    expires_at: 1_786_370_400
  };
}

function seedStripeProviderClaim(
  database: ReturnType<typeof migratedDatabase>,
  input: { id: string; claimedAt: string; expiresAt: string; stripeRequestId?: string }
): void {
  database.prepare(
    `INSERT INTO provider_creation_claims (
       id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
     ) VALUES (?, 'STRIPE', 'seed-client', ?, ?, ?)`
  ).run(input.id, input.stripeRequestId ?? requestId, input.claimedAt, input.expiresAt);
}

function seedDefiniteFailureCheckout(
  database: ReturnType<typeof migratedDatabase>,
  input: { claimId: string; claimedAt?: string; expiresAt?: string }
): void {
  if (input.claimedAt && input.expiresAt) {
    seedStripeProviderClaim(database, {
      id: input.claimId,
      claimedAt: input.claimedAt,
      expiresAt: input.expiresAt
    });
  }
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       currency, livemode, status, creation_attempt_count, creation_outcome_class,
       idempotency_generation, payment_status, provider_creation_claim_id, error_code,
       created_at, updated_at
     ) VALUES ('stripe_checkout_retry_fixture', ?, 'v2:stale', 'ONCE', 'TITHE', 5000,
               'usd', 0, 'FAILED', 1, 'DEFINITE_FAILURE', 1, 'UNPAID', ?,
               'stripe_checkout_create_failed', '2026-07-04T12:00:00.000Z',
               '2026-07-04T12:00:00.000Z')`
  ).run(requestId, input.claimId);
}

function seedProviderCreationCapacity(
  database: ReturnType<typeof migratedDatabase>,
  dimension: "provider" | "global",
  count: number,
  claimedAt: string
): void {
  const insert = database.prepare(
    `INSERT INTO provider_creation_claims (
       id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, '2026-07-04T12:31:00.000Z')`
  );
  for (let index = 0; index < count; index += 1) {
    const provider = dimension === "provider" || index % 2 === 0 ? "STRIPE" : "WOMPI";
    insert.run(
      `${dimension}_capacity_${index}`,
      provider,
      `${dimension}-client-${index}`,
      provider === "STRIPE" ? `${dimension}-request-${index}` : null,
      claimedAt
    );
  }
}

function stubSuccessfulStripeCreation(): ReturnType<typeof vi.fn<typeof fetch>> {
  const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/checkout/sessions") {
      throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
    }
    return stripeCheckoutJson(new URLSearchParams(await request.text()));
  });
  vi.stubGlobal("fetch", providerFetch);
  return providerFetch;
}

function withLosingDefiniteRetryCas(
  database: ReturnType<typeof migratedDatabase>,
  releaseFailures = 0
): { db: D1Database; releaseAttempts(): number } {
  const base = sqliteD1(database);
  let releaseAttempts = 0;
  return {
    db: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        if (
          sql.includes("UPDATE stripe_checkout_sessions")
          && sql.includes("provider_creation_claim_id = ?")
          && sql.includes("creation_outcome_class = 'DEFINITE_FAILURE'")
        ) {
          const mutable = statement as unknown as {
            first: <T>() => Promise<T | null>;
          };
          mutable.first = async <T>() => null as T | null;
        }
        if (sql.includes("DELETE FROM provider_creation_claims")) {
          const mutable = statement as unknown as {
            run: (...args: unknown[]) => Promise<D1Result>;
          };
          const run = mutable.run.bind(mutable);
          mutable.run = async (...args: unknown[]) => {
            releaseAttempts += 1;
            if (releaseAttempts <= releaseFailures) {
              throw new Error("injected provider claim release failure");
            }
            return run(...args);
          };
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return base.batch(statements);
      }
    } as D1Database,
    releaseAttempts() {
      return releaseAttempts;
    }
  };
}

function withFailingStripeReservation(
  database: ReturnType<typeof migratedDatabase>
): D1Database {
  const base = sqliteD1(database);
  return {
    prepare(sql: string) {
      const statement = base.prepare(sql);
      if (sql.includes("INSERT OR IGNORE INTO stripe_checkout_sessions")) {
        const mutable = statement as unknown as {
          run: (...args: unknown[]) => Promise<D1Result>;
        };
        mutable.run = async () => {
          throw new Error("injected Stripe reservation persistence failure");
        };
      }
      return statement;
    },
    batch(statements: D1PreparedStatement[]) {
      return base.batch(statements);
    }
  } as D1Database;
}

function withDeferredStripeAttachment(database: ReturnType<typeof migratedDatabase>): {
  db: D1Database;
  allowAttachments(): void;
} {
  const base = sqliteD1(database);
  let rejectAttachments = true;
  return {
    db: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        if (/UPDATE stripe_checkout_sessions[\s\S]+SET stripe_session_id\s*=/.test(sql)) {
          const mutable = statement as unknown as {
            run: (...args: unknown[]) => Promise<D1Result>;
            first: (...args: unknown[]) => Promise<unknown>;
          };
          const run = mutable.run.bind(mutable);
          const first = mutable.first.bind(mutable);
          mutable.run = async (...args: unknown[]) => {
            if (rejectAttachments) throw new Error("deferred attachment fixture");
            return run(...args);
          };
          mutable.first = async (...args: unknown[]) => {
            if (rejectAttachments) throw new Error("deferred attachment fixture");
            return first(...args);
          };
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return base.batch(statements);
      }
    } as D1Database,
    allowAttachments() {
      rejectAttachments = false;
    }
  };
}

function withSynchronizedStripeReservationReads(database: ReturnType<typeof migratedDatabase>): {
  db: D1Database;
  synchronizeNextPair(): void;
} {
  const base = sqliteD1(database);
  let readsRemaining = 0;
  let releaseReads: (() => void) | null = null;
  let readBarrier = Promise.resolve();
  return {
    db: {
      prepare(sql: string) {
        const statement = base.prepare(sql);
        if (sql === "SELECT * FROM stripe_checkout_sessions WHERE request_id = ?") {
          const mutable = statement as unknown as {
            first: (...args: unknown[]) => Promise<unknown>;
          };
          const first = mutable.first.bind(mutable);
          mutable.first = async (...args: unknown[]) => {
            const snapshot = await first(...args);
            if (readsRemaining > 0) {
              readsRemaining -= 1;
              if (readsRemaining === 0) releaseReads?.();
              await readBarrier;
            }
            return snapshot;
          };
        }
        return statement;
      },
      batch(statements: D1PreparedStatement[]) {
        return base.batch(statements);
      }
    } as D1Database,
    synchronizeNextPair() {
      readsRemaining = 2;
      readBarrier = new Promise<void>((resolve) => { releaseReads = resolve; });
    }
  };
}
