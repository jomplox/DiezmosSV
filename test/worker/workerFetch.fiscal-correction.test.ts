import { describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import {
  fiscalCorrectionPayload,
  type FiscalReceptorCorrection
} from "../../src/shared/fiscalCorrection";
import { buildCdeDocument, buildDirectCdeDocument } from "../../src/worker/domain/dteBuilder";
import { signMhDocument } from "../../src/worker/domain/signer";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { buildCorrectedWompiCandidate } from "../../src/worker/services/fiscalCorrection";
import { MhClient, MhPreDispatchError } from "../../src/worker/services/mhClient";
import { Repository } from "../../src/worker/storage/repository";
import { utf8Bytes } from "../../src/worker/utils/encoding";
import type {
  DteDocumentRecord,
  Env,
  FiscalCorrectionRecord,
  IssuanceMessage,
  WompiWebhook
} from "../../src/worker/types";
import { authedDb, env, InMemoryD1 } from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import { emisorConfig, generatedCertificateXml } from "./support/dteFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { sha256Hex } from "./support/workerFetchHelpers";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();

describe("guarded fiscal correction API", () => {
  const authorization = { Authorization: "Bearer test-token" };

  function correctionDb(role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER" | null = "OPERATOR"): InMemoryD1 {
    const db = new InMemoryD1();
    return role ? authedDb(role, db) : db;
  }

  function correctionWebhook(overrides: Record<string, unknown> = {}): WompiWebhook {
    return {
      ...(wompiSample as WompiWebhook),
      Cliente: {
        ...(wompiSample.Cliente as WompiWebhook["Cliente"]),
        DocumentoIdentidad: "12345678-9",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  function correctionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const payload = correctionWebhook();
    return wompiEventForReservation({
      id: "wompi_bad_dui",
      transaction_id: payload.IdTransaccion,
      environment: "00",
      result: payload.ResultadoTransaccion,
      amount_cents: 1000,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-17T17:00:00.000Z",
      created_document_id: null,
      issuance_claim_id: null,
      issuance_status: "FAILED",
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "El DUI del receptor es inválido.",
      ...overrides
    });
  }

  function correctionReceptor(
    overrides: Partial<FiscalReceptorCorrection> = {}
  ): FiscalReceptorCorrection {
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
      complemento: "Colonia Centro",
      ...overrides
    };
  }

  function correctionRequest(
    path: string,
    body: Record<string, unknown>,
    method = "POST"
  ): Request {
    return new Request(`https://example.org${path}`, {
      method,
      headers: {
        ...authorization,
        "Content-Type": "application/json"
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
  }

  function correctionRecord(
    overrides: Partial<FiscalCorrectionRecord> = {}
  ): FiscalCorrectionRecord {
    return {
      id: "fiscal_correction_1",
      request_id: "11111111-1111-4111-8111-111111111111",
      request_payload_sha256: "payload-sha",
      attempt_number: 1,
      target_kind: "WOMPI_EVENT",
      wompi_event_id: "wompi_bad_dui",
      document_id: null,
      environment: "00",
      status: "QUEUED",
      before_receptor_json: JSON.stringify(correctionReceptor({ numDocumento: "12345678-9" })),
      corrected_receptor_json: JSON.stringify(correctionReceptor()),
      changed_fields_json: JSON.stringify(["numDocumento"]),
      source_document_snapshot_json: null,
      issuance_attempt_id: "issuance_attempt_1",
      fiscal_claim_id: null,
      processing_claim_id: "correction_processing_1",
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
      updated_at: "2026-07-18T12:00:00.000Z",
      ...overrides
    };
  }

  function stubQueuedCorrectionLifecycle(
    correction: FiscalCorrectionRecord,
    event: Record<string, unknown>,
    db: InMemoryD1
  ): void {
    stubCorrectionAuditReconciliation(correction, db);
    const ownedDocument = () => {
      const currentEvent = db.wompiEvents.find(
        (candidate) => candidate.id === correction.wompi_event_id
      );
      return db.documents.find(
        (document) =>
          document.id === currentEvent?.created_document_id
          && document.wompi_event_id === correction.wompi_event_id
      );
    };
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing").mockImplementation(async (input) => {
      if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
        return "terminal";
      }
      if (
        input.id !== correction.id
        || input.processingClaimId !== correction.processing_claim_id
        || input.issuanceAttemptId !== correction.issuance_attempt_id
        || input.fiscalClaimId !== undefined
        || event.issuance_attempt_id !== correction.issuance_attempt_id
        || event.issuance_status !== "RETRY_QUEUED"
        || correction.status !== "QUEUED"
      ) {
        return "busy";
      }
      correction.status = "PROCESSING";
      correction.processing_started_at = new Date().toISOString();
      return "claimed";
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          !document
          || input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== document.id
          || input.documentClaimId !== `fiscal_correction_${correction.id}`
          || input.signedJws !== document.signed_jws
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || document.status !== "SIGNED"
          || document.fiscal_operation_claim_id !== input.documentClaimId
          || document.fiscal_operation_kind !== "TRANSMISSION"
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "clearFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (id, processingClaimId) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at === null
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = null;
        return true;
      });
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrectionDocument")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        const quarantineClaimId = `fiscal_correction_${correction.id}`;
        if (
          input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.issuanceAttemptId !== correction.issuance_attempt_id
          || input.documentId !== document?.id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || event.created_document_id !== document?.id
          || event.issuance_status !== "DOCUMENT_CREATED"
          || event.issuance_attempt_id !== correction.issuance_attempt_id
          || !document
          || !["PENDING", "SIGNED", "FAILED", "CONTINGENCY_PENDING"].includes(document.status)
          || document.transmission_claim_id !== null
          || (
            document.fiscal_operation_claim_id !== null
            && (
              document.fiscal_operation_claim_id !== quarantineClaimId
              || document.fiscal_operation_kind !== "TRANSMISSION"
              || document.fiscal_operation_event_id != null
            )
          )
        ) {
          return false;
        }
        document.fiscal_operation_claim_id = quarantineClaimId;
        document.fiscal_operation_claimed_at = new Date().toISOString();
        document.fiscal_operation_kind = "TRANSMISSION";
        document.fiscal_operation_event_id = null;
        return true;
      });
    vi.spyOn(Repository.prototype, "updateClaimedDocumentSigned")
      .mockImplementation(async (id, signedJws, expectedStatus, claimId) => {
        const document = ownedDocument();
        if (
          id !== document?.id
          || expectedStatus !== document.status
          || document.fiscal_operation_claim_id !== claimId
          || document.fiscal_operation_kind !== "TRANSMISSION"
          || document.fiscal_operation_event_id != null
        ) {
          return false;
        }
        document.signed_jws = signedJws;
        document.status = "SIGNED";
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeWompiFiscalCorrectionFailure")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || event.created_document_id != null
          || !["RETRY_QUEUED", "PROCESSING"].includes(String(event.issuance_status))
          || event.issuance_attempt_id !== correction.issuance_attempt_id
        ) {
          return false;
        }
        const completedAt = new Date().toISOString();
        event.issuance_status = "FAILED";
        event.issuance_error_code = outcome.failureCode ?? "FISCAL_CORRECTION_FAILED";
        event.issuance_error_message = outcome.failureMessage ?? "La corrección fiscal falló.";
        event.issuance_last_attempt_at = completedAt;
        event.issuance_failed_at = completedAt;
        event.processed_at = completedAt;
        event.issuance_attempt_id = null;
        event.issuance_claim_id = null;
        event.issuance_claimed_at = null;
        correction.status = "FAILED";
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = completedAt;
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const dispatchStateMatches = outcome.status === "FAILED"
          ? correction.mh_dispatch_started_at === null
          : correction.mh_dispatch_started_at !== null;
        const document = ownedDocument();
        const evidenceMatches = outcome.status === "FAILED" || Boolean(
          document
          && outcome.document?.documentId === document.id
          && outcome.document.documentClaimId === `fiscal_correction_${correction.id}`
          && outcome.document.signedJws === document.signed_jws
          && (
            outcome.status === "REVIEW_REQUIRED"
              ? document.status === "SIGNED"
                && document.fiscal_operation_claim_id === outcome.document.documentClaimId
                && document.fiscal_operation_kind === "TRANSMISSION"
              : document.status === outcome.status
                && document.fiscal_operation_claim_id === null
                && document.fiscal_operation_kind === null
          )
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || !dispatchStateMatches
          || !evidenceMatches
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        return true;
      });
  }

  function stubDocumentCorrectionLifecycle(
    correction: FiscalCorrectionRecord,
    db: InMemoryD1
  ): void {
    stubCorrectionAuditReconciliation(correction, db);
    const ownedDocument = () => db.documents.find(
      (document) => document.id === correction.document_id
    );
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
          return "terminal";
        }
        if (
          input.id !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.issuanceAttemptId !== undefined
          || input.fiscalClaimId !== correction.fiscal_claim_id
          || correction.status !== "QUEUED"
          || !document
          || document.status !== "REJECTED"
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return "busy";
        }
        correction.status = "PROCESSING";
        correction.processing_started_at = new Date().toISOString();
        return "claimed";
      });
    vi.spyOn(Repository.prototype, "reserveFiscalCorrectionDocumentIdentifiers")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.documentId !== correction.document_id
          || input.processingClaimId !== correction.processing_claim_id
          || input.fiscalClaimId !== correction.fiscal_claim_id
          || correction.status !== "PROCESSING"
          || !document
          || !["REJECTED", "SIGNED"].includes(document.status)
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return null;
        }
        if (
          correction.reserved_control_sequence !== null
          && correction.reserved_codigo_generacion
          && correction.reserved_numero_control
        ) {
          correction.processing_started_at = new Date().toISOString();
          return {
            sequence: correction.reserved_control_sequence,
            codigoGeneracion: correction.reserved_codigo_generacion,
            numeroControl: correction.reserved_numero_control
          };
        }
        const sequence = db.nextSequence++;
        correction.reserved_control_prefix = input.controlPrefix;
        correction.reserved_control_sequence = sequence;
        correction.reserved_codigo_generacion = input.codigoGeneracion;
        correction.reserved_numero_control =
          `DTE-15-${input.controlPrefix}-${String(sequence).padStart(15, "0")}`;
        correction.processing_started_at = new Date().toISOString();
        return {
          sequence,
          codigoGeneracion: correction.reserved_codigo_generacion,
          numeroControl: correction.reserved_numero_control
        };
      });
    vi.spyOn(Repository.prototype, "renewFiscalCorrectionDocumentSigningLease")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.documentId !== correction.document_id
          || input.processingClaimId !== correction.processing_claim_id
          || input.fiscalClaimId !== correction.fiscal_claim_id
          || input.codigoGeneracion !== correction.reserved_codigo_generacion
          || input.numeroControl !== correction.reserved_numero_control
          || correction.status !== "PROCESSING"
          || !document
          || document.status !== "REJECTED"
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return false;
        }
        correction.processing_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "prepareClaimedFiscalCorrectionDocument")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.documentId !== correction.document_id
          || input.processingClaimId !== correction.processing_claim_id
          || input.claimId !== correction.fiscal_claim_id
          || input.codigoGeneracion !== correction.reserved_codigo_generacion
          || input.numeroControl !== correction.reserved_numero_control
          || correction.status !== "PROCESSING"
          || !document
          || document.status !== "REJECTED"
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return false;
        }
        document.codigo_generacion = input.codigoGeneracion;
        document.numero_control = input.numeroControl;
        document.plain_json = JSON.stringify(input.plainJson);
        document.signed_jws = input.signedJws;
        document.donor_name = input.donorName;
        document.donor_email = input.donorEmail;
        document.status = "SIGNED";
        document.sello_recibido = null;
        document.mh_estado = null;
        document.mh_observaciones_json = "[]";
        document.accepted_at = null;
        document.transmission_deferred_at = null;
        document.post_accept_finalized_at = null;
        document.updated_at = new Date().toISOString();
        return true;
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== correction.document_id
          || input.documentClaimId !== correction.fiscal_claim_id
          || input.signedJws !== document?.signed_jws
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || !document
          || document.status !== "SIGNED"
          || document.fiscal_operation_claim_id !== input.documentClaimId
          || document.fiscal_operation_kind !== "TRANSMISSION"
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "clearFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (id, processingClaimId) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at === null
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = null;
        return true;
      });
    vi.spyOn(
      Repository.prototype,
      "finalizeDirectFiscalCorrectionGenerationDisabled"
    ).mockImplementation(async (id, processingClaimId) => {
      const document = ownedDocument();
      if (
        id !== correction.id
        || processingClaimId !== correction.processing_claim_id
        || correction.target_kind !== "DTE_DOCUMENT"
        || correction.wompi_event_id !== null
        || correction.issuance_attempt_id !== null
        || correction.status !== "PROCESSING"
        || correction.mh_dispatch_started_at !== null
        || !correction.fiscal_claim_id
        || !document
        || document.wompi_event_id !== null
        || !["REJECTED", "SIGNED"].includes(document.status)
        || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        || document.fiscal_operation_kind !== "TRANSMISSION"
        || document.fiscal_operation_event_id != null
        || document.transmission_claim_id !== null
        || (
          document.status === "SIGNED"
          && (
            document.codigo_generacion !== correction.reserved_codigo_generacion
            || document.numero_control !== correction.reserved_numero_control
          )
        )
      ) {
        return false;
      }
      let snapshot: DteDocumentRecord;
      try {
        snapshot = JSON.parse(
          correction.source_document_snapshot_json ?? ""
        ) as DteDocumentRecord;
      } catch {
        return false;
      }
      if (
        snapshot.id !== document.id
        || snapshot.wompi_event_id !== null
        || snapshot.environment !== document.environment
        || snapshot.status !== "REJECTED"
      ) {
        return false;
      }
      Object.assign(document, {
        codigo_generacion: snapshot.codigo_generacion,
        numero_control: snapshot.numero_control,
        status: "REJECTED",
        plain_json: snapshot.plain_json,
        signed_jws: snapshot.signed_jws,
        sello_recibido: snapshot.sello_recibido,
        mh_estado: snapshot.mh_estado,
        mh_observaciones_json: snapshot.mh_observaciones_json,
        donor_email: snapshot.donor_email,
        donor_name: snapshot.donor_name,
        amount_cents: snapshot.amount_cents,
        issued_at: snapshot.issued_at,
        accepted_at: snapshot.accepted_at,
        contingency_period_id: snapshot.contingency_period_id,
        transmission_deferred_at: snapshot.transmission_deferred_at,
        fiscal_operation_claim_id: null,
        fiscal_operation_claimed_at: null,
        fiscal_operation_kind: null,
        fiscal_operation_event_id: null,
        transmission_claim_id: null,
        post_accept_finalized_at: null,
        post_accept_finalization_claim_id: null,
        post_accept_finalization_claimed_at: null,
        post_accept_email_dispatch_started_at: null
      });
      correction.status = "FAILED";
      correction.failure_code = "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED";
      correction.failure_message =
        "La corrección de CDE directos está deshabilitada en este despliegue.";
      correction.completed_at = new Date().toISOString();
      return true;
    });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const dispatchStateMatches = outcome.status === "FAILED"
          ? correction.mh_dispatch_started_at === null
          : correction.mh_dispatch_started_at !== null;
        const document = ownedDocument();
        const evidenceMatches = outcome.status === "FAILED" || Boolean(
          document
          && outcome.document?.documentId === document.id
          && outcome.document.documentClaimId === correction.fiscal_claim_id
          && outcome.document.signedJws === document.signed_jws
          && (
            outcome.status === "REVIEW_REQUIRED"
              ? document.status === "SIGNED"
                && document.fiscal_operation_claim_id === outcome.document.documentClaimId
                && document.fiscal_operation_kind === "TRANSMISSION"
              : document.status === outcome.status
                && document.fiscal_operation_claim_id === null
                && document.fiscal_operation_kind === null
          )
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || !dispatchStateMatches
          || !evidenceMatches
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        if (outcome.status !== "REVIEW_REQUIRED") {
          const document = ownedDocument();
          if (document?.fiscal_operation_claim_id === correction.fiscal_claim_id) {
            document.fiscal_operation_claim_id = null;
            document.fiscal_operation_claimed_at = null;
            document.fiscal_operation_kind = null;
            document.fiscal_operation_event_id = null;
          }
        }
        return true;
      });
  }

  async function consumeCorrectionMessage(
    runtime: Env,
    body: IssuanceMessage,
    id = crypto.randomUUID()
  ): Promise<{ ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> {
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({
      queue: "diezmossv-staging-example-issuance",
      messages: [{ id, timestamp: new Date(), body, attempts: 1, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>, runtime);
    return { ack, retry };
  }

  async function consumeCorrectionDeadLetter(
    runtime: Env,
    body: IssuanceMessage,
    id = crypto.randomUUID()
  ): Promise<{
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
    retryAll: ReturnType<typeof vi.fn>;
  }> {
    const ack = vi.fn();
    const retry = vi.fn();
    const retryAll = vi.fn();
    await worker.queue({
      queue: "diezmossv-staging-example-issuance-dlq",
      messages: [{ id, timestamp: new Date(), body, attempts: 4, ack, retry }],
      ackAll: vi.fn(),
      retryAll
    } as unknown as MessageBatch<IssuanceMessage>, runtime);
    return { ack, retry, retryAll };
  }

  function rejectedCorrectionDocument(
    overrides: Partial<DteDocumentRecord> = {}
  ): DteDocumentRecord {
    const plain = buildDirectCdeDocument({
      amount: "10.00",
      donorName: "Donante Original",
      donorEmail: "original@example.org",
      donorDocumentType: "13",
      donorDocument: "10000002-7",
      donorPhone: "70001111",
      donorAddress: "Dirección original"
    }, emisorConfig(), {
      sequence: 7,
      environment: "00",
      issuedAt: new Date("2026-07-17T10:30:00-06:00")
    }) as Record<string, any>;
    return testDocument({
      id: "doc_rejected_correction",
      wompi_event_id: null,
      status: "REJECTED",
      plain_json: JSON.stringify(plain),
      signed_jws: "original.signed.jws",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: JSON.stringify([
        "Campo #/receptor/numDocumento contiene un valor inválido"
      ]),
      accepted_at: null,
      fiscal_operation_claim_id: null,
      ...overrides
    });
  }

  function rejectedProductionCorrectionDocument(
    overrides: Partial<DteDocumentRecord> = {}
  ): DteDocumentRecord {
    const document = rejectedCorrectionDocument({
      ...overrides,
      environment: "01"
    });
    const plain = JSON.parse(document.plain_json) as Record<string, any>;
    plain.identificacion = {
      ...plain.identificacion,
      ambiente: "01"
    };
    return {
      ...document,
      plain_json: JSON.stringify(plain)
    };
  }

  // ── Reissue after a CONFIGURATION fix ────────────────────────────────────
  // MH can reject for reasons that have nothing to do with the donor's data —
  // codigoMsg 802 "Firma no válida" (a bad certificate) being the case that
  // prompted this. The correction dialog deliberately refuses those: correctable
  // is false and it shows CONFIGURATION_GUIDANCE. That left no operator path at
  // all to re-issue once the configuration WAS fixed, so a paid donation stayed
  // stranded. Reissue fills exactly that gap and nothing else.
  describe("reissue after configuration fix", () => {
    // A rejection MH gave no receptor observations for: purely a config failure.
    function configRejectedDocument(overrides: Partial<DteDocumentRecord> = {}): DteDocumentRecord {
      return rejectedCorrectionDocument({
        mh_estado: "RECHAZADO",
        mh_observaciones_json: "[]",
        ...overrides
      });
    }

    it("re-issues a config-rejected document without requiring any data change", async () => {
      const db = correctionDb();
      const document = configRejectedDocument();
      vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
      vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
        kind: "claimed",
        correction: correctionRecord({
          id: "fiscal_correction_reissue",
          target_kind: "DTE_DOCUMENT",
          wompi_event_id: null,
          document_id: document.id,
          issuance_attempt_id: null,
          fiscal_claim_id: "fiscal_claim_reissue"
        })
      });
      const queued: IssuanceMessage[] = [];
      const runtime = correctionRuntime(db, {
        send: async (message: IssuanceMessage) => { queued.push(message); }
      } as unknown as Queue<IssuanceMessage>);

      const response = await worker.fetch(
        correctionRequest(`/api/documents/${document.id}/reissue`, {
          correctionRequestId: "11111111-1111-4111-8111-111111111111"
        }),
        runtime
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
      // Goes through the SAME pipeline as a correction, so it inherits the fresh
      // codigoGeneracion/numeroControl allocation and the re-sign.
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ advancedDocumentId: document.id });
      expect(queued[0].fiscalCorrectionId).toEqual(expect.any(String));
    });

    // The two paths are mutually exclusive on purpose: if the donor's data really
    // was at fault, reissuing it unchanged would just be rejected again, and would
    // quietly consume another control number doing so.
    it("refuses a receptor-correctable rejection and points at correct-and-retry", async () => {
      const db = correctionDb();
      const document = configRejectedDocument({
        mh_observaciones_json: JSON.stringify([
          "Campo #/receptor/direccion contiene un valor inválido"
        ])
      });
      vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);

      const response = await worker.fetch(
        correctionRequest(`/api/documents/${document.id}/reissue`, {
          correctionRequestId: "70000003-2222-4222-8222-700000032222"
        }),
        correctionRuntime(db)
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "reissue_not_applicable" });
    });

    it("refuses to reissue a document that is not REJECTED", async () => {
      const db = correctionDb();
      const document = configRejectedDocument({ status: "ACCEPTED", sello_recibido: "SELLO" });
      vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);

      const response = await worker.fetch(
        correctionRequest(`/api/documents/${document.id}/reissue`, {
          correctionRequestId: "33333333-3333-4333-8333-333333333333"
        }),
        correctionRuntime(db)
      );

      expect(response.status).toBe(409);
    });

    it("requires OPERATOR", async () => {
      const db = correctionDb("VIEWER");
      const response = await worker.fetch(
        correctionRequest("/api/documents/doc_rejected_correction/reissue", {
          correctionRequestId: "44444444-4444-4444-8444-444444444444"
        }),
        correctionRuntime(db)
      );
      expect(response.status).toBe(403);
    });
  });

  function correctionRuntime(
    db: InMemoryD1,
    queue?: Queue<IssuanceMessage>
  ): Env {
    return env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ...(queue ? { ISSUANCE_QUEUE: queue } : {})
    });
  }

  function expectCorrectionAudits(
    db: InMemoryD1,
    correction: FiscalCorrectionRecord,
    terminalStatus: "ACCEPTED" | "REJECTED" | "FAILED" | "REVIEW_REQUIRED",
    changedFields = ["numDocumento"],
    includeQueued = true
  ): void {
    const audits = db.audits.filter(
      (audit) =>
        audit.entity_type === "fiscal_correction"
        && audit.entity_id === correction.id
    );
    expect(audits.map((audit) => audit.action)).toEqual([
      ...(includeQueued ? ["FISCAL_CORRECTION_QUEUED"] : []),
      "FISCAL_CORRECTION_STARTED",
      `FISCAL_CORRECTION_${terminalStatus}`
    ]);
    for (const audit of audits) {
      const action = String(audit.action).replace("FISCAL_CORRECTION_", "");
      expect(JSON.parse(String(audit.metadata_json))).toEqual({
        correctionId: correction.id,
        target: {
          kind: correction.target_kind,
          id: correction.target_kind === "WOMPI_EVENT"
            ? correction.wompi_event_id
            : correction.document_id
        },
        requestIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        attemptNumber: correction.attempt_number,
        changedFields,
        outcomeCode: action === "STARTED"
          ? "PROCESSING"
          : action === terminalStatus && correction.failure_code
            ? correction.failure_code
            : action
      });
      const metadataText = String(audit.metadata_json);
      expect(metadataText).not.toContain("corrected_receptor_json");
      expect(metadataText).not.toContain("before_receptor_json");
      expect(metadataText).not.toContain("10000002-7");
      expect(metadataText).not.toContain("12345678-9");
      expect(metadataText).not.toContain("Ana Donante");
      expect(metadataText).not.toContain(correction.request_id);
    }
  }

  function stubCorrectionAuditReconciliation(
    correction: FiscalCorrectionRecord,
    db: InMemoryD1
  ): void {
    vi.spyOn(Repository.prototype, "reconcileFiscalCorrectionAudits")
      .mockImplementation(async (candidate) => {
        if (candidate.id !== correction.id) return;
        const transitions = ["QUEUED"];
        if (candidate.processing_started_at || candidate.status !== "QUEUED") {
          transitions.push("STARTED");
        }
        if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(
          candidate.status
        )) {
          transitions.push(candidate.status);
        }
        const requestIdHash = await sha256Hex(utf8Bytes(candidate.request_id));
        const changedFields = [
          ...new Set(
            (JSON.parse(candidate.changed_fields_json) as unknown[])
              .filter((field): field is string =>
                typeof field === "string"
                && [
                  "tipoDocumento", "numDocumento", "nrc", "nombre",
                  "codActividad", "descActividad", "correo", "telefono",
                  "codDomiciliado", "codPais", "departamento", "municipio",
                  "distrito", "complemento"
                ].includes(field)
              )
          )
        ];
        for (const transition of transitions) {
          const action = `FISCAL_CORRECTION_${transition}`;
          if (db.audits.some(
            (audit) =>
              audit.action === action
              && audit.entity_type === "fiscal_correction"
              && audit.entity_id === candidate.id
          )) {
            continue;
          }
          db.audits.push({
            id: `fiscal_correction_audit:${candidate.id}:${transition}`,
            actor_type: transition === "QUEUED" ? "USER" : "SYSTEM",
            actor_id: transition === "QUEUED" ? candidate.created_by : null,
            action,
            entity_type: "fiscal_correction",
            entity_id: candidate.id,
            summary: action,
            metadata_json: JSON.stringify({
              correctionId: candidate.id,
              target: {
                kind: candidate.target_kind,
                id: candidate.target_kind === "WOMPI_EVENT"
                  ? candidate.wompi_event_id
                  : candidate.document_id
              },
              requestIdHash,
              attemptNumber: candidate.attempt_number,
              changedFields,
              outcomeCode: transition === "STARTED"
                ? "PROCESSING"
                : transition === candidate.status && candidate.failure_code
                  ? candidate.failure_code
                  : transition
            }),
            actor_ip: null,
            actor_context: null,
            created_at: "2026-07-18T12:00:00.000Z"
          });
        }
      });
  }

  it("requeues only stale queued and proven pre-dispatch fiscal corrections with fresh ownership", async () => {
    const staleQueued = correctionRecord({
      id: "fiscal_correction_stale_queued",
      status: "QUEUED",
      processing_claim_id: "processing_stale_queued",
      issuance_attempt_id: "issuance_stale_queued"
    });
    const safeProcessing = correctionRecord({
      id: "fiscal_correction_safe_processing",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: "doc_safe_processing",
      status: "PROCESSING",
      processing_claim_id: "processing_safe_old",
      processing_started_at: "2000-01-01T00:00:00.000Z",
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_safe_processing"
    });
    const dispatched = correctionRecord({
      id: "fiscal_correction_dispatched",
      status: "PROCESSING",
      processing_started_at: "2000-01-01T00:00:00.000Z",
      mh_dispatch_started_at: "2000-01-01T00:01:00.000Z"
    });
    const review = correctionRecord({
      id: "fiscal_correction_review",
      status: "REVIEW_REQUIRED"
    });
    const accepted = correctionRecord({
      id: "fiscal_correction_accepted",
      status: "ACCEPTED"
    });
    const rejected = correctionRecord({
      id: "fiscal_correction_rejected",
      status: "REJECTED"
    });
    const candidates = [
      staleQueued,
      safeProcessing,
      dispatched,
      review,
      accepted,
      rejected
    ];
    vi.spyOn(Repository.prototype, "listRecoverableFiscalCorrections")
      .mockResolvedValue(candidates);
    const recovered = vi.spyOn(
      Repository.prototype,
      "recoverFiscalCorrectionProcessingClaim"
    ).mockImplementation(async (input) => {
      const candidate = candidates.find((row) =>
        row.id === input.id
        && row.processing_claim_id === input.currentProcessingClaimId
      );
      if (!candidate) return null;
      candidate.status = "PROCESSING";
      candidate.processing_claim_id = input.nextProcessingClaimId;
      candidate.processing_started_at = new Date().toISOString();
      return candidate;
    });
    const auditReconciliation = vi.spyOn(
      Repository.prototype,
      "reconcileFiscalCorrectionAudits"
    ).mockResolvedValue();
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(correctionDb(), {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");

    await new IssuancePipeline(runtime).recoverStalledFiscalCorrections();

    expect(recovered).toHaveBeenCalledTimes(2);
    expect(recovered.mock.calls.map(([input]) => input.id)).toEqual([
      staleQueued.id,
      safeProcessing.id
    ]);
    expect(auditReconciliation).toHaveBeenCalledTimes(2);
    expect(queued).toEqual([
      {
        wompiEventId: staleQueued.wompi_event_id,
        issuanceAttemptId: staleQueued.issuance_attempt_id,
        fiscalCorrectionId: staleQueued.id,
        fiscalCorrectionProcessingClaimId: expect.any(String)
      },
      {
        advancedDocumentId: safeProcessing.document_id,
        fiscalClaimId: safeProcessing.fiscal_claim_id,
        fiscalCorrectionId: safeProcessing.id,
        fiscalCorrectionProcessingClaimId: expect.any(String)
      }
    ]);
    expect(queued[0].fiscalCorrectionProcessingClaimId).not.toBe(
      "processing_stale_queued"
    );
    expect(queued[1].fiscalCorrectionProcessingClaimId).not.toBe(
      "processing_safe_old"
    );
    expect(transmit).not.toHaveBeenCalled();
  });

  it("keeps an owned pre-dispatch correction recoverable when its queue message reaches the DLQ", async () => {
    const db = correctionDb();
    const event = correctionEvent({
      issuance_status: "PROCESSING",
      issuance_attempt_id: "issuance_dlq_predispatch",
      processed_at: null
    });
    const correction = correctionRecord({
      id: "fiscal_correction_dlq_predispatch",
      status: "PROCESSING",
      processing_started_at: "2000-01-01T00:00:00.000Z",
      processing_claim_id: "processing_dlq_predispatch",
      issuance_attempt_id: "issuance_dlq_predispatch"
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const deadLetter = vi.spyOn(
      Repository.prototype,
      "markWompiIssuanceDeadLettered"
    );
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");

    const disposition = await consumeCorrectionDeadLetter(
      correctionRuntime(db),
      {
        wompiEventId: String(event.id),
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(disposition.retryAll).not.toHaveBeenCalled();
    expect(correction.status).toBe("PROCESSING");
    expect(correction.mh_dispatch_started_at).toBeNull();
    expect(event.issuance_status).toBe("PROCESSING");
    expect(deadLetter).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expect(db.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "FISCAL_CORRECTION_STARTED",
        entity_id: correction.id
      })
    ]));
  });

  it("moves an owned dispatch-started correction from the DLQ to review without retransmitting", async () => {
    const db = correctionDb();
    const documentId = "doc_dlq_dispatched";
    const event = correctionEvent({
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: "issuance_dlq_dispatched",
      created_document_id: documentId,
      processed_at: "2000-01-01T00:00:00.000Z"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_dlq_dispatched",
      status: "PROCESSING",
      processing_started_at: "2000-01-01T00:00:00.000Z",
      processing_claim_id: "processing_dlq_dispatched",
      issuance_attempt_id: "issuance_dlq_dispatched",
      mh_dispatch_started_at: "2000-01-01T00:01:00.000Z"
    });
    const documentClaimId = `fiscal_correction_${correction.id}`;
    const document = testDocument({
      id: documentId,
      wompi_event_id: String(event.id),
      status: "SIGNED",
      signed_jws: "signed-dlq-dispatched",
      fiscal_operation_claim_id: documentClaimId,
      fiscal_operation_claimed_at: "2000-01-01T00:00:30.000Z",
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    });
    db.wompiEvents.push(event);
    db.documents.push(document);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const deadLetter = vi.spyOn(
      Repository.prototype,
      "markWompiIssuanceDeadLettered"
    );
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");

    const disposition = await consumeCorrectionDeadLetter(
      correctionRuntime(db),
      {
        wompiEventId: String(event.id),
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(disposition.retryAll).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
    expect(event.issuance_status).toBe("DOCUMENT_CREATED");
    expect(deadLetter).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expect(db.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "FISCAL_CORRECTION_REVIEW_REQUIRED",
        entity_id: correction.id
      })
    ]));
  });

  it("does not mutate a correction target for a DLQ message with stale ownership", async () => {
    const db = correctionDb();
    const event = correctionEvent({
      issuance_status: "PROCESSING",
      issuance_attempt_id: "issuance_dlq_stale",
      processed_at: null
    });
    const correction = correctionRecord({
      id: "fiscal_correction_dlq_stale",
      status: "PROCESSING",
      processing_claim_id: "processing_dlq_current",
      issuance_attempt_id: "issuance_dlq_stale"
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const auditReconciliation = vi.mocked(
      Repository.prototype.reconcileFiscalCorrectionAudits
    );
    const deadLetter = vi.spyOn(
      Repository.prototype,
      "markWompiIssuanceDeadLettered"
    );

    const disposition = await consumeCorrectionDeadLetter(
      correctionRuntime(db),
      {
        wompiEventId: String(event.id),
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: "processing_dlq_stale"
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retryAll).not.toHaveBeenCalled();
    expect(correction.status).toBe("PROCESSING");
    expect(event.issuance_status).toBe("PROCESSING");
    expect(auditReconciliation).not.toHaveBeenCalled();
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("reconciles terminal correction audits when an owned duplicate reaches the DLQ", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_dlq_terminal",
      status: "ACCEPTED",
      processing_claim_id: "processing_dlq_terminal",
      completed_at: "2000-01-01T00:02:00.000Z"
    });
    vi.spyOn(Repository.prototype, "getFiscalCorrection")
      .mockResolvedValue(correction);
    const auditReconciliation = vi.spyOn(
      Repository.prototype,
      "reconcileFiscalCorrectionAudits"
    ).mockResolvedValue();
    const deadLetter = vi.spyOn(
      Repository.prototype,
      "markWompiIssuanceDeadLettered"
    );

    const disposition = await consumeCorrectionDeadLetter(
      correctionRuntime(db),
      {
        wompiEventId: correction.wompi_event_id!,
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retryAll).not.toHaveBeenCalled();
    expect(auditReconciliation).toHaveBeenCalledWith(correction);
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it.each(["ACCEPTED", "REJECTED"] as const)(
    "reconciles a stale dispatch-started %s correction without rotating ownership or requeueing",
    async (terminalStatus) => {
      const db = correctionDb();
      const documentId = `doc_stale_terminal_${terminalStatus.toLowerCase()}`;
      const correction = correctionRecord({
        id: `fiscal_correction_stale_terminal_${terminalStatus.toLowerCase()}`,
        wompi_event_id: `wompi_stale_terminal_${terminalStatus.toLowerCase()}`,
        issuance_attempt_id: `issuance_stale_terminal_${terminalStatus.toLowerCase()}`,
        processing_claim_id: `processing_stale_terminal_${terminalStatus.toLowerCase()}`,
        status: "PROCESSING",
        processing_started_at: "2000-01-01T00:00:00.000Z",
        mh_dispatch_started_at: "2000-01-01T00:01:00.000Z"
      });
      const event = correctionEvent({
        id: correction.wompi_event_id,
        created_document_id: documentId,
        issuance_attempt_id: correction.issuance_attempt_id,
        issuance_status: "DOCUMENT_CREATED",
        processed_at: "2000-01-01T00:00:30.000Z"
      });
      const document = testDocument({
        id: documentId,
        wompi_event_id: correction.wompi_event_id,
        status: terminalStatus,
        signed_jws: `signed-${terminalStatus.toLowerCase()}`,
        fiscal_operation_claim_id: null,
        fiscal_operation_claimed_at: null,
        fiscal_operation_kind: null,
        post_accept_finalized_at:
          terminalStatus === "ACCEPTED" ? "2000-01-01T00:02:00.000Z" : null
      });
      db.wompiEvents.push(event);
      db.documents.push(document);
      stubQueuedCorrectionLifecycle(correction, event, db);
      vi.spyOn(Repository.prototype, "listRecoverableFiscalCorrections")
        .mockResolvedValue([correction]);
      const recovered = vi.spyOn(
        Repository.prototype,
        "recoverFiscalCorrectionProcessingClaim"
      );
      const queued: IssuanceMessage[] = [];
      const runtime = correctionRuntime(db, {
        send: async (message: IssuanceMessage) => queued.push(message)
      } as unknown as Queue<IssuanceMessage>);
      const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
      const originalProcessingClaimId = correction.processing_claim_id;

      await new IssuancePipeline(runtime).recoverStalledFiscalCorrections();

      expect(correction.status).toBe(terminalStatus);
      expect(correction.processing_claim_id).toBe(originalProcessingClaimId);
      expect(recovered).not.toHaveBeenCalled();
      expect(queued).toEqual([]);
      expect(transmit).not.toHaveBeenCalled();
      expectCorrectionAudits(db, correction, terminalStatus);
    }
  );

  it("resumes a recovered signed document without rebuilding or allocating again", async () => {
    const db = correctionDb();
    const fiscalClaimId = "fiscal_claim_recovered_signed";
    const rejectedSnapshot = rejectedCorrectionDocument({
      id: "doc_recovered_signed",
      fiscal_operation_claim_id: fiscalClaimId,
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const signedDocument = {
      ...rejectedSnapshot,
      status: "SIGNED",
      signed_jws: "recovered-corrected-signed-jws",
      mh_estado: null,
      mh_observaciones_json: "[]"
    } as DteDocumentRecord;
    const correction = correctionRecord({
      id: "fiscal_correction_recovered_signed",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: signedDocument.id,
      status: "PROCESSING",
      issuance_attempt_id: null,
      fiscal_claim_id: fiscalClaimId,
      processing_claim_id: "correction_processing_recovered_signed",
      processing_started_at: new Date().toISOString(),
      source_document_snapshot_json: JSON.stringify(rejectedSnapshot)
    });
    db.documents.push(signedDocument);
    stubDocumentCorrectionLifecycle(correction, db);
    const sequenceBefore = db.nextSequence;
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-RECOVERED-SIGNED",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });

    const disposition = await consumeCorrectionMessage(
      correctionRuntime(db),
      {
        advancedDocumentId: signedDocument.id,
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        fiscalClaimId
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(correction.status).toBe("ACCEPTED");
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      signed_jws: "recovered-corrected-signed-jws",
      sello_recibido: "SELLO-RECOVERED-SIGNED"
    });
  });

  it("requires OPERATOR before reading either correction target", async () => {
    const unauthenticated = correctionDb(null);
    const viewer = correctionDb("VIEWER");
    const eventLookup = vi.spyOn(Repository.prototype, "getWompiEventById");
    const documentLookup = vi.spyOn(Repository.prototype, "getDteDocument");

    const responses = await Promise.all([
      worker.fetch(new Request("https://example.org/api/wompi-events/wompi_bad_dui/correction-data"), correctionRuntime(unauthenticated)),
      worker.fetch(correctionRequest("/api/documents/doc_rejected_correction/correct-and-retry", {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor()
      }), correctionRuntime(viewer))
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 403]);
    expect(eventLookup).not.toHaveBeenCalled();
    expect(documentLookup).not.toHaveBeenCalled();
  });

  it("returns only editable correction data and active status to an OPERATOR", async () => {
    const db = correctionDb();
    const event = correctionEvent();
    const document = rejectedCorrectionDocument();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getActiveFiscalCorrectionForTarget")
      .mockResolvedValue({ id: "fiscal_correction_active", status: "REVIEW_REQUIRED" });

    const wompi = await worker.fetch(
      correctionRequest("/api/wompi-events/wompi_bad_dui/correction-data", {}, "GET"),
      correctionRuntime(db)
    );
    const direct = await worker.fetch(
      correctionRequest("/api/documents/doc_rejected_correction/correction-data", {}, "GET"),
      correctionRuntime(db)
    );

    expect(wompi.status).toBe(200);
    expect(direct.status).toBe(200);
    const wompiText = await wompi.text();
    expect(JSON.parse(wompiText)).toMatchObject({
      receptor: expect.objectContaining({
        tipoDocumento: "13",
        numDocumento: "12345678-9"
      }),
      targetStatus: "FAILED",
      correctable: true,
      activeCorrection: { id: "fiscal_correction_active", status: "REVIEW_REQUIRED" }
    });
    expect(Object.keys(JSON.parse(wompiText))).toEqual([
      "receptor", "targetStatus", "failureReason", "correctable", "guidance", "activeCorrection"
    ]);
    for (const responseText of [wompiText, await direct.text()]) {
      for (const forbidden of [
        "raw_body", "signed_jws", "amount_cents", "emisor",
        "codigo_generacion", "numero_control", "sello_recibido"
      ]) {
        expect(responseText).not.toContain(forbidden);
      }
    }
  });

  it("returns 404 for missing targets and 409 for ineligible fiscal states", async () => {
    const db = correctionDb();
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const getEvent = vi.spyOn(Repository.prototype, "getWompiEventById");
    const getDocument = vi.spyOn(Repository.prototype, "getDteDocument");

    getEvent.mockResolvedValueOnce(null).mockResolvedValueOnce(
      correctionEvent({
        result: "Denegada",
        raw_body: JSON.stringify(correctionWebhook({ ResultadoTransaccion: "Denegada" }))
      }) as any
    );
    getDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rejectedCorrectionDocument({ status: "ACCEPTED" }))
      .mockResolvedValueOnce(rejectedCorrectionDocument({ status: "INVALIDATED" }))
      .mockResolvedValueOnce(rejectedCorrectionDocument({ fiscal_operation_claim_id: "pending-claim" }));

    const requestBody = {
      correctionRequestId: crypto.randomUUID(),
      receptor: correctionReceptor({ nombre: "Nombre cambiado" })
    };
    const responses = [];
    responses.push(await worker.fetch(correctionRequest("/api/wompi-events/missing/correction-data", {}, "GET"), correctionRuntime(db)));
    responses.push(await worker.fetch(correctionRequest("/api/documents/missing/correction-data", {}, "GET"), correctionRuntime(db)));
    responses.push(await worker.fetch(correctionRequest("/api/wompi-events/wompi_bad_dui/correct-and-retry", requestBody), correctionRuntime(db)));
    for (let index = 0; index < 3; index += 1) {
      responses.push(await worker.fetch(correctionRequest("/api/documents/doc_rejected_correction/correct-and-retry", {
        ...requestBody,
        correctionRequestId: crypto.randomUUID()
      }), correctionRuntime(db)));
    }

    expect(responses.map((response) => response.status)).toEqual([404, 404, 409, 409, 409, 409]);
  });

  it("rejects protected keys and unchanged corrections before claiming", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7",
        Nombre: "Ana",
        Apellidos: "Donante",
        EMail: "ana@example.org",
        Celular: "70001111",
        CodigoPais: "GT",
        Direccion: "Direccion demo"
      }
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ raw_body: JSON.stringify(payload) }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const claim = vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection");

    const topLevelProtected = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor(),
        amount_cents: 1
      }
    ), correctionRuntime(db));
    const receptorProtected = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: { ...correctionReceptor(), emisor: { nombre: "Ataque" } }
      }
    ), correctionRuntime(db));
    const unchanged = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor({
          codDomiciliado: 2,
          codPais: "GT",
          departamento: "00",
          municipio: "00",
          distrito: "00",
          complemento: "Direccion demo"
        })
      }
    ), correctionRuntime(db));

    expect([topLevelProtected.status, receptorProtected.status, unchanged.status]).toEqual([400, 400, 400]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("queues claimed Wompi and document corrections with every ownership token", async () => {
    const db = correctionDb();
    const event = correctionEvent();
    const document = rejectedCorrectionDocument();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_document",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_document"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);

    const wompi = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: "11111111-1111-4111-8111-111111111111",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);
    const direct = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "70000003-2222-4222-8222-700000032222",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect([wompi.status, direct.status]).toEqual([202, 202]);
    await expect(wompi.json()).resolves.toEqual({
      ok: true,
      queued: true,
      correctionId: "fiscal_correction_1",
      status: "QUEUED"
    });
    expect(queued).toEqual([
      {
        wompiEventId: "wompi_bad_dui",
        fiscalCorrectionId: "fiscal_correction_1",
        fiscalCorrectionProcessingClaimId: "correction_processing_1",
        issuanceAttemptId: "issuance_attempt_1"
      },
      {
        advancedDocumentId: "doc_rejected_correction",
        fiscalCorrectionId: "fiscal_correction_document",
        fiscalCorrectionProcessingClaimId: "correction_processing_1",
        fiscalClaimId: "fiscal_claim_document"
      }
    ]);
  });

  it("rejects a guarded Wompi correction when its app intent binding is unresolved", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      IdExterno: "di_missing_correction",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_missing_correction"
      }
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ raw_body: JSON.stringify(payload) }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const claim = vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection");
    const queued: IssuanceMessage[] = [];

    const dataResponse = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correction-data",
      {},
      "GET"
    ), correctionRuntime(db));
    const response = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: "03030303-0303-4303-8303-030303030303",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>));

    expect(dataResponse.status).toBe(200);
    await expect(dataResponse.json()).resolves.toMatchObject({
      correctable: false,
      guidance: "La intención de donación no coincide con este evento Wompi. Revise el vínculo antes de reintentar."
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "wompi_intent_binding_unresolved",
      message: "La intención de donación no coincide con este evento Wompi."
    });
    expect(claim).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("keeps guarded Wompi correction available for a bound app intent", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      IdExterno: "di_bound_correction",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_bound_correction"
      }
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ raw_body: JSON.stringify(payload) }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue({
      id: "di_bound_correction",
      status: "LINK_CREATED",
      wompi_id_enlace: 987654,
      gift_type: "DIEZMO"
    } as any);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: "04040404-0404-4404-8404-040404040404",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("accepts a guarded correction for a legacy terminal event stuck in PROCESSING", async () => {
    const db = correctionDb();
    const event = correctionEvent({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-17T17:00:00.000Z",
      issuance_attempt_id: "legacy-stuck-attempt"
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);

    const response = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: "05050505-0505-4505-8505-050505050505",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toEqual([{
      wompiEventId: "wompi_bad_dui",
      fiscalCorrectionId: "fiscal_correction_1",
      fiscalCorrectionProcessingClaimId: "correction_processing_1",
      issuanceAttemptId: "issuance_attempt_1"
    }]);
  });

  it("stops a claimed Wompi correction when its bound intent becomes unresolved before queue processing", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      IdExterno: "di_raced_correction",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_raced_correction"
      }
    });
    const event = correctionEvent({
      raw_body: JSON.stringify(payload),
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "issuance_attempt_raced"
    });
    const correction = correctionRecord({
      issuance_attempt_id: "issuance_attempt_raced"
    });
    db.wompiEvents.push(event);
    const intent = {
      id: "di_raced_correction",
      status: "LINK_CREATED",
      wompi_id_enlace: 987654
    };
    db.donationIntents.push(intent);
    stubQueuedCorrectionLifecycle(correction, event, db);
    // The HTTP request claimed the correction while the intent was bound. Before the
    // queued worker starts, another lifecycle write makes that binding ineligible.
    intent.status = "COMPLETED";
    const sequenceBefore = db.nextSequence;
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");

    const disposition = await consumeCorrectionMessage(
      correctionRuntime(db),
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: "issuance_attempt_raced"
      }
    );

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "WOMPI_INTENT_QUARANTINED"
    });
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(transmit).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "SIGNED", "FAILED", "CONTINGENCY_PENDING"] as const)(
    "quarantines a pre-fix unbound Wompi correction before resuming its existing %s document",
    async (documentStatus) => {
      const db = correctionDb();
      const payload = correctionWebhook({
        IdExterno: "di_missing_existing_correction",
        EnlacePago: {
          Id: 987654,
          IdentificadorEnlaceComercio: "di_missing_existing_correction"
        },
        Cliente: {
          ...(correctionWebhook().Cliente ?? {}),
          DocumentoIdentidad: "10000002-7"
        }
      });
      const correction = correctionRecord({
        id: `fiscal_correction_existing_${documentStatus.toLowerCase()}`,
        wompi_event_id: `wompi_correction_existing_${documentStatus.toLowerCase()}`,
        issuance_attempt_id: `issuance_attempt_existing_${documentStatus.toLowerCase()}`,
        processing_claim_id: `correction_processing_existing_${documentStatus.toLowerCase()}`,
        status: "PROCESSING",
        processing_started_at: "2026-07-18T12:01:00.000Z",
        mh_dispatch_started_at: null
      });
      const plainDocument = buildCdeDocument(payload, emisorConfig(), {
        sequence: 83,
        environment: "00",
        issuedAt: new Date(payload.FechaTransaccion)
      });
      const identification = plainDocument.identificacion as Record<string, unknown>;
      const document = testDocument({
        id: `dte_correction_existing_${documentStatus.toLowerCase()}`,
        wompi_event_id: correction.wompi_event_id,
        status: documentStatus,
        codigo_generacion: String(identification.codigoGeneracion),
        numero_control: String(identification.numeroControl),
        plain_json: JSON.stringify(plainDocument),
        signed_jws: documentStatus === "PENDING" ? null : "signed-before-binding-guard",
        sello_recibido: null,
        mh_estado: null,
        accepted_at: null,
        post_accept_finalized_at: null,
        fiscal_operation_claim_id: null,
        fiscal_operation_claimed_at: null,
        fiscal_operation_kind: null
      });
      const event = correctionEvent({
        id: correction.wompi_event_id,
        transaction_id: payload.IdTransaccion,
        raw_body: JSON.stringify(payload),
        processed_at: "2026-07-18T12:00:30.000Z",
        created_document_id: document.id,
        issuance_status: "DOCUMENT_CREATED",
        issuance_attempt_id: correction.issuance_attempt_id,
        control_prefix: "M001P004",
        control_sequence: 83,
        reserved_codigo_generacion: document.codigo_generacion,
        reserved_numero_control: document.numero_control
      });
      db.wompiEvents.push(event);
      db.documents.push(document);
      stubQueuedCorrectionLifecycle(correction, event, db);
      vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
      const sign = vi.spyOn(crypto.subtle, "sign");
      const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
      const eventBefore = JSON.stringify(event);
      const documentBefore = { ...document };
      const sequenceBefore = db.nextSequence;
      const runtime = correctionRuntime(db);

      const disposition = await consumeCorrectionMessage(
        runtime,
        {
          wompiEventId: String(event.id),
          fiscalCorrectionId: correction.id,
          fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
          issuanceAttemptId: correction.issuance_attempt_id!
        }
      );

      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
      expect(correction).toMatchObject({
        status: "FAILED",
        failure_code: "WOMPI_INTENT_QUARANTINED",
        issuance_attempt_id: `issuance_attempt_existing_${documentStatus.toLowerCase()}`,
        processing_claim_id: `correction_processing_existing_${documentStatus.toLowerCase()}`
      });
      expect(JSON.stringify(event)).toBe(eventBefore);
      expect(document).toMatchObject({
        ...documentBefore,
        fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
        fiscal_operation_claimed_at: expect.any(String),
        fiscal_operation_kind: "TRANSMISSION",
        fiscal_operation_event_id: null
      });
      expect(db.nextSequence).toBe(sequenceBefore);
      expect(sign).not.toHaveBeenCalled();
      expect(transmit).not.toHaveBeenCalled();
      expectCorrectionAudits(db, correction, "FAILED");

      await new IssuancePipeline(runtime).processDteDocument(document.id);

      expect(transmit).not.toHaveBeenCalled();
    }
  );

  it("preclaims, signs, and transmits a bound legacy PENDING Wompi correction exactly once", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      IdExterno: "di_bound_existing_pending",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_bound_existing_pending"
      },
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7"
      }
    });
    const correction = correctionRecord({
      id: "fiscal_correction_bound_existing_pending",
      wompi_event_id: "wompi_correction_bound_existing_pending",
      issuance_attempt_id: "issuance_attempt_bound_existing_pending",
      processing_claim_id: "correction_processing_bound_existing_pending",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z",
      mh_dispatch_started_at: null
    });
    const intent = {
      id: "di_bound_existing_pending",
      status: "LINK_CREATED",
      wompi_id_enlace: 987654,
      gift_type: "DIEZMO"
    };
    const plainDocument = buildCorrectedWompiCandidate({
      payload,
      intent: intent as any,
      correction: correctionReceptor(),
      config: emisorConfig(),
      sequence: 84,
      environment: "00"
    });
    const identification = plainDocument.identificacion as Record<string, unknown>;
    const document = testDocument({
      id: "dte_correction_bound_existing_pending",
      wompi_event_id: correction.wompi_event_id,
      status: "PENDING",
      codigo_generacion: String(identification.codigoGeneracion),
      numero_control: String(identification.numeroControl),
      plain_json: JSON.stringify(plainDocument),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      post_accept_finalized_at: null,
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-18T12:00:30.000Z",
      created_document_id: document.id,
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: "M001P004",
      control_sequence: 84,
      reserved_codigo_generacion: document.codigo_generacion,
      reserved_numero_control: document.numero_control
    });
    db.donationIntents.push(intent);
    db.wompiEvents.push(event);
    db.documents.push(document);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const claimDocument = vi.mocked(
      Repository.prototype.claimWompiFiscalCorrectionDocument
    );
    const signClaimedDocument = vi.mocked(
      Repository.prototype.updateClaimedDocumentSigned
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-BOUND-EXISTING-PENDING",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    const documentClaimId = `fiscal_correction_${correction.id}`;
    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(claimDocument).toHaveBeenCalledTimes(1);
    expect(claimDocument).toHaveBeenCalledWith({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id,
      documentId: document.id
    });
    expect(signClaimedDocument).toHaveBeenCalledTimes(1);
    expect(signClaimedDocument).toHaveBeenCalledWith(
      document.id,
      expect.any(String),
      "PENDING",
      documentClaimId
    );
    expect(claimDocument.mock.invocationCallOrder[0]).toBeLessThan(
      signClaimedDocument.mock.invocationCallOrder[0]
    );
    expect(sign).toHaveBeenCalledTimes(1);
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "ACCEPTED",
      failure_code: null,
      failure_message: null,
      completed_at: expect.any(String)
    });
    expect(document).toMatchObject({
      status: "ACCEPTED",
      signed_jws: expect.any(String),
      sello_recibido: "SELLO-BOUND-EXISTING-PENDING",
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null,
      fiscal_operation_event_id: null
    });
    expectCorrectionAudits(db, correction, "ACCEPTED");
  });

  it.each([
    {
      label: "corrected receptor",
      persistedCorrection: correctionReceptor({ nombre: "Receptor persistido distinto" }),
      persistedGiftType: "DIEZMO",
      currentGiftType: "DIEZMO"
    },
    {
      label: "bound gift type",
      persistedCorrection: correctionReceptor(),
      persistedGiftType: "DIEZMO",
      currentGiftType: "OFRENDA"
    }
  ] as const)(
    "quarantines an existing PENDING Wompi correction whose $label no longer matches",
    async ({ label, persistedCorrection, persistedGiftType, currentGiftType }) => {
      const suffix = label.replaceAll(" ", "_");
      const intentId = `di_mismatched_${suffix}`;
      const db = correctionDb();
      const payload = correctionWebhook({
        IdExterno: intentId,
        EnlacePago: {
          Id: 987654,
          IdentificadorEnlaceComercio: intentId
        },
        Cliente: {
          ...(correctionWebhook().Cliente ?? {}),
          DocumentoIdentidad: "10000002-7"
        }
      });
      const correction = correctionRecord({
        id: `fiscal_correction_mismatched_${suffix}`,
        wompi_event_id: `wompi_correction_mismatched_${suffix}`,
        issuance_attempt_id: `issuance_attempt_mismatched_${suffix}`,
        processing_claim_id: `correction_processing_mismatched_${suffix}`,
        status: "PROCESSING",
        processing_started_at: "2026-07-18T12:01:00.000Z",
        mh_dispatch_started_at: null
      });
      const currentIntent = {
        id: intentId,
        status: "LINK_CREATED",
        wompi_id_enlace: 987654,
        gift_type: currentGiftType
      };
      const persistedDocument = buildCorrectedWompiCandidate({
        payload,
        intent: {
          ...currentIntent,
          gift_type: persistedGiftType
        } as any,
        correction: persistedCorrection,
        config: emisorConfig(),
        sequence: 85,
        environment: "00"
      });
      const identification = persistedDocument.identificacion as Record<string, unknown>;
      const document = testDocument({
        id: `dte_correction_mismatched_${suffix}`,
        wompi_event_id: correction.wompi_event_id,
        status: "PENDING",
        codigo_generacion: String(identification.codigoGeneracion),
        numero_control: String(identification.numeroControl),
        plain_json: JSON.stringify(persistedDocument),
        signed_jws: null,
        sello_recibido: null,
        mh_estado: null,
        accepted_at: null,
        post_accept_finalized_at: null,
        fiscal_operation_claim_id: null,
        fiscal_operation_claimed_at: null,
        fiscal_operation_kind: null
      });
      const event = correctionEvent({
        id: correction.wompi_event_id,
        transaction_id: payload.IdTransaccion,
        raw_body: JSON.stringify(payload),
        processed_at: "2026-07-18T12:00:30.000Z",
        created_document_id: document.id,
        issuance_status: "DOCUMENT_CREATED",
        issuance_attempt_id: correction.issuance_attempt_id,
        control_prefix: "M001P004",
        control_sequence: 85,
        reserved_codigo_generacion: document.codigo_generacion,
        reserved_numero_control: document.numero_control
      });
      db.donationIntents.push(currentIntent);
      db.wompiEvents.push(event);
      db.documents.push(document);
      stubQueuedCorrectionLifecycle(correction, event, db);
      const runtime = correctionRuntime(db);
      runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
      runtime.MH_CERT_PASSWORD = "cert-password";
      const sign = vi.spyOn(crypto.subtle, "sign");
      const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
        accepted: true,
        estado: "PROCESADO",
        selloRecibido: "MUST-NOT-TRANSMIT",
        observaciones: [],
        raw: { estado: "PROCESADO" }
      });

      const disposition = await consumeCorrectionMessage(runtime, {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id!
      });

      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
      expect(correction).toMatchObject({
        status: "FAILED",
        failure_code: "FISCAL_CORRECTION_EXISTING_DOCUMENT_MISMATCH",
        completed_at: expect.any(String)
      });
      expect(document).toMatchObject({
        status: "PENDING",
        signed_jws: null,
        sello_recibido: null,
        fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
        fiscal_operation_claimed_at: expect.any(String),
        fiscal_operation_kind: "TRANSMISSION",
        fiscal_operation_event_id: null
      });
      expect(sign).not.toHaveBeenCalled();
      expect(transmit).not.toHaveBeenCalled();
      expectCorrectionAudits(db, correction, "FAILED");
    }
  );

  it("issues a corrected pre-CDE Wompi failure with its existing reservation", async () => {
    const db = correctionDb();
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const numeroControl = "DTE-15-M001P004-000000000000041";
    const event = correctionEvent({
      control_prefix: "M001P004",
      control_sequence: 41,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    });
    db.wompiEvents.push(event);
    db.nextSequence = 42;
    const rawBodyBefore = String(event.raw_body);
    const intentsBefore = JSON.stringify(db.donationIntents);
    const sequenceBefore = db.nextSequence;
    const correction = correctionRecord({
      wompi_event_id: String(event.id),
      issuance_attempt_id: "issuance_attempt_corrected_1",
      processing_claim_id: "correction_processing_corrected_1",
      changed_fields_json: JSON.stringify([
        "numDocumento",
        "raw_body",
        "numDocumento",
        42
      ])
    });
    stubCorrectionAuditReconciliation(correction, db);
    const queued: IssuanceMessage[] = [];
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockImplementation(async () => {
      event.processed_at = null;
      event.issuance_status = "RETRY_QUEUED";
      event.issuance_attempt_id = correction.issuance_attempt_id;
      return { kind: "claimed", correction };
    });
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
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const currentEvent = db.wompiEvents.find((candidate) =>
          candidate.id === correction.wompi_event_id
        );
        const document = db.documents.find((candidate) =>
          candidate.id === currentEvent?.created_document_id
        );
        if (
          input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== document?.id
          || input.documentClaimId !== `fiscal_correction_${correction.id}`
          || input.signedJws !== document?.signed_jws
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const currentEvent = db.wompiEvents.find((candidate) =>
          candidate.id === correction.wompi_event_id
        );
        const document = db.documents.find((candidate) =>
          candidate.id === currentEvent?.created_document_id
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || !document
          || outcome.document?.documentId !== document.id
          || outcome.document.documentClaimId !== `fiscal_correction_${correction.id}`
          || outcome.document.signedJws !== document.signed_jws
          || document.status !== outcome.status
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        return true;
      });
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.EMISOR_CONFIG_JSON = JSON.stringify({
      ...emisorConfig(),
      controlPrefix: "M009P009"
    });
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const response = await worker.fetch(correctionRequest(
      `/api/wompi-events/${String(event.id)}/correct-and-retry`,
      {
        correctionRequestId: correction.request_id,
        receptor: correctionReceptor()
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toEqual([expect.objectContaining({
      fiscalCorrectionId: expect.any(String),
      fiscalCorrectionProcessingClaimId: expect.any(String),
      issuanceAttemptId: expect.any(String)
    })]);
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({
      queue: "diezmossv-staging-example-issuance",
      messages: [{
        id: "msg_corrected_wompi_1",
        timestamp: new Date(),
        body: queued[0],
        attempts: 1,
        ack,
        retry
      }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>, runtime);

    expect(correction).toMatchObject({
      status: "ACCEPTED",
      failure_code: null,
      failure_message: null
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const created = db.documents[0];
    expect(created.numero_control).toBe(numeroControl);
    expect(created.codigo_generacion).toBe(codigoGeneracion);
    expect(JSON.parse(created.plain_json).receptor.numDocumento).toBe("10000002-7");
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(event.raw_body).toBe(rawBodyBefore);
    expect(JSON.stringify(db.donationIntents)).toBe(intentsBefore);
    expectCorrectionAudits(db, correction, "ACCEPTED", ["numDocumento"], true);
  });

  it("validates before allocating one reservation for a corrected event without identifiers", async () => {
    const db = correctionDb();
    db.nextSequence = 51;
    const correction = correctionRecord({
      id: "fiscal_correction_unreserved",
      wompi_event_id: "wompi_correction_unreserved",
      issuance_attempt_id: "issuance_attempt_unreserved",
      processing_claim_id: "correction_processing_unreserved"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].numero_control).toBe(
      `DTE-15-M001P004-${String(sequenceBefore).padStart(15, "0")}`
    );
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("does not allocate when the durable corrected candidate fails validation", async () => {
    const db = correctionDb();
    db.nextSequence = 56;
    const correction = correctionRecord({
      id: "fiscal_correction_invalid_candidate",
      wompi_event_id: "wompi_correction_invalid_candidate",
      issuance_attempt_id: "issuance_attempt_invalid_candidate",
      processing_claim_id: "correction_processing_invalid_candidate",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        numDocumento: "12345678-9"
      }))
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      received_at: "2026-07-17T12:00:00.000Z",
      issuance_last_attempt_at: "2026-07-17T12:01:00.000Z",
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const queued: IssuanceMessage[] = [];
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_INVALID_CANDIDATE",
      mh_dispatch_started_at: null
    });
    expect(event.issuance_claim_id ?? null).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();

    await new IssuancePipeline(runtime).sweepStalledWompiEvents();

    expect(queued).toHaveLength(0);
    expect(event).toMatchObject({
      issuance_status: "FAILED",
      processed_at: expect.any(String),
      issuance_attempt_id: null,
      issuance_claim_id: null
    });
  });

  it("acks a duplicate correction delivery without allocating or transmitting twice", async () => {
    const db = correctionDb();
    db.nextSequence = 61;
    const correction = correctionRecord({
      id: "fiscal_correction_duplicate",
      wompi_event_id: "wompi_correction_duplicate",
      issuance_attempt_id: "issuance_attempt_duplicate",
      processing_claim_id: "correction_processing_duplicate"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const body: IssuanceMessage = {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    };
    const sequenceBefore = db.nextSequence;

    const first = await consumeCorrectionMessage(runtime, body, "msg_correction_duplicate_1");
    const second = await consumeCorrectionMessage(runtime, body, "msg_correction_duplicate_2");

    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("allows only the correction CAS winner to transmit under concurrent delivery", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_concurrent_dispatch",
      wompi_event_id: "wompi_correction_concurrent_dispatch",
      issuance_attempt_id: "issuance_attempt_concurrent_dispatch",
      processing_claim_id: "correction_processing_concurrent_dispatch",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z"
    });
    const payload = correctionWebhook({
      IdExterno: "di_concurrent_correction",
      EnlacePago: {
        Id: 987655,
        IdentificadorEnlaceComercio: "di_concurrent_correction"
      },
      IdTransaccion: "wompi_correction_concurrent_dispatch_tx",
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7"
      }
    });
    const intent = {
      id: "di_concurrent_correction",
      status: "LINK_CREATED",
      wompi_id_enlace: 987655,
      gift_type: "DIEZMO"
    };
    const document = buildCorrectedWompiCandidate({
      payload,
      intent: intent as any,
      correction: correctionReceptor(),
      config: emisorConfig(),
      sequence: 62,
      environment: "00"
    });
    const identifiers = (document.identificacion ?? {}) as Record<string, unknown>;
    const documentId = "dte_correction_concurrent_dispatch";
    const event = correctionEvent({
      id: correction.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-18T12:02:00.000Z",
      created_document_id: documentId,
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: "M001P004",
      control_sequence: 62,
      reserved_codigo_generacion: String(identifiers.codigoGeneracion),
      reserved_numero_control: String(identifiers.numeroControl)
    });
    db.donationIntents.push(intent);
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: documentId,
      wompi_event_id: String(event.id),
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: "signed-corrected-document",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      codigo_generacion: String(identifiers.codigoGeneracion),
      numero_control: String(identifiers.numeroControl),
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_claimed_at: "2026-07-18T12:02:01.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    let arrivals = 0;
    let releaseArrivals!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        expect(input).toEqual({
          correctionId: correction.id,
          processingClaimId: correction.processing_claim_id,
          documentId,
          documentClaimId: `fiscal_correction_${correction.id}`,
          signedJws: "signed-corrected-document"
        });
        arrivals += 1;
        if (arrivals === 2) releaseArrivals();
        await bothArrived;
        if (correction.mh_dispatch_started_at) return false;
        correction.mh_dispatch_started_at = "2026-07-18T12:03:00.000Z";
        return true;
      });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-CONCURRENT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    const body: IssuanceMessage = {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    };

    const [first, second] = await Promise.all([
      consumeCorrectionMessage(runtime, body, "msg_correction_concurrent_1"),
      consumeCorrectionMessage(runtime, body, "msg_correction_concurrent_2")
    ]);

    expect(transmit).toHaveBeenCalledTimes(1);
    expect(first.ack.mock.calls.length + second.ack.mock.calls.length).toBe(1);
    expect(first.retry.mock.calls.length + second.retry.mock.calls.length).toBe(1);
    expect(correction).toMatchObject({
      status: "ACCEPTED",
      mh_dispatch_started_at: "2026-07-18T12:03:00.000Z"
    });
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-CORRECTION"
    });
  });

  it("keeps a durable MH acceptance when post-accept bookkeeping throws", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_post_accept_failure",
      wompi_event_id: "wompi_correction_post_accept_failure",
      issuance_attempt_id: "issuance_attempt_post_accept_failure",
      processing_claim_id: "correction_processing_post_accept_failure"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    vi.spyOn(Repository.prototype, "claimDocumentPostAcceptFinalization")
      .mockRejectedValueOnce(new Error("injected post-accept bookkeeping failure"));
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      post_accept_finalized_at: null
    });
    expect(correction.status).toBe("ACCEPTED");
    expectCorrectionAudits(db, correction, "ACCEPTED");
  });

  it("acks missing or stale correction ownership without allocating, signing, or transmitting", async () => {
    const db = correctionDb();
    db.nextSequence = 71;
    const correction = correctionRecord({
      id: "fiscal_correction_stale_ownership",
      wompi_event_id: "wompi_correction_stale_ownership",
      issuance_attempt_id: "issuance_attempt_owned",
      processing_claim_id: "correction_processing_owned"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    const sequenceBefore = db.nextSequence;
    const messages: IssuanceMessage[] = [
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        issuanceAttemptId: correction.issuance_attempt_id!
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: "correction_processing_stale",
        issuanceAttemptId: correction.issuance_attempt_id!
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: "issuance_attempt_stale"
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalClaimId: "unexpected_fiscal_claim"
      }
    ];

    const dispositions = [];
    for (const [index, message] of messages.entries()) {
      dispositions.push(await consumeCorrectionMessage(
        runtime,
        message,
        `msg_correction_stale_${index}`
      ));
    }

    for (const disposition of dispositions) {
      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
    }
    expect(correction.status).toBe("QUEUED");
    expect(event.issuance_claim_id ?? null).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("finalizes a corrected CDE rejected by MH as REJECTED", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_rejected",
      wompi_event_id: "wompi_correction_rejected",
      issuance_attempt_id: "issuance_attempt_rejected",
      processing_claim_id: "correction_processing_rejected"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      expect(correction.mh_dispatch_started_at).toBeTruthy();
      return {
        accepted: false,
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: ["#/receptor/numDocumento rechazado"],
        raw: { estado: "RECHAZADO" }
      };
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction.status).toBe("REJECTED");
    expect(correction.mh_dispatch_started_at).toBeTruthy();
    expect(db.documents[0]).toMatchObject({
      status: "REJECTED",
      fiscal_operation_claim_id: null
    });
    expectCorrectionAudits(db, correction, "REJECTED");
  });

  it.each(["ACCEPTED", "REJECTED"] as const)(
    "recovers a known %s correction when terminal DTE persistence is followed by a finalization crash",
    async (terminalStatus) => {
      const db = correctionDb();
      const suffix = terminalStatus.toLowerCase();
      const correction = correctionRecord({
        id: `fiscal_correction_terminal_crash_${suffix}`,
        wompi_event_id: `wompi_correction_terminal_crash_${suffix}`,
        issuance_attempt_id: `issuance_attempt_terminal_crash_${suffix}`,
        processing_claim_id: `correction_processing_terminal_crash_${suffix}`
      });
      const event = correctionEvent({
        id: correction.wompi_event_id,
        processed_at: null,
        issuance_status: "RETRY_QUEUED",
        issuance_attempt_id: correction.issuance_attempt_id
      });
      db.wompiEvents.push(event);
      stubQueuedCorrectionLifecycle(correction, event, db);
      const finalize = vi.mocked(
        Repository.prototype.finalizeFiscalCorrection
      );
      const finalizeImplementation = finalize.getMockImplementation();
      if (!finalizeImplementation) {
        throw new Error("expected fiscal correction finalization stub");
      }
      finalize
        .mockRejectedValueOnce(new Error("injected post-MH finalization crash"))
        .mockImplementation(finalizeImplementation);
      const transmit = vi.spyOn(MhClient.prototype, "transmitDte")
        .mockResolvedValue({
          accepted: terminalStatus === "ACCEPTED",
          estado: terminalStatus === "ACCEPTED" ? "PROCESADO" : "RECHAZADO",
          selloRecibido:
            terminalStatus === "ACCEPTED" ? `SELLO-${suffix}` : null,
          observaciones:
            terminalStatus === "ACCEPTED" ? [] : ["Rechazo conocido"],
          raw: { estado: terminalStatus }
        });
      const runtime = correctionRuntime(db);
      runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
      runtime.MH_CERT_PASSWORD = "cert-password";

      const disposition = await consumeCorrectionMessage(runtime, {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id!
      });

      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
      expect(transmit).toHaveBeenCalledTimes(1);
      expect(correction.status).toBe(terminalStatus);
      expect(db.documents[0]).toMatchObject({
        status: terminalStatus,
        fiscal_operation_claim_id: null
      });
      expectCorrectionAudits(db, correction, terminalStatus);
    }
  );

  it("marks a proven MH pre-dispatch correction failure FAILED and clears claims", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_pre_dispatch",
      wompi_event_id: "wompi_correction_pre_dispatch",
      issuance_attempt_id: "issuance_attempt_pre_dispatch",
      processing_claim_id: "correction_processing_pre_dispatch"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new MhPreDispatchError("MH auth unavailable", new Error("auth unavailable"))
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "FAILED",
      mh_dispatch_started_at: null,
      failure_code: "MH_PRE_DISPATCH_ERROR"
    });
    expect(db.documents[0]).toMatchObject({
      status: "FAILED",
      fiscal_operation_claim_id: null
    });
    expectCorrectionAudits(db, correction, "FAILED");
  });

  it("keeps an ambiguous corrected MH dispatch claimed and REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_uncertain",
      wompi_event_id: "wompi_correction_uncertain",
      issuance_attempt_id: "issuance_attempt_uncertain",
      processing_claim_id: "correction_processing_uncertain"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      expect(correction.mh_dispatch_started_at).toBeTruthy();
      throw new Error("connection reset after request write");
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: expect.any(String),
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_kind: "TRANSMISSION"
    });
    expectCorrectionAudits(db, correction, "REVIEW_REQUIRED");
  });

  it("turns a redelivered post-boundary PROCESSING correction into REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const documentId = "dte_correction_post_boundary_redelivery";
    const correction = correctionRecord({
      id: "fiscal_correction_post_boundary_redelivery",
      wompi_event_id: "wompi_correction_post_boundary_redelivery",
      issuance_attempt_id: "issuance_attempt_post_boundary_redelivery",
      processing_claim_id: "correction_processing_post_boundary_redelivery",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z",
      mh_dispatch_started_at: "2026-07-18T12:02:00.000Z"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: "2026-07-18T12:01:30.000Z",
      created_document_id: documentId,
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: documentId,
      wompi_event_id: String(correction.wompi_event_id),
      status: "SIGNED",
      signed_jws: "signed-post-boundary-correction",
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_claimed_at: "2026-07-18T12:01:59.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: "2026-07-18T12:02:00.000Z",
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
  });

  it.each(["ACCEPTED", "REJECTED"] as const)(
    "finalizes a redelivered post-boundary correction from its durable %s DTE without redispatching",
    async (terminalStatus) => {
      const db = correctionDb();
      const suffix = terminalStatus.toLowerCase();
      const documentId = `dte_correction_terminal_redelivery_${suffix}`;
      const correction = correctionRecord({
        id: `fiscal_correction_terminal_redelivery_${suffix}`,
        wompi_event_id: `wompi_correction_terminal_redelivery_${suffix}`,
        issuance_attempt_id: `issuance_attempt_terminal_redelivery_${suffix}`,
        processing_claim_id: `correction_processing_terminal_redelivery_${suffix}`,
        status: "PROCESSING",
        processing_started_at: "2026-07-18T12:01:00.000Z",
        mh_dispatch_started_at: "2026-07-18T12:02:00.000Z"
      });
      const event = correctionEvent({
        id: correction.wompi_event_id,
        processed_at: "2026-07-18T12:01:30.000Z",
        created_document_id: documentId,
        issuance_status: "DOCUMENT_CREATED",
        issuance_attempt_id: correction.issuance_attempt_id
      });
      db.wompiEvents.push(event);
      db.documents.push(testDocument({
        id: documentId,
        wompi_event_id: String(correction.wompi_event_id),
        status: terminalStatus,
        signed_jws: `signed-terminal-redelivery-${suffix}`,
        fiscal_operation_claim_id: null,
        fiscal_operation_claimed_at: null,
        fiscal_operation_kind: null,
        post_accept_finalized_at:
          terminalStatus === "ACCEPTED" ? "2026-07-18T12:03:00.000Z" : null
      }));
      stubQueuedCorrectionLifecycle(correction, event, db);
      const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
      const runtime = correctionRuntime(db);

      const disposition = await consumeCorrectionMessage(runtime, {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id!
      });

      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
      expect(transmit).not.toHaveBeenCalled();
      expect(correction).toMatchObject({
        status: terminalStatus,
        mh_dispatch_started_at: "2026-07-18T12:02:00.000Z",
        failure_code: null
      });
      expectCorrectionAudits(db, correction, terminalStatus);
    }
  );

  it("retries token-owned safe pre-dispatch work while its CDE claim is busy", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_safe_busy",
      wompi_event_id: "wompi_correction_safe_busy",
      issuance_attempt_id: "issuance_attempt_safe_busy",
      processing_claim_id: "correction_processing_safe_busy",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z"
    });
    const payload = correctionWebhook({
      IdTransaccion: "wompi_correction_safe_busy_tx",
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7"
      }
    });
    const document = buildCdeDocument(payload, emisorConfig(), {
      sequence: 81,
      environment: "00",
      issuedAt: new Date(payload.FechaTransaccion)
    });
    const identifiers = (document.identificacion ?? {}) as Record<string, unknown>;
    const event = correctionEvent({
      id: correction.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-18T12:02:00.000Z",
      created_document_id: "dte_correction_safe_busy",
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: "dte_correction_safe_busy",
      wompi_event_id: String(event.id),
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: "signed-by-other-owner",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      codigo_generacion: String(identifiers.codigoGeneracion),
      numero_control: String(identifiers.numeroControl),
      fiscal_operation_claim_id: "foreign-safe-predispatch-claim",
      fiscal_operation_claimed_at: "2026-07-18T12:02:01.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).not.toHaveBeenCalled();
    expect(disposition.retry).toHaveBeenCalledTimes(1);
    expect(transmit).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "PROCESSING",
      mh_dispatch_started_at: null
    });
    expect(db.documents[0].fiscal_operation_claim_id).toBe("foreign-safe-predispatch-claim");
  });

  it("fences a reserved direct correction before signing after recovery rotates ownership", async () => {
    const db = correctionDb();
    db.nextSequence = 89;
    const source = rejectedCorrectionDocument({
      id: "doc_correction_signing_fence",
      fiscal_operation_claim_id: "fiscal_claim_signing_fence",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_signing_fence",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_signing_fence",
      processing_claim_id: "correction_processing_signing_old",
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);

    const reserve = vi.mocked(
      Repository.prototype.reserveFiscalCorrectionDocumentIdentifiers
    );
    const reserveImplementation = reserve.getMockImplementation();
    if (!reserveImplementation) throw new Error("expected reservation fixture");
    let reservationCall = 0;
    let releaseOldReservation!: () => void;
    let markOldReserved!: () => void;
    const oldReserved = new Promise<void>((resolve) => {
      markOldReserved = resolve;
    });
    const reservationGate = new Promise<void>((resolve) => {
      releaseOldReservation = resolve;
    });
    reserve.mockImplementation(async (input) => {
      const result = await reserveImplementation(input);
      reservationCall += 1;
      if (reservationCall === 1) {
        markOldReserved();
        await reservationGate;
      }
      return result;
    });
    vi.spyOn(Repository.prototype, "recoverFiscalCorrectionProcessingClaim")
      .mockImplementation(async (input) => {
        if (
          input.id !== correction.id
          || input.currentProcessingClaimId !== correction.processing_claim_id
        ) {
          return null;
        }
        correction.processing_claim_id = input.nextProcessingClaimId;
        correction.processing_started_at = new Date().toISOString();
        return correction;
      });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sign = vi.spyOn(crypto.subtle, "sign");
    const prepare = vi.mocked(
      Repository.prototype.prepareClaimedFiscalCorrectionDocument
    );
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-SIGNING-FENCE",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const oldMessage = consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: "correction_processing_signing_old",
      fiscalClaimId: correction.fiscal_claim_id!
    });
    await oldReserved;

    const recovered = await new Repository(runtime.DB)
      .recoverFiscalCorrectionProcessingClaim({
        id: correction.id,
        currentProcessingClaimId: "correction_processing_signing_old",
        nextProcessingClaimId: "correction_processing_signing_new",
        staleBefore: "2030-01-01T00:00:00.000Z"
      });
    expect(recovered).toMatchObject({
      processing_claim_id: "correction_processing_signing_new",
      reserved_control_sequence: 89,
      reserved_numero_control: "DTE-15-M001P004-000000000000089"
    });
    releaseOldReservation();
    const oldDisposition = await oldMessage;

    expect(oldDisposition.ack).toHaveBeenCalledTimes(1);
    expect(oldDisposition.retry).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expect(db.nextSequence).toBe(90);
    expect(source.status).toBe("REJECTED");

    const newDisposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: "correction_processing_signing_new",
      fiscalClaimId: correction.fiscal_claim_id!
    });
    expect(newDisposition.ack).toHaveBeenCalledTimes(1);
    expect(newDisposition.retry).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.nextSequence).toBe(90);
    expect(correction.status).toBe("ACCEPTED");
  });

  it("does not dispatch when a corrected document loses its exact claim before the marker", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_correction_dispatch_owner_lost",
      fiscal_operation_claim_id: "fiscal_claim_dispatch_owner_lost",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_dispatch_owner_lost",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_dispatch_owner_lost",
      processing_claim_id: "correction_processing_dispatch_owner_lost",
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    let markerInput: unknown;
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input: any) => {
        markerInput = input;
        source.fiscal_operation_claim_id = "foreign-claim-before-marker";
        return false;
      });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).not.toHaveBeenCalled();
    expect(disposition.retry).toHaveBeenCalledTimes(1);
    expect(transmit).not.toHaveBeenCalled();
    expect(markerInput).toEqual({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId: source.id,
      documentClaimId: correction.fiscal_claim_id,
      signedJws: expect.any(String)
    });
    expect((markerInput as { signedJws: string }).signedJws).not.toBe(
      "original.signed.jws"
    );
    expect(correction).toMatchObject({
      status: "PROCESSING",
      mh_dispatch_started_at: null
    });
    expect(source.fiscal_operation_claim_id).toBe("foreign-claim-before-marker");
  });

  it("rebuilds a claimed direct rejected document from its immutable snapshot", async () => {
    const db = correctionDb();
    db.nextSequence = 91;
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_direct_correction",
      fiscal_operation_claim_id: "fiscal_claim_direct_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_direct_document",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_direct_correction",
      processing_claim_id: "correction_processing_direct_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor Directo Corregido",
        correo: null
      })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-DIRECT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const original = JSON.parse(source.plain_json) as Record<string, any>;
    const originalIdentifiers = {
      codigoGeneracion: source.codigo_generacion,
      numeroControl: source.numero_control
    };
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: correction.document_id!,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    const updated = db.documents[0];
    const corrected = JSON.parse(updated.plain_json) as Record<string, any>;
    expect(updated.id).toBe(source.id);
    expect(updated.wompi_event_id).toBeNull();
    expect(updated.codigo_generacion).not.toBe(originalIdentifiers.codigoGeneracion);
    expect(updated.numero_control).not.toBe(originalIdentifiers.numeroControl);
    expect(corrected.receptor.nombre).toBe("Receptor Directo Corregido");
    expect(corrected.emisor).toEqual(original.emisor);
    expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
    expect(corrected.resumen).toEqual(original.resumen);
    expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
    expect(JSON.parse(correction.source_document_snapshot_json!)).toMatchObject({
      codigo_generacion: originalIdentifiers.codigoGeneracion,
      numero_control: originalIdentifiers.numeroControl,
      signed_jws: "original.signed.jws"
    });
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({
      signedJws: expect.not.stringMatching(/^original\.signed\.jws$/)
    }));
  });

  it("fails a queued production direct correction before reservation, signing, or transmission", async () => {
    const db = correctionDb();
    db.nextSequence = 95;
    const source = rejectedProductionCorrectionDocument({
      id: "doc_production_direct_correction",
      fiscal_operation_claim_id: "fiscal_claim_production_direct",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_production_direct",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      environment: "01",
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_production_direct",
      processing_claim_id: "correction_processing_production_direct",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor corregido"
      })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    const reserve = vi.mocked(
      Repository.prototype.reserveFiscalCorrectionDocumentIdentifiers
    );
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.APP_ENV = "production";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED"
    });
    expect(source).toMatchObject({
      status: "REJECTED",
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null
    });
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(reserve).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expectCorrectionAudits(db, correction, "FAILED");
  });

  it("restores and retires a pre-fix signed production direct correction without transmitting", async () => {
    const db = correctionDb();
    db.nextSequence = 96;
    const fiscalClaimId = "fiscal_claim_production_signed";
    const rejectedSnapshot = rejectedProductionCorrectionDocument({
      id: "doc_production_signed_correction",
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null
    });
    const signed = {
      ...rejectedSnapshot,
      codigo_generacion: "96969696-9696-4696-8696-969696969696",
      numero_control: "DTE-15-M001P004-000000000000096",
      status: "SIGNED",
      plain_json: JSON.stringify({
        ...(JSON.parse(rejectedSnapshot.plain_json) as Record<string, unknown>),
        receptor: correctionReceptor({ nombre: "Receptor pre-fix corregido" })
      }),
      signed_jws: "pre-fix-corrected.signed.jws",
      mh_estado: null,
      mh_observaciones_json: "[]",
      fiscal_operation_claim_id: fiscalClaimId,
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    } as DteDocumentRecord;
    const correction = correctionRecord({
      id: "fiscal_correction_production_signed",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: signed.id,
      environment: "01",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z",
      issuance_attempt_id: null,
      fiscal_claim_id: fiscalClaimId,
      processing_claim_id: "correction_processing_production_signed",
      reserved_control_prefix: "M001P004",
      reserved_control_sequence: 96,
      reserved_codigo_generacion: signed.codigo_generacion,
      reserved_numero_control: signed.numero_control,
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor pre-fix corregido"
      })),
      source_document_snapshot_json: JSON.stringify(rejectedSnapshot)
    });
    db.documents.push(signed);
    stubDocumentCorrectionLifecycle(correction, db);
    const reserve = vi.mocked(
      Repository.prototype.reserveFiscalCorrectionDocumentIdentifiers
    );
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SHOULD-NOT-TRANSMIT",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const runtime = correctionRuntime(db);
    runtime.APP_ENV = "production";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: signed.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED"
    });
    expect(signed).toMatchObject({
      codigo_generacion: rejectedSnapshot.codigo_generacion,
      numero_control: rejectedSnapshot.numero_control,
      status: "REJECTED",
      plain_json: rejectedSnapshot.plain_json,
      signed_jws: rejectedSnapshot.signed_jws,
      mh_estado: rejectedSnapshot.mh_estado,
      mh_observaciones_json: rejectedSnapshot.mh_observaciones_json,
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null
    });
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(reserve).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expectCorrectionAudits(db, correction, "FAILED");
  });

  it("keeps a pre-fix signed production direct correction claimed when guarded restore loses ownership", async () => {
    const db = correctionDb();
    const fiscalClaimId = "fiscal_claim_production_signed_restore_race";
    const rejectedSnapshot = rejectedProductionCorrectionDocument({
      id: "doc_production_signed_restore_race",
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null
    });
    const signed = {
      ...rejectedSnapshot,
      codigo_generacion: "97979797-9797-4797-8797-979797979797",
      numero_control: "DTE-15-M001P004-000000000000097",
      status: "SIGNED",
      signed_jws: "pre-fix-restore-race.signed.jws",
      fiscal_operation_claim_id: fiscalClaimId,
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    } as DteDocumentRecord;
    const correction = correctionRecord({
      id: "fiscal_correction_production_signed_restore_race",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: signed.id,
      environment: "01",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z",
      issuance_attempt_id: null,
      fiscal_claim_id: fiscalClaimId,
      processing_claim_id: "correction_processing_production_signed_restore_race",
      reserved_control_prefix: "M001P004",
      reserved_control_sequence: 97,
      reserved_codigo_generacion: signed.codigo_generacion,
      reserved_numero_control: signed.numero_control,
      source_document_snapshot_json: JSON.stringify(rejectedSnapshot)
    });
    db.documents.push(signed);
    stubDocumentCorrectionLifecycle(correction, db);
    vi.mocked(
      Repository.prototype.finalizeDirectFiscalCorrectionGenerationDisabled
    ).mockResolvedValueOnce(false);
    const ordinaryFinalize = vi.mocked(
      Repository.prototype.finalizeFiscalCorrection
    );
    ordinaryFinalize.mockClear();
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.APP_ENV = "production";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: signed.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId
    });

    expect(disposition.ack).not.toHaveBeenCalled();
    expect(disposition.retry).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "PROCESSING",
      mh_dispatch_started_at: null
    });
    expect(signed).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: fiscalClaimId,
      fiscal_operation_kind: "TRANSMISSION"
    });
    expect(ordinaryFinalize).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("rejects a queue-time signed/archive mismatch before reserving identifiers", async () => {
    const db = correctionDb();
    db.nextSequence = 96;
    const password = "cert-password";
    const certXml = await generatedCertificateXml(password);
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_tampered_snapshot",
      fiscal_operation_claim_id: "fiscal_claim_tampered_snapshot",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const signedPayload = JSON.parse(source.plain_json) as Record<string, any>;
    signedPayload.emisor = {
      ...signedPayload.emisor,
      nombre: "EMISOR HISTORICO FIRMADO"
    };
    source.signed_jws = await signMhDocument(signedPayload, certXml, password);
    source.plain_json = JSON.stringify({
      ...signedPayload,
      emisor: {
        ...signedPayload.emisor,
        nombre: "EMISOR ARCHIVADO ALTERADO"
      }
    });
    const correction = correctionRecord({
      id: "fiscal_correction_tampered_snapshot",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_tampered_snapshot",
      processing_claim_id: "correction_processing_tampered_snapshot",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor corregido"
      })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = certXml;
    runtime.MH_CERT_PASSWORD = password;
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_INVALID_SOURCE"
    });
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("preserves Wompi evidence and runs normal accepted finalization in production on the same row", async () => {
    const db = correctionDb();
    db.nextSequence = 101;
    const payload = correctionWebhook({
      IdTransaccion: "wompi_rejected_correction_tx",
      Monto: "25.00",
      CodigoAutorizacion: "authorization_original",
      IdExterno: "di_document_correction",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_document_correction",
        NombreProducto: "Ofrenda"
      },
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7",
        EMail: "original@example.org"
      }
    });
    const sourcePlain = buildCdeDocument(payload, emisorConfig(), {
      sequence: 23,
      environment: "01",
      issuedAt: new Date(payload.FechaTransaccion),
      donorOverride: {
        tipoDocumento: "13",
        numDocumento: "10000002-7",
        nombre: "Receptor Wompi Original",
        correo: "original@example.org",
        telefono: "70001111",
        direccion: {
          departamento: "06",
          municipio: "22",
          distrito: "01",
          complemento: "Dirección original"
        },
        codPais: "SV",
        codDomiciliado: 1,
        giftType: "OFRENDA"
      }
    }) as Record<string, any>;
    const sourceIds = sourcePlain.identificacion as Record<string, string>;
    const source = testDocument({
      id: "doc_rejected_wompi_correction",
      wompi_event_id: "wompi_rejected_correction",
      environment: "01",
      status: "REJECTED",
      codigo_generacion: sourceIds.codigoGeneracion,
      numero_control: sourceIds.numeroControl,
      plain_json: JSON.stringify(sourcePlain),
      signed_jws: "original-wompi.signed.jws",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: JSON.stringify(["#/receptor/nombre rechazado"]),
      donor_name: "Receptor Wompi Original",
      donor_email: "original@example.org",
      amount_cents: 2500,
      accepted_at: null,
      fiscal_operation_claim_id: "fiscal_claim_wompi_document",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_wompi_document_processing",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      environment: "01",
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_wompi_document",
      processing_claim_id: "correction_processing_wompi_document",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor Wompi Corregido",
        correo: "corrected@example.org"
      })),
      changed_fields_json: JSON.stringify(["nombre", "correo"]),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    db.wompiEvents.push(correctionEvent({
      id: source.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      environment: "01",
      created_document_id: source.id,
      processed_at: "2026-07-18T12:00:00.000Z",
      issuance_status: "DOCUMENT_CREATED"
    }));
    db.donationIntents.push({
      id: "di_document_correction",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: "06",
      direccion_municipio: "22",
      direccion_distrito: "01",
      direccion_complemento: "Dirección original",
      donor_pais: null,
      gift_type: "OFRENDA",
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-07-18T11:00:00.000Z",
      updated_at: "2026-07-18T11:00:00.000Z",
      expires_at: "2099-07-18T12:00:00.000Z"
    });
    stubDocumentCorrectionLifecycle(correction, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-WOMPI-DOCUMENT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const runtime = correctionRuntime(db);
    runtime.APP_ENV = "production";
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    const updated = db.documents[0];
    const corrected = JSON.parse(updated.plain_json) as Record<string, any>;
    const snapshot = JSON.parse(correction.source_document_snapshot_json!) as DteDocumentRecord;
    const original = JSON.parse(snapshot.plain_json) as Record<string, any>;
    expect(updated.id).toBe(source.id);
    expect(updated.wompi_event_id).toBe(source.wompi_event_id);
    expect(updated.codigo_generacion).not.toBe(snapshot.codigo_generacion);
    expect(updated.numero_control).not.toBe(snapshot.numero_control);
    expect(snapshot.signed_jws).toBe("original-wompi.signed.jws");
    expect(corrected.receptor).toMatchObject({
      nombre: "Receptor Wompi Corregido",
      correo: "corrected@example.org"
    });
    expect(corrected.resumen).toEqual(original.resumen);
    expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
    expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
    expect(corrected.apendice).toEqual(original.apendice);
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({
      signedJws: expect.not.stringMatching(/^original-wompi\.signed\.jws$/)
    }));
    expect(db.donationIntents[0]).toMatchObject({
      status: "COMPLETED",
      document_id: source.id
    });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: source.id,
      email_type: "dteReceipt",
      status: "SENT"
    }));
    expectCorrectionAudits(db, correction, "ACCEPTED", ["nombre", "correo"]);
  });

  it("leaves a durable corrected SIGNED row on the safe retry path after proven pre-dispatch failure", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_predispatch_correction",
      fiscal_operation_claim_id: "fiscal_claim_predispatch_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_document_predispatch",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_predispatch_correction",
      processing_claim_id: "correction_processing_predispatch_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({ correo: null })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new MhPreDispatchError("MH auth unavailable", new Error("auth unavailable"))
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      mh_dispatch_started_at: null,
      failure_code: "MH_PRE_DISPATCH_ERROR"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: null,
      fiscal_operation_kind: null
    });
  });

  it("keeps an ambiguous corrected document dispatch claimed and REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_ambiguous_correction",
      fiscal_operation_claim_id: "fiscal_claim_ambiguous_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_document_ambiguous",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_ambiguous_correction",
      processing_claim_id: "correction_processing_ambiguous_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({ correo: null })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new Error("connection reset after request write")
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: expect.any(String),
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: correction.fiscal_claim_id,
      fiscal_operation_kind: "TRANSMISSION"
    });
    expectCorrectionAudits(db, correction, "REVIEW_REQUIRED");
  });

  it("blocks a new production direct correction before durable claim or queue submission", async () => {
    const db = correctionDb();
    const document = rejectedProductionCorrectionDocument();
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const claim = vi.spyOn(
      Repository.prototype,
      "claimDocumentFiscalCorrection"
    );
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.APP_ENV = "production";

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "70000003-2222-4222-8222-700000032222",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "document_correction_direct_generation_disabled"
    });
    expect(claim).not.toHaveBeenCalled();
    expect(queued).toEqual([]);
  });

  it("preflights a Wompi-backed rejected document from its durable source", async () => {
    const db = correctionDb();
    const document = rejectedProductionCorrectionDocument({
      wompi_event_id: "wompi_rejected_source"
    });
    const event = correctionEvent({
      id: "wompi_rejected_source",
      environment: "01",
      raw_body: JSON.stringify(correctionWebhook({ Monto: "not-a-number" }))
    });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_wompi_document",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_wompi_document"
      })
    });
    const queued: IssuanceMessage[] = [];

    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.APP_ENV = "production";
    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "33333333-3333-4333-8333-333333333333",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toEqual([{
      advancedDocumentId: document.id,
      fiscalCorrectionId: "fiscal_correction_wompi_document",
      fiscalCorrectionProcessingClaimId: "correction_processing_1",
      fiscalClaimId: "fiscal_claim_wompi_document"
    }]);
  });

  it("accepts a signed historical issuer during direct correction preflight", async () => {
    const db = correctionDb();
    const password = "cert-password";
    const certXml = await generatedCertificateXml(password);
    const document = rejectedCorrectionDocument();
    const historical = JSON.parse(document.plain_json) as Record<string, any>;
    historical.emisor = {
      ...historical.emisor,
      nombre: "EMISOR HISTORICO VERIFICADO"
    };
    document.plain_json = JSON.stringify(historical);
    document.signed_jws = await signMhDocument(historical, certXml, password);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_historical_issuer",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_historical_issuer"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.MH_CERT_XML = certXml;

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "66666666-6666-4666-8666-666666666666",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("accepts a signed historical issuer when archived JSON only reorders object keys", async () => {
    const db = correctionDb();
    const password = "cert-password";
    const certXml = await generatedCertificateXml(password);
    const document = rejectedCorrectionDocument();
    const historical = JSON.parse(document.plain_json) as Record<string, any>;
    historical.emisor = {
      ...historical.emisor,
      nombre: "EMISOR HISTORICO VERIFICADO"
    };
    document.signed_jws = await signMhDocument(historical, certXml, password);
    document.plain_json = JSON.stringify(
      Object.fromEntries(Object.entries(historical).reverse())
    );
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_historical_reordered",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_historical_reordered"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.MH_CERT_XML = certXml;

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "69696969-6969-4969-8969-696969696969",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("rejects a signed historical issuer when the certificate belongs to another NIT", async () => {
    const db = correctionDb();
    const password = "cert-password";
    const certXml = await generatedCertificateXml(password, "99999999999999");
    const document = rejectedCorrectionDocument();
    const historical = JSON.parse(document.plain_json) as Record<string, any>;
    historical.emisor = {
      ...historical.emisor,
      nombre: "EMISOR HISTORICO NO VINCULADO"
    };
    document.plain_json = JSON.stringify(historical);
    document.signed_jws = await signMhDocument(historical, certXml, password);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const claim = vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection")
      .mockResolvedValue({
        kind: "claimed",
        correction: correctionRecord({
          id: "fiscal_correction_mismatched_certificate_nit",
          target_kind: "DTE_DOCUMENT",
          wompi_event_id: null,
          document_id: document.id,
          issuance_attempt_id: null,
          fiscal_claim_id: "fiscal_claim_mismatched_certificate_nit"
        })
      });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = certXml;

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "70707070-7070-4070-8070-707070707071",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "fiscal_correction_not_allowed",
      message: "El emisor del CDE original no pudo verificarse."
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a historical issuer when signed payload and archived JSON differ", async () => {
    const db = correctionDb();
    const password = "cert-password";
    const certXml = await generatedCertificateXml(password);
    const document = rejectedCorrectionDocument();
    const signedPayload = JSON.parse(document.plain_json) as Record<string, any>;
    signedPayload.emisor = {
      ...signedPayload.emisor,
      nombre: "EMISOR HISTORICO VERIFICADO"
    };
    document.signed_jws = await signMhDocument(signedPayload, certXml, password);
    document.plain_json = JSON.stringify({
      ...signedPayload,
      resumen: {
        ...signedPayload.resumen,
        totalPagar: 999
      }
    });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const claim = vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection");
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.MH_CERT_XML = certXml;

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "67676767-6767-4767-8767-676767676767",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect(response.status).toBe(409);
    expect(claim).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("accepts an unsigned direct source when its issuer matches current config", async () => {
    const db = correctionDb();
    const document = rejectedCorrectionDocument({ signed_jws: null });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_unsigned_current_issuer",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_unsigned_current_issuer"
      })
    });
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "68686868-6868-4868-8868-686868686868",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("rejects an unsigned direct source whose issuer is not current", async () => {
    const db = correctionDb();
    const document = rejectedCorrectionDocument({ signed_jws: null });
    const foreign = JSON.parse(document.plain_json) as Record<string, any>;
    foreign.emisor = {
      ...foreign.emisor,
      nombre: "EMISOR NO CONFIABLE"
    };
    document.plain_json = JSON.stringify(foreign);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const claim = vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection");
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "69696969-6969-4969-8969-696969696969",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(409);
    expect(claim).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("refuses non-receptor corrections before durable claim or queue send", async () => {
    const db = correctionDb();
    const event = correctionEvent({
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "NIT del emisor inválido"
    });
    const document = rejectedCorrectionDocument({
      mh_observaciones_json: JSON.stringify(["Actividad del emisor inválida"])
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const wompiClaim = vi.spyOn(
      Repository.prototype,
      "claimWompiFiscalCorrection"
    ).mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    const documentClaim = vi.spyOn(
      Repository.prototype,
      "claimDocumentFiscalCorrection"
    ).mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_noncorrectable"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const requestBody = {
      receptor: correctionReceptor({ nombre: "Nombre corregido" })
    };

    const wompi = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        ...requestBody,
        correctionRequestId: "44444444-4444-4444-8444-444444444444"
      }
    ), runtime);
    const direct = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        ...requestBody,
        correctionRequestId: "55555555-5555-4555-8555-555555555555"
      }
    ), runtime);

    expect([wompi.status, direct.status]).toEqual([409, 409]);
    for (const response of [wompi, direct]) {
      await expect(response.json()).resolves.toEqual({
        error: "fiscal_correction_not_allowed",
        message: "Revise Configuración y la evidencia técnica antes de volver a intentar."
      });
    }
    expect(wompiClaim).not.toHaveBeenCalled();
    expect(documentClaim).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("suppresses duplicate queue sends and rejects a conflicting request id", async () => {
    const db = correctionDb();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ issuance_status: "RETRY_QUEUED", processed_at: null }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const existing = correctionRecord({
      request_payload_sha256: await sha256Hex(utf8Bytes(fiscalCorrectionPayload(
        correctionReceptor({ nombre: "Nombre corregido" }) as any
      ))),
      corrected_receptor_json: JSON.stringify(
        correctionReceptor({ nombre: "Nombre corregido" })
      )
    });
    vi.spyOn(Repository.prototype, "getFiscalCorrectionByRequestId")
      .mockResolvedValue(existing);
    const claim = vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection");
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const body = {
      correctionRequestId: "11111111-1111-4111-8111-111111111111",
      receptor: correctionReceptor({ nombre: "Nombre corregido" })
    };

    const duplicate = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      body
    ), runtime);
    const conflict = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        ...body,
        receptor: correctionReceptor({ nombre: "Otro nombre" })
      }
    ), runtime);

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ok: true,
      queued: false,
      duplicate: true,
      correctionId: "fiscal_correction_1",
      status: "QUEUED"
    });
    expect(conflict.status).toBe(409);
    expect(queued).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
  });

  it("replays a terminal direct correction before eligibility or unchanged checks", async () => {
    const db = correctionDb();
    const receptor = correctionReceptor({
      nombre: "Donante Original",
      correo: "original@example.org",
      complemento: "Dirección original"
    });
    const document = rejectedProductionCorrectionDocument();
    const existing = correctionRecord({
      request_id: "70707070-7070-4070-8070-707070707070",
      request_payload_sha256: await sha256Hex(
        utf8Bytes(fiscalCorrectionPayload(receptor as any))
      ),
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: document.id,
      status: "REJECTED",
      corrected_receptor_json: fiscalCorrectionPayload(receptor as any),
      completed_at: "2026-07-18T13:00:00.000Z"
    });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getFiscalCorrectionByRequestId")
      .mockResolvedValue(existing);
    const claim = vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection");

    const runtime = correctionRuntime(db);
    runtime.APP_ENV = "production";
    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: existing.request_id,
        receptor
      }
    ), runtime);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      queued: false,
      duplicate: true,
      correctionId: existing.id,
      status: "REJECTED"
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps a same-id direct replay with a different payload in conflict", async () => {
    const db = correctionDb();
    const original = correctionReceptor({ nombre: "Nombre original" });
    const document = rejectedCorrectionDocument();
    const existing = correctionRecord({
      request_id: "71717171-7171-4171-8171-717171717171",
      request_payload_sha256: await sha256Hex(
        utf8Bytes(fiscalCorrectionPayload(original as any))
      ),
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: document.id,
      status: "REJECTED",
      corrected_receptor_json: fiscalCorrectionPayload(original as any),
      completed_at: "2026-07-18T13:00:00.000Z"
    });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getFiscalCorrectionByRequestId")
      .mockResolvedValue(existing);
    const claim = vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection");

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: existing.request_id,
        receptor: correctionReceptor({ nombre: "Nombre diferente" })
      }
    ), correctionRuntime(db));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "correction_request_conflict"
    });
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps a durable QUEUED correction when queue submission fails", async () => {
    const db = correctionDb();
    const correction = correctionRecord();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(correctionEvent() as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: correction.request_id,
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async () => { throw new Error("private queue failure"); }
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "fiscal_correction_queue_failed",
      message: "La corrección quedó guardada y será reintentada automáticamente."
    });
    expect(correction.status).toBe("QUEUED");
  });
});
