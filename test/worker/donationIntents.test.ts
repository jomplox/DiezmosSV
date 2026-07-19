import { describe, expect, it } from "vitest";
import { validateDonorData } from "../../src/worker/services/donations";
import { INTENT_EXPIRY_SWEEP_LIMIT, Repository } from "../../src/worker/storage/repository";
import type { DonationIntentRecord } from "../../src/worker/types";
import { makeIntent } from "./fixtures";

const validDonorData = {
  donorDocumentType: "03",
  donorDocument: "P1234567",
  donorPhone: "70001122",
  departamento: "06",
  municipio: "23",
  distrito: "14",
  complemento: "Colonia Escalón"
};

function expectDonorValidationCode(body: Record<string, unknown>, code: string): void {
  try {
    validateDonorData(body);
    throw new Error("Expected donor validation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("donor data DTE schema boundaries", () => {
  it.each(["02", "03", "37"])("caps document type %s at the schema maximum of 20 characters", (donorDocumentType) => {
    expect(() => validateDonorData({ ...validDonorData, donorDocumentType, donorDocument: "A".repeat(20) })).not.toThrow();
    expectDonorValidationCode(
      { ...validDonorData, donorDocumentType, donorDocument: "A".repeat(21) },
      donorDocumentType === "37" ? "invalid_document" : "invalid_identity_document"
    );
  });

  it("accepts an absent phone or 8-30 characters and rejects values outside the schema range", () => {
    for (const donorPhone of [undefined, "1".repeat(8), "1".repeat(30)]) {
      expect(() => validateDonorData({ ...validDonorData, donorPhone })).not.toThrow();
    }
    for (const donorPhone of ["1".repeat(7), "1".repeat(31)]) {
      expectDonorValidationCode({ ...validDonorData, donorPhone }, "invalid_phone");
    }
  });
});

// Lightweight D1 fake: records every prepared SQL + bindings and serves rows from
// a seeded map, so we can assert the SQL shapes of the donation-intent methods
// without standing up the full InMemoryD1 fake (which Task 2 will extend).
class RecordingD1 {
  readonly calls: Array<{ sql: string; args: unknown[] }> = [];
  readonly intents = new Map<string, DonationIntentRecord>();
  intentDatosUpdateSucceeds = false;

  prepare(sql: string) {
    return new RecordingStatement(this, sql);
  }
}

class RecordingStatement {
  private args: unknown[] = [];
  constructor(private readonly db: RecordingD1, private readonly sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("RETURNING id")) {
      return (this.db.intentDatosUpdateSucceeds
        ? {
            id: String(this.args.at(-3)),
            wompi_url_enlace: "https://s.wompi.sv/987654",
            wompi_url_enlace_largo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc"
          }
        : null) as T | null;
    }
    if (this.sql.includes("FROM donation_intents WHERE id = ?")) {
      return (this.db.intents.get(String(this.args[0])) ?? null) as T | null;
    }
    return null;
  }

  async run(): Promise<Record<string, never>> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    return {};
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.db.calls.push({ sql: this.sql, args: this.args });
    return { results: [] };
  }
}

function repo(): { repository: Repository; db: RecordingD1 } {
  const db = new RecordingD1();
  return { repository: new Repository(db as unknown as D1Database), db };
}

describe("donation intents repository", () => {
  it("inserts a PENDING intent with an expiry and returns the created row", async () => {
    const { repository, db } = repo();
    db.intents.set("di_seed", seedIntent({ id: "di_seed" }));

    const created = await repository.createDonationIntent({
      id: "di_seed",
      amountCents: 2550,
      // Name and email are no longer collected on the form — they arrive on the
      // webhook from Wompi — so a non-NIT intent binds null for both.
      donorName: null,
      donorDocumentType: "13",
      donorDocument: "000000000",
      donorEmail: null,
      donorPhone: null,
      direccionDepartamento: "06",
      direccionMunicipio: "22",
      direccionDistrito: "01",
      direccionComplemento: "San Salvador",
      donorPais: null,
      giftType: null,
      clientIp: "203.0.113.9",
      expiresAt: "2026-07-05T13:00:00.000Z",
      datosTokenHash: null,
      rateLimitClaimId: "rate_seed"
    });

    expect(created.id).toBe("di_seed");
    const insert = db.calls.find((call) => call.sql.includes("INSERT INTO donation_intents"));
    expect(insert).toBeTruthy();
    // PENDING is the seeded status for a new intent (written as a SQL literal).
    expect(insert!.sql).toContain("'PENDING'");
    // The 0011 column set: donor_pais rides between the address and the client ip.
    expect(insert!.sql).toContain("donor_pais");
    // The 0012 column: gift_type is appended LAST so existing positional binds hold.
    expect(insert!.sql).toContain("gift_type");
    expect(insert!.args).toContain("2026-07-05T13:00:00.000Z");
    expect(insert!.args).toContain(2550);
    expect(insert!.args).toContain("203.0.113.9");
    // donor_name and donor_email are bound null (positions 3 and 6 of the VALUES list).
    expect(insert!.args[2]).toBeNull();
    expect(insert!.args[5]).toBeNull();
    // donor_pais is bound null for a domestic intent (position 12, after complemento).
    expect(insert!.args[11]).toBeNull();
    // The capability hash and admission provenance follow gift_type.
    expect(insert!.args[14]).toBeNull();
    expect(insert!.args[15]).toBeNull();
    expect(insert!.args[16]).toBe("rate_seed");
  });

  it("binds the razón social and país when the intent carries them (NIT / foreign path)", async () => {
    const { repository, db } = repo();
    db.intents.set("di_foreign", seedIntent({ id: "di_foreign" }));

    await repository.createDonationIntent({
      id: "di_foreign",
      amountCents: 5000,
      donorName: "Empresa Ejemplo, S.A. de C.V.",
      donorDocumentType: "36",
      donorDocument: "0614-280390-112-1",
      donorEmail: null,
      donorPhone: null,
      direccionDepartamento: "00",
      direccionMunicipio: "00",
      direccionDistrito: "00",
      direccionComplemento: "742 Evergreen Terrace, Springfield",
      donorPais: "US",
      giftType: "DIEZMO",
      clientIp: "203.0.113.9",
      expiresAt: "2026-07-05T13:00:00.000Z",
      datosTokenHash: "a".repeat(64),
      rateLimitClaimId: "rate_foreign"
    });

    const insert = db.calls.find((call) => call.sql.includes("INSERT INTO donation_intents"));
    expect(insert).toBeTruthy();
    expect(insert!.args).toContain("Empresa Ejemplo, S.A. de C.V.");
    expect(insert!.args).toContain("US");
    expect(insert!.args).toContain("0614-280390-112-1");
    // A chosen gift type is bound as the last INSERT arg.
    expect(insert!.args).toContain("DIEZMO");
    expect(insert!.args[14]).toBe("DIEZMO");
    expect(insert!.args[15]).toBe("a".repeat(64));
    expect(insert!.args[16]).toBe("rate_foreign");
  });

  it("consumes a datos capability with one guarded UPDATE RETURNING", async () => {
    const { repository, db } = repo();
    db.intentDatosUpdateSucceeds = true;

    const updated = await repository.applyIntentDatosWithCapability("di_1", "b".repeat(64), {
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorName: null,
      donorPhone: "70001122",
      direccionDepartamento: "06",
      direccionMunicipio: "23",
      direccionDistrito: "14",
      direccionComplemento: "Colonia Escalón",
      donorPais: null
    });

    expect(updated).toEqual({
      id: "di_1",
      urlEnlace: "https://s.wompi.sv/987654",
      urlEnlaceLargo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc"
    });
    const update = db.calls.find((call) => call.sql.includes("UPDATE donation_intents") && call.sql.includes("RETURNING id"));
    expect(update).toBeTruthy();
    expect(update!.sql).toContain("datos_token_hash = NULL");
    expect(update!.sql).toContain("datos_token_hash = ?");
    expect(update!.sql).toContain("status = 'LINK_CREATED'");
    expect(update!.sql).toContain("paid_at IS NULL");
    expect(update!.sql).toContain("donor_document IS NULL");
    expect(update!.sql).toContain("expires_at > ?");
    expect(update!.args).toContain("b".repeat(64));
  });

  it("reads a single intent by id", async () => {
    const { repository, db } = repo();
    db.intents.set("di_1", seedIntent({ id: "di_1" }));

    const found = await repository.getDonationIntent("di_1");
    expect(found?.id).toBe("di_1");
    expect(db.calls.at(-1)?.sql).toContain("FROM donation_intents WHERE id = ?");
  });

  it("attaches the Wompi link and flips status to LINK_CREATED", async () => {
    const { repository, db } = repo();

    await repository.attachIntentLink("di_1", {
      idEnlace: 987654,
      urlEnlace: "https://s.wompi.sv/987654",
      urlEnlaceLargo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc"
    });

    const update = db.calls.find((call) => call.sql.includes("UPDATE donation_intents") && call.sql.includes("wompi_id_enlace"));
    expect(update).toBeTruthy();
    expect(update!.sql).toContain("status = 'LINK_CREATED'");
    expect(update!.sql).toContain("wompi_url_enlace_largo");
    expect(update!.args).toContain(987654);
    expect(update!.args).toContain("https://s.wompi.sv/987654");
    expect(update!.args).toContain("https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc");
    expect(update!.args).toContain("di_1");
  });

  it("marks an intent COMPLETED and records the emitted document id", async () => {
    const { repository, db } = repo();

    await repository.markIntentCompleted("di_1", "dte_42");

    const update = db.calls.find((call) => call.sql.includes("UPDATE donation_intents") && call.sql.includes("status = 'COMPLETED'"));
    expect(update).toBeTruthy();
    // document_id links the intent to the CDE so the admin panel can show its numero de control.
    expect(update!.sql).toContain("document_id = ?");
    expect(update!.args).toContain("dte_42");
    expect(update!.args).toContain("di_1");
  });


  it("lists a bounded oldest-first page of expiring intents", async () => {
    const { repository, db } = repo();

    await repository.listIntentsExpiringBefore("2026-07-05T13:00:00.000Z");

    const select = db.calls.find((call) => call.sql.includes("SELECT id, wompi_id_enlace"));
    expect(select).toBeTruthy();
    // Oldest-first + LIMIT caps the snapshot so attacker-created intents cannot force
    // one cron invocation to read (and deactivate) an unbounded row set.
    expect(select!.sql).toContain("ORDER BY expires_at ASC, id ASC LIMIT ?");
    expect(select!.args).toEqual(["2026-07-05T13:00:00.000Z", INTENT_EXPIRY_SWEEP_LIMIT]);
  });

  it("expires only the bounded page of intent ids the sweep processed", async () => {
    const { repository, db } = repo();

    await repository.expireDonationIntentsByIds(["di_old", "di_older"], "2026-07-05T13:00:00.000Z");

    const update = db.calls.find((call) => call.sql.includes("UPDATE donation_intents") && call.sql.includes("id IN"));
    expect(update).toBeTruthy();
    expect(update!.sql).toContain("status IN ('PENDING','LINK_CREATED')");
    expect(update!.sql).toContain("id IN (?, ?)");
    expect(update!.args).toEqual(["2026-07-05T13:00:00.000Z", "di_old", "di_older"]);
  });

});

function seedIntent(overrides: Partial<DonationIntentRecord> = {}): DonationIntentRecord {
  return makeIntent({
    status: "PENDING",
    client_ip: "203.0.113.9",
    ...overrides
  });
}
