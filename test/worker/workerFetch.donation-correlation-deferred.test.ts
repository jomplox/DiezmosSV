import { describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument } from "../../src/worker/domain/dteBuilder";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { MhClient } from "../../src/worker/services/mhClient";
import { Repository } from "../../src/worker/storage/repository";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env, IssuanceMessage, WompiWebhook } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import {
  advancedCdeDraft,
  advancedFailingDocument,
  emisorConfig,
  generatedCertificateXml
} from "./support/dteFixtures";
import { TEST_RESEND_REQUEST_ID } from "./support/documentDeliveryFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

describe("donation intent correlation", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_corr_1",
      status: "LINK_CREATED",
      amount_cents: 2500,
      // Name/email are no longer captured on the form; the intent stores null and the
      // correlated CDE lifts nombre/correo from the webhook.
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
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-06-26T01:00:00.000Z",
      updated_at: "2026-06-26T01:00:00.000Z",
      expires_at: "2026-06-26T02:00:00.000Z",
      ...overrides
    };
    db.donationIntents.push(intent);
    return intent;
  }

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_corr_evt"): string {
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

  function correlationWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_corr_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_corr_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" },
      // Fallback donor data that MUST be overridden by the intent when correlated.
      // Non-DUI document so the uncorrelated fallback CDE still validates.
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

  async function pipelineEnv(db: InMemoryD1): Promise<Env> {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password"
    });
  }

  async function expectQuarantined(
    db: InMemoryD1,
    eventId: string,
    runtime: Env,
    reason: string
  ): Promise<void> {
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;
    const result = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeTruthy();
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      issuance_status: "FAILED",
      issuance_attempt_count: 1,
      issuance_error_code: "WOMPI_INTENT_QUARANTINED",
      issuance_error_message: expect.stringContaining("intención")
    });
    const audits = db.audits.filter(
      (row) =>
        row.action === "DONATION_INTENT_BINDING_REJECTED" &&
        row.entity_id === eventId
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0].metadata_json))).toMatchObject({ reason });

    await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(1);
    expect(db.documents).toHaveLength(0);
  }

  it("records one webhook smoke provenance marker only for a valid signed staging identity", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const staging = new InMemoryD1();
    seedIntentRow(staging);
    const stagingEventId = seedWompiEvent(
      staging,
      correlationWebhook({ IdTransaccion: `SMOKE-WEBHOOK-${runId}` })
    );
    const stagingRuntime = { ...(await pipelineEnv(staging)), APP_ENV: "staging" };

    const document = await new IssuancePipeline(stagingRuntime).processWompiEvent(stagingEventId);
    await new IssuancePipeline(stagingRuntime).processWompiEvent(stagingEventId);

    expect(document).not.toBeNull();
    expect(staging.audits.filter((audit) => audit.action === "STAGING_SMOKE_RUN")).toEqual([
      expect.objectContaining({
        entity_type: "dte_document",
        entity_id: document!.id,
        metadata_json: JSON.stringify({
          runId,
          path: "webhook",
          source: "staging-smoke"
        })
      })
    ]);

    const invalid = new InMemoryD1();
    seedIntentRow(invalid);
    const invalidEventId = seedWompiEvent(
      invalid,
      correlationWebhook({ IdTransaccion: "SMOKE-WEBHOOK-not-a-uuid" })
    );
    await new IssuancePipeline({ ...(await pipelineEnv(invalid)), APP_ENV: "staging" })
      .processWompiEvent(invalidEventId);
    expect(invalid.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);

    const local = new InMemoryD1();
    seedIntentRow(local);
    const localEventId = seedWompiEvent(
      local,
      correlationWebhook({ IdTransaccion: `SMOKE-WEBHOOK-${runId}` })
    );
    await new IssuancePipeline(await pipelineEnv(local)).processWompiEvent(localEventId);
    expect(local.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);
  });

  it("marks a non-approved Wompi event as ignored", async () => {
    const db = new InMemoryD1();
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_not_approved_tx",
      ResultadoTransaccion: "Fallida"
    });
    const eventId = seedWompiEvent(db, webhook, "wompi_not_approved");

    const result = await new IssuancePipeline(env(db)).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      issuance_status: "IGNORED",
      issuance_attempt_count: 0,
      processed_at: expect.any(String)
    });
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
  });

  it("correlates a LINK_CREATED intent: identity + address from the intent, nombre/correo from the webhook", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // Merge: tipoDocumento/numDocumento/direccion from the intent (canonical DUI +
    // catalog-coded address), nombre/correo from the webhook (the donor typed them on
    // Wompi's sheet — the intent no longer carries them), telefono from the intent phone.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nombre: "Fallback Cliente",
      correo: "fallback@example.org",
      telefono: "70001111",
      direccion: INTENT_ADDRESS
    });
    // Natural-person flow unchanged: donor_name/donor_email track the emitted receptor,
    // which for a person is the webhook cardholder name and correo.
    expect(record?.donor_name).toBe("Fallback Cliente");
    expect(record?.donor_email).toBe("fallback@example.org");
    // The intent is closed and points at the CDE that fulfilled it.
    const intent = db.donationIntents.find((row) => row.id === "di_corr_1");
    expect(intent?.status).toBe("COMPLETED");
    expect(intent?.document_id).toBe(record!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_corr_1" })
    );
  });

  it("lets only one concurrent delivery issue a successful Wompi event", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook({ IdTransaccion: "wompi_concurrent_success" }));
    let claimAttempts = 0;
    let releaseClaims!: () => void;
    const bothClaimsReached = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    db.beforeWompiIssuanceClaim = async () => {
      claimAttempts += 1;
      if (claimAttempts === 2) releaseClaims();
      await bothClaimsReached;
    };
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = await pipelineEnv(db);
    const sequenceBefore = db.nextSequence;

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("retries accepted Wompi bookkeeping and finalizes it without retransmitting", async () => {
    const db = new InMemoryD1();
    const intent = seedIntentRow(db);
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_post_acceptance_retry_tx"
    });
    const eventId = seedWompiEvent(db, webhook, "wompi_post_acceptance_retry");
    const codigoGeneracion = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const numeroControl = "DTE-15-M001P004-000000000000031";
    const plainDocument = buildCdeDocument(webhook as unknown as WompiWebhook, emisorConfig(), {
      sequence: 31,
      codigoGeneracion,
      environment: "00",
      issuedAt: new Date("2026-07-13T11:00:00-06:00")
    });
    db.documents.push(testDocument({
      id: "dte_post_acceptance_retry",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: numeroControl,
      status: "SIGNED",
      plain_json: JSON.stringify(plainDocument),
      signed_jws: "stored-signed-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      donor_email: "fallback@example.org",
      post_accept_finalized_at: null
    }));
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-POST-ACCEPTANCE",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const realPrepare = db.prepare.bind(db);
    let failAcceptedAudit = true;
    let failIntentLookup = true;
    let intentCompletedBeforeReceipt = false;
    db.prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (sql.includes("INSERT INTO audit_logs") && failAcceptedAudit) {
        failAcceptedAudit = false;
        statement.run = async () => {
          throw new Error("transient accepted-audit failure");
        };
      }
      if (sql.includes("SELECT * FROM donation_intents WHERE id = ?")) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          if (failIntentLookup) {
            failIntentLookup = false;
            throw new Error("transient intent-correlation failure");
          }
          return first<T>();
        };
      }
      if (sql.includes("INSERT INTO email_deliveries")) {
        const run = statement.run.bind(statement);
        const first = statement.first.bind(statement);
        statement.run = async () => {
          intentCompletedBeforeReceipt = intent.status === "COMPLETED";
          return run();
        };
        statement.first = async <T>() => {
          intentCompletedBeforeReceipt = intent.status === "COMPLETED";
          return first<T>();
        };
      }
      return statement;
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = await pipelineEnv(db);
    const queueBatch = () => {
      const ack = vi.fn();
      const retry = vi.fn();
      const batch = {
        queue: "diezmossv-staging-issuance-example",
        messages: [{
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body: { wompiEventId: eventId },
          attempts: 1,
          ack,
          retry
        }],
        ackAll: vi.fn(),
        retryAll: vi.fn()
      } as unknown as MessageBatch<IssuanceMessage>;
      return { batch, ack, retry };
    };

    const first = queueBatch();
    await worker.queue(first.batch, runtime);

    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-POST-ACCEPTANCE"
    });
    expect(intent.status).toBe("LINK_CREATED");
    expect(db.emailDeliveries).toHaveLength(0);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(0);
    expect(transmit).toHaveBeenCalledTimes(1);

    const second = queueBatch();
    await worker.queue(second.batch, runtime);

    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
    expect(intent).toMatchObject({
      status: "COMPLETED",
      document_id: "dte_post_acceptance_retry"
    });
    expect(intentCompletedBeforeReceipt).toBe(true);
    expect(db.emailDeliveries.filter((row) => row.status === "SENT")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);

    const third = queueBatch();
    await worker.queue(third.batch, runtime);

    expect(third.ack).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries.filter((row) => row.status === "SENT")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("finalizes concurrent deliveries of one accepted Wompi CDE exactly once", async () => {
    const db = new InMemoryD1();
    const intent = seedIntentRow(db);
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_concurrent_finalization_tx"
    });
    const eventId = seedWompiEvent(
      db,
      webhook,
      "wompi_concurrent_finalization"
    );
    const codigoGeneracion = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const plainDocument = buildCdeDocument(
      webhook as unknown as WompiWebhook,
      emisorConfig(),
      {
        sequence: 32,
        codigoGeneracion,
        environment: "00",
        issuedAt: new Date("2026-07-13T11:30:00-06:00")
      }
    );
    db.documents.push(testDocument({
      id: "dte_concurrent_finalization",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000032",
      status: "ACCEPTED",
      plain_json: JSON.stringify(plainDocument),
      signed_jws: "stored-concurrent-signed-jws",
      sello_recibido: "SELLO-CONCURRENT-FINALIZATION",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T17:30:05.000Z",
      donor_email: "fallback@example.org",
      post_accept_finalized_at: null
    }));

    const pairBarrier = () => {
      let arrivals = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      return async () => {
        arrivals += 1;
        if (arrivals === 2) {
          release();
        }
        await bothArrived;
      };
    };
    const acceptedAuditCount = pairBarrier();
    const completedAuditCount = pairBarrier();
    db.beforeAuditCount = async (action, entityId) => {
      if (action === "DTE_ACCEPTED" && entityId === "dte_concurrent_finalization") {
        await acceptedAuditCount();
      }
      if (action === "DONATION_INTENT_COMPLETED" && entityId === "di_corr_1") {
        await completedAuditCount();
      }
    };

    const sent: unknown[] = [];
    const intentCompletedAtSend: boolean[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          intentCompletedAtSend.push(intent.status === "COMPLETED");
          sent.push(message);
          return { messageId: `concurrent-receipt-${sent.length}` };
        }
      } as SendEmail
    });
    const transmit = vi
      .spyOn(MhClient.prototype, "transmitDte")
      .mockRejectedValue(new Error("an accepted CDE must not be retransmitted"));

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results.map((record) => record?.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(transmit).not.toHaveBeenCalled();
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-FINALIZATION"
    });
    expect(intent).toMatchObject({
      status: "COMPLETED",
      document_id: "dte_concurrent_finalization"
    });
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(
      db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")
    ).toHaveLength(1);
    expect(
      db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")
    ).toHaveLength(1);
    expect(intentCompletedAtSend).toEqual([true]);
    expect(sent).toHaveLength(1);
    expect(db.emailDeliveries).toHaveLength(1);
    const providerDeliveryId = `sha256:${await sha256Hex(utf8Bytes("concurrent-receipt-1"))}`;
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "dte_concurrent_finalization",
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      provider_delivery_id: providerDeliveryId
    });
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("SELECT COUNT(*) AS count FROM audit_logs")
      )
    ).toBe(false);
    expect(
      db.preparedSql.some(
        (sql) =>
          sql.includes("INSERT INTO email_deliveries") &&
          sql.includes("WHERE NOT EXISTS")
      )
    ).toBe(true);
  });

  it("keeps the payload-derived codPais/codDomiciliado for a domestic intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // No donor_pais on the intent → the existing payload-based behavior is untouched.
    expect(cde.receptor).toMatchObject({ codPais: "SV", codDomiciliado: 1 });
  });

  it("threads the intent gift type into the CDE apéndice on normal issuance (descripcion stays DONACIÓN)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as {
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
  });

  it("omits the TipoAportacion apéndice for an intent with no gift type", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // gift_type undefined → treated as null
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { apendice: Array<Record<string, unknown>> };
    expect(cde.apendice.find((entry) => entry.campo === "TipoAportacion")).toBeUndefined();
  });

  it("uses the intent razón social as the receptor nombre for a NIT intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      donor_document_type: "36",
      donor_document: "0614-280390-112-1",
      donor_name: "Empresa Ejemplo, S.A. de C.V."
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // The comprobante must carry the empresa's razón social, not the cardholder
    // name from the Wompi webhook. Correo still comes from the webhook.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "36",
      numDocumento: "0614-280390-112-1",
      nombre: "Empresa Ejemplo, S.A. de C.V.",
      correo: "fallback@example.org"
    });
    // Persisted metadata must match the signed document: donor_name is the razón social
    // (the emitted receptor nombre), NOT the Wompi cardholder name, and donor_email is
    // the emitted receptor correo.
    expect(record?.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
    expect(record?.donor_email).toBe("fallback@example.org");
  });

  it("marks a foreign intent's receptor non-domiciled with the intent país and a null direccion", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      direccion_departamento: "00",
      direccion_municipio: "00",
      direccion_distrito: "00",
      direccion_complemento: "742 Evergreen Terrace, Springfield",
      donor_pais: "US"
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // MH rejects ANY direccion object for a non-domiciled receptor (00/00/00 AND a
    // valid SV geography both fail codigoMsg 096, verified live): direccion is null,
    // the país rides in codPais, and the foreign address stays on the intent record.
    expect(cde.receptor).toMatchObject({ codPais: "US", codDomiciliado: 2, direccion: null });
  });

  it("falls back to the webhook Celular when the intent has no phone", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { donor_phone: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // telefono = intent.donor_phone ?? webhook Celular; identity/address stay from the intent.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", telefono: "70000003", direccion: INTENT_ADDRESS });
  });

  it("correlates an EXPIRED intent (donor paid in the link's last minute)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "EXPIRED" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // numDocumento/direccion still come from the intent; nombre/correo from the webhook.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", nombre: "Fallback Cliente", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
  });

  it("quarantines a COMPLETED application intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "COMPLETED", document_id: "dte_prev" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    await expectQuarantined(db, eventId, await pipelineEnv(db), "ineligible_status");

    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.document_id).toBe("dte_prev");
  });

  it("audits an amount mismatch and uses the webhook amount, still correlating", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { amount_cents: 2500 });
    // Webhook amount ($30) differs from the intent amount ($25): money truth is Wompi.
    const eventId = seedWompiEvent(db, correlationWebhook({ Monto: "30.00" }));

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.amount_cents).toBe(3000);
    const cde = JSON.parse(record!.plain_json) as { resumen: { valorTotal: number }; receptor: Record<string, unknown> };
    expect(cde.resumen.valorTotal).toBe(30);
    // Still correlated to the intent despite the mismatch: numDocumento/direccion prove it.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    const mismatch = db.audits.find((row) => row.action === "DONATION_INTENT_AMOUNT_MISMATCH");
    expect(mismatch).toBeTruthy();
    expect(mismatch).toMatchObject({ entity_type: "donation_intent", entity_id: "di_corr_1" });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { intentAmountCents: number; eventAmountCents: number };
    expect(metadata).toMatchObject({ intentAmountCents: 2500, eventAmountCents: 3000 });
  });

  it("leaves legacy payloads (no intent id) unchanged: fallback receptor, no intent lookup", async () => {
    const db = new InMemoryD1();
    // A static-link payload whose IdentificadorEnlaceComercio is not a "di_" intent id.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      enlacePago: { Id: 123, IdentificadorEnlaceComercio: "DONACION-legacy" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("quarantines when the webhook link id does not match the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // wompi_id_enlace: 987654
    // A donor-influenced IdExterno points at di_corr_1, but the payment was made on a
    // DIFFERENT Wompi link than the one minted for that intent.
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 111111, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    await expectQuarantined(db, eventId, await pipelineEnv(db), "link_id_mismatch");

    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("creates one binding-rejected audit when two pipelines quarantine the same event concurrently", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    let countArrivals = 0;
    let releaseCounts!: () => void;
    const bothCountsReached = new Promise<void>((resolve) => {
      releaseCounts = resolve;
    });
    db.beforeBindingAuditCount = async () => {
      countArrivals += 1;
      if (countArrivals === 2) {
        releaseCounts();
      }
      await bothCountsReached;
    };
    const runtime = await pipelineEnv(db);
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results).toEqual([null, null]);
    const audits = db.audits.filter(
      (row) =>
        row.action === "DONATION_INTENT_BINDING_REJECTED" &&
        row.entity_id === eventId
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0].metadata_json))).toMatchObject({
      intentId: "di_corr_1",
      reason: "link_id_mismatch",
      expectedLinkId: 987654,
      payloadLinkId: 111111
    });
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeTruthy();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("SELECT COUNT(*) AS count FROM audit_logs")
      )
    ).toBe(false);
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("UPDATE dte_documents SET signed_jws")
      )
    ).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("does not add a binding-rejected audit to an already processed application event", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    const event = db.wompiEvents.find((row) => row.id === eventId)!;
    event.processed_at = "2026-07-13T10:00:00.000Z";
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    await expect(
      new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId)
    ).resolves.toBeNull();

    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(0);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBe("2026-07-13T10:00:00.000Z");
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rolls back the binding audit when the quarantine batch fails before processed marking", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    db.failBindingQuarantineBatchAfterStatement = 1;
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    await expect(
      new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId)
    ).rejects.toThrow("injected binding-quarantine batch failure");

    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(0);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("correlates when the webhook link id matches the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
    expect(db.audits.find((row) => row.action === "DONATION_INTENT_BINDING_REJECTED")).toBeUndefined();
  });

  it("quarantines a draft intent whose donor document is missing", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { donor_document: null, direccion_departamento: null, direccion_municipio: null, direccion_distrito: null, direccion_complemento: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    await expectQuarantined(db, eventId, await pipelineEnv(db), "incomplete_donor_data");

    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
  });

  it("requires a fiscal correction to retry a rejected document with a quarantined app binding", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    db.documents.push({
      ...testDocument({
        id: "dte_quarantine_rebuild",
        wompi_event_id: eventId,
        status: "REJECTED",
        signed_jws: null
      })
    });
    const outbound = vi.spyOn(globalThis, "fetch");

    db.sessionUser = {
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR"
    };
    const response = await worker.fetch(
      new Request(
        "https://example.org/api/documents/dte_quarantine_rebuild/retry",
        {
          method: "POST",
          headers: { Authorization: "Bearer test-token" }
        }
      ),
      await pipelineEnv(db)
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "document_correction_required"
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("treats an invalid donor DUI as terminal: no control sequence, no document, audited", async () => {
    const db = new InMemoryD1();
    // A raw legacy webhook (no intent) whose DocumentoIdentidad looks like a DUI (9
    // digits) but fails the check digit. buildCdeDocument would declare it type 13 and
    // throw AFTER the control sequence is allocated, so a queue retry would burn a
    // control number on every attempt — the guard must reject it BEFORE allocation.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_bad_dui_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const result = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.documents).toHaveLength(0);
    // The sequence counter never advanced — no fiscal gap across queue retries.
    expect(db.nextSequence).toBe(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_INVALID_DONOR_DUI", entity_type: "wompi_event", entity_id: eventId })
    );
    const invalidDuiAudit = db.audits.find(
      (audit) => audit.action === "WOMPI_INVALID_DONOR_DUI" && audit.entity_id === eventId
    );
    expect(invalidDuiAudit?.summary).toBe("Los datos del donante contienen un DUI inválido.");
    expect(invalidDuiAudit?.summary).not.toContain("12345678-9");
    expect(db.wompiEvents.find((event) => event.id === eventId)).toMatchObject({
      processed_at: expect.any(String),
      issuance_status: "FAILED",
      issuance_attempt_count: 1,
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: expect.stringContaining("DUI")
    });
    expect(db.wompiEvents.find((event) => event.id === eventId)?.issuance_error_message)
      .not.toContain("12345678-9");
  });

  it("rejects deterministic CDE schema failures before allocating a control sequence", async () => {
    const db = new InMemoryD1();
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_oversized_email_tx",
      cliente: {
        DocumentoIdentidad: "",
        Nombre: "Correo",
        Apellidos: "Extenso",
        EMail: `${"a".repeat(90)}@example.org`,
        CodigoPais: "SV"
      }
    });
    const eventId = seedWompiEvent(db, webhook);

    const first = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);
    const second = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.audits.filter((audit) => audit.action === "WOMPI_INVALID_CDE_INPUT")).toHaveLength(1);
    expect(db.wompiEvents.find((event) => event.id === eventId)?.processed_at).toEqual(expect.any(String));
  });

  it("does not requeue an invalid-DUI Wompi event after terminal processing", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_bad_dui_sweep_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);
    const pipeline = new IssuancePipeline({
      ...(await pipelineEnv(db)),
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await pipeline.processWompiEvent(eventId);
    await pipeline.sweepStalledWompiEvents();

    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId)).toBe(false);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId)).toBe(false);
  });

  it("recovers intent and receipt finalization after post-acceptance auditing fails", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook({ IdTransaccion: "wompi_post_accept_audit_failure" }));
    db.failNextAuditAction = "DTE_ACCEPTED";
    const runtime = await pipelineEnv(db);

    await expect(new IssuancePipeline(runtime).processWompiEvent(eventId)).rejects.toThrow("injected DTE_ACCEPTED audit failure");

    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.documents[0].sello_recibido).toBeTruthy();
    expect(db.documents[0].post_accept_finalized_at ?? null).toBeNull();
    expect(db.donationIntents[0]).toMatchObject({ status: "COMPLETED", document_id: db.documents[0].id });
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.some((audit) => audit.action === "DTE_FAILED")).toBe(false);
    expect(await new Repository(runtime.DB).claimDocumentInvalidation(db.documents[0].id, "must_not_claim_before_finalization")).toBe(false);

    const recovery = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(recovery).toEqual({ finalized: 1, failed: 0 });
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DTE_ACCEPTED")).toHaveLength(1);
  });

  it("lets only one concurrent post-accept finalizer send the definitive receipt", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    let claimAttempts = 0;
    let releaseClaims!: () => void;
    const bothClaimed = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    db.beforePostAcceptFinalizationClaim = async () => {
      claimAttempts += 1;
      if (claimAttempts === 2) releaseClaims();
      await bothClaimed;
    };
    const runtime = await pipelineEnv(db);

    const results = await Promise.all([
      new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations(),
      new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations()
    ]);

    expect(results.reduce((total, result) => total + result.finalized, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
  });

  it("reloads a donor-email correction that commits immediately before finalization ownership", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({
      wompi_event_id: null,
      donor_email: "anterior@example.org",
      post_accept_finalized_at: null
    }));
    db.beforePostAcceptFinalizationClaim = () => {
      db.documents[0].donor_email = "corregido@example.org";
    };
    const runtime = await pipelineEnv(db);

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "corregido@example.org",
      status: "SENT",
      email_type: "dteReceipt"
    }));
  });

  it("sends the definitive accepted receipt even after a manual rejected-document resend", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      wompi_event_id: null,
      status: "REJECTED",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      accepted_at: null,
      post_accept_finalized_at: null
    }));

    const resend = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db)
    );
    expect(resend.status).toBe(200);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      email_type: "dteReceipt",
      document_status_at_send: "REJECTED",
      status: "SENT"
    }));

    Object.assign(db.documents[0], {
      status: "ACCEPTED",
      sello_recibido: "ACCEPTED-AFTER-RETRY",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-14T15:00:00.000Z"
    });

    const finalization = await new IssuancePipeline(await pipelineEnv(db)).retryPendingPostAcceptFinalizations();

    expect(finalization).toEqual({ finalized: 1, failed: 0 });
    expect(db.emailDeliveries.filter((delivery) => delivery.email_type === "dteReceipt")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document_status_at_send: "REJECTED", status: "SENT" }),
        expect.objectContaining({ document_status_at_send: "ACCEPTED", status: "SENT" })
      ])
    );
  });

  it("stops before the email provider when finalization ownership is lost at dispatch", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    db.beforePostAcceptEmailDispatchMark = () => {
      db.documents[0].post_accept_finalization_claim_id = "stolen_owner";
    };
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toEqual([
      expect.objectContaining({
        document_id: "doc_1",
        status: "PENDING",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    ]);
    expect(db.documents[0]).toMatchObject({
      post_accept_finalized_at: null,
      post_accept_finalization_claim_id: "stolen_owner"
    });
    expect(db.documents[0].post_accept_email_dispatch_started_at ?? null).toBeNull();
  });

  it("records a retry-safe NOT_SENT outcome when Cloudflare rejects receipt headers before acceptance", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const providerError = Object.assign(
      new Error("custom header 'Idempotency-Key' is not allowed"),
      { code: "E_HEADER_NOT_ALLOWED" }
    );
    const send = vi.fn(async () => {
      throw providerError;
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      provider_dispatch_started_at: expect.any(String),
      outcome_class: "NOT_SENT",
      failure_code: "E_HEADER_NOT_ALLOWED",
      retry_safe: 1
    }));
  });

  it("records an UNKNOWN manual-review outcome for an internal provider error after dispatch starts", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const providerError = Object.assign(
      new Error("internal provider failure"),
      { code: "E_INTERNAL_SERVER_ERROR" }
    );
    const send = vi.fn(async () => {
      throw providerError;
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      provider_dispatch_started_at: expect.any(String),
      outcome_class: "UNKNOWN",
      failure_code: "E_INTERNAL_SERVER_ERROR",
      retry_safe: 0
    }));
  });

  it("sends an operational alert when an accepted receipt delivery fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const sent: Array<{ to: string; subject: string; text?: string; headers?: Record<string, string> }> = [];
    const send = vi.fn(async (message: unknown) => {
      const outbound = message as (typeof sent)[number];
      sent.push(outbound);
      if (outbound.subject === "Fallo al enviar comprobante") {
        return { messageId: "alert-email-failed" };
      }
      throw new Error("custom header rejected by provider");
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      to: "owner@example.org",
      subject: "Fallo al enviar comprobante",
      text: expect.stringContaining(
        "No se pudo confirmar el resultado del envío con el proveedor."
      )
    });
    expect(sent[1].headers).toBeUndefined();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "EMAIL_FAILED", entity_type: "dte_document", entity_id: "doc_1" })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:EMAIL_FAILED", entity_type: "dte_document", entity_id: "doc_1" })
    );
    const delivery = db.emailDeliveries.find((row) => row.document_id === "doc_1");
    const alertAudit = db.audits.find((row) => row.action === "ALERT_SENT:EMAIL_FAILED");
    expect(JSON.parse(String(alertAudit?.metadata_json))).toEqual({
      incidentId: delivery?.claim_token,
      channel: "email"
    });
  });

  it("recovers finalization after a recorded email failure without redispatching it", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    db.failNextAuditAction = "ADVANCED_CDE_ACCEPTED";
    const send = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const first = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(first).toEqual({ finalized: 0, failed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      email_type: "dteReceipt"
    }));
    expect(db.documents[0].post_accept_finalization_claim_id ?? null).toBeNull();

    const recovery = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(recovery).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
  });

});

// Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
// admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
// está EXCLUIDO, así que un CDE nunca se emite en contingencia. Cuando MH no está
// disponible, la emisión queda diferida (status SIGNED + transmission_deferred_at —
// D1 no permite reconstruir tablas padre de FK para ampliar el CHECK de status):
// el donante recibe de inmediato
// el comprobante TRANSITORIO y el cron de 15 minutos reintenta la transmisión.
describe("deferred transmission when MH is unavailable", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_defer_1",
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

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_defer_evt"): string {
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

  function deferWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_defer_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_defer_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_defer_1" },
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

  // URL-routing fetch stub: MH auth always succeeds; recepciondte behaves per test.
  function stubMhFetch(recepcion: () => Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" });
      }
      if (url.includes("recepciondte")) {
        return recepcion();
      }
      throw new Error(`Fetch inesperado en prueba de transmisión diferida: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // Authentication happens before the legal fiscal POST. This is the only outage
  // class that is safe to defer and retry automatically.
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

  async function deferredEnv(db: InMemoryD1, sent: Array<{ subject: string; to: string; text: string }>): Promise<Env> {
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
          sent.push(message as { subject: string; to: string; text: string });
          return { messageId: `email-${sent.length}` };
        }
      } as SendEmail
    });
  }

  it("defers a Wompi CDE: SIGNED + deferred marker, normal shape, transitorio email, intent untouched", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processWompiEvent(eventId);

    // Deferred state = SIGNED + transmission_deferred_at (no new status value: D1
    // cannot rebuild dte_documents to widen its CHECK constraint).
    expect(record?.status).toBe("SIGNED");
    expect(record?.transmission_deferred_at).toBeTruthy();
    expect(record?.signed_jws).toBeTruthy();
    // NO contingency: no period row, no attachment — the CDE keeps its NORMAL shape.
    expect(db.contingencies).toHaveLength(0);
    expect(record?.contingency_period_id).toBeNull();
    const cde = JSON.parse(String(record!.plain_json)) as {
      identificacion: Record<string, unknown>;
      receptor: Record<string, unknown>;
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.identificacion.tipoModelo).toBe(1);
    // The intent override and gift type survive the deferral unchanged.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_type: "dte_document", entity_id: record!.id })
    );
    // Immediate transitorio email with distinguishing evidence type.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(sent[0].text).toContain("Sello de Recepción");
    // ...but never claims the deferred CDE already carries an MH reception seal.
    expect(sent[0].text).not.toContain("con Sello de Recepción del Ministerio de Hacienda");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: record!.id,
        status: "SENT",
        email_type: "dteReceiptTransitorio",
        document_status_at_send: "SIGNED"
      })
    );
    // The intent completes only on REAL MH acceptance — never at deferral.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("defers a quick/advanced queue CDE instead of marking it FAILED", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_quick_defer"));
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_defer");

    expect(record.status).toBe("SIGNED");
    expect(record.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_id: "doc_quick_defer" })
    );
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
  });

  it("does not resend the transitorio email when a queue redelivery re-defers the same document", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_quick_dedupe"), status: "SIGNED", transmission_deferred_at: "2026-06-26T01:49:00.000Z", signed_jws: "already-signed-jws" });
    // The first delivery attempt already sent the transitorio before the crash/redelivery.
    db.emailDeliveries.push({
      id: "email_prev",
      document_id: "doc_quick_dedupe",
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
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_dedupe");

    expect(sent).toHaveLength(0);
    expect(db.emailDeliveries.filter((row) => row.document_id === "doc_quick_dedupe")).toHaveLength(1);
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.transmission_deferred_at).toBeTruthy();
  });

  it("rejects deferred issuer drift before an unsigned recovery can sign or call MH", async () => {
    const db = new InMemoryD1();
    const document = advancedCdeDraft();
    (document.emisor as Record<string, unknown>).numDocumento = "06142803901122";
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_issuer_drift",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      transmission_deferred_at: new Date().toISOString()
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    const mhFetch = stubMhFetch(() => new Response("MH no disponible", { status: 503 }));
    const signSpy = vi.spyOn(crypto.subtle, "sign");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    expect(result).toEqual({ transmitted: 0, rejected: 0, pending: 1 });
    expect(signSpy).not.toHaveBeenCalled();
    expect(mhFetch).not.toHaveBeenCalled();
    expect(db.documents.find((row) => row.id === "doc_deferred_issuer_drift")).toMatchObject({
      status: "SIGNED",
      signed_jws: null
    });
    expect(errorLog).toHaveBeenCalledWith({
      event: "deferred_transmission_retry_failed",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });

  it("retries a deferred CDE on the sweep: acceptance completes the intent and sends the definitive email", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(deferred?.transmission_deferred_at).toBeTruthy();
    expect(sent).toHaveLength(1);

    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-DEFINITIVO", observaciones: [] }));
    const result = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    expect(result).toMatchObject({ transmitted: 1 });
    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("ACCEPTED");
    expect(doc?.sello_recibido).toBe("SELLO-DEFINITIVO");
    // The marker stays as historical "was deferred at" evidence; leaving SIGNED is
    // what removes the doc from the retry sweep.
    expect(doc?.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // Definitive email: normal receipt copy, PDF now carries the real sello.
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).not.toContain("(en trámite)");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: deferred!.id,
        status: "SENT",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    );
    // REAL acceptance completes the correlated intent.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("COMPLETED");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.document_id).toBe(deferred!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_defer_1" })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED_FINALIZED", entity_type: "dte_document", entity_id: deferred!.id })
    );
  });

  it("records a deferred post-accept email timeout once without a second provider or MH send", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook({
      IdTransaccion: "wompi_deferred_finalization_recovery_tx"
    }), "wompi_deferred_finalization_recovery");
    const sent: Array<{
      subject: string;
      to: string;
      text: string;
      headers?: Record<string, string>;
    }> = [];
    const runtime = await deferredEnv(db, sent);
    let definitiveAttempts = 0;
    runtime.EMAIL = {
      send: async (message: unknown) => {
        const outbound = message as (typeof sent)[number];
        sent.push(outbound);
        if (!outbound.subject.includes("(en trámite)")) {
          definitiveAttempts += 1;
          if (definitiveAttempts === 1) {
            throw new Error("provider timeout after accepting the message");
          }
        }
        return { messageId: `deferred-finalization-${sent.length}` };
      }
    } as SendEmail;

    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(sent).toHaveLength(1);

    const mhRecoveryFetch = stubMhFetch(() => jsonResponse({
      estado: "PROCESADO",
      selloRecibido: "SELLO-DEFERRED-FINALIZATION",
      observaciones: []
    }));
    await new IssuancePipeline(runtime).retryDeferredTransmissions();

    expect(db.documents.find((row) => row.id === deferred!.id)?.status).toBe("ACCEPTED");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("COMPLETED");
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    const failedDelivery = db.emailDeliveries.find(
      (row) => row.document_id === deferred!.id && row.email_type === "dteReceipt"
    );
    expect(failedDelivery).toMatchObject({
      status: "FAILED",
      idempotency_key: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/),
      claim_attempted_at: expect.any(String)
    });
    expect(sent[1].headers).toMatchObject({
      "X-Idempotency-Key": failedDelivery!.idempotency_key
    });
    expect(sent[1].headers).not.toHaveProperty("Message-ID");

    const result = await new IssuancePipeline(runtime).retryAcceptedWompiFinalizations();

    expect(result).toEqual({ finalized: 0, pending: 0 });
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(db.emailDeliveries.filter(
      (row) => row.document_id === deferred!.id && row.email_type === "dteReceipt"
    )).toHaveLength(1);
    expect(failedDelivery).toMatchObject({
      status: "FAILED",
      idempotency_key: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/),
      provider_delivery_id: null
    });
    expect(sent).toHaveLength(2);
    expect(
      mhRecoveryFetch.mock.calls.filter(([input]) => String(input).includes("recepciondte"))
    ).toHaveLength(1);
  });

  it("does not redispatch a deferred CDE after an ambiguous transport failure", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_ambiguous",
      status: "SIGNED",
      signed_jws: "signed-deferred-ambiguous-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      transmission_deferred_at: "2026-07-14T12:00:00.000Z",
      donor_email: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    const fetchMock = stubMhFetch(() => {
      throw new Error("connection reset after request write");
    });

    const first = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(first).toEqual({ transmitted: 0, rejected: 0, pending: 1 });
    expect(db.documents[0].fiscal_operation_claim_id).toMatch(/^fiscal_/);
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const second = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(second).toEqual({ transmitted: 0, rejected: 0, pending: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("keeps the CDE pending without email or audit spam while MH stays down, alerting once after an hour", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(sent).toHaveLength(1); // transitorio
    // Age the DEFERRAL beyond the one-hour alert threshold (the alert is measured
    // from transmission_deferred_at, not from document creation).
    const doc = db.documents.find((row) => row.id === deferred!.id)!;
    doc.transmission_deferred_at = "2026-06-26T00:00:00.000Z";

    const first = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(first).toMatchObject({ transmitted: 0, pending: 1 });
    expect(db.documents.find((row) => row.id === deferred!.id)?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === deferred!.id)?.transmission_deferred_at).toBeTruthy();
    // One backlog alert (transitorio + alert = 2 sends), deduped on the next tick.
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);

    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);
    // No per-tick audit noise: the deferral audit stays singular, no accepted/rejected audits.
    expect(db.audits.filter((row) => row.action === "DTE_TRANSMISSION_DEFERRED")).toHaveLength(1);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_ACCEPTED" }));
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_REJECTED" }));
  });

  it("marks a deferred CDE REJECTED through the normal rejected path when MH rejects it on retry", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);

    stubMhFetch(() => jsonResponse({ estado: "RECHAZADO", observaciones: ["Firma inválida"] }));
    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("REJECTED");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_REJECTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // No definitive email on rejection; the intent stays open for the operator rebuild.
    expect(sent).toHaveLength(1);
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).not.toBe("COMPLETED");
  });

  it("runs the deferred-transmission retry on the 15-minute cron tick", async () => {
    const db = new InMemoryD1();
    const codigoGeneracion = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const document = buildCdeDocument(
      wompiSample as unknown as WompiWebhook,
      emisorConfig(),
      { sequence: 73, codigoGeneracion, environment: "00" }
    );
    db.documents.push({
      ...testDocument(),
      id: "doc_sched_defer",
      wompi_event_id: null,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000073",
      plain_json: JSON.stringify(document),
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      donor_email: null
    });

    // Mock mode: MH accepts without network. The cron must pick the pending doc up.
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));

    expect(db.documents.find((row) => row.id === "doc_sched_defer")?.status).toBe("ACCEPTED");
  });

  it("finalizes an accepted Wompi CDE missing its completion marker on the 15-minute cron without retransmitting", async () => {
    const db = new InMemoryD1();
    const eventId = seedWompiEvent(db, deferWebhook({
      IdTransaccion: "wompi_scheduled_finalization_tx",
      IdExterno: undefined,
      EnlacePago: undefined
    }), "wompi_scheduled_finalization");
    db.documents.push({
      ...testDocument(),
      id: "doc_scheduled_finalization",
      wompi_event_id: eventId,
      status: "ACCEPTED",
      sello_recibido: "SELLO-SCHEDULED-FINALIZATION",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T18:00:00.000Z",
      donor_email: null,
      post_accept_finalized_at: null
    });
    const transmit = vi
      .spyOn(MhClient.prototype, "transmitDte")
      .mockRejectedValue(new Error("accepted finalization sweep must not call MH"));

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env(db)
    );

    expect(transmit).not.toHaveBeenCalled();
    expect(db.audits.filter(
      (row) => row.action === "DTE_ACCEPTED_FINALIZED" && row.entity_id === "doc_scheduled_finalization"
    )).toHaveLength(1);
    expect(db.audits.filter(
      (row) => row.action === "EMAIL_SKIPPED" && row.entity_id === "doc_scheduled_finalization"
    )).toHaveLength(1);
  });

  it("lists FAILED and REJECTED under the combined Fallos filter while a deferred SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      {
        ...testDocument(),
        id: "doc_failed_list",
        codigo_generacion: "CCCCCCC3-CCCC-4CCC-8CCC-CCCCCCCCCCC3",
        numero_control: "DTE-15-M001P004-000000000000803",
        status: "FAILED",
        created_at: "2026-06-26T01:50:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_rejected_list",
        codigo_generacion: "DDDDDDD4-DDDD-4DDD-8DDD-DDDDDDDDDDD4",
        numero_control: "DTE-15-M001P004-000000000000804",
        status: "REJECTED",
        created_at: "2026-06-26T01:51:00.000Z"
      },
      // A deferred SIGNED doc (En trámite) must NOT leak into Fallos — that exclusion
      // is a deliberate product decision (it is awaiting transmission, not failed).
      {
        ...testDocument(),
        id: "doc_deferred_excluded",
        codigo_generacion: "FFFFFFF6-FFFF-4FFF-8FFF-FFFFFFFFFFF6",
        numero_control: "DTE-15-M001P004-000000000000806",
        status: "SIGNED",
        transmission_deferred_at: "2026-06-26T01:52:00.000Z",
        created_at: "2026-06-26T01:52:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=FAILED,REJECTED", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_rejected_list", "doc_failed_list"]);
  });

  it("lists accepted receipt failures under the server-side attention filter until a later send succeeds", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      {
        ...testDocument(),
        id: "doc_fiscal_failed_attention",
        codigo_generacion: "AAAAAAA1-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
        numero_control: "DTE-15-M001P004-000000000000811",
        status: "FAILED",
        created_at: "2026-07-17T11:01:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_fiscal_rejected_attention",
        codigo_generacion: "BBBBBBB2-BBBB-4BBB-8BBB-BBBBBBBBBBB2",
        numero_control: "DTE-15-M001P004-000000000000812",
        status: "REJECTED",
        created_at: "2026-07-17T11:02:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_failed_attention",
        codigo_generacion: "CCCCCCC3-CCCC-4CCC-8CCC-CCCCCCCCCCC3",
        numero_control: "DTE-15-M001P004-000000000000813",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:03:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_recovered_attention",
        codigo_generacion: "DDDDDDD4-DDDD-4DDD-8DDD-DDDDDDDDDDD4",
        numero_control: "DTE-15-M001P004-000000000000814",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:04:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_pending_attention",
        codigo_generacion: "EEEEEEE5-EEEE-4EEE-8EEE-EEEEEEEEEEE5",
        numero_control: "DTE-15-M001P004-000000000000815",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:05:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_deferred_attention",
        codigo_generacion: "FFFFFFF6-FFFF-4FFF-8FFF-FFFFFFFFFFF6",
        numero_control: "DTE-15-M001P004-000000000000816",
        status: "SIGNED",
        transmission_deferred_at: "2026-07-17T11:06:00.000Z",
        created_at: "2026-07-17T11:06:00.000Z"
      }
    );
    db.emailDeliveries.push(
      {
        id: "delivery_failed_latest",
        document_id: "doc_receipt_failed_attention",
        email_type: "dteReceipt",
        status: "FAILED",
        outcome_class: "UNKNOWN",
        failure_code: "E_INTERNAL_SERVER_ERROR",
        retry_safe: 0,
        provider_response_json: JSON.stringify({ error: "provider rejected" }),
        created_at: "2026-07-17T11:06:00.000Z"
      },
      {
        id: "delivery_recovered_old_failure",
        document_id: "doc_receipt_recovered_attention",
        email_type: "dteReceipt",
        status: "FAILED",
        provider_response_json: JSON.stringify({ error: "provider rejected" }),
        created_at: "2026-07-17T11:06:00.000Z"
      },
      {
        id: "delivery_recovered_latest_success",
        document_id: "doc_receipt_recovered_attention",
        email_type: "dteReceipt",
        status: "SENT",
        provider_response_json: JSON.stringify({ provider: "cloudflare-email" }),
        created_at: "2026-07-17T11:07:00.000Z"
      },
      {
        id: "delivery_pending_post_dispatch",
        document_id: "doc_receipt_pending_attention",
        email_type: "dteReceipt",
        status: "PENDING",
        provider_dispatch_started_at: "2026-07-17T11:08:00.000Z",
        provider_response_json: "{}",
        created_at: "2026-07-17T11:08:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?attention=failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      documents: Array<{
        id: string;
        status: string;
        receipt_email_status?: string | null;
        receipt_email_outcome_class?: string | null;
        receipt_email_failure_code?: string | null;
        receipt_email_requires_review?: number | null;
      }>;
    };
    expect(body.documents.map((document) => document.id)).toEqual([
      "doc_receipt_pending_attention",
      "doc_receipt_failed_attention",
      "doc_fiscal_rejected_attention",
      "doc_fiscal_failed_attention"
    ]);
    expect(body.documents.find((document) => document.id === "doc_receipt_failed_attention")).toMatchObject({
      status: "ACCEPTED",
      receipt_email_status: "FAILED",
      receipt_email_outcome_class: "UNKNOWN",
      receipt_email_failure_code: "E_INTERNAL_SERVER_ERROR"
    });
    expect(body.documents.find((document) => document.id === "doc_receipt_pending_attention")).toMatchObject({
      status: "ACCEPTED",
      receipt_email_status: "PENDING",
      receipt_email_requires_review: 1
    });
  });

  it("surfaces deferred docs as En trámite (virtual filter) while a plain SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Deferred: SIGNED + marker → listed under the virtual TRANSMISSION_PENDING filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_list",
      codigo_generacion: "AAAAAAA1-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
      numero_control: "DTE-15-M001P004-000000000000801",
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null
    });
    // Plain SIGNED (mid-pipeline transient, NOT deferred) → excluded from the filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_plain_signed",
      codigo_generacion: "BBBBBBB2-BBBB-4BBB-8BBB-BBBBBBBBBBB2",
      numero_control: "DTE-15-M001P004-000000000000802",
      status: "SIGNED",
      transmission_deferred_at: null,
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=TRANSMISSION_PENDING", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_deferred_list"]);
  });
});
