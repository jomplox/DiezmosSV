import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  afterEach(() => database.close());

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
