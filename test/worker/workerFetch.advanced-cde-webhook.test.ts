import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import { TEST_RESEND_REQUEST_ID } from "./support/documentDeliveryFixtures";
import {
  advancedCdeDraft,
  emisorConfig,
  generatedCertificateXml
} from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

async function signWompiBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)));
  return hexFromBytes(digest);
}


describe("advanced CDE generation", () => {
  it.each([
    ["production", "/api/test/dte"],
    ["production", "/api/test/dte/advanced-template"],
    ["production", "/api/test/dte/advanced"],
    ["preview", "/api/test/dte"],
    ["preview", "/api/test/dte/advanced-template"],
    ["preview", "/api/test/dte/advanced"]
  ])("blocks direct generation in %s at %s before creating or queueing a DTE", async (appEnv, path) => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request(`https://example.org${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, { APP_ENV: appEnv, ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "test_generation_disabled_in_production" });
    expect(db.documents).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("locks emission settings to the deployment's allowed ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const request = (method: "GET" | "PUT", environment?: "00" | "01") =>
      new Request("https://example.org/api/settings/emission-environment", {
        method,
        headers: { Authorization: "Bearer test-token", ...(environment ? { "Content-Type": "application/json" } : {}) },
        body: environment ? JSON.stringify({ environment }) : undefined
      });

    const state = await worker.fetch(request("GET"), env(db, { APP_ENV: "staging" }));
    const stagingRejected = await worker.fetch(request("PUT", "01"), env(db, { APP_ENV: "staging" }));
    const productionRejected = await worker.fetch(request("PUT", "00"), env(db, { APP_ENV: "production" }));

    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toEqual({
      emissionEnvironment: {
        environment: "00",
        source: "deployment_default",
        appEnv: "staging",
        locked: true,
        allowedEnvironments: ["00"]
      }
    });
    expect(stagingRejected.status).toBe(409);
    expect(productionRejected.status).toBe(409);
    expect(db.settings.find((row) => row.key === "emission_environment")).toBeUndefined();
    expect(db.audits.find((row) => row.action === "EMISSION_ENVIRONMENT_UPDATED")).toBeUndefined();
  });

  it("creates a staging quick DTE in 00 despite a stale incompatible setting", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const settingsResponse = await worker.fetch(
      new Request("https://example.org/api/settings/emission-environment", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "01" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(settingsResponse.status).toBe(409);
    db.settings.push({ key: "emission_environment", value: "01", updated_by: "legacy", updated_at: "2026-07-01T00:00:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "1.00",
          donorName: "Example Person",
          donorDocument: "100000001",
          donorEmail: "donor@example.org",
          donorPhone: "70000005"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({ ambiente: "00", tipoDte: "15" });
    expect(generated.receptor.nombre).toBe("Example Person");
    expect(generated.otrosDocumentos[0]).toMatchObject({
      descDocumento: "Generación directa",
      detalleDocumento: "Donación offline"
    });
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 100,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("records smoke provenance only for a valid staging admin run ID", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const create = async (appEnv: string, smokeRunId: string) => {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      const response = await worker.fetch(
        new Request("https://example.org/api/test/dte", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: "1.00",
            donorName: "Staging Smoke",
            donorDocument: "100000001",
            donorEmail: "smoke@example.org",
            donorPhone: "70000005",
            smokeRunId
          })
        }),
        env(db, {
          APP_ENV: appEnv,
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
        })
      );
      return { db, response };
    };

    const staging = await create("staging", runId);
    expect(staging.response.status).toBe(202);
    expect(staging.db.audits).toContainEqual(expect.objectContaining({
      action: "STAGING_SMOKE_RUN",
      entity_type: "dte_document",
      entity_id: staging.db.documents[0].id,
      metadata_json: JSON.stringify({
        runId,
        path: "admin",
        source: "staging-smoke"
      })
    }));

    const invalid = await create("staging", "not-a-uuid");
    expect(invalid.response.status).toBe(202);
    expect(invalid.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);

    const local = await create("local", runId);
    expect(local.response.status).toBe(202);
    expect(local.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);
  });

  it("accepts a quick DTE donor document type outside DUI and NIT", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "offline@example.org"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.receptor).toMatchObject({
      tipoDocumento: "37",
      numDocumento: "RECIBO-123",
      nombre: "Donante Offline"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("rejects malformed donor email on quick DTE creation", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "correo-invalido"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_donor_email", message: "Ingrese un correo válido" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toEqual([]);
  });

  it("opens the advanced template with a default amount when quick amount is blank", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "Example Person", donorDocumentType: "03", donorDocument: "A1234567" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string }; resumen: { valorTotal: number } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "03", numDocumento: "A1234567" });
    expect(body.draft.resumen.valorTotal).toBe(1);
  });

  it("opens the advanced template with empty donor fields so the wizard can collect them", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string; nombre: string } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "13", numDocumento: "", nombre: "" });
  });

  it("stores a schema-valid advanced CDE draft and queues it for transmission", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: advancedCdeDraft() })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000001",
      tipoOperacion: 1,
      tipoMoneda: "USD"
    });
    expect(generated.identificacion.codigoGeneracion).toMatch(/^[A-F0-9-]{36}$/);
    expect(generated.receptor.nombre).toBe("Example Person Advanced");
    expect(generated.cuerpoDocumento[0].descripcion).toBe("Diezmo avanzado");
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "advanced@example.org",
      donor_name: "Example Person Advanced",
      amount_cents: 12345,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_CREATED", entity_type: "dte_document" }));
  });

  it("rejects an advanced CDE draft that does not match the CDE schema", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: { receptor: { nombre: "Sin estructura" } } })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects final generation of a template draft whose receptor was left empty", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const baseEnv = {
      APP_ENV: "staging",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
    };

    const templateResponse = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, baseEnv)
    );
    expect(templateResponse.status).toBe(200);
    const { draft: emptyReceptorDraft } = (await templateResponse.json()) as { draft: Record<string, unknown> };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: emptyReceptorDraft })
      }),
      env(db, baseEnv)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects an advanced CDE draft with an invalid DUI check digit", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const draft = advancedCdeDraft();
    (draft.receptor as Record<string, unknown>).tipoDocumento = "13";
    (draft.receptor as Record<string, unknown>).numDocumento = "00000000-9";

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_advanced_cde",
      message: expect.stringContaining("DUI")
    });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("Wompi webhook integration", () => {
  it("accepts a signed official Wompi webhook and queues approved payments", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_doc_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      },
      enlacePago: {
        IdentificadorEnlaceComercio: "DONACION-123"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, inserted: true, queued: true });
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0]).toMatchObject({
      transaction_id: "wompi_doc_tx_1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donor@example.org",
      donor_name: "Example Person"
    });
    expect(queued).toEqual([{
      wompiEventId: db.wompiEvents[0].id,
      issuanceAttemptId: expect.any(String)
    }]);
  });

  it("stores but quarantines a signed webhook whose ambiente is incompatible with the deployment", async () => {
    const db = new InMemoryD1();
    // Owner has the app set to PRODUCTION emission, but a TEST-mode payment arrives.
    db.settings.push({ key: "emission_environment", value: "01" });
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_mismatch",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        APP_ENV: "production",
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.clone().json()).resolves.toMatchObject({ queued: false });
    expect(db.wompiEvents[0]).toMatchObject({ transaction_id: "wompi_env_tx_mismatch", environment: "00" });
    const mismatch = db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH");
    expect(mismatch).toMatchObject({ entity_type: "wompi_event", entity_id: db.wompiEvents[0].id });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { payloadEnvironment: string; activeEnvironment: string };
    expect(metadata).toMatchObject({ payloadEnvironment: "00", activeEnvironment: "01" });
    expect(queued).toEqual([]);
  });

  it("rejects a manually injected incompatible Wompi queue event before any issuance side effect", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push({
      id: "wompi_injected_prod",
      transaction_id: "wompi_injected_prod_tx",
      environment: "01",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify({
        IdCuenta: "acct_1",
        FechaTransaccion: "2026-07-09T12:00:00-06:00",
        Monto: "25.00",
        IdTransaccion: "wompi_injected_prod_tx",
        ResultadoTransaccion: "ExitosaAprobada",
        EsProductiva: true
      }),
      headers_json: "{}",
      received_at: "2026-07-09T18:00:00.000Z",
      processed_at: null,
      created_document_id: null
    });

    const error = await new IssuancePipeline(env(db, { APP_ENV: "staging" }))
      .processWompiEvent("wompi_injected_prod")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentNotAllowedError);
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.wompiEvents[0].processed_at).toBeNull();
  });

  it("does not audit a mismatch when the signed payload agrees with the active emission setting", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "emission_environment", value: "00" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_agree",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents[0]).toMatchObject({ environment: "00" });
    expect(db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH")).toBeUndefined();
  });

  it("normalizes the stored raw Wompi body before generating the queued CDE", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_pipeline_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const body = await response.json() as { wompiEventId: string };
    const certificateXml = await generatedCertificateXml("cert-password");

    const record = await new IssuancePipeline(env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify({ ...emisorConfig(), defaultDonationType: 1 }),
      MH_CERT_XML: certificateXml,
      MH_CERT_PASSWORD: "cert-password"
    })).processWompiEvent(body.wompiEventId);

    expect(record).toMatchObject({
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 2500,
      status: "ACCEPTED"
    });
    const cde = JSON.parse(record!.plain_json) as { receptor: { nombre: string; correo: string; telefono: string } };
    expect(cde.receptor).toMatchObject({
      nombre: "Example Person",
      correo: "donor@example.org",
      telefono: "70000005"
    });
  });

  it("returns a clear 400 for signed webhook payloads Wompi cannot map to a transaction", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "25.00",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_wompi_payload",
      message: expect.stringContaining("IdTransaccion")
    });
    expect(db.wompiEvents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("does not mark paid_at from an IdExterno-only app identifier", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_paidmark",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_paid_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_paidmark"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.paid_at ?? null).toBeNull();
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.status).toBe("LINK_CREATED");
  });

  it("marks paid_at only from an exact canonical commerce id and numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_enlacepaid",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_enlace_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_enlacepaid" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_enlacepaid")?.paid_at).toBeTruthy();
  });

  it("does not mark paid_at when the canonical commerce id lacks the numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_missing_link",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_missing_link_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "di_missing_link" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents[0].paid_at ?? null).toBeNull();
  });

  it("does not change paid_at on a replayed webhook for an already-paid intent", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_replay",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: "2026-07-04T12:30:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_replay_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_replay",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_replay" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    // markIntentPaid is idempotent (WHERE paid_at IS NULL): the first stamp stands.
    expect(db.donationIntents.find((row) => row.id === "di_replay")?.paid_at).toBe("2026-07-04T12:30:00.000Z");
  });

  it("leaves non-intent (legacy static-link) webhooks unaffected — no intent, no error", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_legacy_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "DONACION-123" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    // Still processed and queued; nothing to mark paid, no crash.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true, queued: true });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("never lets a paid-marker failure (unknown di_ intent) break webhook processing", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    // A di_ id that has no matching intent row — the marker must no-op, not 500.
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_orphan_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_does_not_exist"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true });
    expect(db.wompiEvents).toHaveLength(1);
  });

  it("does not mark paid_at for a declined di_ webhook", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_declined",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_declined_tx_1",
      ResultadoTransaccion: "Rechazada",
      EsProductiva: false,
      IdExterno: "di_declined"
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_declined")?.paid_at ?? null).toBeNull();
  });
});

