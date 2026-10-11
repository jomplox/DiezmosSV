import { describe, expect, it } from "vitest";
import {
  N1coPayloadError,
  n1coWebhookFromOrder,
  parseN1coWebhookEvent,
  verifyN1coSignature
} from "../../src/worker/domain/n1co";
import { normalizeWompiWebhook, WompiPayloadError } from "../../src/worker/domain/wompi";
import { bytesToBase64, hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";

// Shape captured from a real n1co sandbox delivery (order cancelled afterwards).
const SANDBOX_CREATED_BODY =
  '{"orderId":"22805","orderReference":"di_hooktest_0001","orderType":"FASTLINK_CHARGE","description":"La orden fue creada","metadata":null,"level":"Info","type":"Created"}';

const intent = {
  id: "di_n1co",
  amount_cents: 2550,
  n1co_order_id: 22805,
  n1co_order_code: "yY7Mcnd"
};

function paidOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: 22805,
    orderCode: "yY7Mcnd",
    orderReference: "di_n1co",
    name: "Diezmo",
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

async function sign(body: string, secret: string, encode: (bytes: Uint8Array) => string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body))));
}

describe("n1co webhook signature", () => {
  it("accepts the Base64 HMAC-SHA256 of the raw body and nothing else", async () => {
    const secret = "n1co-webhook-secret";
    const signature = await sign(SANDBOX_CREATED_BODY, secret, bytesToBase64);

    await expect(verifyN1coSignature(SANDBOX_CREATED_BODY, signature, secret)).resolves.toBe(true);
    await expect(verifyN1coSignature(`${SANDBOX_CREATED_BODY}\n`, signature, secret)).resolves.toBe(false);
    await expect(verifyN1coSignature(SANDBOX_CREATED_BODY, signature, "other-secret")).resolves.toBe(false);
    await expect(
      verifyN1coSignature(SANDBOX_CREATED_BODY, await sign(SANDBOX_CREATED_BODY, secret, hexFromBytes), secret)
    ).resolves.toBe(false);
    await expect(verifyN1coSignature(SANDBOX_CREATED_BODY, null, secret)).resolves.toBe(false);
  });
});

describe("n1co webhook event", () => {
  it("parses the sandbox delivery shape, where orderId is a string", () => {
    expect(parseN1coWebhookEvent(JSON.parse(SANDBOX_CREATED_BODY))).toEqual({
      orderId: 22805,
      orderReference: "di_hooktest_0001",
      orderType: "FASTLINK_CHARGE",
      type: "Created"
    });
  });

  it.each([
    ["a non-object", "nope"],
    ["a missing orderId", { orderType: "FASTLINK_CHARGE", type: "Created" }],
    ["a non-numeric orderId", { orderId: "22805x", orderType: "FASTLINK_CHARGE", type: "Created" }],
    ["a missing type", { orderId: "1", orderType: "FASTLINK_CHARGE" }]
  ])("rejects %s", (_label, input) => {
    expect(() => parseN1coWebhookEvent(input)).toThrow(N1coPayloadError);
  });
});

describe("n1co order to canonical payload", () => {
  const context = { observedAt: "2026-10-10T18:00:00.000Z", production: false };

  it("expresses a paid order as an approved, provider-marked canonical payload", () => {
    const payload = n1coWebhookFromOrder(intent, paidOrder(), context);

    expect(payload).toEqual({
      IdCuenta: "",
      FechaTransaccion: "2026-10-10T18:00:00.000Z",
      Monto: "25.50",
      IdTransaccion: "n1co-22805",
      ResultadoTransaccion: "ExitosaAprobada",
      CodigoAutorizacion: "831000",
      IdIntentoPago: null,
      Cantidad: 1,
      EsProductiva: false,
      Proveedor: "N1CO",
      Aplicativo: { Nombre: "n1co", Url: undefined, Id: undefined },
      EnlacePago: {
        Id: 22805,
        IdentificadorEnlaceComercio: "di_n1co",
        NombreProducto: "Diezmo",
        DescripcionProducto: undefined
      },
      Cliente: expect.objectContaining({
        Nombre: "Ana Pérez",
        EMail: "ana@example.org",
        Celular: "+50370001122"
      }),
      Tarjeta: undefined,
      EsInternacional: undefined,
      IdExterno: undefined
    });
  });

  it("round-trips through the stored canonical form unchanged", () => {
    const payload = n1coWebhookFromOrder(intent, paidOrder(), context);

    expect(normalizeWompiWebhook(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it.each(["PAID", "FINALIZED", "paid"])("treats status %s as paid", (orderStatus) => {
    expect(n1coWebhookFromOrder(intent, paidOrder({ orderStatus }), context)).not.toBeNull();
  });

  it.each(["PENDING", "CANCELLED", undefined])("returns null for unpaid status %s", (orderStatus) => {
    expect(n1coWebhookFromOrder(intent, paidOrder({ orderStatus }), context)).toBeNull();
  });

  it.each([
    ["another order id", { orderId: 22806 }],
    ["another order code", { orderCode: "other" }],
    ["another reference", { orderReference: "di_other" }],
    ["a missing reference", { orderReference: null }],
    ["a different amount", { total: 25.49 }],
    ["a surcharge-inflated amount", { total: 26.5 }],
    ["a non-USD store", { store: { currencyCode: "HNL" } }]
  ])("refuses %s", (_label, overrides) => {
    expect(() => n1coWebhookFromOrder(intent, paidOrder(overrides), context)).toThrow(N1coPayloadError);
  });

  it("marks production only when the lookup came from the production API", () => {
    expect(n1coWebhookFromOrder(intent, paidOrder(), { ...context, production: true })?.EsProductiva).toBe(true);
  });

  it("omits buyer fields n1co did not return", () => {
    const payload = n1coWebhookFromOrder(intent, paidOrder({ payment: { authorizationCode: null } }), context);

    expect(payload?.Cliente).toEqual(expect.objectContaining({ Nombre: undefined, EMail: undefined }));
    expect(payload?.CodigoAutorizacion).toBeNull();
  });
});

describe("canonical provider marker", () => {
  it("rejects any provider value other than N1CO", () => {
    expect(() => normalizeWompiWebhook({
      IdTransaccion: "tx",
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "1.00",
      FechaTransaccion: "2026-10-10T18:00:00.000Z",
      EsProductiva: false,
      Proveedor: "WOMPI"
    })).toThrow(WompiPayloadError);
  });
});
