import { describe, expect, it } from "vitest";
import {
  aggregateDonorContacts,
  buildContactsCsv,
  contactsCsvFilename,
  CONTACT_CSV_HEADERS,
  type ContactSourceRow
} from "../../src/worker/services/contacts";
import { Repository } from "../../src/worker/storage/repository";

describe("aggregateDonorContacts", () => {
  it("groups Wompi-lane donations per donor by lowercased email, sums dollars, counts docs, and enriches from the most recent intent", async () => {
    const db = new FakeContactsDb([
      row({
        id: "d1",
        donorEmail: "Ana@Example.org",
        donorName: "Ana",
        amountCents: 2500,
        issuedAt: "2026-02-01T18:00:00.000Z",
        donorPhone: "70000001",
        direccionComplemento: "Calle Vieja",
        direccionDepartamento: "06",
        donorPais: null,
        giftType: "DIEZMO",
        intentCreatedAt: "2026-02-01T18:00:00.000Z"
      }),
      row({
        id: "d2",
        donorEmail: "ana@example.org",
        donorName: "Ana Lopez",
        amountCents: 7501,
        issuedAt: "2026-05-10T18:00:00.000Z",
        donorPhone: "70000002",
        direccionComplemento: "Calle Nueva",
        direccionDepartamento: "05",
        donorPais: null,
        giftType: "DIEZMO",
        intentCreatedAt: "2026-05-10T18:00:00.000Z"
      })
    ]);

    const contacts = await aggregateDonorContacts(new Repository(db as unknown as D1Database), "01");

    expect(contacts).toHaveLength(1);
    const ana = contacts[0];
    expect(ana.correo).toBe("ana@example.org");
    expect(ana.nombre).toBe("Ana");
    expect(ana.numeroDonaciones).toBe(2);
    expect(ana.totalDonadoUsd).toBe("100.01");
    // Enrichment from the MOST RECENT intent (2026-05-10):
    expect(ana.telefono).toBe("70000002");
    expect(ana.direccion).toBe("Calle Nueva");
    expect(ana.departamento).toBe("La Libertad");
    expect(ana.pais).toBe("El Salvador");
    // Local-time (UTC-6) YYYY-MM-DD span:
    expect(ana.primeraDonacion).toBe("2026-02-01");
    expect(ana.ultimaDonacion).toBe("2026-05-10");
    expect(ana.tipoPreferido).toBe("Diezmo");
  });

  it("falls back to donor_name identity when email is missing, blanks enrichment without an intent", async () => {
    const db = new FakeContactsDb([
      row({
        id: "n1",
        donorEmail: null,
        donorName: "Sin Correo",
        amountCents: 500,
        issuedAt: "2026-03-01T18:00:00.000Z",
        intentCreatedAt: null
      })
    ]);

    const contacts = await aggregateDonorContacts(new Repository(db as unknown as D1Database), "01");

    expect(contacts).toHaveLength(1);
    expect(contacts[0].nombre).toBe("Sin Correo");
    expect(contacts[0].correo).toBe("");
    // No correlated intent: phone/address/departamento and país all blank.
    expect(contacts[0].telefono).toBe("");
    expect(contacts[0].direccion).toBe("");
    expect(contacts[0].departamento).toBe("");
    expect(contacts[0].pais).toBe("");
    expect(contacts[0].tipoPreferido).toBe("");
  });

  it("labels the foreign path as Extranjero with its CAT-020 country", async () => {
    const db = new FakeContactsDb([
      row({
        id: "f1",
        donorEmail: "usa@example.org",
        donorName: "US Donor",
        amountCents: 10000,
        issuedAt: "2026-04-01T18:00:00.000Z",
        direccionDepartamento: "00",
        donorPais: "US",
        intentCreatedAt: "2026-04-01T18:00:00.000Z"
      })
    ]);

    const contacts = await aggregateDonorContacts(new Repository(db as unknown as D1Database), "01");

    expect(contacts[0].departamento).toBe("Extranjero");
    expect(contacts[0].pais).toBe("Estados Unidos");
  });

  it("picks tipo_preferido by majority and blanks a tie", async () => {
    const tie = new FakeContactsDb([
      row({ id: "t1", donorEmail: "tie@example.org", donorName: "Tie", amountCents: 100, issuedAt: "2026-01-01T18:00:00.000Z", giftType: "DIEZMO", intentCreatedAt: "2026-01-01T18:00:00.000Z" }),
      row({ id: "t2", donorEmail: "tie@example.org", donorName: "Tie", amountCents: 100, issuedAt: "2026-01-02T18:00:00.000Z", giftType: "OFRENDA", intentCreatedAt: "2026-01-02T18:00:00.000Z" })
    ]);
    const majority = new FakeContactsDb([
      row({ id: "m1", donorEmail: "maj@example.org", donorName: "Maj", amountCents: 100, issuedAt: "2026-01-01T18:00:00.000Z", giftType: "OFRENDA", intentCreatedAt: "2026-01-01T18:00:00.000Z" }),
      row({ id: "m2", donorEmail: "maj@example.org", donorName: "Maj", amountCents: 100, issuedAt: "2026-01-02T18:00:00.000Z", giftType: "OFRENDA", intentCreatedAt: "2026-01-02T18:00:00.000Z" }),
      row({ id: "m3", donorEmail: "maj@example.org", donorName: "Maj", amountCents: 100, issuedAt: "2026-01-03T18:00:00.000Z", giftType: "DIEZMO", intentCreatedAt: "2026-01-03T18:00:00.000Z" })
    ]);

    const tieContacts = await aggregateDonorContacts(new Repository(tie as unknown as D1Database), "01");
    const majorityContacts = await aggregateDonorContacts(new Repository(majority as unknown as D1Database), "01");

    expect(tieContacts[0].tipoPreferido).toBe("");
    expect(majorityContacts[0].tipoPreferido).toBe("Ofrenda");
  });

  it("sorts contacts by nombre", async () => {
    const db = new FakeContactsDb([
      row({ id: "z", donorEmail: "z@example.org", donorName: "Zoe", amountCents: 100, issuedAt: "2026-01-01T18:00:00.000Z", intentCreatedAt: "2026-01-01T18:00:00.000Z" }),
      row({ id: "a", donorEmail: "a@example.org", donorName: "Abel", amountCents: 100, issuedAt: "2026-01-01T18:00:00.000Z", intentCreatedAt: "2026-01-01T18:00:00.000Z" })
    ]);

    const contacts = await aggregateDonorContacts(new Repository(db as unknown as D1Database), "01");

    expect(contacts.map((contact) => contact.nombre)).toEqual(["Abel", "Zoe"]);
  });
});

describe("buildContactsCsv", () => {
  it("prefixes a UTF-8 BOM, emits the Spanish headers, uses CRLF, and escapes fields", async () => {
    const db = new FakeContactsDb([
      row({
        id: "d1",
        donorEmail: "quote@example.org",
        donorName: 'Ana "La" Vega',
        amountCents: 12345,
        issuedAt: "2026-02-01T18:00:00.000Z",
        donorPhone: "70000001",
        direccionComplemento: "Calle 1, Casa 2",
        direccionDepartamento: "06",
        giftType: "DIEZMO",
        intentCreatedAt: "2026-02-01T18:00:00.000Z"
      })
    ]);
    const contacts = await aggregateDonorContacts(new Repository(db as unknown as D1Database), "01");

    const csv = buildContactsCsv(contacts);

    expect(csv.startsWith("﻿")).toBe(true);
    const [header, firstRow] = csv.slice(1).split("\r\n");
    expect(header).toBe(CONTACT_CSV_HEADERS.join(","));
    // Quote in name and comma in address force quoting; the embedded quote is doubled.
    expect(firstRow).toContain('"Ana ""La"" Vega"');
    expect(firstRow).toContain('"Calle 1, Casa 2"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("names the file with the environment and count", () => {
    expect(contactsCsvFilename("01", 42)).toBe("contactos-donantes-01-42.csv");
    expect(contactsCsvFilename("00", 0)).toBe("contactos-donantes-00-0.csv");
  });
});

function row(overrides: Partial<ContactSourceRow> & Pick<ContactSourceRow, "id" | "issuedAt" | "amountCents">): ContactSourceRow {
  return {
    donorEmail: null,
    donorName: null,
    donorPhone: null,
    direccionComplemento: null,
    direccionDepartamento: null,
    donorPais: null,
    giftType: null,
    intentCreatedAt: null,
    ...overrides
  };
}

// Minimal D1 fake that only answers the keyset-paged Wompi-lane contacts query,
// returning the raw snake_case join columns the repository maps.
class FakeContactsDb {
  constructor(private readonly rows: ContactSourceRow[]) {}

  prepare(sql: string) {
    const rows = this.rows;
    let args: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        args = bound;
        return this;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (!sql.includes("FROM dte_documents") || !sql.includes("LEFT JOIN donation_intents")) {
          return { results: [] };
        }
        let filtered = [...rows];
        if (sql.includes("(dte_documents.issued_at, dte_documents.id) > (?, ?)")) {
          const [afterIssued, afterId] = [String(args[2]), String(args[3])];
          filtered = filtered.filter(
            (candidate) => candidate.issuedAt > afterIssued || (candidate.issuedAt === afterIssued && candidate.id > afterId)
          );
        }
        filtered.sort((left, right) => left.issuedAt.localeCompare(right.issuedAt) || left.id.localeCompare(right.id));
        const limit = Number(args.at(-1) ?? 500);
        const mapped = filtered.slice(0, limit).map((candidate) => ({
          id: candidate.id,
          donor_email: candidate.donorEmail,
          donor_name: candidate.donorName,
          amount_cents: candidate.amountCents,
          issued_at: candidate.issuedAt,
          intent_donor_phone: candidate.donorPhone,
          intent_direccion_complemento: candidate.direccionComplemento,
          intent_direccion_departamento: candidate.direccionDepartamento,
          intent_donor_pais: candidate.donorPais,
          intent_gift_type: candidate.giftType,
          intent_created_at: candidate.intentCreatedAt
        }));
        return { results: mapped as T[] };
      }
    };
  }
}
