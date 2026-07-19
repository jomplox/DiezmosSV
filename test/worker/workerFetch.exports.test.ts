import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import type { DteDocumentRecord } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("F960 CSV export", () => {
  it("returns accepted CDEs for a date range in the real F960 semicolon format", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument(),
      {
        ...testDocument(),
        id: "doc_may",
        codigo_generacion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000008",
        issued_at: "2026-05-31T23:30:00.000Z",
        accepted_at: "2026-05-31T23:31:00.000Z",
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: { nombre: "Outside Range", correo: "outside@example.org", tipoDocumento: "13", numDocumento: "100000043" },
          resumen: { valorTotal: 50 },
          identificacion: { fecEmi: "2026-05-31", horEmi: "17:30:00", codigoGeneracion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B" }
        })
      },
      {
        ...testDocument(),
        id: "doc_failed",
        codigo_generacion: "0E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000010",
        status: "FAILED",
        sello_recibido: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-20260601-20260630.csv"');
    await expect(response.text()).resolves.toBe(
      "1;;Example Person;9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;100000001;062026\r\n"
    );
  });

  it("neutralizes spreadsheet formulas in donor-controlled CSV fields", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument({
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: {
            nombre: '=HYPERLINK("https://evil.example",A1)',
            correo: "donor@example.org",
            tipoDocumento: "13",
            numDocumento: "@PAYLOAD"
          },
          resumen: { valorTotal: 100 },
          identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
        })
      })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    // The =HYPERLINK name gets a leading apostrophe (then quoted for the embedded "),
    // the @PAYLOAD document gets one too; benign numeric/hex fields stay bare.
    await expect(response.text()).resolves.toBe(
      `1;;"'=HYPERLINK(""https://evil.example"",A1)";9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;'@PAYLOAD;062026\r\n`
    );
  });

  it("returns preview rows for the selected date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rowCount: 1,
      amountTotal: "100.00",
      rows: [
        {
          nit: "",
          nombre: "Example Person",
          codigoActividad: "9300",
          tipoDonacion: "4",
          sello: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
          codigoGeneracion: "6CAE5F7EA59045738EF2FE48B14796C4",
          monto: "100.00",
          dui: "100000001",
          periodo: "062026"
        }
      ]
    });
  });

  it("returns an Excel inspection workbook with headers for the selected rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.xlsx?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-inspeccion-20260601-20260630.xlsx"');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
    const workbookText = new TextDecoder().decode(bytes);
    expect(workbookText).toContain("Nombre donante");
    expect(workbookText).toContain("Example Person");
    expect(workbookText).toContain("Código generación");
    expect(workbookText).toContain("Aceptado");
  });

  it("requires an admin role", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("CRM contacts export", () => {
  function seedWompiDonor(
    db: InMemoryD1,
    document: Partial<DteDocumentRecord>,
    intent?: Record<string, unknown>
  ): void {
    const doc = testDocument({ wompi_event_id: `wompi_${document.id}`, ...document });
    db.documents.push(doc);
    if (intent) {
      db.donationIntents.push({
        id: `intent_${doc.id}`,
        status: "COMPLETED",
        document_id: doc.id,
        created_at: doc.issued_at,
        donor_phone: null,
        direccion_complemento: null,
        direccion_departamento: null,
        donor_pais: null,
        gift_type: null,
        ...intent
      });
    }
  }

  it("returns a BOM-prefixed CSV of unique Wompi-lane donors for the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      {
        id: "doc_ana",
        environment: "01",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 5000,
        issued_at: "2026-02-01T18:00:00.000Z"
      },
      {
        donor_phone: "70000001",
        direccion_complemento: "Calle Nueva",
        direccion_departamento: "06",
        gift_type: "DIEZMO"
      }
    );
    // Excluded: production filter (this doc is ambiente 00).
    seedWompiDonor(db, {
      id: "doc_other_env",
      environment: "00",
      donor_email: "test@example.org",
      donor_name: "Test",
      issued_at: "2026-02-02T18:00:00.000Z"
    });
    // Excluded: not a Wompi-lane document (no wompi_event_id).
    seedWompiDonor(db, {
      id: "doc_manual",
      environment: "01",
      wompi_event_id: null,
      donor_email: "manual@example.org",
      donor_name: "Manual",
      issued_at: "2026-02-03T18:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="contactos-donantes-01-1.csv"');
    // Response.text() strips a leading BOM per spec, so assert the BOM on raw bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("nombre,correo,telefono,direccion,departamento,pais,primera_donacion,ultima_donacion,total_donado_usd,numero_donaciones,tipo_preferido");
    expect(rows[1]).toBe("Ana,ana@example.org,70000001,Calle Nueva,San Salvador,El Salvador,2026-02-01,2026-02-01,50.00,1,Diezmo");
    // Only the single ambiente-01 Wompi-lane donor.
    expect(rows.filter((row) => row.length > 0)).toHaveLength(2);
  });

  it("records a CONTACTS_EXPORTED audit with the count and environment but no PII", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "CONTACTS_EXPORTED");
    expect(audit).toBeDefined();
    expect(audit!.entity_type).toBe("export");
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({ environment: "01", contacts: 1 });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("ana@example.org");
    expect(serialized).not.toContain("70000001");
    expect(serialized).not.toContain("Ana");
  });

  it("rejects a missing or invalid environment", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_export_environment" });
  });

  it("requires an admin role (viewer and operator are rejected)", async () => {
    for (const role of ["VIEWER", "OPERATOR"]) {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_x", email: "x@example.org", name: "X", role };

      const response = await worker.fetch(
        new Request("https://example.org/api/exports/contacts?environment=01", {
          headers: { Authorization: "Bearer test-token" }
        }),
        env(db)
      );

      expect(response.status).toBe(403);
    }
  });

  it("restricts the export to a from/to date window (El Salvador local, inclusive)", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Before the window (2024) and inside the window (2025-06).
    seedWompiDonor(
      db,
      { id: "doc_old", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 1000, issued_at: "2024-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_in", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2025-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-01-01&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    // Header + one donor; the 2025 donation is the only one counted (total 50.00).
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("50.00");
    expect(rows[1]).not.toContain("60.00");
  });

  it("filters counted donations by giftType and drops donors with none", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_diez", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 3000, issued_at: "2026-02-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_ofr", environment: "01", donor_email: "beto@example.org", donor_name: "Beto", amount_cents: 4000, issued_at: "2026-02-02T18:00:00.000Z" },
      { gift_type: "OFRENDA" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&giftType=DIEZMO", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Ana");
    expect(csv).not.toContain("Beto");
  });

  it("emits only the requested columns and rejects an unknown column name with 400 Spanish", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    const ok = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,correo", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(ok.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await ok.arrayBuffer())).replace(/^﻿/, "");
    expect(csv.split("\r\n")[0]).toBe("nombre,correo");

    const bad = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,inventada", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_export_columns");
    expect(body.message).toContain("inventada");
  });

  it("rejects a malformed or inverted date range with 400", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const inverted = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-12-31&to=2025-01-01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(inverted.status).toBe(400);
    await expect(inverted.json()).resolves.toMatchObject({ error: "invalid_export_range" });

    const malformed = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-1-1&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(malformed.status).toBe(400);
  });
});
