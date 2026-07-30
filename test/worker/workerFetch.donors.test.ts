import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { sha256Hex, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

interface SeedAcceptedDonorInput {
  id?: string;
  name?: string;
  email?: string;
  documentNumber?: string;
  amountCents?: number;
  issuedAt?: string;
}

function seedAcceptedDonor(
  database: DatabaseSync,
  input: SeedAcceptedDonorInput = {}
): void {
  const id = input.id ?? "ana";
  const name = input.name ?? "Ana Pérez";
  const email = input.email ?? "ana@example.org";
  const documentNumber = input.documentNumber ?? "10000000-1";
  const amountCents = input.amountCents ?? 2500;
  const issuedAt = input.issuedAt ?? "2026-07-01T18:00:00.000Z";
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body, headers_json
     ) VALUES (?, ?, '00', 'Exitosa', ?, '{}', '{}')`
  ).run(`wompi_${id}`, `transaction_${id}`, amountCents);
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control, status,
       plain_json, donor_email, donor_name, amount_cents, issued_at, accepted_at
     ) VALUES (
       ?, ?, '00', ?, ?, 'ACCEPTED',
       ?, ?, ?, ?,
       ?, ?
     )`
  ).run(
    `doc_${id}`,
    `wompi_${id}`,
    `generation-${id}`,
    `control-${id}`,
    JSON.stringify({
      receptor: {
        tipoDocumento: "13",
        numDocumento: documentNumber,
        nombre: name,
        correo: email,
        telefono: "7000-0000",
        codPais: "SV",
        direccion: {
          departamento: "06",
          municipio: "23",
          distrito: "01",
          complemento: "San Salvador"
        }
      }
    }),
    email,
    name,
    amountCents,
    issuedAt,
    issuedAt
  );
  database.prepare(
    `INSERT INTO donation_intents (
       id, status, amount_cents, donor_document_type, donor_document,
       gift_type, document_id, created_at, updated_at, expires_at
     ) VALUES (
       ?, 'COMPLETED', ?, '13', ?,
       'DIEZMO', ?, ?,
       ?, '2030-01-01T00:00:00.000Z'
     )`
  ).run(
    `intent_${id}`,
    amountCents,
    documentNumber,
    `doc_${id}`,
    issuedAt,
    issuedAt
  );
}

async function seedSession(
  database: DatabaseSync,
  input: { id: string; role: "OPERATOR" | "ADMIN"; token: string }
): Promise<void> {
  database.prepare(
    `INSERT INTO users (
       id, email, name, role, password_hash, password_salt
     ) VALUES (?, ?, ?, ?, 'hash', 'salt')`
  ).run(input.id, `${input.id}@example.org`, input.id, input.role);
  database.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, '2030-01-01T00:00:00.000Z')`
  ).run(`session_${input.id}`, input.id, await sha256Hex(utf8Bytes(input.token)));
}

describe("GET /api/donors", () => {
  it("returns filtered donor summaries to administrators and denies operators", async () => {
    const database = migratedDatabase();
    seedAcceptedDonor(database);
    await seedSession(database, { id: "admin", role: "ADMIN", token: "admin-token" });
    await seedSession(database, { id: "limited", role: "OPERATOR", token: "operator-token" });
    const workerEnv = { ...env(new InMemoryD1()), DB: sqliteD1(database) };
    const url = new URL("https://example.org/api/donors");
    url.search = new URLSearchParams({
      environment: "00",
      documentType: "13",
      documentValue: "0000000",
      name: "ana",
      email: "ana@example.org",
      minTotalCents: "2000",
      maxTotalCents: "3000",
      giftType: "DIEZMO",
      source: "WOMPI",
      limit: "25",
      offset: "0"
    }).toString();

    const adminResponse = await worker.fetch(
      new Request(url, { headers: { Authorization: "Bearer admin-token" } }),
      workerEnv
    );
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      total: 1,
      limit: 25,
      offset: 0,
      hasMore: false,
      donors: [
        {
          name: "Ana Pérez",
          documentType: "13",
          documentNumber: "10000000-1",
          totalCents: 2500
        }
      ]
    });

    const operatorResponse = await worker.fetch(
      new Request(url, { headers: { Authorization: "Bearer operator-token" } }),
      workerEnv
    );
    expect(operatorResponse.status).toBe(403);
  });

  it("rejects malformed filters before querying donor PII", async () => {
    const database = migratedDatabase();
    await seedSession(database, { id: "admin", role: "ADMIN", token: "admin-token" });
    const workerEnv = { ...env(new InMemoryD1()), DB: sqliteD1(database) };
    const invalidQueries: Array<Record<string, string>> = [
      { environment: "00", documentType: "99" },
      { environment: "00", minTotalCents: "-1" },
      { environment: "00", minTotalCents: "3000", maxTotalCents: "2000" },
      { environment: "00", giftType: "OTRO" },
      { environment: "00", source: "UNKNOWN" },
      { environment: "00", limit: "0" },
      { environment: "00", limit: "101" },
      { environment: "00", offset: "-1" }
    ];

    for (const query of invalidQueries) {
      const response = await worker.fetch(
        new Request(`https://example.org/api/donors?${new URLSearchParams(query)}`, {
          headers: { Authorization: "Bearer admin-token" }
        }),
        workerEnv
      );
      expect(response.status, JSON.stringify(query)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_donor_filters"
      });
    }
  });
});

describe("GET /api/exports/donors.csv", () => {
  it("downloads every filtered donor row and records a PII-free audit", async () => {
    const database = migratedDatabase();
    seedAcceptedDonor(database);
    seedAcceptedDonor(database, {
      id: "beto",
      name: "Beto Ruiz",
      email: "beto@example.org",
      documentNumber: "10000004-3",
      amountCents: 4000,
      issuedAt: "2026-07-02T18:00:00.000Z"
    });
    await seedSession(database, { id: "admin", role: "ADMIN", token: "admin-token" });
    const workerEnv = { ...env(new InMemoryD1()), DB: sqliteD1(database) };
    const params = new URLSearchParams({
      environment: "00",
      documentType: "13",
      name: "ana",
      minTotalCents: "2000",
      maxTotalCents: "3000",
      giftType: "DIEZMO",
      source: "WOMPI"
    });

    const response = await worker.fetch(
      new Request(`https://example.org/api/exports/donors.csv?${params}`, {
        headers: { Authorization: "Bearer admin-token" }
      }),
      workerEnv
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="donantes-00-1.csv"'
    );
    const csv = new TextDecoder("utf-8")
      .decode(new Uint8Array(await response.arrayBuffer()))
      .replace(/^\uFEFF/, "");
    expect(csv).toContain(
      "tipo_documento,numero_documento,nombre,correo,telefono,direccion,departamento,pais"
    );
    expect(csv).toContain("DUI,10000000-1,Ana Pérez,ana@example.org");
    expect(csv).not.toContain("Beto Ruiz");

    const audit = database.prepare(
      `SELECT action, summary, metadata_json
         FROM audit_logs
        WHERE action = 'DONORS_EXPORTED'`
    ).get() as { action: string; summary: string; metadata_json: string } | undefined;
    expect(audit?.action).toBe("DONORS_EXPORTED");
    expect(audit?.summary).toBe("1 donante exportado (ambiente 00)");
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      environment: "00",
      donors: 1,
      filters: {
        documentType: "13",
        giftType: "DIEZMO",
        hasName: true,
        maxTotalCents: 3000,
        minTotalCents: 2000,
        source: "WOMPI"
      }
    });
    expect(audit!.metadata_json).not.toContain("Ana");
    expect(audit!.metadata_json).not.toContain("ana@example.org");
  });

  it("rejects invalid filters and non-admin users", async () => {
    const database = migratedDatabase();
    await seedSession(database, { id: "admin", role: "ADMIN", token: "admin-token" });
    await seedSession(database, { id: "limited", role: "OPERATOR", token: "operator-token" });
    const workerEnv = { ...env(new InMemoryD1()), DB: sqliteD1(database) };

    const invalid = await worker.fetch(
      new Request("https://example.org/api/exports/donors.csv?environment=00&documentType=99", {
        headers: { Authorization: "Bearer admin-token" }
      }),
      workerEnv
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: "invalid_donor_filters"
    });

    const forbidden = await worker.fetch(
      new Request("https://example.org/api/exports/donors.csv?environment=00", {
        headers: { Authorization: "Bearer operator-token" }
      }),
      workerEnv
    );
    expect(forbidden.status).toBe(403);
  });
});
