import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { sha256Hex, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

function seedAcceptedDonor(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body, headers_json
     ) VALUES ('wompi_ana', 'transaction_ana', '00', 'Exitosa', 2500, '{}', '{}')`
  ).run();
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control, status,
       plain_json, donor_email, donor_name, amount_cents, issued_at, accepted_at
     ) VALUES (
       'doc_ana', 'wompi_ana', '00', 'generation-ana', 'control-ana', 'ACCEPTED',
       ?, 'ana@example.org', 'Ana Pérez', 2500,
       '2026-07-01T18:00:00.000Z', '2026-07-01T18:00:00.000Z'
     )`
  ).run(JSON.stringify({
    receptor: {
      tipoDocumento: "13",
      numDocumento: "10000000-1",
      nombre: "Ana Pérez",
      correo: "ana@example.org",
      telefono: "7000-0000",
      codPais: "SV",
      direccion: {
        departamento: "06",
        municipio: "23",
        distrito: "01",
        complemento: "San Salvador"
      }
    }
  }));
  database.prepare(
    `INSERT INTO donation_intents (
       id, status, amount_cents, donor_document_type, donor_document,
       gift_type, document_id, created_at, updated_at, expires_at
     ) VALUES (
       'intent_ana', 'COMPLETED', 2500, '13', '10000000-1',
       'DIEZMO', 'doc_ana', '2026-07-01T18:00:00.000Z',
       '2026-07-01T18:00:00.000Z', '2030-01-01T00:00:00.000Z'
     )`
  ).run();
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
