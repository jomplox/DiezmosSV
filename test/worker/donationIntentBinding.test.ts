import { describe, expect, it } from "vitest";
import { resolveDonationIntentBinding } from "../../src/worker/services/donationIntentBinding";
import type { DonationIntentRecord, WompiWebhook } from "../../src/worker/types";
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
  return {
    id: "di_bound",
    status: "LINK_CREATED",
    amount_cents: 2550,
    donor_name: null,
    donor_document_type: "13",
    donor_document: "10000001-9",
    donor_email: null,
    donor_phone: null,
    direccion_departamento: "06",
    direccion_municipio: "23",
    direccion_distrito: "14",
    direccion_complemento: "San Salvador",
    donor_pais: null,
    gift_type: "DIEZMO",
    wompi_id_enlace: 987654,
    wompi_url_enlace: null,
    wompi_url_enlace_largo: null,
    document_id: null,
    client_ip: null,
    datos_token_hash: null,
    paid_at: null,
    created_at: "2026-07-09T12:00:00.000Z",
    updated_at: "2026-07-09T12:00:00.000Z",
    expires_at: "2026-07-09T13:00:00.000Z",
    ...overrides
  };
}
