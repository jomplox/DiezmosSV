import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument } from "../../src/worker/domain/dteBuilder";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { MhClient } from "../../src/worker/services/mhClient";
import { previousElSalvadorMonth } from "../../src/worker/services/retention";
import { Repository } from "../../src/worker/storage/repository";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env, IssuanceMessage, WompiWebhook } from "../../src/worker/types";
import {
  analyticsDocumentRow,
  analyticsIntentRow,
  authedDb,
  env,
  FakeArchiveBucket,
  InMemoryD1
} from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import {
  advancedCdeDraft,
  advancedFailingDocument,
  emisorConfig,
  generatedCertificateXml
} from "./support/dteFixtures";
import { TEST_RESEND_REQUEST_ID } from "./support/documentDeliveryFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();





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

describe("audit pagination", () => {
  it("pages the audit list by keyset cursor with a stable order", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    for (let i = 0; i < 7; i++) {
      db.audits.push({
        id: `audit_${String(i).padStart(3, "0")}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "DTE_ACCEPTED",
        entity_type: "dte_document",
        entity_id: `doc_${i}`,
        summary: `fila ${i}`,
        metadata_json: "{}",
        actor_ip: null,
        actor_context: null,
        created_at: `2026-07-0${(i % 7) + 1}T10:00:00.000Z`
      });
    }

    const first = await worker.fetch(
      new Request("https://example.org/api/audit?limit=3", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { audit: Array<{ id: string; created_at: string }>; nextCursor: string | null };
    expect(page1.audit).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first.
    expect(page1.audit[0].created_at >= page1.audit[1].created_at).toBe(true);

    const second = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page2 = (await second.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.audit).toHaveLength(3);
    // No overlap between pages.
    const ids1 = new Set(page1.audit.map((row) => row.id));
    expect(page2.audit.every((row) => !ids1.has(row.id))).toBe(true);

    const third = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page2.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page3 = (await third.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page3.audit).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("pipeline failure alerts", () => {
  it("sends an operational alert when a Wompi-triggered DTE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_alert_tx_1",
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

    const webhookResponse = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const { wompiEventId } = (await webhookResponse.json()) as { wompiEventId: string };

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-dte-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails before reaching MH,
      // deterministically driving the DTE into the FAILED path.
    });

    await expect(new IssuancePipeline(pipelineEnv).processWompiEvent(wompiEventId)).rejects.toThrow();

    const failedDocument = db.documents.find((document) => document.wompi_event_id === wompiEventId);
    expect(failedDocument?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_FAILED", entity_id: failedDocument!.id }));
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:DTE_FAILED", entity_type: "dte_document", entity_id: failedDocument!.id })
    );
  });

  it("sends an operational alert when an advanced CDE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail"));

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-advanced-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails deterministically.
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail")).rejects.toThrow();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail" }));
    expect(sentAlerts).toHaveLength(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail" })
    );
  });

  it("does not fail the pipeline when the alert email provider throws", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_alert_error"));

    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async () => {
          throw new Error("destination address is not a verified address");
        }
      } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_alert_error")).rejects.toThrow();

    const document = db.documents.find((doc) => doc.id === "doc_advanced_fail_alert_error");
    expect(document?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail_alert_error" }));
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail_alert_error" })
    );
  });

  it("does not send a duplicate alert for a document that fails twice", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_twice"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_twice",
        "advanced_attempt_twice"
      )
    ).rejects.toThrow();
    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_twice",
        "advanced_attempt_twice"
      )
    ).rejects.toThrow();

    expect(sentAlerts).toHaveLength(1);
  });

  it("sends another alert when a later advanced issuance attempt fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_later"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_later",
        "advanced_attempt_first"
      )
    ).rejects.toThrow();
    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_later",
        "advanced_attempt_second"
      )
    ).rejects.toThrow();

    expect(sentAlerts).toHaveLength(2);
  });

  it("does not send an alert when alert_email is unset", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_advanced_fail_no_alert_email"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_no_alert_email")).rejects.toThrow();

    expect(sentAlerts).toHaveLength(0);
  });
});

describe("advanced DTE queue idempotency", () => {
  it("does not let a late signer reopen and retransmit an already accepted CDE", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_sign_race",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    db.beforeDocumentRead = async () => {
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
    };
    let signedUpdates = 0;
    let releaseLateSigner!: () => void;
    const firstPipelineCompleted = new Promise<void>((resolve) => {
      releaseLateSigner = resolve;
    });
    db.beforeDocumentSignedUpdate = async () => {
      signedUpdates += 1;
      if (signedUpdates === 2) await firstPipelineCompleted;
    };
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password"
    });
    const first = new IssuancePipeline(runtime).processDteDocument("doc_advanced_sign_race");
    const second = new IssuancePipeline(runtime).processDteDocument("doc_advanced_sign_race");

    await Promise.race([first, second]);
    releaseLateSigner();
    const results = await Promise.all([first, second]);

    expect(results.every((record) => record.status === "ACCEPTED")).toBe(true);
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.documents[0].sello_recibido).toBeTruthy();
  });

  it.each([408, 429, 500, 503, 521])("does not redispatch a queue CDE after an ambiguous MH %i response", async (status) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_ambiguous",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(new Response("MH unavailable", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_ambiguous")
    ).rejects.toThrow(`Ministerio de Hacienda no disponible: ${status}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const redelivery = await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_ambiguous");
    expect(redelivery.status).toBe("SIGNED");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("does not redispatch a queue CDE after an empty HTTP 200 without a terminal MH verdict", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_empty_200",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-empty-200-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_empty_200")
    ).rejects.toThrow("resultado no definitivo");
    expect(db.documents[0].fiscal_operation_claim_id).toEqual(expect.stringMatching(/^fiscal_/));
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const redelivery = await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_empty_200");
    expect(redelivery.fiscal_operation_claim_id).toBe(db.documents[0].fiscal_operation_claim_id);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it.each([
    [{ estado: "NO PROCESADO", selloRecibido: "CONTRADICTORY-SEAL" }, "NO PROCESADO"],
    [{ estado: "RECHAZADO", selloRecibido: "CONTRADICTORY-SEAL" }, "RECHAZADO"],
    [{ estado: "PROCESADO", selloRecibido: null }, "PROCESADO"]
  ])("retains the fiscal claim for contradictory MH HTTP 200 verdict %s", async (mhBody, expectedState) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_contradictory_200",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-contradictory-200-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse(mhBody));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_contradictory_200")
    ).rejects.toThrow(`resultado no definitivo: ${expectedState}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_contradictory_200");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it.each([
    [302, null, "RECIBIDO"],
    [400, { estado: "PROCESADO", selloRecibido: "CONTRADICTORY-SEAL" }, "PROCESADO"],
    [400, { estado: "RECHAZADO", selloRecibido: "CONTRADICTORY-SEAL" }, "RECHAZADO"],
    [422, "not-json", "RECIBIDO"]
  ])("retains the fiscal claim for non-definitive MH HTTP %i response", async (status, mhBody, expectedState) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_nondefinitive_http",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-nondefinitive-http-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const mhResponse = typeof mhBody === "string"
      ? new Response(mhBody, { status })
      : mhBody === null
        ? new Response("", { status })
        : jsonResponse(mhBody, { status });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(mhResponse);
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_nondefinitive_http")
    ).rejects.toThrow(`resultado no definitivo: ${expectedState}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_nondefinitive_http");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("rejects persisted issuer drift before signing an advanced CDE", async () => {
    const db = new InMemoryD1();
    const document = advancedCdeDraft();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_issuer_drift",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(document),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const persisted = JSON.parse(db.documents[0].plain_json) as Record<string, any>;
    persisted.emisor.numDocumento = "06142803901122";
    db.documents[0].plain_json = JSON.stringify(persisted);
    const mhFetch = vi.fn(async () => new Response("MH must not be called", { status: 500 }));
    vi.stubGlobal("fetch", mhFetch);

    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_issuer_drift")
    ).rejects.toThrow(/emisor/i);

    expect(db.documents[0].signed_jws).toBeNull();
    expect(mhFetch).not.toHaveBeenCalled();
    expect(db.audits).toContainEqual(
      expect.objectContaining({
        action: "ADVANCED_CDE_FAILED",
        entity_type: "dte_document",
        entity_id: "doc_advanced_issuer_drift"
      })
    );
  });

  it("does not re-transmit an already ACCEPTED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_accepted",
      wompi_event_id: null,
      status: "ACCEPTED",
      signed_jws: "signed-jws",
      sello_recibido: "SELLO-EXISTING",
      accepted_at: "2026-06-26T01:46:48.000Z"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_accepted");

    // Terminal document returned untouched: no re-sign, no re-transmit, verdict preserved.
    expect(record.status).toBe("ACCEPTED");
    expect(record.sello_recibido).toBe("SELLO-EXISTING");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(0);
    expect(db.audits.filter((row) => row.action === "EMAIL_SENT")).toHaveLength(0);
  });

  it("does not re-process an INVALIDATED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_invalidated",
      wompi_event_id: null,
      status: "INVALIDATED",
      signed_jws: "signed-jws"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_invalidated");

    expect(record.status).toBe("INVALIDATED");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED" || row.action === "ADVANCED_CDE_REJECTED")).toHaveLength(0);
  });

  it("does not flip an accepted advanced CDE to FAILED when post-acceptance bookkeeping throws", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_advanced_postfail"), signed_jws: "signed-jws" });
    // Make the ADVANCED_CDE_ACCEPTED audit write throw once, AFTER MH has accepted and
    // the row has already been marked ACCEPTED, forcing the catch path.
    const realPrepare = db.prepare.bind(db);
    let failNextAudit = true;
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes("INSERT INTO audit_logs") && failNextAudit) {
        failNextAudit = false;
        stmt.run = async () => {
          throw new Error("audit write failed");
        };
      }
      return stmt;
    };

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_postfail");

    // The MH acceptance seal survives: never overwritten with FAILED.
    expect(record.status).toBe("ACCEPTED");
    expect(db.documents.find((row) => row.id === "doc_advanced_postfail")?.status).toBe("ACCEPTED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
  });
});

describe("DTE transmission claim", () => {
  it("lets only one of two nonterminal deliveries call MH", async () => {
    const db = new InMemoryD1();
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const document = buildCdeDocument(
      wompiSample as unknown as WompiWebhook,
      emisorConfig(),
      { sequence: 71, codigoGeneracion, environment: "00" }
    );
    db.documents.push(testDocument({
      id: "dte_concurrent_transmission",
      wompi_event_id: null,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000071",
      plain_json: JSON.stringify(document),
      status: "SIGNED",
      signed_jws: "stable-signed-jws",
      sello_recibido: null,
      accepted_at: null
    }));
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      await providerGate;
      return {
        accepted: true,
        estado: "PROCESADO",
        selloRecibido: "SELLO-CONCURRENT-CLAIM",
        observaciones: [],
        raw: { estado: "PROCESADO" }
      };
    });
    const runtime = env(db, { MOCK_EXTERNAL_SERVICES: "true" });

    const processing = Promise.all([
      new IssuancePipeline(runtime).processDteDocument("dte_concurrent_transmission"),
      new IssuancePipeline(runtime).processDteDocument("dte_concurrent_transmission")
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const callsBeforeRelease = transmit.mock.calls.length;
    release();
    await processing;

    expect(callsBeforeRelease).toBe(1);
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-CLAIM"
    });
  });

  it("does not let a late divergent result replace a terminal verdict or seal", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({
      id: "dte_terminal_result_guard",
      status: "SIGNED",
      signed_jws: "stable-signed-jws",
      sello_recibido: null,
      accepted_at: null
    }));
    const repo = new Repository(db as unknown as D1Database);

    const claimId = "fiscal-terminal-winner";
    await expect(repo.claimDocumentTransmission(
      "dte_terminal_result_guard",
      "SIGNED",
      "stable-signed-jws",
      claimId
    )).resolves.toBe(true);
    await expect(repo.completeDocumentTransmission("dte_terminal_result_guard", claimId, {
      status: "ACCEPTED",
      sello: "SELLO-WINNER",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:05:00.000Z"
    })).resolves.toBe(true);
    await expect(repo.completeDocumentTransmission("dte_terminal_result_guard", claimId, {
      status: "REJECTED",
      sello: null,
      mhEstado: "RECHAZADO",
      observaciones: ["late loser"],
      acceptedAt: null
    })).resolves.toBe(false);

    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-WINNER",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T20:05:00.000Z"
    });
  });

  it("does not auto-transmit a claimed SIGNED row whose fiscal outcome needs reconciliation", async () => {
    const db = new InMemoryD1();
    // A worker crash between claiming the transmission and recording MH's verdict
    // leaves the row SIGNED with the fiscal claim still attached. The sweep must
    // leave it for reconciliation instead of risking a duplicate fiscal POST.
    db.documents.push(testDocument({
      id: "dte_claimed_crash_gap",
      wompi_event_id: null,
      status: "SIGNED",
      signed_jws: "claimed-signed-jws",
      sello_recibido: null,
      accepted_at: null,
      donor_email: null,
      transmission_deferred_at: "2026-07-13T20:00:00.000Z",
      fiscal_operation_claim_id: "fiscal-claim-crash",
      fiscal_operation_claimed_at: "2026-07-13T20:01:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));

    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-REBUILT-SWEEP",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const result = await new IssuancePipeline(env(db, {
      MOCK_EXTERNAL_SERVICES: "true"
    })).retryDeferredTransmissions();

    expect(result).toEqual({ transmitted: 0, rejected: 0, pending: 0 });
    expect(transmit).not.toHaveBeenCalled();
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      sello_recibido: null,
      fiscal_operation_claim_id: "fiscal-claim-crash"
    });
  });
});

describe("issuance dead-letter and stalled-event sweep", () => {
  function deadLetterBatch(body: IssuanceMessage, queueName: string) {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: queueName,
      messages: [{ id: "msg_1", timestamp: new Date(), body, attempts: 3, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>;
    return { batch, ack, retry };
  }

  function stalledWompiEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "wompi_stalled",
      transaction_id: "TX-STALLED-1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donante@example.org",
      donor_name: "Donante",
      raw_body: "{}",
      processed_at: null,
      created_document_id: null,
      received_at: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  it("persists four pre-CDE failures before dead-lettering the reserved identifiers", async () => {
    const db = new InMemoryD1();
    db.nextSequence = 31;
    const eventId = "wompi_bad_country";
    const webhook = {
      ...wompiSample,
      IdTransaccion: "wompi_bad_country_tx",
      Cliente: {
        ...wompiSample.Cliente,
        CodigoPais: "ZZ"
      }
    };
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: webhook.IdTransaccion,
      raw_body: JSON.stringify(webhook)
    }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const { batch, ack, retry } = deadLetterBatch(
        { wompiEventId: eventId },
        "diezmossv-staging-issuance-example"
      );

      await worker.queue(batch, runtime);

      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(1);
    }

    const { batch: deadLetter, ack } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example-dlq"
    );
    await worker.queue(deadLetter, runtime);

    const event = db.wompiEvents.find((row) => row.id === eventId);
    expect(event).toMatchObject({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_count: 4,
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: expect.stringContaining("CAT-020 País")
    });
    expect(event?.control_sequence).toBeNull();
    expect(db.nextSequence).toBe(31);
    expect(db.audits.filter((row) => row.action === "WOMPI_ISSUANCE_FAILED" && row.entity_id === eventId)).toHaveLength(4);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("never persists or exposes arbitrary secret-bearing queue errors", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const eventId = "wompi_unsafe_failure";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_unsafe_failure_tx"
    }));
    const unsafe = new Error(
      "Bearer sk-live-secret private-victim@example.net $123.45 " +
      "https://internal.example/retry\n    at retryIssuance (worker.ts:1:1)"
    );
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent").mockRejectedValue(unsafe);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, retry } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(retry).toHaveBeenCalledTimes(1);
    const event = db.wompiEvents.find((row) => row.id === eventId);
    expect(event).toMatchObject({
      issuance_status: "FAILED",
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "Fallo de emisión sin detalle"
    });
    const audit = db.audits.find(
      (row) => row.action === "WOMPI_ISSUANCE_FAILED" && row.entity_id === eventId
    );
    expect(audit).toMatchObject({
      summary: "Fallo de emisión sin detalle",
      metadata_json: JSON.stringify({ code: "ISSUANCE_ERROR" })
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain("sk-live-secret");
    expect(responseText).not.toContain("private-victim@example.net");
    expect(responseText).not.toContain("$123.45");
    expect(responseText).not.toContain("https://internal.example");
    expect(responseText).not.toContain("retryIssuance");
    expect(responseText).toContain("Fallo de emisión sin detalle");
  });

  it("resumes a stored nonterminal Wompi document without changing its identifiers or JSON", async () => {
    const db = new InMemoryD1();
    db.nextSequence = 32;
    const eventId = "wompi_resume_stored";
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const numeroControl = "DTE-15-M001P004-000000000000031";
    const webhook = {
      ...wompiSample,
      IdTransaccion: "wompi_resume_stored_tx",
      IdExterno: undefined,
      EnlacePago: undefined
    } as WompiWebhook;
    const plainDocument = buildCdeDocument(webhook, emisorConfig(), {
      sequence: 31,
      codigoGeneracion,
      environment: "00",
      issuedAt: new Date("2026-07-13T10:00:00-06:00")
    });
    const plainJson = JSON.stringify(plainDocument);
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: webhook.IdTransaccion,
      raw_body: JSON.stringify(webhook),
      issuance_status: "FAILED",
      control_prefix: "M001P004",
      control_sequence: 31,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    }));
    db.documents.push(testDocument({
      id: "dte_resume_stored",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: numeroControl,
      status: "SIGNED",
      plain_json: plainJson,
      signed_jws: "stored-jws",
      sello_recibido: null,
      mh_estado: null,
      donor_email: null,
      accepted_at: null
    }));

    const record = await new IssuancePipeline(env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
    })).processWompiEvent(eventId);

    expect(record).toMatchObject({
      id: "dte_resume_stored",
      status: "ACCEPTED",
      numero_control: numeroControl,
      codigo_generacion: codigoGeneracion,
      plain_json: plainJson
    });
    expect(db.documents).toHaveLength(1);
    expect(db.nextSequence).toBe(32);
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      created_document_id: "dte_resume_stored",
      issuance_status: "DOCUMENT_CREATED"
    });
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED", entity_id: "dte_resume_stored" })
    );
    expect(db.audits).not.toContainEqual(
      expect.objectContaining({ action: "ADVANCED_CDE_ACCEPTED", entity_id: "dte_resume_stored" })
    );
  });

  it("audits and acks dead-lettered issuance messages", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_dead",
      transaction_id: "wompi_dead_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    const { batch, ack, retry } = deadLetterBatch({ wompiEventId: "wompi_dead" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead" })
    );
  });

  it("ignores a delayed DLQ from an older attempt without overwriting the current retry", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_stale_dlq";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_stale_dlq_tx",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_last_attempt_at: "2026-07-13T22:10:00.000Z",
      issuance_failed_at: "2026-07-13T22:00:00.000Z"
    }));
    const { batch, ack } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-old" } as IssuanceMessage,
      "diezmossv-staging-issuance-example-dlq"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_dead_lettered_at: null
    });
    expect(db.audits).not.toContainEqual(expect.objectContaining({
      action: "ISSUANCE_DEAD_LETTERED",
      entity_id: eventId
    }));
  });

  it("records bounded fallback evidence when the current attempt hard-terminates without an error", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const eventId = "wompi_hard_termination";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_hard_termination_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: null,
      issuance_error_message: null,
      issuance_last_attempt_at: "2026-07-13T22:10:00.000Z"
    }));
    const { batch, ack } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-current" } as IssuanceMessage,
      "diezmossv-staging-issuance-example-dlq"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "ISSUANCE_RETRIES_EXHAUSTED",
      issuance_error_message: "El mensaje de emisión agotó sus reintentos antes de crear el CDE."
    });
    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const body = await response.json() as { failures: Array<Record<string, unknown>> };
    expect(body.failures).toContainEqual(expect.objectContaining({
      id: eventId,
      issuance_status: "DEAD_LETTERED",
      issuance_error_code: "ISSUANCE_RETRIES_EXHAUSTED"
    }));
  });

  it("claims tokenless legacy deliveries into one deterministic legacy attempt", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_legacy_message";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_legacy_message_tx",
      issuance_status: null,
      issuance_attempt_id: null
    }));
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent")
      .mockRejectedValue(new Error("legacy failure"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, retry } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "FAILED",
      issuance_attempt_id: `legacy:${eventId}`,
      issuance_error_code: "ISSUANCE_ERROR"
    });
  });

  it("acks a failure from an attempt that became stale while processing", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_stale_failure";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_stale_failure_tx",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-old",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "Error anterior"
    }));
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent").mockImplementation(async () => {
      db.wompiEvents[0].issuance_status = "RETRY_QUEUED";
      db.wompiEvents[0].issuance_attempt_id = "attempt-new";
      throw new Error("late old failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, ack, retry } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-old" },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-new",
      issuance_error_message: "Error anterior"
    });
    expect(db.audits).not.toContainEqual(expect.objectContaining({
      action: "WOMPI_ISSUANCE_FAILED",
      entity_id: eventId
    }));
  });

  it("emits dead-letter audit and alert only for the winning current transition", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const eventId = "wompi_current_dlq_once";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_current_dlq_once_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current"
    }));
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-current-dlq" };
        }
      } as SendEmail
    });

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const { batch, ack } = deadLetterBatch(
        { wompiEventId: eventId, issuanceAttemptId: "attempt-current" },
        "diezmossv-staging-issuance-example-dlq"
      );
      await worker.queue(batch, runtime);
      expect(ack).toHaveBeenCalledTimes(1);
    }

    expect(db.audits.filter(
      (row) => row.action === "ISSUANCE_DEAD_LETTERED" && row.entity_id === eventId
    )).toHaveLength(1);
    expect(db.audits.filter(
      (row) => row.action === "ALERT_SENT:ISSUANCE_DEAD_LETTERED" && row.entity_id === eventId
    )).toHaveLength(1);
    expect(sentAlerts).toHaveLength(1);
  });

  it("sends an operational alert for a dead-lettered issuance message", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_dead_alert",
      transaction_id: "wompi_dead_alert_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const { batch } = deadLetterBatch({ wompiEventId: "wompi_dead_alert" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(
      batch,
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message as { to: string; subject: string });
            return { messageId: "alert-dead-letter" };
          }
        } as SendEmail
      })
    );

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead_alert" })
    );
  });

  it("re-enqueues an approved wompi event stuck without a document for over an hour", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toEqual([{
      wompiEventId: "wompi_stalled",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_EVENT_REQUEUED", entity_id: "wompi_stalled" })
    );
  });

  it("does not touch recent or already-processed events", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_fresh", received_at: new Date().toISOString() }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_done", created_document_id: "dte_1" }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_declined", result: "Rechazada" }));

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(0);
  });

  it("recovers stale queued or processing retries using the last-attempt cutoff", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_retry_stale",
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-retry-stale",
      issuance_last_attempt_at: "2026-01-01T00:04:00.000Z"
    }));
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_processing_stale",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-processing-stale",
      issuance_last_attempt_at: "2026-01-01T00:04:00.000Z"
    }));
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_retry_fresh",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-retry-fresh",
      issuance_last_attempt_at: new Date().toISOString()
    }));

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(2);
    expect(queued).toEqual(expect.arrayContaining([
      { wompiEventId: "wompi_retry_stale", issuanceAttemptId: expect.any(String) },
      { wompiEventId: "wompi_processing_stale", issuanceAttemptId: expect.any(String) }
    ]));
    expect(queued).not.toContainEqual({ wompiEventId: "wompi_retry_fresh" });
  });

  it("ignores historical requeue audits from before the current retry epoch", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const eventId = "wompi_retry_new_epoch";
    db.wompiEvents.push(stalledWompiEvent({
      id: eventId,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-new-epoch",
      issuance_last_attempt_at: "2026-06-01T00:00:00.000Z"
    }));
    for (let index = 0; index < 3; index += 1) {
      db.audits.push({
        id: `audit_historical_${index}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: eventId,
        summary: "",
        metadata_json: "{}",
        created_at: `2026-05-0${index + 1}T00:00:00.000Z`
      });
    }

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toEqual([{
      wompiEventId: eventId,
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.audits.filter(
      (audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId
    )).toHaveLength(4);
  });

  it("caps three requeues from the current retry epoch and raises the stalled alert", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const eventId = "wompi_retry_current_epoch";
    db.wompiEvents.push(stalledWompiEvent({
      id: eventId,
      processed_at: null,
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current-epoch",
      issuance_last_attempt_at: "2026-06-01T00:00:00.000Z"
    }));
    for (let index = 0; index < 3; index += 1) {
      db.audits.push({
        id: `audit_current_${index}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: eventId,
        summary: "",
        metadata_json: "{}",
        created_at: `2026-06-0${index + 1}T00:00:00.000Z`
      });
    }

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(0);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "WOMPI_EVENT_STALLED",
      entity_id: eventId
    }));
  });

  it("gives up after three requeues and flags the event exactly once", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(queued).toHaveLength(0);
    const stalledAudits = db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === "wompi_stalled");
    expect(stalledAudits).toHaveLength(1);
  });

  it("sends a single operational alert even across repeated 15-minute cron runs", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled" };
        }
      } as SendEmail
    });

    // Simulate three consecutive 15-minute cron ticks after the event is already flagged stalled.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
  });

  it("retries the operational alert on a later tick after the first send attempt fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    let attempt = 0;
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("recipient rejected before acceptance"), {
              code: "E_RECIPIENT_NOT_ALLOWED"
            });
          }
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled-retry" };
        }
      } as SendEmail
    });

    // Tick 1: the provider proves rejection before acceptance, so the same incident
    // remains safe to retry on a later tick.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
    expect(db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED")).toHaveLength(1);

    // Tick 2: email provider succeeds — the alert must be retried (not permanently
    // suppressed by the WOMPI_EVENT_STALLED audit from tick 1) and now sends.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );

    // Tick 3: alert already sent — sendOperationalAlert's own dedupe prevents a resend.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
  });
});

function queuedNoop(_message: IssuanceMessage): void {
  // Sweep should not requeue once an event has already been flagged stalled.
}

describe("scheduled cron dispatch", () => {
  it("routes the monthly retention cron to the retention export, not the 15-minute sweeps", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    // Retention export ran (audited), and the 15-minute sweep logic (which
    // would have requeued the stalled Wompi event) did not run.
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(true);
    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED")).toBe(false);
  });

  it("routes the 15-minute cron to the existing sweeps, not the retention export", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    expect(queued).toEqual([{
      wompiEventId: "wompi_stalled",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(false);
  });

  it("isolates a retention export failure so it never throws out of scheduled()", async () => {
    const db = new InMemoryD1();
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));
    const scheduledEnv = env(db, { ARCHIVE: archive as unknown as R2Bucket });

    await expect(
      worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_FAILED" }));
  });
});

describe("certificate expiry alerts (15-minute cron)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the expiry date in Spanish and counts days remaining in the alert copy", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 2026-07-11
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expiring-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("vence el 11/07/2026");
      expect(alert.text).toContain("Quedan 10 día(s)");
      expect(alert.text).not.toContain(expiresAt.toISOString());
    }
  });

  it("words an already-expired certificate as 'venció hace N días' instead of a negative countdown", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // already expired 5 days ago
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expired-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("venció hace 5 días");
      expect(alert.text).not.toContain("Quedan -5");
    }
  });

  it("sends a CERT_EXPIRING alert once per threshold crossed and never duplicates on repeated ticks", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 10 days out: crosses 30 and 14 thresholds, not 3
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-cert-expiring" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(2);
    expect(sentAlerts.every((alert) => alert.to === "owner@example.org")).toBe(true);
    const expiryIso = expiresAt.toISOString();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:30` })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:14` })
    );
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(2);
  });

  it("does not alert when more than 30 days remain before expiry", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });

  it("re-arms alerts for a renewed certificate because the dedupe key includes the expiry date", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const oldExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    db.audits.push({
      id: "audit_prior_alert",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ALERT_SENT:CERT_EXPIRING",
      entity_type: "credentials",
      entity_id: `${oldExpiresAt.toISOString()}:14`,
      summary: "",
      metadata_json: "{}",
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const renewedExpiresAt = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(renewedExpiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    // Renewed cert is >30 days out, so no new alert fires — but the important
    // assertion is that the stale dedupe audit for the old expiry date does
    // not suppress a future alert against the new expiry date.
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(1);
  });

  it("never throws when the certificate secret is absent, and sends no alert", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const scheduledEnv = env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "alerts@example.org" });

    await expect(
      worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });
});

function certXmlWithExpiry(expiresAt: Date): string {
  const epochSecond = Math.floor(expiresAt.getTime() / 1000);
  return `<CertificadoMH><activo>true</activo><certificado><basicEstructure><validity><notAfter><epochSecond>${epochSecond}</epochSecond></notAfter></validity></basicEstructure></certificado></CertificadoMH>`;
}

function stalledWompiEventFixture(): Record<string, unknown> {
  return {
    id: "wompi_stalled",
    transaction_id: "TX-STALLED-1",
    environment: "00",
    result: "ExitosaAprobada",
    amount_cents: 2500,
    donor_email: "donante@example.org",
    donor_name: "Donante",
    raw_body: "{}",
    processed_at: null,
    created_document_id: null,
    received_at: "2026-01-01T00:00:00.000Z"
  };
}

describe("credential administration", () => {
  it("returns safe credential status to owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        MH_USER_TEST: "0614",
        MH_PASSWORD_TEST: "test-password",
        MH_CERT_XML_PART_1: "<CertificadoMH>",
        MH_CERT_XML_PART_2: "</CertificadoMH>",
        MH_CERT_PASSWORD: "cert-password",
        WOMPI_API_SECRET: "wompi-secret"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      credentials: {
        target: {
          appEnv: "staging",
          scriptName: "diezmossv-staging-resource-example",
          writerConfigured: false,
          writerMissing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
        },
        groups: {
          mhTest: { ready: true },
          signer: { ready: true },
          wompi: {
            label: "Webhook entrante de Wompi",
            ready: true,
            items: [
              {
                name: "WOMPI_API_SECRET",
                label: "Firma del webhook entrante",
                configured: true
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("test-password");
    expect(JSON.stringify(data)).not.toContain("cert-password");
    expect(JSON.stringify(data)).not.toContain("wompi-secret");
  });

  it.each([
    ["staging", "production"],
    ["production", "test"]
  ] as const)("rejects %s credential writes for the %s-incompatible environment", async (appEnv, environment) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment, mhUser: "replacement-user" })
      }),
      env(db, {
        APP_ENV: appEnv,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "writer-token",
        CLOUDFLARE_SCRIPT_NAME: `example-worker-${appEnv}`
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits.find((row) => row.action === "CREDENTIALS_UPDATED")).toBeUndefined();
  });

  it("returns a clear error when credential update is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "test", mhUser: "0614", mhPassword: "test-password" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "credential_writer_not_configured"
    });
    expect(db.audits).toHaveLength(0);
  });

  it("lets owners bootstrap the Cloudflare writer token without echoing it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials/writer-token", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ token: "cf-writer-token" })
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        CLOUDFLARE_API_BASE_URL: "https://cf.test"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      updated: ["CLOUDFLARE_API_TOKEN"],
      credentials: {
        target: {
          writerConfigured: true,
          writerMissing: []
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("cf-writer-token");
    expect(JSON.stringify(db.audits)).not.toContain("cf-writer-token");
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "CLOUDFLARE_WRITER_ENABLED",
      entity_id: "diezmossv-staging-resource-example"
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-resource-example/secrets-bulk");
    expect(init.headers).toMatchObject({ Authorization: "Bearer cf-writer-token" });
  });
});

describe("email template settings", () => {
  it("lets owners edit subject and body templates for each email type", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          templates: {
            dteReceipt: {
              subject: "CDE {{numeroControl}} emitido",
              body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
            },
            dteInvalidation: {
              subject: "CDE {{numeroControl}} invalidado",
              body: "El CDE {{numeroControl}} quedó {{estado}}."
            }
          }
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailTemplates: {
        definitions: [
          expect.objectContaining({ type: "dteReceipt", label: "Envío de comprobante" }),
          expect.objectContaining({ type: "dteInvalidation", label: "Invalidación de comprobante" })
        ],
        placeholders: expect.arrayContaining(["{{numeroControl}}", "{{donante}}", "{{monto}}"]),
        templates: {
          dteReceipt: {
            subject: "CDE {{numeroControl}} emitido",
            body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
          },
          dteInvalidation: {
            subject: "CDE {{numeroControl}} invalidado",
            body: "El CDE {{numeroControl}} quedó {{estado}}."
          }
        }
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_templates_json",
      updated_by: "user_owner"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_TEMPLATES_UPDATED",
      entity_type: "app_setting",
      entity_id: "email_templates_json"
    }));

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      emailTemplates: {
        templates: {
          dteReceipt: { subject: "CDE {{numeroControl}} emitido" },
          dteInvalidation: { subject: "CDE {{numeroControl}} invalidado" }
        }
      }
    });
  });
});

describe("alert email setting", () => {
  it("lets owners configure and read back the operational alert recipient", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org" })
      }),
      env(db)
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" }));
    // The audit records THAT the recipient changed, but never the address itself — the
    // audit trail is readable by lower roles, so the OWNER-only value must not ride in.
    const audit = db.audits.find((row) => row.action === "ALERT_EMAIL_UPDATED");
    expect(audit).toMatchObject({
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado",
      metadata_json: JSON.stringify({ enabled: true })
    });

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ alertEmail: "owner@example.org" });
  });

  it("lets owners configure multiple operational alert recipients separated by commas", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, admin@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org, admin@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org, admin@example.org", updated_by: "user_owner" }));
  });

  it("rejects malformed operational alert recipient lists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("redacts a legacy alert-email address from the audit trail for lower roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // A row written before the redaction shipped still carries the address in both the
    // summary and metadata; the read path must scrub it for everyone.
    db.audits.push({
      id: "audit_alert_legacy",
      actor_type: "USER",
      actor_id: "user_owner",
      action: "ALERT_EMAIL_UPDATED",
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado a owner@example.org",
      metadata_json: JSON.stringify({ alertEmail: "owner@example.org" }),
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const scopedResponse = await worker.fetch(
      new Request("https://example.org/api/audit?entityType=app_setting&entityId=alert_email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(scopedResponse.status).toBe(200);
    const scopedBody = (await scopedResponse.json()) as { audit: Array<{ summary?: string; metadata_json?: string }> };
    expect(JSON.stringify(scopedBody.audit)).not.toContain("owner@example.org");
    expect(scopedBody.audit[0]).toMatchObject({
      summary: "Correo de alertas actualizado",
      metadata_json: "{}"
    });

    // The general (keyset-paginated) audit trail is the primary VIEWER surface and must
    // scrub the legacy address too.
    const generalResponse = await worker.fetch(
      new Request("https://example.org/api/audit", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(generalResponse.status).toBe(200);
    const generalBody = (await generalResponse.json()) as { audit: Array<Record<string, unknown>> };
    expect(JSON.stringify(generalBody.audit)).not.toContain("owner@example.org");
  });

  it("allows clearing the alert email to disable alerting", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "" });
  });

  it("rejects a malformed alert email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("manual retention export endpoint", () => {
  it("lets an owner trigger the retention export for an explicit month and audits the request", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "completed", month: "2026-03" });
    expect(archive.objects.has("retention/2026/2026-03/manifest.json")).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_EXPORT_REQUESTED", entity_type: "retention_export", entity_id: "2026-03" })
    );
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_COMPLETED" }));
  });

  it("rejects a malformed month parameter", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=not-a-month", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
  });

  it("rejects an export request for the current (still-open) month and writes nothing to the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const archive = new FakeArchiveBucket();
    // The month currently open in El Salvador local time — same helper the
    // handler itself will use to compute "the previous closed month" — so
    // this test targets "now"'s own month regardless of when it runs.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

    const response = await worker.fetch(
      new Request(`https://example.org/api/admin/retention-export?month=${currentMonth}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns HTTP 500 when the export itself fails, instead of 200 with ok:false", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "failed", month: "2026-03" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("admin backups panel", () => {
  function seedManifest(archive: FakeArchiveBucket, month: string, tables: Record<string, { rowCount: number; body: string }>): Promise<void> {
    return (async () => {
      const prefix = `retention/${month.slice(0, 4)}/${month}`;
      const manifestTables: Record<string, { rowCount: number; sha256: string }> = {};
      for (const [table, { rowCount, body }] of Object.entries(tables)) {
        const bytes = utf8Bytes(body);
        await archive.put(`${prefix}/${table}.ndjson`, bytes);
        manifestTables[table] = { rowCount, sha256: await sha256Hex(bytes) };
      }
      const manifest = { month, generatedAt: `${month}-28T09:00:00.000Z`, tables: manifestTables };
      await archive.put(`${prefix}/manifest.json`, utf8Bytes(JSON.stringify(manifest)));
    })();
  }

  it("lists archived, missing, and in-progress months newest-first with parsed manifest data", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Earliest document is April 2026, so the expected range spans April..(last closed month).
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-04-10T12:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    // April archived, May missing (no manifest).
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 3, body: "a\nb\nc\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { months: Array<{ month: string; status: string; totalRows?: number; exportedAt?: string }> };
    const byMonth = new Map(payload.months.map((entry) => [entry.month, entry]));

    // Newest first.
    expect(payload.months[0].month > payload.months[payload.months.length - 1].month).toBe(true);
    expect(byMonth.get("2026-04")).toMatchObject({ status: "archivado", totalRows: 3 });
    expect(byMonth.get("2026-04")?.exportedAt).toBe("2026-04-28T09:00:00.000Z");
    expect(byMonth.get("2026-05")).toMatchObject({ status: "faltante" });
    // The current (still-open) El Salvador month appears only as en_curso.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
    expect(byMonth.get(currentMonth)?.status).toBe("en_curso");
  });

  it("returns an empty list when there are no documents and no manifests", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ months: [] });
  });

  it("rejects a VIEWER with 403 and an unauthenticated caller with 401", async () => {
    const dbViewer = new InMemoryD1();
    dbViewer.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const viewerResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(dbViewer)
    );
    expect(viewerResponse.status).toBe(403);

    const anonResponse = await worker.fetch(new Request("https://example.org/api/admin/backups"), env(new InMemoryD1()));
    expect(anonResponse.status).toBe(401);
  });

  it("verifies a month against its manifest and audits RETENTION_VERIFIED on a full match", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "row\n" },
      audit_logs: { rowCount: 0, body: "" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean }> };
    expect(payload.ok).toBe(true);
    expect(payload.files.every((file) => file.ok)).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFIED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("reports a mismatch, audits RETENTION_VERIFY_FAILED, and sends an operational alert when an object is corrupted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "row\n" } });
    // Corrupt the stored object's bytes so its SHA-256 no longer matches the manifest.
    await archive.put("retention/2026/2026-04/dte_documents.ndjson", utf8Bytes("tampered\n"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        ARCHIVE: archive as unknown as R2Bucket,
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message);
            return { messageId: "alert-verify" };
          }
        } as unknown as Env["EMAIL"]
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean; expected: string; actual: string }> };
    expect(payload.ok).toBe(false);
    const corrupted = payload.files.find((file) => file.table === "dte_documents");
    expect(corrupted?.ok).toBe(false);
    expect(corrupted?.expected).not.toBe(corrupted?.actual);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFY_FAILED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    expect(sent).toHaveLength(1);
  });

  it("streams a table object as an attachment and audits RETENTION_DOWNLOADED", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 2, body: "line1\nline2\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("2026-04");
    await expect(response.text()).resolves.toBe("line1\nline2\n");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("returns 404 when downloading an object that is not in the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a full-month ZIP whose objects exceed the memory budget with a Spanish 413", async () => {
    // The ZIP is buffered in worker memory; enforcement fires DURING collection (before
    // reading each object) so an oversized month can never balloon memory first.
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    // One object claims a size beyond the 32 MiB budget; its body is tiny so the test
    // itself stays cheap — the guard must trust the R2-reported size, not read first.
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });
    archive.sizeOverrides.set("retention/2026/2026-04/dte_documents.ndjson", 32 * 1024 * 1024 + 1);

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    // No PII-download audit for a refused archive.
    expect(db.audits.filter((row) => row.action === "RETENTION_DOWNLOADED")).toHaveLength(0);
  });

  it("streams a full-month ZIP of every archived object plus the manifest and audits the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="respaldo-2026-04.zip"');

    // Round-trip the streamed ZIP through the system unzip binary (same pattern as
    // pdf.test.ts shelling out to poppler) to prove listing + exact content.
    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const dir = mkdtempSync(join(tmpdir(), "diezmos-backup-zip-"));
    const zipPath = join(dir, "respaldo.zip");
    writeFileSync(zipPath, zipBytes);
    const listing = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("dte_documents.ndjson");
    expect(listing).toContain("audit_logs.ndjson");
    expect(listing).toContain("No errors detected");
    expect(execFileSync("unzip", ["-p", zipPath, "dte_documents.ndjson"], { encoding: "utf8" })).toBe("line1\nline2\n");
    expect(execFileSync("unzip", ["-p", zipPath, "audit_logs.ndjson"], { encoding: "utf8" })).toBe("audit\n");

    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    const audit = db.audits.find((row) => row.action === "RETENTION_DOWNLOADED");
    expect(JSON.parse(String(audit!.metadata_json))).toMatchObject({ month: "2026-04", table: "__all__" });
  });

  it("rejects an oversized full-month ZIP before auditing the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "x".repeat(33 * 1024 * 1024) }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "RETENTION_DOWNLOADED" }));
  });

  it("returns 404 for a full-month download of a month without an archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a VIEWER full-month download with 403", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("audit actor context", () => {
  // Cloudflare only sets request.cf in the Workers runtime, so tests attach it
  // manually; the worker reads it defensively via (request as any).cf.
  function withCf(request: Request, cf: Record<string, unknown>): Request {
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    return request;
  }

  const SV_CF = {
    country: "SV",
    city: "San Salvador",
    region: "San Salvador",
    timezone: "America/El_Salvador",
    asn: 27773,
    asOrganization: "Claro El Salvador",
    colo: "SJO",
    httpProtocol: "HTTP/2",
    tlsVersion: "TLSv1.3"
  };

  it("records the client IP and cf context on a failed login audit", async () => {
    const db = new InMemoryD1();

    const request = withCf(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "190.86.1.2",
          "user-agent": "Mozilla/5.0 Test"
        },
        body: JSON.stringify({ email: "nobody@example.org", password: "whatever" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(401);
    const failure = db.audits.find((audit) => audit.action === "LOGIN_FAILED");
    expect(failure).toBeTruthy();
    expect(failure?.actor_ip).toBe("190.86.1.2");
    expect(JSON.parse(String(failure?.actor_context))).toMatchObject({
      country: "SV",
      city: "San Salvador",
      asOrganization: "Claro El Salvador",
      userAgent: "Mozilla/5.0 Test"
    });
  });

  it("bounds oversized actor fields on a failed login audit", async () => {
    const db = new InMemoryD1();
    const request = withCf(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "2".repeat(200),
          "user-agent": "Browser".repeat(200)
        },
        body: JSON.stringify({ email: "nobody@example.org", password: "whatever" })
      }),
      {
        ...SV_CF,
        country: "S".repeat(20),
        city: "á".repeat(1_000),
        asOrganization: "Org".repeat(1_000),
        ignored: "x".repeat(100_000)
      }
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(401);
    const failure = db.audits.find((audit) => audit.action === "LOGIN_FAILED");
    expect(failure).toBeTruthy();
    expect(utf8Bytes(String(failure?.actor_ip)).byteLength).toBeLessThanOrEqual(64);
    const actorContext = String(failure?.actor_context);
    expect(utf8Bytes(actorContext).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(actorContext)).toMatchObject({
      _truncated: expect.arrayContaining(["country", "city", "asOrganization", "userAgent"])
    });
    expect(JSON.parse(actorContext)).not.toHaveProperty("ignored");
  });

  it("bounds actor fields when createAudit is called directly", async () => {
    const db = new InMemoryD1();
    const repo = new Repository(env(db).DB);

    await repo.createAudit({
      action: "DIRECT_AUDIT_TEST",
      entityType: "test",
      entityId: "direct",
      summary: "Direct audit boundary",
      actorIp: "🧪".repeat(100),
      actorContext: {
        city: "á".repeat(1_000),
        userAgent: "🧪".repeat(10_000),
        asn: 27773,
        ignored: "x".repeat(100_000)
      }
    });

    const audit = db.audits.find((row) => row.action === "DIRECT_AUDIT_TEST");
    expect(audit).toBeTruthy();
    expect(utf8Bytes(String(audit?.actor_ip)).byteLength).toBeLessThanOrEqual(64);
    expect(String(audit?.actor_ip)).not.toContain("�");
    const actorContext = String(audit?.actor_context);
    expect(utf8Bytes(actorContext).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(actorContext)).toMatchObject({
      asn: 27773,
      _truncated: expect.arrayContaining(["city", "userAgent"])
    });
    expect(JSON.parse(actorContext)).not.toHaveProperty("ignored");
  });

  it("records the client IP and cf context on an admin user update audit", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const request = withCf(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "cf-connecting-ip": "201.203.9.9",
          "user-agent": "AdminBrowser/1.0"
        },
        body: JSON.stringify({ role: "ADMIN" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(200);
    const audit = db.audits.find((row) => row.action === "USER_UPDATED");
    expect(audit?.actor_ip).toBe("201.203.9.9");
    expect(JSON.parse(String(audit?.actor_context))).toMatchObject({
      asOrganization: "Claro El Salvador",
      userAgent: "AdminBrowser/1.0"
    });
  });

  it("leaves cron/queue (SYSTEM) audits without actor IP or context", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_1",
      transaction_id: "wompi_1_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    // A dead-letter batch runs in the queue handler with no incoming Request.
    await worker.queue(
      {
        queue: "issuance-dlq",
        messages: [
          {
            body: { wompiEventId: "wompi_1" } as IssuanceMessage,
            ack: () => undefined,
            retry: () => undefined
          }
        ]
      } as unknown as MessageBatch<IssuanceMessage>,
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "ISSUANCE_DEAD_LETTERED");
    expect(audit).toBeTruthy();
    expect(audit?.actor_ip ?? null).toBeNull();
    expect(audit?.actor_context ?? null).toBeNull();
  });

  it.each(["VIEWER", "OPERATOR"] as const)("projects account audit rows safely for %s users", async (role) => {
    const db = authedDb(role, new InMemoryD1());
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_system_1",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ISSUANCE_DEAD_LETTERED",
      entity_type: "wompi_event",
      entity_id: "wompi_1",
      summary: "seeded",
      metadata_json: "{}",
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:46.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    const userRow = body.audit.find((row) => row.id === "audit_user_1");
    const systemRow = body.audit.find((row) => row.id === "audit_system_1");

    // Account rows hide both the actor and target identity from lower audit audiences.
    expect(userRow?.actor_id ?? null).toBeNull();
    expect(userRow?.actor_name ?? null).toBeNull();
    expect(userRow?.actor_email ?? null).toBeNull();
    expect(userRow?.actor_ip ?? null).toBeNull();
    expect(userRow?.actor_context ?? null).toBeNull();
    expect(userRow?.entity_id ?? null).toBeNull();
    expect(userRow?.summary).toBe("Usuario actualizado");
    expect(userRow?.metadata_json).toBe("{}");
    // SYSTEM rows have no resolvable user and no captured context.
    expect(systemRow?.actor_name ?? null).toBeNull();
    expect(systemRow?.actor_ip ?? null).toBeNull();
  });

  it("applies the lower-role audit projection on scoped, document-detail, and contingency responses", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.documents.push(testDocument({ id: "doc_projection" }));
    db.contingencies.push({
      id: "cont_projection",
      environment: "00",
      status: "OPEN",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      created_at: "2026-06-26T01:00:00.000Z"
    });
    const sensitiveContext = JSON.stringify({ city: "San Salvador", country: "SV" });
    db.audits.push(
      {
        id: "audit_scoped_user",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "USER_UPDATED",
        entity_type: "user",
        entity_id: "user_operator",
        summary: "operator@example.org ascendido",
        metadata_json: JSON.stringify({ email: "operator@example.org" }),
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:49.015Z"
      },
      {
        id: "audit_document_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "DTE_RETRIED",
        entity_type: "dte_document",
        entity_id: "doc_projection",
        summary: "Documento reintentado",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:48.015Z"
      },
      {
        id: "audit_contingency_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "CONTINGENCY_OPENED",
        entity_type: "contingency_period",
        entity_id: "cont_projection",
        summary: "Contingencia abierta",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:47.015Z"
      }
    );

    const headers = { Authorization: "Bearer test-token" };
    const [scopedResponse, documentResponse, contingencyResponse] = await Promise.all([
      worker.fetch(
        new Request("https://example.org/api/audit?entityType=user&entityId=user_operator", { headers }),
        env(db)
      ),
      worker.fetch(new Request("https://example.org/api/documents/doc_projection", { headers }), env(db)),
      worker.fetch(new Request("https://example.org/api/contingency", { headers }), env(db))
    ]);

    expect(scopedResponse.status).toBe(200);
    expect(documentResponse.status).toBe(200);
    expect(contingencyResponse.status).toBe(200);
    const scoped = (await scopedResponse.json()) as { audit: Array<Record<string, unknown>> };
    const document = (await documentResponse.json()) as { audit: Array<Record<string, unknown>> };
    const contingency = (await contingencyResponse.json()) as { contingency: { audit: Array<Record<string, unknown>> } };

    expect(scoped.audit[0]).toMatchObject({
      actor_id: null,
      actor_name: null,
      actor_email: null,
      actor_ip: null,
      actor_context: null,
      entity_id: null,
      summary: "Usuario actualizado",
      metadata_json: "{}"
    });
    for (const row of [document.audit[0], contingency.contingency.audit[0]]) {
      expect(row).toMatchObject({ actor_email: null, actor_ip: null, actor_context: null });
    }
  });

  it("returns sensitive audit actor fields for ADMIN users", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin_session", email: "admin-session@example.org", name: "Admin Session", role: "ADMIN" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    expect(body.audit[0]).toMatchObject({
      actor_name: "Ada Admin",
      actor_email: "admin@example.org",
      actor_ip: "190.86.1.2"
    });
    expect(JSON.parse(String(body.audit[0]?.actor_context))).toMatchObject({ city: "San Salvador" });
  });
});

describe("branding", () => {
  function ownerDb(): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    return db;
  }

  function authed(role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER"): InMemoryD1 {
    return authedDb(role, new InMemoryD1());
  }

  it("returns the defaults for the public branding endpoint before anything is set", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: "ExamplePerson1",
      accentColor: "#0f766e",
      supportEmail: "legacy-contact-1@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("reflects a saved name and color on the public branding endpoint", async () => {
    const db = ownerDb();
    const put = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "  Iglesia Central  ", accentColor: "#123ABC", supportEmail: "  legacy-email-119@example.com " })
      }),
      env(db)
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      ok: true,
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com"
    });
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_UPDATED", entity_type: "app_setting" });

    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));
    await expect(response.json()).resolves.toMatchObject({
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("carries the support email in the branding audit metadata", async () => {
    const db = ownerDb();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia Central", accentColor: "#123abc", supportEmail: "legacy-email-119@example.com" })
      }),
      env(db)
    );
    const audit = db.audits.at(-1) as { action: string; metadata_json?: string };
    expect(audit.action).toBe("BRANDING_UPDATED");
    expect(String(audit.metadata_json)).toContain("legacy-email-119@example.com");
  });

  it("rejects a malformed support email with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e", supportEmail: "no-arroba" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("correo");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a bad hex color with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#zzz" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("color");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an empty name with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "   ", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("rejects an 81-character name", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "a".repeat(81), accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("forbids a VIEWER from writing branding", async () => {
    const db = authed("VIEWER");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("forbids an OPERATOR from writing branding", async () => {
    const db = authed("OPERATOR");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("requires a session to write branding", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(401);
  });

  const logoCases: Array<{ contentType: string; ext: string }> = [
    { contentType: "image/svg+xml", ext: "svg" },
    { contentType: "image/png", ext: "png" },
    { contentType: "image/jpeg", ext: "jpg" }
  ];

  for (const { contentType } of logoCases) {
    it(`stores a ${contentType} logo and serves it with hardening headers`, async () => {
      const db = ownerDb();
      const archive = new FakeArchiveBucket();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);

      const put = await worker.fetch(
        new Request("https://example.org/api/settings/branding/logo", {
          method: "PUT",
          headers: { Authorization: "Bearer test-token", "Content-Type": contentType },
          body: bytes
        }),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { ok: boolean; logoVersion: string };
      expect(putBody.ok).toBe(true);
      expect(putBody.logoVersion).toBeTruthy();
      expect(archive.putCalls.at(-1)?.key).toBe("branding/logo");
      expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_UPDATED" });

      const publicBranding = await worker.fetch(
        new Request("https://example.org/api/branding"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: putBody.logoVersion });

      const logo = await worker.fetch(
        new Request("https://example.org/api/branding/logo"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(logo.status).toBe(200);
      expect(logo.headers.get("Content-Type")).toBe(contentType);
      expect(logo.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(logo.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(logo.headers.get("Content-Security-Policy")).toBe("script-src 'none'; default-src 'none'; style-src 'unsafe-inline'");
      await expect(logo.arrayBuffer()).resolves.toEqual(bytes.buffer);
    });
  }

  it("stores and serves the donor logo separately from the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const adminBytes = new Uint8Array([1, 2, 3]);
    const donorBytes = new Uint8Array([7, 8, 9]);

    const adminPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: adminBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const adminBody = (await adminPut.json()) as { logoVersion: string };

    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: donorBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorPut.status).toBe(200);
    const donorBody = (await donorPut.json()) as { ok: boolean; donorLogoVersion: string };
    expect(donorBody.ok).toBe(true);
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/logo");
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/donor-logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_UPDATED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({
      logoVersion: adminBody.logoVersion,
      donorLogoVersion: donorBody.donorLogoVersion
    });

    const donorLogo = await worker.fetch(
      new Request("https://example.org/api/branding/donor-logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorLogo.status).toBe(200);
    expect(donorLogo.headers.get("Content-Type")).toBe("image/png");
    await expect(donorLogo.arrayBuffer()).resolves.toEqual(donorBytes.buffer);

    const adminLogo = await worker.fetch(
      new Request("https://example.org/api/branding/logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(adminLogo.arrayBuffer()).resolves.toEqual(adminBytes.buffer);
  });

  it("rejects a logo upload with an unsupported content type", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/gif" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding_logo" });
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a logo upload larger than 512 KB", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const bytes = new Uint8Array(512 * 1024 + 1);
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: bytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns 404 for the logo stream when none is stored", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding/logo"), env(db));
    expect(response.status).toBe(404);
  });

  it("removes a stored logo and records an audit", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([9, 9, 9])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true });
    expect(archive.deleteCalls).toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: null });
  });

  it("removes a stored donor logo without removing the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 1, 1])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([2, 2, 2])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorBody = (await donorPut.json()) as { donorLogoVersion: string };

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true, donorLogoVersion: null });
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.deleteCalls).toContain("branding/donor-logo");
    expect(archive.deleteCalls).not.toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: expect.any(String), donorLogoVersion: null });
  });

  it("forbids a non-owner from uploading a logo", async () => {
    const db = authed("ADMIN");
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(403);
    expect(archive.putCalls).toHaveLength(0);
  });
});

const ANALYTICS_MAX_BYTES = 8 * 1024 * 1024;
const ANALYTICS_CAPACITY_RESPONSE = {
  error: "analytics_range_too_large",
  message: "El rango solicitado contiene demasiados datos. Reduzca las fechas."
};

describe("analytics endpoint (Wompi lane)", () => {
  it("requires a session (401 without a token)", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/analytics"), env(db));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-13-40&to=2026-01-01", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("rejects analytics ranges wider than one year", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=1900-01-01&to=9998-12-31", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("aggregates the Wompi lane and excludes manually issued CDEs by design", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Wompi-lane accepted doc (environment 00).
    db.documents.push(
      testDocument({
        id: "doc_wompi",
        wompi_event_id: "wompi_lane",
        environment: "00",
        status: "ACCEPTED",
        donor_email: "lane@example.org",
        donor_name: "Lane Donor",
        amount_cents: 5000,
        issued_at: "2026-06-10T18:00:00.000Z",
        accepted_at: "2026-06-10T18:00:20.000Z"
      }),
      // Manually issued CDE (no wompi_event_id) — must NOT appear in any total.
      testDocument({
        id: "doc_manual",
        wompi_event_id: null,
        environment: "00",
        status: "ACCEPTED",
        donor_email: "manual@example.org",
        amount_cents: 999999,
        issued_at: "2026-06-11T18:00:00.000Z"
      })
    );
    db.donationIntents.push({
      id: "di_lane",
      status: "COMPLETED",
      document_id: "doc_wompi",
      donor_document: "DUI-1",
      gift_type: "DIEZMO",
      direccion_departamento: "06",
      donor_pais: null,
      created_at: "2026-06-10T17:50:00.000Z",
      paid_at: "2026-06-10T17:55:00.000Z"
    });
    db.emailDeliveries.push({ id: "em_1", document_id: "doc_wompi", status: "SENT", created_at: "2026-06-10T18:01:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { analytics: Record<string, any> };
    const analytics = body.analytics;
    expect(analytics.environment).toBe("00");
    expect(analytics.hasData).toBe(true);
    // Only the Wompi-lane doc counts (the 999999 manual CDE is excluded).
    const june = analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    expect(june).toMatchObject({ totalCents: 5000, count: 1 });
    // Gift split routes it to Diezmo via the correlated intent.
    expect(analytics.giving.giftSplit.find((point: any) => point.key === "2026-06")?.diezmoCents).toBe(5000);
    // Geography buckets it under department 06.
    expect(analytics.geography.departments.find((row: any) => row.code === "06")?.count).toBe(1);
    // Funnel + email pick up the lane intent and delivery.
    expect(analytics.funnel).toMatchObject({ created: 1, datos: 1, paid: 1, completed: 1 });
    expect(analytics.email.weekly.reduce((sum: number, point: any) => sum + point.sent, 0)).toBe(1);
    // Top donors never leak numero de control.
    expect(JSON.stringify(analytics.giving.topDonors)).not.toContain("numero_control");
  });

  it("returns 422 before materializing more than ten thousand analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 10_001; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(false);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("returns 422 when serialized analytics rows exceed eight MiB", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    db.documents.push(
      testDocument({
        id: "doc_byte_budget",
        wompi_event_id: "wompi_byte_budget",
        environment: "00",
        donor_name: "🧪".repeat(2_100_000),
        issued_at: "2026-06-10T18:00:00.000Z"
      })
    );

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
  });

  it("shares remaining row capacity across document and intent readers", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 9_999; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_shared_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_shared_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }
    db.donationIntents.push(
      testAnalyticsIntent({ id: "di_shared_budget_1" }),
      testAnalyticsIntent({ id: "di_shared_budget_2" })
    );

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.analyticsQueryLimits.find((query) => query.reader === "intents")?.limit
    ).toBe(2);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("accepts exactly ten thousand analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 10_000; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_exact_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_exact_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { analytics: { giving: { monthly: Array<{ count: number }> } } };
    expect(body.analytics.giving.monthly[0]?.count).toBe(10_000);
    expect(
      db.analyticsQueryLimits.find((query) => query.reader === "intents")?.limit
    ).toBe(1);
  });

  it("bounds document query pages for realistically amended donor emails", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const amendedEmail = `${"a".repeat(262_000)}@x.co`;
    expect(
      utf8Bytes(JSON.stringify({ email: amendedEmail })).byteLength
    ).toBeLessThanOrEqual(256 * 1024);
    for (let index = 0; index < 32; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_amended_email_${String(index).padStart(2, "0")}`,
          wompi_event_id: `wompi_amended_email_${index}`,
          environment: "00",
          donor_email: amendedEmail,
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }
    const serializedRowBytes =
      utf8Bytes(
        JSON.stringify(analyticsDocumentRow(db.documents[0], []))
      ).byteLength + 1;
    expect(serializedRowBytes * 31).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(serializedRowBytes * 32).toBeGreaterThan(ANALYTICS_MAX_BYTES);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    const documentQueryLimits = db.analyticsQueryLimits
      .filter((query) => query.reader === "documents")
      .map((query) => query.limit);
    expect(documentQueryLimits[0]).toBe(31);
    expect(documentQueryLimits.every((limit) => limit <= 31)).toBe(true);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(false);
  });

  it("shares serialized UTF-8 capacity across document and intent readers", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const document = testDocument({
      id: "doc_combined_bytes",
      wompi_event_id: "wompi_combined_bytes",
      environment: "00",
      donor_name: "🧪".repeat(1_050_000),
      issued_at: "2026-06-10T18:00:00.000Z"
    });
    const intent = testAnalyticsIntent({
      id: "di_combined_bytes",
      donor_document: "🧪".repeat(1_050_000)
    });
    db.documents.push(document);
    db.donationIntents.push(intent);

    const documentBytes = utf8Bytes(
      JSON.stringify(analyticsDocumentRow(document, db.donationIntents))
    ).byteLength + 1;
    const intentBytes = utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1;
    expect(documentBytes).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(intentBytes).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(documentBytes + intentBytes).toBeGreaterThan(ANALYTICS_MAX_BYTES);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(true);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("accepts exactly eight MiB of serialized analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const intent = analyticsIntentWithSerializedBytes(ANALYTICS_MAX_BYTES);
    expect(
      utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1
    ).toBe(ANALYTICS_MAX_BYTES);
    db.donationIntents.push(intent);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(200);
  });

  it("rejects one byte beyond eight MiB with the exact capacity response", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const intent = analyticsIntentWithSerializedBytes(ANALYTICS_MAX_BYTES + 1);
    expect(
      utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1
    ).toBe(ANALYTICS_MAX_BYTES + 1);
    db.donationIntents.push(intent);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
  });

  it("scopes every metric to the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({ id: "doc_00", wompi_event_id: "w00", environment: "00", amount_cents: 1000, issued_at: "2026-06-10T18:00:00.000Z" }),
      testDocument({ id: "doc_01", wompi_event_id: "w01", environment: "01", amount_cents: 8000, issued_at: "2026-06-10T18:00:00.000Z" })
    );
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const body = (await response.json()) as { analytics: Record<string, any> };
    const june = body.analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    // Only the 01 doc is counted; the 00 doc is invisible in this ambiente.
    expect(june).toMatchObject({ totalCents: 8000, count: 1 });
  });
});

function testAnalyticsIntent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "di_analytics",
    status: "COMPLETED",
    document_id: null,
    donor_document: "10000000-1",
    gift_type: "DIEZMO",
    created_at: "2026-06-10T17:50:00.000Z",
    paid_at: "2026-06-10T17:55:00.000Z",
    direccion_departamento: "06",
    donor_pais: null,
    ...overrides
  };
}

function analyticsIntentWithSerializedBytes(
  serializedBytes: number
): Record<string, unknown> {
  const intent = testAnalyticsIntent({
    id: "di_exact_byte_budget",
    donor_document: ""
  });
  const baseBytes =
    utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1;
  if (serializedBytes < baseBytes) {
    throw new Error("El presupuesto de prueba no alcanza para la fila base");
  }
  return {
    ...intent,
    donor_document: "a".repeat(serializedBytes - baseBytes)
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function signWompiBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)));
  return hexFromBytes(digest);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
