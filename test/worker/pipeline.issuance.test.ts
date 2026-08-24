// Characterization unit suite for IssuancePipeline (src/worker/services/pipeline.ts).
// Every test drives pipeline methods DIRECTLY (no worker.fetch) against the shared
// InMemoryD1 harness, pinning the current issuance orchestration: MH acceptance,
// MH rejection, deferred transmission, receipt-email claim evidence, and the
// Wompi-event fiscal correction happy path.
import { describe, expect, it, vi } from "vitest";
import type { FiscalReceptorCorrection } from "../../src/shared/fiscalCorrection";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { Repository } from "../../src/worker/storage/repository";
import type { DteDocumentRecord, Env, FiscalCorrectionRecord } from "../../src/worker/types";
import { makeDocument as testDocument } from "./fixtures";
import { advancedFailingDocument, emisorConfig, generatedCertificateXml } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { jsonResponse } from "./support/workerFetchHelpers";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();

type SentEmail = {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
};

const PIPELINE_MH_SECRET_USER = "mh user+canary@example.test";
const PIPELINE_MH_SECRET_USER_PERCENT = "mh%20user%2Bcanary%40example.test";
const PIPELINE_MH_SECRET_USER_FORM = "mh+user%2Bcanary%40example.test";
const PIPELINE_MH_SECRET_PASSWORD = "PW canary+&=/%?";
const PIPELINE_MH_SECRET_PASSWORD_PERCENT = "PW%20canary%2B%26%3D%2F%25%3F";
const PIPELINE_MH_SECRET_PASSWORD_FORM = "PW+canary%2B%26%3D%2F%25%3F";
const PIPELINE_MH_SECRET_TOKEN = `Bearer token:${PIPELINE_MH_SECRET_PASSWORD}:mh-token-canary`;

const PIPELINE_MH_SECRET_VARIANTS = [
  PIPELINE_MH_SECRET_USER,
  PIPELINE_MH_SECRET_USER_PERCENT,
  PIPELINE_MH_SECRET_USER_FORM,
  PIPELINE_MH_SECRET_PASSWORD,
  PIPELINE_MH_SECRET_PASSWORD_PERCENT,
  PIPELINE_MH_SECRET_PASSWORD_FORM,
  PIPELINE_MH_SECRET_TOKEN
];

const INTENT_ADDRESS = {
  departamento: "05",
  municipio: "24",
  distrito: "01",
  complemento: "Calle Donante 123, Antiguo Cuscatlán"
};

function seedIntent(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const intent = {
    id: "di_unit_1",
    status: "LINK_CREATED",
    amount_cents: 2500,
    donor_name: null,
    donor_document_type: "13",
    donor_document: "10000002-7",
    donor_email: null,
    donor_phone: "70001111",
    direccion_departamento: INTENT_ADDRESS.departamento,
    direccion_municipio: INTENT_ADDRESS.municipio,
    direccion_distrito: INTENT_ADDRESS.distrito,
    direccion_complemento: INTENT_ADDRESS.complemento,
    donor_pais: null,
    wompi_id_enlace: 987654,
    wompi_url_enlace: "https://s.wompi.sv/987654",
    wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
    document_id: null,
    client_ip: "203.0.113.9",
    created_at: "2026-06-26T01:00:00.000Z",
    updated_at: "2026-06-26T01:00:00.000Z",
    expires_at: "2026-06-26T02:00:00.000Z",
    ...overrides
  };
  db.donationIntents.push(intent);
  return intent;
}

function unitWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IdCuenta: "acct_1",
    FechaTransaccion: "2026-06-26T01:40:00-06:00",
    Monto: "25.00",
    IdTransaccion: "wompi_unit_tx_1",
    ResultadoTransaccion: "ExitosaAprobada",
    EsProductiva: false,
    IdExterno: "di_unit_1",
    EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_unit_1" },
    cliente: {
      DocumentoIdentidad: "P-A123456",
      Nombre: "Fallback",
      Apellidos: "Cliente",
      EMail: "fallback@example.org",
      Celular: "70000003",
      CodigoPais: "SV"
    },
    ...overrides
  };
}

function seedEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_unit_evt"): string {
  db.wompiEvents.push({
    id,
    transaction_id: String(webhook.IdTransaccion),
    environment: "00",
    result: String(webhook.ResultadoTransaccion),
    amount_cents: 2500,
    donor_email: null,
    donor_name: null,
    raw_body: JSON.stringify(webhook),
    headers_json: "{}",
    received_at: "2026-06-26T01:46:47.015Z",
    processed_at: null,
    created_document_id: null
  });
  return id;
}

async function pipelineRuntime(db: InMemoryD1, sent: SentEmail[]): Promise<Env> {
  return env(db, {
    MOCK_EXTERNAL_SERVICES: "false",
    EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
    MH_CERT_XML: await generatedCertificateXml("cert-password"),
    MH_CERT_PASSWORD: "cert-password",
    MH_USER_TEST: "10000003520015",
    MH_PASSWORD_TEST: "test-password",
    MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
    MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
    EMAIL_FROM: "comprobantes@example.org",
    EMAIL: {
      send: async (message: unknown) => {
        sent.push(message as SentEmail);
        return { messageId: `email-${sent.length}` };
      }
    } as SendEmail
  });
}

// URL-routing fetch stub: MH auth succeeds; the recepciondte verdict is per test.
function stubMhFetch(recepcion: () => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/seguridad/auth")) {
      return jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" });
    }
    if (url.includes("recepciondte")) {
      return recepcion();
    }
    throw new Error(`Fetch inesperado en prueba unitaria del pipeline: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// MH auth outage: the only failure class proven to happen BEFORE the fiscal POST,
// so it is the deterministic trigger for the deferred-transmission path.
function stubMhAuthUnavailable(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/seguridad/auth")) {
      return new Response("MH no disponible", { status: 503 });
    }
    throw new Error(`El endpoint fiscal no debía alcanzarse: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mhRecepcionCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("recepciondte")).length;
}

describe("IssuancePipeline.processWompiEvent acceptance", () => {
  it("issues an intent-correlated CDE to ACCEPTED with sello, receipt evidence, and completed intent", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-UNIT-HAPPY", observaciones: [] }));

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(record).toMatchObject({
      status: "ACCEPTED",
      environment: "00",
      numero_control: "DTE-15-M001P004-000000000000001",
      sello_recibido: "SELLO-UNIT-HAPPY",
      mh_estado: "PROCESADO",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500
    });
    expect(record?.signed_jws).toEqual(expect.any(String));
    expect(record?.accepted_at).toEqual(expect.any(String));
    expect(record?.post_accept_finalized_at).toEqual(expect.any(String));
    expect(record?.transmission_deferred_at).toBeNull();

    // The Wompi event carries the durable issuance bookkeeping for the created CDE.
    const event = db.wompiEvents.find((row) => row.id === eventId);
    expect(event).toMatchObject({
      created_document_id: record!.id,
      issuance_status: "DOCUMENT_CREATED",
      control_prefix: "M001P004",
      control_sequence: 1,
      reserved_numero_control: "DTE-15-M001P004-000000000000001",
      reserved_codigo_generacion: record!.codigo_generacion
    });
    expect(event?.processed_at).toEqual(expect.any(String));

    // Receipt email evidence: exactly one definitive dteReceipt SENT at ACCEPTED.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("fallback@example.org");
    expect(sent[0].subject).not.toContain("(en trámite)");
    expect(db.emailDeliveries).toEqual([
      expect.objectContaining({
        document_id: record!.id,
        to_email: "fallback@example.org",
        status: "SENT",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    ]);

    // Exact post-accept audit trail.
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_ACCEPTED",
      entity_type: "dte_document",
      entity_id: record!.id,
      summary: "DTE-15-M001P004-000000000000001 PROCESADO"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_SENT",
      entity_type: "dte_document",
      entity_id: record!.id
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_ACCEPTED_FINALIZED",
      entity_type: "dte_document",
      entity_id: record!.id,
      summary: "Finalización post-aceptación completada"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DONATION_INTENT_COMPLETED",
      entity_type: "donation_intent",
      entity_id: "di_unit_1"
    }));

    // MH acceptance is what completes the application intent.
    expect(db.donationIntents.find((row) => row.id === "di_unit_1")).toMatchObject({
      status: "COMPLETED",
      document_id: record!.id
    });
  });

  // /donar stopped asking for the address once Wompi's production sheet began forcing
  // it, so a correlated intent now arrives with direccion_complemento NULL and the
  // street address rides in on the webhook instead.
  it("takes the receptor complemento from the Wompi webhook when the intent carries none", async () => {
    const db = new InMemoryD1();
    seedIntent(db, { direccion_complemento: null });
    const eventId = seedEvent(db, unitWebhook({
      cliente: { ...(unitWebhook().cliente as Record<string, unknown>), Direccion: "Av. Wompi 456, San Salvador" }
    }));
    const runtime = await pipelineRuntime(db, []);
    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-ADDR", observaciones: [] }));

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    // The donor's catalog geography still comes from the intent; only the free-text
    // complemento falls back to Wompi. Never null — MH rejects that with codigoMsg 096.
    expect(JSON.parse(String(record!.plain_json)).receptor.direccion).toEqual({
      departamento: INTENT_ADDRESS.departamento,
      municipio: INTENT_ADDRESS.municipio,
      distrito: INTENT_ADDRESS.distrito,
      complemento: "Av. Wompi 456, San Salvador"
    });
  });

  it("falls back to the not-provided constant when neither the intent nor Wompi has an address", async () => {
    const db = new InMemoryD1();
    seedIntent(db, { direccion_complemento: null });
    const eventId = seedEvent(db, unitWebhook());
    const runtime = await pipelineRuntime(db, []);
    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-NOADDR", observaciones: [] }));

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(JSON.parse(String(record!.plain_json)).receptor.direccion.complemento)
      .toBe("No proporcionada por el donante");
  });

  // Regression guard. MH forbids a direccion object for a non-domiciled receptor, so a
  // foreign donor's address survives ONLY via the DireccionExtranjera apéndice — which
  // interpolates the complemento straight into a string. A null reaching that line would
  // print the literal "Estados Unidos: null" onto a legally-binding fiscal document.
  it("never prints a null address into the foreign-donor apéndice", async () => {
    const db = new InMemoryD1();
    seedIntent(db, {
      direccion_departamento: "00",
      direccion_municipio: "00",
      direccion_distrito: "00",
      direccion_complemento: null,
      donor_pais: "US",
      donor_document_type: "03",
      donor_document: "AB-123456"
    });
    const eventId = seedEvent(db, unitWebhook({
      cliente: { ...(unitWebhook().cliente as Record<string, unknown>), Direccion: "742 Evergreen Terrace, Springfield" }
    }));
    const runtime = await pipelineRuntime(db, []);
    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-FOREIGN", observaciones: [] }));

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    const document = JSON.parse(String(record!.plain_json));

    expect(document.receptor.direccion).toBeNull();
    const foreign = (document.apendice as Array<{ campo: string; valor: string }>)
      .find((entry) => entry.campo === "DireccionExtranjera");
    expect(foreign?.valor).toBe("Estados Unidos: 742 Evergreen Terrace, Springfield");
    expect(foreign?.valor).not.toContain("null");
  });

  it("returns the terminal document on queue redelivery without a second MH dispatch or email", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    const fetchMock = stubMhFetch(() =>
      jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-UNIT-HAPPY", observaciones: [] })
    );
    const first = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(first?.status).toBe("ACCEPTED");
    expect(mhRecepcionCalls(fetchMock)).toBe(1);

    const redelivered = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(redelivered?.id).toBe(first!.id);
    expect(redelivered?.status).toBe("ACCEPTED");
    expect(redelivered?.sello_recibido).toBe("SELLO-UNIT-HAPPY");
    // The terminal short-circuit stops before signing/transmitting again.
    expect(mhRecepcionCalls(fetchMock)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "EMAIL_SENT")).toHaveLength(1);
  });
});

describe("IssuancePipeline.processWompiEvent rejection", () => {
  it("records REJECTED with the exact MH observations and sends no receipt", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhFetch(() => jsonResponse(
      {
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: ["El receptor no coincide", "Regla 999"]
      },
      { status: 400 }
    ));

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(record).toMatchObject({
      status: "REJECTED",
      mh_estado: "RECHAZADO",
      sello_recibido: null,
      accepted_at: null,
      post_accept_finalized_at: null
    });
    expect(JSON.parse(String(record!.mh_observaciones_json))).toEqual([
      "El receptor no coincide",
      "Regla 999"
    ]);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_REJECTED",
      entity_type: "dte_document",
      entity_id: record!.id,
      summary: "DTE-15-M001P004-000000000000001 RECHAZADO"
    }));
    // A rejection never emails the donor nor completes the intent.
    expect(sent).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(db.donationIntents.find((row) => row.id === "di_unit_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_ACCEPTED" }));
  });

  it("keeps echoed MH credentials out of returned, document, audit, and log rejection evidence", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    runtime.MH_USER_TEST = PIPELINE_MH_SECRET_USER;
    runtime.MH_PASSWORD_TEST = PIPELINE_MH_SECRET_PASSWORD;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return jsonResponse({
          status: "OK",
          body: { token: PIPELINE_MH_SECRET_TOKEN },
          tokenType: "Bearer"
        });
      }
      if (url.includes("recepciondte")) {
        return jsonResponse({
          estado: "RECHAZADO",
          selloRecibido: null,
          observaciones: [
            `user=${PIPELINE_MH_SECRET_USER}; encoded=${PIPELINE_MH_SECRET_USER_PERCENT}`,
            `pwd=${PIPELINE_MH_SECRET_PASSWORD}; form=${PIPELINE_MH_SECRET_PASSWORD_FORM}`,
            `authorization=${PIPELINE_MH_SECRET_TOKEN}`
          ],
          descripcionMsg: `description ${PIPELINE_MH_SECRET_PASSWORD_PERCENT}`,
          estadoDetalle: `state ${PIPELINE_MH_SECRET_USER_FORM}`,
          selloEcho: `seal ${PIPELINE_MH_SECRET_TOKEN}`,
          text: `text ${PIPELINE_MH_SECRET_PASSWORD}`,
          nested: [{ evidence: `prefix-${PIPELINE_MH_SECRET_TOKEN}-suffix` }],
          [`provider-${PIPELINE_MH_SECRET_PASSWORD}-key`]: "nested key evidence"
        }, { status: 400 });
      }
      throw new Error(`Fetch inesperado en prueba unitaria del pipeline: ${url}`);
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    const capturedLogs = errorLog.mock.calls;
    errorLog.mockRestore();

    expect(record).toMatchObject({
      status: "REJECTED",
      mh_estado: "RECHAZADO",
      sello_recibido: null
    });
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_REJECTED",
      summary: "DTE-15-M001P004-000000000000001 RECHAZADO"
    }));
    expect(JSON.parse(String(record!.mh_observaciones_json))[2]).toBe("authorization=[REDACTED]");
    expectNoPipelineMhSecrets(JSON.stringify({
      returned: record,
      documents: db.documents,
      rejectionAudits: db.audits.filter((audit) => audit.action === "DTE_REJECTED"),
      logs: capturedLogs
    }));
  });

  it("retains the fiscal claim and bounds durable evidence for an indeterminate MH estado", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    runtime.MH_USER_TEST = PIPELINE_MH_SECRET_USER;
    runtime.MH_PASSWORD_TEST = PIPELINE_MH_SECRET_PASSWORD;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return jsonResponse({
          status: "OK",
          body: { token: PIPELINE_MH_SECRET_TOKEN },
          tokenType: "Bearer"
        });
      }
      if (url.includes("recepciondte")) {
        return jsonResponse({
          estado: `PENDIENTE ${PIPELINE_MH_SECRET_USER} ${PIPELINE_MH_SECRET_TOKEN}`,
          selloRecibido: null,
          observaciones: [`pending ${PIPELINE_MH_SECRET_PASSWORD_FORM}`],
          nested: { evidence: `nested ${PIPELINE_MH_SECRET_PASSWORD_PERCENT}` }
        });
      }
      throw new Error(`Fetch inesperado en prueba unitaria del pipeline: ${url}`);
    }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await new IssuancePipeline(runtime)
      .processWompiEvent(eventId)
      .catch((caught: unknown) => caught);
    const capturedLogs = errorLog.mock.calls;
    errorLog.mockRestore();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Ministerio de Hacienda devolvió un resultado no definitivo: ESTADO_NO_RECONOCIDO"
    );
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/),
      transmission_deferred_at: null
    });
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_REJECTED" }));
    expectNoPipelineMhSecrets(JSON.stringify({
      error: { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack },
      documents: db.documents,
      audits: db.audits,
      logs: capturedLogs
    }));
  });
});

describe("IssuancePipeline deferred transmission", () => {
  const AUTH_OUTAGE_REASON =
    "Falló la autenticación con el Ministerio de Hacienda (HTTP 503)";

  it("defers to SIGNED + transmission_deferred_at and sends the transitorio receipt", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(record).toMatchObject({
      status: "SIGNED",
      mh_estado: "MH_NO_DISPONIBLE",
      sello_recibido: null,
      accepted_at: null,
      post_accept_finalized_at: null
    });
    expect(record?.transmission_deferred_at).toEqual(expect.any(String));
    expect(record?.signed_jws).toEqual(expect.any(String));
    expect(JSON.parse(String(record!.mh_observaciones_json))).toEqual([AUTH_OUTAGE_REASON]);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_TRANSMISSION_DEFERRED",
      entity_type: "dte_document",
      entity_id: record!.id,
      summary: `${record!.numero_control}: ${AUTH_OUTAGE_REASON}`
    }));
    // The donor immediately receives the TRANSITORIO receipt...
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(db.emailDeliveries).toEqual([
      expect.objectContaining({
        document_id: record!.id,
        status: "SENT",
        email_type: "dteReceiptTransitorio",
        document_status_at_send: "SIGNED"
      })
    ]);
    // ...but the intent completes only on real MH acceptance.
    expect(db.donationIntents.find((row) => row.id === "di_unit_1")?.status).toBe("LINK_CREATED");
  });

  it("processDteDocument retries the deferred CDE to ACCEPTED with the definitive receipt", async () => {
    const db = new InMemoryD1();
    seedIntent(db);
    const eventId = seedEvent(db, unitWebhook());
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(sent).toHaveLength(1);

    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-RETRY-1", observaciones: [] }));
    const record = await new IssuancePipeline(runtime).processDteDocument(deferred!.id);

    expect(record).toMatchObject({
      id: deferred!.id,
      status: "ACCEPTED",
      sello_recibido: "SELLO-RETRY-1",
      mh_estado: "PROCESADO"
    });
    expect(record.accepted_at).toEqual(expect.any(String));
    expect(record.post_accept_finalized_at).toEqual(expect.any(String));
    // The deferral marker is preserved as historical evidence.
    expect(record.transmission_deferred_at).toEqual(expect.any(String));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_ACCEPTED",
      entity_type: "dte_document",
      entity_id: deferred!.id,
      summary: "DTE-15-M001P004-000000000000001 PROCESADO"
    }));
    // Transitorio first, definitive second — two distinct evidence types.
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).not.toContain("(en trámite)");
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: deferred!.id,
      status: "SENT",
      email_type: "dteReceiptTransitorio",
      document_status_at_send: "SIGNED"
    }));
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: deferred!.id,
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED"
    }));
    // Real acceptance completes the correlated intent.
    expect(db.donationIntents.find((row) => row.id === "di_unit_1")).toMatchObject({
      status: "COMPLETED",
      document_id: deferred!.id
    });
  });

  it("does not resend the transitorio when a redelivery re-defers a document with SENT evidence", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...advancedFailingDocument("doc_redefer"),
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "already-signed-jws"
    });
    db.emailDeliveries.push({
      id: "email_prev",
      document_id: "doc_redefer",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: "{}",
      sent_at: "2026-06-26T01:50:00.000Z",
      email_type: "dteReceiptTransitorio",
      document_status_at_send: "SIGNED",
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(runtime).processDteDocument("doc_redefer");

    expect(record.status).toBe("SIGNED");
    expect(record.transmission_deferred_at).toEqual(expect.any(String));
    expect(sent).toHaveLength(0);
    expect(db.emailDeliveries.filter((row) => row.document_id === "doc_redefer")).toHaveLength(1);
  });
});

function expectNoPipelineMhSecrets(evidence: string): void {
  for (const secret of PIPELINE_MH_SECRET_VARIANTS) {
    expect(evidence).not.toContain(secret);
  }
}

describe("IssuancePipeline receipt email claim behavior", () => {
  function acceptedAdvancedDocument(): DteDocumentRecord {
    return testDocument({ wompi_event_id: null, post_accept_finalized_at: null });
  }

  it("claims the delivery row and post-accept dispatch marker before the provider is called", async () => {
    const db = new InMemoryD1();
    db.documents.push(acceptedAdvancedDocument());
    const sent: SentEmail[] = [];
    const observedAtDispatch: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (message: unknown) => {
      const row = db.emailDeliveries.find((delivery) => delivery.document_id === "doc_1");
      observedAtDispatch.push({
        deliveryStatus: row?.status,
        providerDispatchStarted: row?.provider_dispatch_started_at != null,
        postAcceptDispatchStarted: db.documents[0].post_accept_email_dispatch_started_at != null
      });
      sent.push(message as SentEmail);
      return { messageId: "receipt-claim-1" };
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    // The claim row and both dispatch markers were durable BEFORE provider contact.
    expect(observedAtDispatch).toEqual([{
      deliveryStatus: "PENDING",
      providerDispatchStarted: true,
      postAcceptDispatchStarted: true
    }]);
    const delivery = db.emailDeliveries.find((row) => row.document_id === "doc_1");
    expect(delivery).toMatchObject({
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      to_email: "legacy-contact-2@example.com",
      template_version: expect.stringMatching(/^dteReceipt:sha256:[a-f0-9]{64}$/),
      pdf_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      dte_json_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      provider_delivery_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    // The provider send carried the claimed idempotency identity.
    expect(sent[0].headers).toEqual({ "X-Idempotency-Key": delivery?.idempotency_key });
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_SENT",
      entity_type: "dte_document",
      entity_id: "doc_1",
      summary: "Comprobante enviado al correo registrado."
    }));
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
  });

  it("finalizes the claim FAILED with UNKNOWN outcome when the provider throws after dispatch", async () => {
    const db = new InMemoryD1();
    db.documents.push(acceptedAdvancedDocument());
    const send = vi.fn(async () => {
      throw new Error("proveedor caído");
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    // An email failure never blocks post-accept finalization of the fiscal document.
    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toEqual([
      expect.objectContaining({
        document_id: "doc_1",
        status: "FAILED",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED",
        outcome_class: "UNKNOWN",
        failure_code: "EMAIL_DISPATCH_UNKNOWN",
        retry_safe: 0,
        provider_dispatch_started_at: expect.any(String)
      })
    ]);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_FAILED",
      entity_type: "dte_document",
      entity_id: "doc_1",
      summary: "No se pudo confirmar el resultado del envío con el proveedor."
    }));
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "EMAIL_SENT" }));
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
  });

  it("does not contact the provider again when SENT evidence already exists", async () => {
    const db = new InMemoryD1();
    db.documents.push(acceptedAdvancedDocument());
    db.emailDeliveries.push({
      id: "email_prev_sent",
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: "{}",
      sent_at: "2026-06-26T01:50:00.000Z",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "ADVANCED_CDE_ACCEPTED",
      entity_type: "dte_document",
      entity_id: "doc_1"
    }));
  });
});

describe("IssuancePipeline.processFiscalCorrection happy path", () => {
  // The InMemoryD1 harness has no fiscal_corrections table, so the correction
  // lifecycle rows are stubbed at the Repository boundary (mirroring
  // workerFetch.fiscal-correction.test.ts) while documents, Wompi events,
  // reservations, emails, and audits run through the real in-memory storage.
  function correctionReceptor(): FiscalReceptorCorrection {
    return {
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nrc: null,
      nombre: "Ana Donante",
      codActividad: null,
      descActividad: null,
      correo: "ana@example.org",
      telefono: "70001111",
      codDomiciliado: 1,
      codPais: "SV",
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Colonia Centro"
    };
  }

  function correctionRecord(): FiscalCorrectionRecord {
    return {
      id: "fc_1",
      request_id: "11111111-1111-4111-8111-111111111111",
      request_payload_sha256: "payload-sha",
      attempt_number: 1,
      target_kind: "WOMPI_EVENT",
      wompi_event_id: "wompi_corr_evt",
      document_id: null,
      environment: "00",
      status: "QUEUED",
      before_receptor_json: JSON.stringify({ ...correctionReceptor(), numDocumento: "12345678-9" }),
      corrected_receptor_json: JSON.stringify(correctionReceptor()),
      changed_fields_json: JSON.stringify(["numDocumento"]),
      source_document_snapshot_json: null,
      issuance_attempt_id: "attempt_corr_1",
      fiscal_claim_id: null,
      processing_claim_id: "processing_corr_1",
      reserved_control_prefix: null,
      reserved_control_sequence: null,
      reserved_codigo_generacion: null,
      reserved_numero_control: null,
      mh_dispatch_started_at: null,
      failure_code: null,
      failure_message: null,
      created_by: "user_operator",
      created_at: "2026-07-18T12:00:00.000Z",
      processing_started_at: null,
      completed_at: null,
      updated_at: "2026-07-18T12:00:00.000Z"
    };
  }

  it("issues the corrected Wompi CDE to ACCEPTED and finalizes the correction with document evidence", async () => {
    const db = new InMemoryD1();
    // Legacy webhook (no di_ intent binding) whose original donor DUI was invalid.
    const payload = unitWebhook({
      IdTransaccion: "wompi_corr_tx_1",
      IdExterno: "Diezmos y Ofrendas Demo",
      EnlacePago: { Id: 1, IdentificadorEnlaceComercio: "Diezmos y Ofrendas Demo" },
      cliente: {
        DocumentoIdentidad: "12345678-9",
        Nombre: "Ana",
        Apellidos: "Donante",
        EMail: "ana@example.org",
        Celular: "70001111",
        CodigoPais: "SV"
      }
    });
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_corr_evt",
      transaction_id: "wompi_corr_tx_1",
      amount_cents: 2500,
      raw_body: JSON.stringify(payload),
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt_corr_1",
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "Los datos del donante contienen un DUI inválido."
    }));
    const correction = correctionRecord();
    const reconciledStatuses: string[] = [];
    const dispatchMarks: Array<Record<string, unknown>> = [];
    const finalizations: Array<Record<string, unknown>> = [];
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing").mockImplementation(async (input) => {
      if (
        input.id !== correction.id
        || input.processingClaimId !== correction.processing_claim_id
        || input.issuanceAttemptId !== correction.issuance_attempt_id
        || correction.status !== "QUEUED"
      ) {
        return "busy";
      }
      correction.status = "PROCESSING";
      correction.processing_started_at = new Date().toISOString();
      return "claimed";
    });
    vi.spyOn(Repository.prototype, "reconcileFiscalCorrectionAudits").mockImplementation(async (candidate) => {
      reconciledStatuses.push(candidate.status);
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted").mockImplementation(async (input) => {
      dispatchMarks.push(input as unknown as Record<string, unknown>);
      if (
        input.correctionId !== correction.id
        || input.processingClaimId !== correction.processing_claim_id
        || correction.status !== "PROCESSING"
      ) {
        return false;
      }
      correction.mh_dispatch_started_at = new Date().toISOString();
      return true;
    });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection").mockImplementation(async (id, processingClaimId, outcome) => {
      finalizations.push({ id, processingClaimId, outcome });
      if (
        id !== correction.id
        || processingClaimId !== correction.processing_claim_id
        || correction.status !== "PROCESSING"
      ) {
        return false;
      }
      correction.status = outcome.status;
      correction.failure_code = outcome.failureCode ?? null;
      correction.failure_message = outcome.failureMessage ?? null;
      correction.completed_at = new Date().toISOString();
      return true;
    });
    const sent: SentEmail[] = [];
    const runtime = await pipelineRuntime(db, sent);
    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-CORRECCION", observaciones: [] }));

    const result = await new IssuancePipeline(runtime).processFiscalCorrection("fc_1", {
      processingClaimId: "processing_corr_1",
      issuanceAttemptId: "attempt_corr_1"
    });

    expect(result.status).toBe("ACCEPTED");
    expect(result.failure_code).toBeNull();
    const document = db.documents[0];
    expect(document).toMatchObject({
      wompi_event_id: "wompi_corr_evt",
      status: "ACCEPTED",
      sello_recibido: "SELLO-CORRECCION",
      mh_estado: "PROCESADO",
      numero_control: "DTE-15-M001P004-000000000000001",
      donor_email: "ana@example.org"
    });
    // The persisted CDE carries the CORRECTED receptor identity.
    expect(JSON.parse(String(document.plain_json)).receptor).toMatchObject({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nombre: "Ana Donante"
    });
    // The MH dispatch boundary was marked with the exact document claim evidence.
    expect(dispatchMarks).toEqual([{
      correctionId: "fc_1",
      processingClaimId: "processing_corr_1",
      documentId: document.id,
      documentClaimId: "fiscal_correction_fc_1",
      signedJws: document.signed_jws
    }]);
    // The correction was finalized once, with the accepted document as evidence.
    expect(finalizations).toEqual([{
      id: "fc_1",
      processingClaimId: "processing_corr_1",
      outcome: {
        status: "ACCEPTED",
        document: {
          documentId: document.id,
          documentClaimId: "fiscal_correction_fc_1",
          signedJws: document.signed_jws
        }
      }
    }]);
    expect(reconciledStatuses).toEqual(["PROCESSING", "ACCEPTED"]);
    // The corrected event retired into the normal created-document lifecycle.
    expect(db.wompiEvents[0]).toMatchObject({
      created_document_id: document.id,
      issuance_status: "DOCUMENT_CREATED"
    });
    // The donor received the definitive receipt for the corrected CDE.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ana@example.org");
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: document.id,
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DTE_ACCEPTED",
      entity_type: "dte_document",
      entity_id: document.id
    }));
  });
});
