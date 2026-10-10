import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { bytesToBase64, utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env } from "../../src/worker/types";
import { emisorConfig, generatedCertificateXml } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { signWompiBody } from "./support/workerFetchHelpers";

installWorkerFetchGlobals();

const NOW = "2026-10-10T18:00:00.000Z";
const WEBHOOK_SECRET = "n1co-webhook-test-secret";
const INTENT_ID = "di_n1co_flow";
const ORDER = { orderId: 22805, orderCode: "yY7Mcnd", paymentLinkUrl: "https://pay-sandbox.n1co.shop/yY7Mcnd" };

interface Harness {
  database: DatabaseSync;
  queued: unknown[];
  env(values?: Partial<Env>): Env;
}

function harness(): Harness {
  const database = migratedDatabase();
  const queued: unknown[] = [];
  return {
    database,
    queued,
    env: (values = {}) => ({
      ...env(new InMemoryD1()),
      DB: sqliteD1(database),
      ISSUANCE_QUEUE: { send: async (message: unknown) => { queued.push(message); } } as unknown as Env["ISSUANCE_QUEUE"],
      ...values
    })
  };
}

async function realModeEnv(h: Harness, values: Partial<Env> = {}): Promise<Env> {
  return h.env({
    MOCK_EXTERNAL_SERVICES: "false",
    APP_ENV: "staging",
    APP_ORIGIN: "https://donar.example.org",
    EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
    WOMPI_CLIENT_ID: "id",
    WOMPI_CLIENT_SECRET: "secret",
    N1CO_CHECKOUT_SECRET_KEY: "n1co-checkout-key",
    N1CO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MH_CERT_XML: await generatedCertificateXml("cert-password"),
    MH_CERT_PASSWORD: "cert-password",
    MH_USER_TEST: "test-mh-user",
    MH_PASSWORD_TEST: "test-mh-password",
    MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
    MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
    MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte",
    ...values
  });
}

function seedIntent(database: DatabaseSync, overrides: Record<string, string | number | null> = {}): void {
  const row: Record<string, string | number | null> = {
    id: INTENT_ID,
    status: "LINK_CREATED",
    amount_cents: 2550,
    donor_document_type: "13",
    donor_document: "10000001-9",
    direccion_departamento: "06",
    direccion_municipio: "23",
    direccion_distrito: "14",
    gift_type: "DIEZMO",
    wompi_id_enlace: 987654,
    wompi_url_enlace: `https://s.wompi.sv/abc`,
    wompi_url_enlace_largo: `https://pagos.wompi.sv/IntentoPago/Redirect?id=abc`,
    created_at: "2026-10-10T17:50:00.000Z",
    updated_at: "2026-10-10T17:50:00.000Z",
    expires_at: "2026-10-10T18:50:00.000Z",
    ...overrides
  };
  const columns = Object.keys(row);
  database
    .prepare(`INSERT INTO donation_intents (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function moveToN1co(database: DatabaseSync): void {
  database.prepare(
    `UPDATE donation_intents
        SET payment_provider = 'N1CO', n1co_order_id = ?, n1co_order_code = ?, n1co_payment_link_url = ?
      WHERE id = ?`
  ).run(ORDER.orderId, ORDER.orderCode, ORDER.paymentLinkUrl, INTENT_ID);
}

function intentRow(database: DatabaseSync): Record<string, unknown> {
  return database.prepare("SELECT * FROM donation_intents WHERE id = ?").get(INTENT_ID) as Record<string, unknown>;
}

function switchRequest(id = INTENT_ID): Request {
  return new Request(`https://donar.example.org/api/donations/intent/${id}/n1co`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: "{}"
  });
}

function paidOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: ORDER.orderId,
    orderCode: ORDER.orderCode,
    orderReference: INTENT_ID,
    name: "Diezmos y Ofrendas",
    orderStatus: "PAID",
    total: 25.5,
    store: { currencyCode: "USD" },
    payment: {
      authorizationCode: "831000",
      buyer: { name: "Ana Pérez", phone: "+50370001122", email: "ana@example.org" }
    },
    ...overrides
  };
}

async function webhookRequest(event: Record<string, unknown>, secret = WEBHOOK_SECRET): Promise<Request> {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body))));
  return new Request("https://donar.example.org/webhooks/n1co", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-H4B-Hmac-Sha256": signature, "User-Agent": "H4B" },
    body
  });
}

function successEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: String(ORDER.orderId),
    orderReference: INTENT_ID,
    orderType: "FASTLINK_CHARGE",
    description: "La orden fue pagada exitosamente",
    metadata: null,
    level: "Info",
    type: "SuccessPayment",
    ...overrides
  };
}

type Route = (url: string, init: RequestInit | undefined) => Response | undefined;

function stubFetch(...routes: Route[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    throw new Error(`Unexpected outbound request: ${init?.method ?? "GET"} ${url}`);
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const wompiToken: Route = (url) =>
  url === "https://id.wompi.sv/connect/token"
    ? json({ access_token: "wompi-token", expires_in: 3600, token_type: "Bearer" })
    : undefined;
const wompiDeactivate: Route = (url, init) =>
  url === "https://api.wompi.sv/EnlacePago/987654" && init?.method === "PUT" ? json({ idEnlace: 987654 }) : undefined;
const wompiLinkUnpaid: Route = (url, init) =>
  url === "https://api.wompi.sv/EnlacePago/987654" && (init?.method ?? "GET") === "GET"
    ? json({ idEnlace: 987654, nombreEnlace: INTENT_ID, transacciones: [] })
    : undefined;
const n1coCreate: Route = (url, init) =>
  url === "https://api-pay-sandbox.n1co.shop/api/paymentlink/checkout" && init?.method === "POST" ? json(ORDER) : undefined;
const n1coOrder = (order: Record<string, unknown>): Route => (url) =>
  url === `https://api-pay-sandbox.n1co.shop/api/paymentlink/order/${ORDER.orderCode}` ? json(order) : undefined;

describe("n1co secondary provider", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
    h = harness();
  });

  afterEach(() => {
    vi.useRealTimers();
    h.database.close();
  });

  describe("switch", () => {
    it("mints the n1co link, deactivates Wompi, and moves the intent to n1co once", async () => {
      seedIntent(h.database);
      const fetchSpy = stubFetch(n1coCreate, wompiToken, wompiDeactivate, wompiLinkUnpaid);

      const response = await worker.fetch(switchRequest(), await realModeEnv(h));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ paymentLinkUrl: ORDER.paymentLinkUrl });
      expect(intentRow(h.database)).toMatchObject({
        payment_provider: "N1CO",
        n1co_order_id: ORDER.orderId,
        n1co_order_code: ORDER.orderCode,
        n1co_payment_link_url: ORDER.paymentLinkUrl,
        paid_at: null
      });
      const calls = fetchSpy.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`);
      expect(calls[0]).toBe("POST https://api-pay-sandbox.n1co.shop/api/paymentlink/checkout");
      expect(calls).toContain("PUT https://api.wompi.sv/EnlacePago/987654");
      const [, createInit] = fetchSpy.mock.calls[0];
      expect(createInit?.headers).toMatchObject({ Authorization: "Bearer n1co-checkout-key" });
      expect(JSON.parse(String(createInit?.body))).toEqual({
        orderReference: INTENT_ID,
        orderName: "Diezmos y Ofrendas",
        amount: 25.5,
        successUrl: `https://donar.example.org/donar/gracias?identificadorEnlaceComercio=${INTENT_ID}&monto=25.50`,
        cancelUrl: "https://donar.example.org/donar?ruta=sv",
        metadata: [{ name: "intentId", value: INTENT_ID }],
        expirationMinutes: 50
      });

      // A second click returns the same link without touching either provider.
      fetchSpy.mockClear();
      const again = await worker.fetch(switchRequest(), await realModeEnv(h));
      await expect(again.json()).resolves.toEqual({ paymentLinkUrl: ORDER.paymentLinkUrl });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("leaves the donor on Wompi when n1co cannot mint a link", async () => {
      seedIntent(h.database);
      const fetchSpy = stubFetch((url) => (url.includes("n1co.shop") ? json({ title: "boom" }, 500) : undefined));

      const response = await worker.fetch(switchRequest(), await realModeEnv(h));

      expect(response.status).toBe(502);
      expect(intentRow(h.database)).toMatchObject({ payment_provider: "WOMPI", n1co_order_id: null });
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("wompi"))).toBe(false);
    });

    it("keeps the intent on Wompi when a Wompi payment landed before deactivation", async () => {
      seedIntent(h.database);
      stubFetch(n1coCreate, wompiToken, wompiDeactivate, (url) =>
        url === "https://api.wompi.sv/EnlacePago/987654"
          ? json({
            idEnlace: 987654,
            nombreEnlace: INTENT_ID,
            transacciones: [{ idTransaccion: "tx-1", esAprobada: true, fechaTransaccion: NOW, monto: 25.5, esReal: false }]
          })
          : undefined);

      const response = await worker.fetch(switchRequest(), await realModeEnv(h));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_already_paid" });
      expect(intentRow(h.database).payment_provider).toBe("WOMPI");
    });

    it.each([
      ["fiscal data is not attached yet", { donor_document: null }],
      ["the intent is paid", { paid_at: NOW }],
      ["the intent expired", { expires_at: "2026-10-10T17:59:00.000Z" }],
      ["the intent is still PENDING", { status: "PENDING", wompi_id_enlace: null }]
    ])("refuses when %s, before any provider call", async (_label, overrides) => {
      seedIntent(h.database, overrides);
      const fetchSpy = stubFetch();

      const response = await worker.fetch(switchRequest(), await realModeEnv(h));

      expect(response.status).toBe(409);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(intentRow(h.database).payment_provider).toBe("WOMPI");
    });

    it("is unavailable without both n1co secrets", async () => {
      seedIntent(h.database);
      const response = await worker.fetch(switchRequest(), await realModeEnv(h, { N1CO_WEBHOOK_SECRET: undefined }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: "n1co_unavailable" });
    });

    it("rejects cross-site requests", async () => {
      seedIntent(h.database);
      const response = await worker.fetch(
        new Request(`https://donar.example.org/api/donations/intent/${INTENT_ID}/n1co`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: "https://attacker.example" },
          body: "{}"
        }),
        await realModeEnv(h)
      );

      expect(response.status).toBe(415);
      expect(intentRow(h.database).payment_provider).toBe("WOMPI");
    });

    it("refuses a provider switch the schema does not allow", () => {
      seedIntent(h.database, { paid_at: NOW });
      expect(() => moveToN1co(h.database)).toThrow(/donation_intent_provider_switch_invalid/);
      seedIntent(h.database, { id: "di_other", wompi_id_enlace: 987655 });
      expect(() => h.database.prepare("UPDATE donation_intents SET payment_provider = 'N1CO' WHERE id = 'di_other'").run())
        .toThrow(/donation_intent_provider_switch_invalid/);
    });
  });

  describe("webhook", () => {
    it("verifies the order with n1co and queues one CDE for a paid order", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      const fetchSpy = stubFetch(n1coOrder(paidOrder()));
      const testEnv = await realModeEnv(h);

      const response = await worker.fetch(await webhookRequest(successEvent()), testEnv);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, outcome: "ingested" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer n1co-checkout-key" });
      const events = h.database.prepare("SELECT transaction_id, payment_link_id, environment, result, amount_cents, donor_email, raw_body FROM wompi_events").all() as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        transaction_id: "n1co-22805",
        payment_link_id: null,
        environment: "00",
        result: "ExitosaAprobada",
        amount_cents: 2550,
        donor_email: "ana@example.org"
      });
      expect(JSON.parse(String(events[0].raw_body))).toMatchObject({ Proveedor: "N1CO", FechaTransaccion: NOW });
      expect(intentRow(h.database)).toMatchObject({ paid_at: NOW, n1co_paid_observed_at: NOW, donor_phone: "+50370001122" });
      expect(h.queued).toHaveLength(1);

      // n1co's retry of the same delivery neither duplicates the event nor re-queues.
      vi.setSystemTime(new Date("2026-10-10T18:00:03.000Z"));
      const retry = await worker.fetch(await webhookRequest(successEvent()), testEnv);
      expect(retry.status).toBe(200);
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM wompi_events").get()).toEqual({ count: 1 });
      expect(h.queued).toHaveLength(1);
    });

    it("rejects a delivery whose signature does not match", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      const fetchSpy = stubFetch();

      const response = await worker.fetch(await webhookRequest(successEvent(), "wrong-secret"), await realModeEnv(h));

      expect(response.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ["another product's order", successEvent({ orderType: "COUPON_APP" })],
      ["an order without our reference", successEvent({ orderReference: null })],
      ["an order id the intent does not hold", successEvent({ orderId: "22806" })],
      ["the Created event that precedes the switch", successEvent({ type: "Created" })]
    ])("acknowledges %s without a lookup", async (label, event) => {
      seedIntent(h.database);
      if (!label.includes("precedes")) moveToN1co(h.database);
      const fetchSpy = stubFetch();

      const response = await worker.fetch(await webhookRequest(event), await realModeEnv(h));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, ignored: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("records nothing for an unpaid order and audits a mismatched one", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      stubFetch(n1coOrder(paidOrder({ orderStatus: "PENDING" })));
      const unpaid = await worker.fetch(await webhookRequest(successEvent()), await realModeEnv(h));
      await expect(unpaid.json()).resolves.toEqual({ ok: true, outcome: "unpaid" });

      vi.restoreAllMocks();
      vi.setSystemTime(new Date("2026-10-10T18:00:01.000Z"));
      stubFetch(n1coOrder(paidOrder({ total: 2.55 })));
      const mismatched = await worker.fetch(await webhookRequest(successEvent()), await realModeEnv(h));
      await expect(mismatched.json()).resolves.toEqual({ ok: true, outcome: "rejected" });

      expect(h.database.prepare("SELECT COUNT(*) AS count FROM wompi_events").get()).toEqual({ count: 0 });
      expect(intentRow(h.database).paid_at).toBeNull();
      expect(h.database.prepare("SELECT action FROM audit_logs WHERE entity_id = ?").all(INTENT_ID))
        .toContainEqual({ action: "N1CO_ORDER_REJECTED" });
    });

    it("has a production Worker read production n1co and record ambiente 01", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      stubFetch((url) =>
        url === `https://api-pay.n1co.shop/api/paymentlink/order/${ORDER.orderCode}` ? json(paidOrder()) : undefined);

      // The deployment selects the n1co host, so a staging Worker can only ever see
      // sandbox (ambiente 00) payments and production only production ones.
      const response = await worker.fetch(await webhookRequest(successEvent()), await realModeEnv(h, { APP_ENV: "production" }));

      expect(response.status).toBe(200);
      const event = h.database.prepare("SELECT environment FROM wompi_events").get();
      expect(event).toEqual({ environment: "01" });
    });

    it("answers 500 so n1co retries when the order lookup fails", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      stubFetch((url) => (url.includes("n1co.shop") ? json({}, 503) : undefined));

      const response = await worker.fetch(await webhookRequest(successEvent()), await realModeEnv(h));

      expect(response.status).toBe(500);
      expect(intentRow(h.database).paid_at).toBeNull();
    });
  });

  it("refuses a Wompi-signed webhook that claims to be an n1co payment", async () => {
    seedIntent(h.database);
    moveToN1co(h.database);
    const body = JSON.stringify({
      IdTransaccion: "n1co-22805",
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "25.50",
      FechaTransaccion: NOW,
      EsProductiva: false,
      Proveedor: "N1CO",
      EnlacePago: { Id: ORDER.orderId, IdentificadorEnlaceComercio: INTENT_ID }
    });
    const response = await worker.fetch(new Request("https://donar.example.org/webhooks/wompi", {
      method: "POST",
      headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(body, "wompi-api-secret") },
      body
    }), await realModeEnv(h, { WOMPI_API_SECRET: "wompi-api-secret" }));

    expect(response.status).toBe(400);
    expect(h.database.prepare("SELECT COUNT(*) AS count FROM wompi_events").get()).toEqual({ count: 0 });
    expect(intentRow(h.database).paid_at).toBeNull();
  });

  describe("recovery without the webhook", () => {
    it("lets the thank-you poll confirm a paid order, at most one lookup per interval", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      const fetchSpy = stubFetch(n1coOrder(paidOrder({ orderStatus: "PENDING" })));
      const testEnv = await realModeEnv(h);
      const status = () => worker.fetch(new Request(`https://donar.example.org/api/donations/intent/${INTENT_ID}/status`), testEnv);

      await expect((await status()).json()).resolves.toEqual({ status: "LINK_CREATED", paid: false });
      await expect((await status()).json()).resolves.toEqual({ status: "LINK_CREATED", paid: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      vi.restoreAllMocks();
      stubFetch(n1coOrder(paidOrder()));
      vi.setSystemTime(new Date("2026-10-10T18:00:21.000Z"));
      await expect((await status()).json()).resolves.toEqual({ status: "LINK_CREATED", paid: true });
      expect(h.queued).toHaveLength(1);
    });

    it("reconciles a paid n1co order on the cron tick", async () => {
      seedIntent(h.database);
      moveToN1co(h.database);
      stubFetch(n1coOrder(paidOrder()), wompiToken, wompiLinkUnpaid, wompiDeactivate);

      await worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        await realModeEnv(h)
      );

      expect(intentRow(h.database).paid_at).toBe(NOW);
      expect(h.database.prepare("SELECT transaction_id FROM wompi_events").all()).toEqual([{ transaction_id: "n1co-22805" }]);
      expect(h.queued).toHaveLength(1);
    });
  });

  it("advertises n1co on the datos response only when it is configured", async () => {
    const datos = async (values: Partial<Env>) => {
      h.database.exec("DELETE FROM donation_intents");
      const created = await worker.fetch(new Request("https://donar.example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ amount: "25.50", giftType: "DIEZMO" })
      }), h.env(values));
      const { intentId, datosToken } = await created.json() as { intentId: string; datosToken: string };
      const response = await worker.fetch(new Request(`https://donar.example.org/api/donations/intent/${intentId}/datos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", "X-Donation-Datos-Token": datosToken },
        body: JSON.stringify({
          donorDocumentType: "13",
          donorDocument: "10000001-9",
          departamento: "06",
          municipio: "23",
          distrito: "14"
        })
      }), h.env(values));
      return response.json() as Promise<Record<string, unknown>>;
    };

    await expect(datos({})).resolves.toMatchObject({ n1coAvailable: true });
  });
});
