import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
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
      "SELECT COUNT(*) AS count FROM security_rate_limit_claims WHERE scope = 'donation_intent'"
    ).get()).toEqual({ count: 1 });
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
      "SELECT COUNT(*) AS count FROM security_rate_limit_claims WHERE scope = 'donation_intent'"
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
      "SELECT COUNT(*) AS count FROM security_rate_limit_claims WHERE scope = 'donation_intent'"
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
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    };

    const first = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(first.response.status).toBe(502);
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

    const portal = await worker.fetch(new Request(`${origin}/api/donations/stripe/portal`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId })
    }), { ...workerEnv, DONATION_INTAKE_DISABLED: "true" });
    expect(portal.status).toBe(200);
    await expect(portal.json()).resolves.toEqual({
      url: "https://billing.stripe.test/session/cus_fixture"
    });
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
  });

  it("releases the duplicate admission claim when concurrent requests converge on one checkout", async () => {
    const concurrent = withSynchronizedStripeReservationReads(database);
    concurrent.synchronizeNextPair();
    const concurrentEnv = { ...workerEnv, DB: concurrent.db };
    const [first, second] = await Promise.all([
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" }, "203.0.113.55"),
      createCheckout(concurrentEnv, { requestId, amount: 50, frequency: "once" }, "203.0.113.55")
    ]);

    expect([first.response.status, second.response.status].sort()).toEqual([200, 201]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM security_rate_limit_claims WHERE scope = 'donation_intent'"
    ).get()).toEqual({ count: 1 });
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
