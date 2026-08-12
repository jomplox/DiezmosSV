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

  it("reconciles an ambiguous cached failure before rotating its idempotency generation", async () => {
    const creationKeys: string[] = [];
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
      const params = new URLSearchParams(await request.text());
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
        client_secret: `${sessionId}_secret_fixture`,
        url: null,
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
    const retry = await createCheckout(proxyEnv, { requestId, amount: 50, frequency: "once" });
    expect(retry.response.status).toBe(201);
    expect(listCalls).toBe(1);
    expect(creationKeys).toHaveLength(3);
    expect(creationKeys[1]).toBe(creationKeys[0]);
    expect(creationKeys[2]).not.toBe(creationKeys[0]);
    expect(database.prepare(
      `SELECT status, creation_outcome_class, idempotency_generation
         FROM stripe_checkout_sessions WHERE request_id = ?`
    ).get(requestId)).toEqual({
      status: "OPEN",
      creation_outcome_class: null,
      idempotency_generation: 2
    });
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
