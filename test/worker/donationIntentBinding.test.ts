import { describe, expect, it } from "vitest";
import { resolveDonationIntentBinding } from "../../src/worker/services/donationIntentBinding";
import type { DonationIntentRecord, WompiWebhook } from "../../src/worker/types";
import { makeIntent } from "./fixtures";
import type { Repository } from "../../src/worker/storage/repository";

class BindingRepository {
  lookups = 0;

  constructor(private readonly intent: DonationIntentRecord | null = bindingIntent()) {}

  async getDonationIntent(id: string): Promise<DonationIntentRecord | null> {
    this.lookups += 1;
    return this.intent?.id === id ? this.intent : null;
  }
}

describe("donation intent Wompi binding", () => {
  it("treats ordinary static-link payloads as legacy without an intent lookup", async () => {
    const repo = new BindingRepository();
    const result = await resolveDonationIntentBinding(repo as unknown as Repository, payload({
      IdExterno: "DONACION",
      EnlacePago: { Id: 123, IdentificadorEnlaceComercio: "DONACION-123" }
    }));

    expect(result).toEqual({ kind: "legacy" });
    expect(repo.lookups).toBe(0);
  });

  it("rejects an IdExterno-only app id without looking it up", async () => {
    const repo = new BindingRepository();
    const result = await resolveDonationIntentBinding(repo as unknown as Repository, payload({
      IdExterno: "di_bound",
      EnlacePago: { Id: 987654 }
    }));

    expect(result).toMatchObject({ kind: "unbound", intentId: "di_bound", reason: "missing_canonical_commerce_id" });
    expect(repo.lookups).toBe(0);
  });

  it.each([
    ["missing payload link", { EnlacePago: { IdentificadorEnlaceComercio: "di_bound" } }, bindingIntent(), "missing_payload_link_id"],
    ["missing stored link", {}, bindingIntent({ wompi_id_enlace: null }), "missing_stored_link_id"],
    ["mismatched link", { EnlacePago: { Id: 111, IdentificadorEnlaceComercio: "di_bound" } }, bindingIntent(), "link_id_mismatch"],
    ["ineligible status", {}, bindingIntent({ status: "PENDING" }), "ineligible_status"]
  ])("rejects %s", async (_label, overrides, intent, reason) => {
    const repo = new BindingRepository(intent);
    const result = await resolveDonationIntentBinding(
      repo as unknown as Repository,
      payload(overrides as Partial<WompiWebhook>)
    );

    expect(result).toMatchObject({ kind: "unbound", intentId: "di_bound", reason });
    expect(repo.lookups).toBe(1);
  });

  it("rejects a disagreeing IdExterno after the canonical app id is present", async () => {
    const repo = new BindingRepository();
    const result = await resolveDonationIntentBinding(repo as unknown as Repository, payload({ IdExterno: "di_other" }));

    expect(result).toMatchObject({ kind: "unbound", intentId: "di_bound", reason: "commerce_id_mismatch" });
    expect(repo.lookups).toBe(0);
  });

  it.each(["LINK_CREATED", "EXPIRED"] as const)("binds an exact commerce/link match in %s", async (status) => {
    const intent = bindingIntent({ status });
    const repo = new BindingRepository(intent);

    const result = await resolveDonationIntentBinding(repo as unknown as Repository, payload());

    expect(result).toEqual({ kind: "bound", intent });
    expect(repo.lookups).toBe(1);
  });

  describe("n1co", () => {
    const n1coIntent = (overrides: Partial<DonationIntentRecord> = {}) => bindingIntent({
      payment_provider: "N1CO",
      n1co_order_id: 22805,
      n1co_order_code: "yY7Mcnd",
      n1co_payment_link_url: "https://pay-sandbox.n1co.shop/yY7Mcnd",
      ...overrides
    });
    const n1coPayload = (overrides: Partial<WompiWebhook> = {}) => payload({
      IdTransaccion: "n1co-22805",
      Proveedor: "N1CO",
      EnlacePago: { Id: 22805, IdentificadorEnlaceComercio: "di_bound" },
      ...overrides
    });

    it("binds an n1co payment to an intent that moved to n1co by its order id", async () => {
      const intent = n1coIntent();
      const result = await resolveDonationIntentBinding(
        new BindingRepository(intent) as unknown as Repository,
        n1coPayload()
      );

      expect(result).toEqual({ kind: "bound", intent });
    });

    it("quarantines a late Wompi payment once the intent moved to n1co", async () => {
      const result = await resolveDonationIntentBinding(
        new BindingRepository(n1coIntent()) as unknown as Repository,
        payload()
      );

      expect(result).toMatchObject({ kind: "unbound", reason: "provider_mismatch" });
    });

    it("quarantines an n1co payment for an intent still on Wompi", async () => {
      const result = await resolveDonationIntentBinding(
        new BindingRepository(bindingIntent({ n1co_order_id: 22805 })) as unknown as Repository,
        n1coPayload()
      );

      expect(result).toMatchObject({ kind: "unbound", reason: "provider_mismatch" });
    });

    it("never matches an n1co order id against the Wompi link id", async () => {
      const result = await resolveDonationIntentBinding(
        new BindingRepository(n1coIntent({ wompi_id_enlace: 22806 })) as unknown as Repository,
        n1coPayload({ EnlacePago: { Id: 22806, IdentificadorEnlaceComercio: "di_bound" } })
      );

      expect(result).toMatchObject({
        kind: "unbound",
        reason: "link_id_mismatch",
        expectedLinkId: 22805,
        payloadLinkId: 22806
      });
    });
  });
});

function payload(overrides: Partial<WompiWebhook> = {}): WompiWebhook {
  return {
    IdCuenta: "acct",
    FechaTransaccion: "2026-07-09T12:00:00-06:00",
    Monto: "25.50",
    IdTransaccion: "tx_binding",
    ResultadoTransaccion: "ExitosaAprobada",
    EsProductiva: false,
    EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_bound" },
    ...overrides
  };
}

function bindingIntent(overrides: Partial<DonationIntentRecord> = {}): DonationIntentRecord {
  return makeIntent({
    id: "di_bound",
    donor_document: "10000001-9",
    direccion_municipio: "23",
    direccion_distrito: "14",
    gift_type: "DIEZMO",
    wompi_id_enlace: 987654,
    created_at: "2026-07-09T12:00:00.000Z",
    updated_at: "2026-07-09T12:00:00.000Z",
    expires_at: "2026-07-09T13:00:00.000Z",
    ...overrides
  });
}
