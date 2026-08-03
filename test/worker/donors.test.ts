import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

interface SeedDocument {
  id: string;
  status?: "ACCEPTED" | "REJECTED" | "INVALIDATED";
  origin?: "WOMPI" | "MANUAL";
  documentType: string;
  documentNumber: string;
  name: string;
  email: string;
  phone?: string;
  amountCents: number;
  issuedAt: string;
  giftType?: "DIEZMO" | "OFRENDA";
}

function seedDocument(database: DatabaseSync, input: SeedDocument): void {
  const wompiEventId = input.origin === "WOMPI" ? `wompi_${input.id}` : null;
  if (wompiEventId) {
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body, headers_json
       ) VALUES (?, ?, '00', 'Exitosa', ?, '{}', '{}')`
    ).run(wompiEventId, `transaction_${input.id}`, input.amountCents);
  }

  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control, status,
       plain_json, donor_email, donor_name, amount_cents, issued_at, accepted_at
     ) VALUES (?, ?, '00', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    wompiEventId,
    `generation-${input.id}`,
    `control-${input.id}`,
    input.status ?? "ACCEPTED",
    JSON.stringify({
      receptor: {
        tipoDocumento: input.documentType,
        numDocumento: input.documentNumber,
        nombre: input.name,
        correo: input.email,
        telefono: input.phone ?? null,
        codPais: "SV",
        direccion: {
          departamento: "06",
          municipio: "23",
          distrito: "01",
          complemento: "San Salvador"
        }
      }
    }),
    input.email,
    input.name,
    input.amountCents,
    input.issuedAt,
    input.status === "ACCEPTED" || input.status === undefined ? input.issuedAt : null
  );

  if (wompiEventId) {
    database.prepare(
      `INSERT INTO donation_intents (
         id, status, amount_cents, donor_document_type, donor_document,
         gift_type, document_id, created_at, updated_at, expires_at
       ) VALUES (?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `intent_${input.id}`,
      input.amountCents,
      input.documentType,
      input.documentNumber,
      input.giftType ?? null,
      input.id,
      input.issuedAt,
      input.issuedAt,
      "2030-01-01T00:00:00.000Z"
    );
  }
}

describe("donor explorer repository", () => {
  it("groups accepted CDEs by legal identity and excludes rejected documents", async () => {
    const database = migratedDatabase();
    seedDocument(database, {
      id: "ana-online",
      origin: "WOMPI",
      documentType: "13",
      documentNumber: "10000000-1",
      name: "Ana Pérez",
      email: "ana@example.org",
      phone: "7000-0000",
      amountCents: 2_500,
      issuedAt: "2026-06-01T18:00:00.000Z",
      giftType: "DIEZMO"
    });
    seedDocument(database, {
      id: "ana-manual",
      origin: "MANUAL",
      documentType: "13",
      documentNumber: "100000001",
      name: "Ana Pérez",
      email: "ana@example.org",
      phone: "7000-0000",
      amountCents: 1_250,
      issuedAt: "2026-07-01T18:00:00.000Z"
    });
    seedDocument(database, {
      id: "ana-rejected",
      status: "REJECTED",
      origin: "MANUAL",
      documentType: "13",
      documentNumber: "100000001",
      name: "Ana Pérez",
      email: "ana@example.org",
      amountCents: 99_900,
      issuedAt: "2026-07-02T18:00:00.000Z"
    });
    seedDocument(database, {
      id: "beto",
      origin: "MANUAL",
      documentType: "03",
      documentNumber: "P-1234",
      name: "Beto Ruiz",
      email: "beto@example.org",
      amountCents: 2_000,
      issuedAt: "2026-05-01T18:00:00.000Z"
    });

    const result = await new Repository(sqliteD1(database)).listDonors({
      environment: "00",
      limit: 25,
      offset: 0
    });

    expect(result.total).toBe(2);
    expect(result.donors[0]).toMatchObject({
      documentType: "13",
      documentNumber: "100000001",
      name: "Ana Pérez",
      email: "ana@example.org",
      phone: "7000-0000",
      department: "06",
      municipality: "23",
      district: "01",
      country: "SV",
      firstGiftAt: "2026-06-01T18:00:00.000Z",
      lastGiftAt: "2026-07-01T18:00:00.000Z",
      giftCount: 2,
      totalCents: 3_750,
      preferredGiftType: "DIEZMO",
      source: "MIXED"
    });
    expect(result.donors.map((donor) => donor.name)).toEqual(["Ana Pérez", "Beto Ruiz"]);
  });

  it("filters grouped donors by identity, contact, total, gift type, and source", async () => {
    const database = migratedDatabase();
    seedDocument(database, {
      id: "ana-online",
      origin: "WOMPI",
      documentType: "13",
      documentNumber: "10000000-1",
      name: "Ana Pérez",
      email: "ana@example.org",
      amountCents: 2_500,
      issuedAt: "2026-06-01T18:00:00.000Z",
      giftType: "DIEZMO"
    });
    seedDocument(database, {
      id: "ana-manual",
      origin: "MANUAL",
      documentType: "13",
      documentNumber: "100000001",
      name: "Ana Pérez",
      email: "ana@example.org",
      amountCents: 1_250,
      issuedAt: "2026-07-01T18:00:00.000Z"
    });
    seedDocument(database, {
      id: "beto",
      origin: "MANUAL",
      documentType: "03",
      documentNumber: "P-1234",
      name: "Beto Ruiz",
      email: "beto@example.org",
      amountCents: 2_000,
      issuedAt: "2026-05-01T18:00:00.000Z"
    });
    seedDocument(database, {
      id: "caro",
      origin: "WOMPI",
      documentType: "36",
      documentNumber: "0614-010101-101-1",
      name: "Carolina Soto",
      email: "carolina@example.org",
      amountCents: 10_000,
      issuedAt: "2026-04-01T18:00:00.000Z",
      giftType: "OFRENDA"
    });
    const repository = new Repository(sqliteD1(database));
    const list = (filters: Record<string, unknown>) =>
      repository.listDonors({
        environment: "00",
        limit: 25,
        offset: 0,
        ...filters
      });

    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ documentType: "13" }, ["Ana Pérez"]],
      [{ documentValue: "00000" }, ["Ana Pérez"]],
      [{ name: "ana" }, ["Ana Pérez"]],
      [{ email: "BETO@EXAMPLE.ORG" }, ["Beto Ruiz"]],
      [{ minTotalCents: 4_000 }, ["Carolina Soto"]],
      [{ maxTotalCents: 4_000 }, ["Ana Pérez", "Beto Ruiz"]],
      [{ giftType: "DIEZMO" }, ["Ana Pérez"]],
      [{ giftType: "OFRENDA" }, ["Carolina Soto"]],
      [{ source: "WOMPI" }, ["Ana Pérez", "Carolina Soto"]],
      [{ source: "MANUAL" }, ["Ana Pérez", "Beto Ruiz"]]
    ];

    for (const [filters, expectedNames] of cases) {
      const result = await list(filters);
      expect(result.donors.map((donor) => donor.name).sort()).toEqual(expectedNames.sort());
    }

    const page = await repository.listDonors({
      environment: "00",
      limit: 1,
      offset: 1
    });
    expect(page).toMatchObject({
      total: 3,
      limit: 1,
      offset: 1,
      hasMore: true
    });
    expect(page.donors).toHaveLength(1);

    const beyondLastPage = await repository.listDonors({
      environment: "00",
      limit: 1,
      offset: 3
    });
    expect(beyondLastPage).toEqual({
      donors: [],
      total: 3,
      limit: 1,
      offset: 3,
      hasMore: false
    });
  });
});
