import { getEmisorConfig, getMhCertificateXml, requireSecret } from "../config";
import { assertCdeIssuerMatchesConfig, buildCdeDocument, cdeDocumentSummary } from "../domain/dteBuilder";
import type { IntentDonorOverride } from "../domain/dteBuilder";
import { DocumentSchemaValidationError, validateCde } from "../domain/schema";
import { signMhDocument } from "../domain/signer";
import { amountCents, donorName, isApprovedDonation, normalizeWompiWebhook } from "../domain/wompi";
import { assertValidDui, cleanDui, isDuiDocumentType } from "../../shared/dui";
import {
  legacyIssuanceAttemptId,
  Repository,
  type FiscalCorrectionDocumentEvidence
} from "../storage/repository";
import type { DonationIntentRecord, DteDocumentRecord, Env, FiscalCorrectionRecord, MhResponse, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { sendOperationalAlert } from "./alerts";
import { loadEmailBranding } from "./branding";
import { classifyEmailDispatchError, emailDeliveryAuditEvidence, EmailService, type EmailDeliveryResult } from "./email";
import { EMAIL_TEMPLATES_SETTING_KEY, parseEmailTemplates } from "./emailTemplates";
import { resolveDonationIntentBinding } from "./donationIntentBinding";
import type { DonationIntentBinding } from "./donationIntentBinding";
import { logWorkerError } from "./observability";
import { stagingSmokeRunIdFromTransaction } from "./stagingSmoke";
import { MhClient, MhPreDispatchError } from "./mhClient";
import {
  assertDeploymentAllowsAmbiente,
  deploymentEnvironmentPolicy,
  EnvironmentNotAllowedError
} from "./environmentPolicy";
import {
  assertDirectCorrectionSourceTrusted,
  buildCorrectedDirectCandidate,
  buildCorrectedWompiCandidate
} from "./fiscalCorrection";
import type { FiscalReceptorCorrection } from "../../shared/fiscalCorrection";

// Lanzado cuando un reintento de operador pierde el CAS sobre un CDE Wompi RECHAZADO
// (otro reintento concurrente ya lo reclamó). El handler HTTP lo traduce a un 409.
export class RejectedWompiRetryConflictError extends Error {
  constructor(message = "Ya hay un reintento en curso para este documento.") {
    super(message);
    this.name = "RejectedWompiRetryConflictError";
  }
}

type IntentCorrelation =
  | { kind: "legacy" }
  | { kind: "ready"; intent: DonationIntentRecord }
  | {
      kind: "quarantined";
      intentId: string;
      reason:
        | Extract<DonationIntentBinding, { kind: "unbound" }>["reason"]
        | "incomplete_donor_data";
      expectedLinkId: number | null;
      payloadLinkId: number | null;
    };

export class WompiIntentQuarantinedError extends Error {
  readonly code = "wompi_intent_quarantined";

  constructor() {
    super(WOMPI_INTENT_QUARANTINED_MESSAGE);
    this.name = "WompiIntentQuarantinedError";
  }
}

class PostAcceptFinalizationOwnershipError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PostAcceptFinalizationOwnershipError";
  }
}

const WOMPI_INTENT_QUARANTINED_MESSAGE =
  "El evento Wompi está en cuarentena porque no coincide con una intención lista.";
const WOMPI_INVALID_DONOR_DUI_MESSAGE =
  "Los datos del donante contienen un DUI inválido.";

// Estados TERMINALES de un CDE: un veredicto de MH ya sellado (ACCEPTED/REJECTED) o una
// invalidación. Una reentrega de cola NUNCA debe re-firmar/re-transmitir un documento en
// estos estados ni sobrescribir un sello de aceptación. NO incluye SIGNED (un CDE
// diferido sigue su ciclo de reintento del cron) ni FAILED (reintetable).
const TERMINAL_DTE_STATUSES = new Set(["ACCEPTED", "REJECTED", "INVALIDATED"]);

function isTerminalDteStatus(status: string): boolean {
  return TERMINAL_DTE_STATUSES.has(status);
}

const STALLED_WOMPI_EVENT_AGE_MS = 60 * 60 * 1000;
const FISCAL_CORRECTION_STALE_MS = 15 * 60 * 1000;
const MAX_WOMPI_EVENT_REQUEUES = 3;
// Un CDE diferido que sigue sin transmitirse una hora después de emitido dispara
// una alerta operativa MH_UNAVAILABLE (una sola vez por episodio diferido y canal).
const DEFERRED_ALERT_AGE_MS = 60 * 60 * 1000;

const TERMINAL_FISCAL_CORRECTION_STATUSES = new Set([
  "ACCEPTED",
  "REJECTED",
  "FAILED",
  "REVIEW_REQUIRED"
]);

export interface FiscalCorrectionQueueOwnership {
  processingClaimId: string;
  issuanceAttemptId?: string;
  fiscalClaimId?: string;
}

interface FiscalCorrectionContext {
  correctionId: string;
  processingClaimId: string;
  claimId: string;
  preserveSignedOnPreDispatchFailure?: boolean;
}

export class FiscalCorrectionOwnershipError extends Error {
  constructor() {
    super("La corrección fiscal perdió su propiedad de procesamiento.");
    this.name = "FiscalCorrectionOwnershipError";
  }
}

class FiscalCorrectionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiscalCorrectionBusyError";
  }
}

class FiscalCorrectionDispatchInFlightError extends Error {
  constructor() {
    super("Otra entrega ya cruzó el límite de despacho fiscal de esta corrección.");
    this.name = "FiscalCorrectionDispatchInFlightError";
  }
}

export class IssuancePipeline {
  private readonly repo: Repository;
  private readonly mh: MhClient;

  constructor(private readonly env: Env) {
    this.repo = new Repository(env.DB);
    this.mh = new MhClient(env);
  }

  // Red de seguridad para el peor fallo del sistema: una donación aprobada cuyo
  // mensaje de emisión se perdió (la cola descarta tras agotar reintentos). Los
  // eventos aprobados sin CDE después de una hora se reencolan; processWompiEvent
  // es idempotente, así que un reencolado duplicado es inofensivo.
  async sweepStalledWompiEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - STALLED_WOMPI_EVENT_AGE_MS).toISOString();
    const stalled = await this.repo.listStalledApprovedWompiEvents(cutoff);
    for (const event of stalled) {
      const eventId = String(event.id);
      try {
        assertDeploymentAllowsAmbiente(this.env, String(event.environment) as "00" | "01");
      } catch (error) {
        if (error instanceof EnvironmentNotAllowedError) {
          continue;
        }
        throw error;
      }
      const issuanceEpoch = typeof event.issuance_last_attempt_at === "string" && event.issuance_last_attempt_at
        ? event.issuance_last_attempt_at
        : null;
      const requeues = issuanceEpoch
        ? await this.repo.countAuditEntriesSince("WOMPI_EVENT_REQUEUED", eventId, issuanceEpoch)
        : await this.repo.countAuditEntries("WOMPI_EVENT_REQUEUED", eventId);
      if (requeues >= MAX_WOMPI_EVENT_REQUEUES) {
        const summary = `Donación aprobada sin CDE tras ${MAX_WOMPI_EVENT_REQUEUES} reencolados; requiere revisión manual`;
        if ((await this.repo.countAuditEntries("WOMPI_EVENT_STALLED", eventId)) === 0) {
          await this.repo.createAudit({
            action: "WOMPI_EVENT_STALLED",
            entityType: "wompi_event",
            entityId: eventId,
            summary
          });
        }
        // Retried on every tick regardless of the WOMPI_EVENT_STALLED audit above:
        // a failed alert channel does not suppress a later attempt. Successful
        // channels dedupe on this stable issuance epoch.
        await sendOperationalAlert(this.env, this.repo, {
          kind: "WOMPI_EVENT_STALLED",
          title: "Evento Wompi sin procesar",
          detail: summary,
          entityType: "wompi_event",
          entityId: eventId,
          incidentId: issuanceEpoch ?? eventId
        });
        continue;
      }
      const attemptId = await this.repo.claimStalledWompiIssuanceAttempt(
        eventId,
        typeof event.issuance_attempt_id === "string" ? event.issuance_attempt_id : null,
        cutoff
      );
      if (!attemptId) {
        continue;
      }
      await this.env.ISSUANCE_QUEUE.send({ wompiEventId: eventId, issuanceAttemptId: attemptId });
      await this.repo.createWompiAttemptAudit({
        wompiEventId: eventId,
        attemptId,
        action: "WOMPI_EVENT_REQUEUED",
        summary: "Reencolado por barrido: donación aprobada sin CDE después de una hora"
      });
    }
  }

  async recoverStalledFiscalCorrections(
    limit = 100
  ): Promise<{ requeued: number }> {
    const staleBefore = new Date(
      Date.now() - FISCAL_CORRECTION_STALE_MS
    ).toISOString();
    const candidates = await this.repo.listRecoverableFiscalCorrections(
      staleBefore,
      limit
    );
    let requeued = 0;
    for (const candidate of candidates) {
      try {
        assertDeploymentAllowsAmbiente(this.env, candidate.environment);
      } catch (error) {
        if (error instanceof EnvironmentNotAllowedError) continue;
        throw error;
      }
      if (
        candidate.status === "PROCESSING"
        && candidate.mh_dispatch_started_at !== null
      ) {
        await this.reconcileKnownTerminalFiscalCorrection(
          candidate,
          candidate.processing_claim_id
        );
        continue;
      }
      const safeLifecycle =
        candidate.status === "QUEUED"
        || (
          candidate.status === "PROCESSING"
          && candidate.mh_dispatch_started_at === null
        );
      if (!safeLifecycle) continue;
      const recovered = await this.repo.recoverFiscalCorrectionProcessingClaim({
        id: candidate.id,
        currentProcessingClaimId: candidate.processing_claim_id,
        nextProcessingClaimId: newId("correction_processing"),
        staleBefore
      });
      if (!recovered) continue;
      await this.recordFiscalCorrectionAudit(recovered, "STARTED");

      if (
        recovered.target_kind === "WOMPI_EVENT"
        && recovered.wompi_event_id
        && recovered.issuance_attempt_id
      ) {
        await this.env.ISSUANCE_QUEUE.send({
          wompiEventId: recovered.wompi_event_id,
          issuanceAttemptId: recovered.issuance_attempt_id,
          fiscalCorrectionId: recovered.id,
          fiscalCorrectionProcessingClaimId: recovered.processing_claim_id
        });
        requeued += 1;
        continue;
      }
      if (
        recovered.target_kind === "DTE_DOCUMENT"
        && recovered.document_id
        && recovered.fiscal_claim_id
      ) {
        await this.env.ISSUANCE_QUEUE.send({
          advancedDocumentId: recovered.document_id,
          fiscalClaimId: recovered.fiscal_claim_id,
          fiscalCorrectionId: recovered.id,
          fiscalCorrectionProcessingClaimId: recovered.processing_claim_id
        });
        requeued += 1;
      }
    }
    return { requeued };
  }

  async processWompiEvent(
    wompiEventId: string,
    issuanceAttemptId?: string
  ): Promise<DteDocumentRecord | null> {
    const event = await this.repo.getWompiEventById(wompiEventId);
    if (!event) {
      throw new Error(`Evento Wompi ${wompiEventId} no encontrado`);
    }
    const activeAttemptId = issuanceAttemptId
      ?? event.issuance_attempt_id
      ?? legacyIssuanceAttemptId(wompiEventId);
    if (!issuanceAttemptId) {
      await this.repo.markWompiIssuanceProcessing(
        wompiEventId,
        activeAttemptId,
        event.issuance_attempt_id === null
      );
    }
    assertDeploymentAllowsAmbiente(this.env, event.environment);
    const existing = await this.repo.getDteDocumentByWompiEvent(wompiEventId);
    if (existing) {
      await this.repo.markWompiDocumentCreated(wompiEventId, existing.id);
      await this.recordStagingSmokeRun(existing.id, event.transaction_id);
      return this.processDteDocument(existing.id, activeAttemptId);
    }
    if (event.processed_at) {
      return null;
    }
    const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
    if (!isApprovedDonation(payload)) {
      await this.repo.markWompiIssuanceIgnored(wompiEventId);
      await this.repo.createAudit({
        action: "WOMPI_IGNORED",
        entityType: "wompi_event",
        entityId: wompiEventId,
        summary: `Resultado Wompi ignorado: ${payload.ResultadoTransaccion}`
      });
      return null;
    }

    const config = getEmisorConfig(this.env);
    const environment = event.environment;
    const correlation = await this.correlateIntent(payload);
    if (correlation.kind === "quarantined") {
      await this.quarantineWompiEvent(wompiEventId, correlation);
      await this.repo.recordWompiIssuanceFailure(wompiEventId, activeAttemptId, {
        code: "WOMPI_INTENT_QUARANTINED",
        message: WOMPI_INTENT_QUARANTINED_MESSAGE
      });
      return null;
    }
    const intent = correlation.kind === "ready" ? correlation.intent : null;
    const donorOverride = intent
      ? donorOverrideFromIntent(intent, payload)
      : undefined;
    // Validate the donor DUI BEFORE allocating a control sequence. A malformed DUI is a
    // permanent input failure; letting buildCdeDocument throw it AFTER nextControlSequence
    // burns a control number on every queue retry, opening a permanent fiscal gap. Reject
    // it as terminal here — no sequence consumed, no DTE created.
    const duiReason = invalidWompiDonorDuiReason(payload, donorOverride);
    if (duiReason) {
      await this.repo.createAudit({
        action: "WOMPI_INVALID_DONOR_DUI",
        entityType: "wompi_event",
        entityId: wompiEventId,
        summary: WOMPI_INVALID_DONOR_DUI_MESSAGE
      });
      await this.repo.recordWompiIssuanceFailure(wompiEventId, activeAttemptId, {
        code: "WOMPI_INVALID_DONOR_DUI",
        message: WOMPI_INVALID_DONOR_DUI_MESSAGE
      });
      await this.repo.markWompiEventProcessed(wompiEventId);
      return null;
    }
    const issuedAt = new Date(payload.FechaTransaccion);
    try {
      // Validate every deterministic CDE field before the durable sequence mutation.
      // The preview number is never persisted; the real build below uses the allocated
      // sequence and the same business timestamp after this complete schema check passes.
      buildCdeDocument(payload, config, {
        sequence: 1,
        environment,
        donorOverride,
        issuedAt
      });
    } catch (error) {
      if (!(error instanceof DocumentSchemaValidationError)) throw error;
      await this.repo.createAudit({
        action: "WOMPI_INVALID_CDE_INPUT",
        entityType: "wompi_event",
        entityId: wompiEventId,
        summary: error.message
      });
      await this.repo.recordWompiIssuanceFailure(wompiEventId, activeAttemptId, {
        code: error.evidenceCode,
        message: error.evidenceMessage
      });
      await this.repo.markWompiEventProcessed(wompiEventId);
      return null;
    }
    const issuanceClaimId = newId("wompi_issue");
    if (!(await this.repo.claimWompiEventIssuance(wompiEventId, issuanceClaimId))) {
      return (await this.repo.getDteDocumentByWompiEvent(wompiEventId)) ?? null;
    }

    let record: DteDocumentRecord;
    try {
      const reserved = await this.repo.reserveWompiDocumentIdentifiers(
        wompiEventId,
        environment,
        config.controlPrefix
      );
      const normalDocument = buildCdeDocument(payload, config, {
        sequence: reserved.sequence,
        codigoGeneracion: reserved.codigoGeneracion,
        environment,
        donorOverride,
        issuedAt
      });
      const identifiers = extractCdeIdentifiers(normalDocument);
      // Persist the donor metadata from the EMITTED CDE receptor, not the raw webhook:
      // for an empresa intent the receptor name is its razón social, while natural-person
      // name/email remain the webhook values.
      const summary = cdeDocumentSummary(normalDocument);
      const created = await this.repo.createClaimedWompiDteDocument({
        wompiEventId,
        issuanceClaimId,
        environment,
        codigoGeneracion: identifiers.codigoGeneracion,
        numeroControl: identifiers.numeroControl,
        plainJson: normalDocument,
        donorEmail: summary.donorEmail,
        donorName: summary.donorName,
        amountCents: amountCents(payload),
        issuedAt: nowIso()
      });
      if (!created) {
        await this.repo.releaseWompiEventIssuance(wompiEventId, issuanceClaimId);
        return (await this.repo.getDteDocumentByWompiEvent(wompiEventId)) ?? null;
      }
      record = created;
      await this.recordStagingSmokeRun(record.id, event.transaction_id);
    } catch (error) {
      await this.repo.releaseWompiEventIssuance(wompiEventId, issuanceClaimId);
      throw error;
    }
    return this.processDteDocument(record.id, activeAttemptId);
  }

  async processFiscalCorrection(
    correctionId: string,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    let correction = await this.repo.getFiscalCorrection(correctionId);
    if (!correction) {
      throw new FiscalCorrectionOwnershipError();
    }
    assertFiscalCorrectionOwnership(correction, ownership);
    if (TERMINAL_FISCAL_CORRECTION_STATUSES.has(correction.status)) {
      await this.recordFiscalCorrectionAudit(correction, correction.status);
      return correction;
    }
    if (
      correction.target_kind === "WOMPI_EVENT"
        ? (!correction.wompi_event_id || !ownership.issuanceAttemptId)
        : (!correction.document_id || !ownership.fiscalClaimId)
    ) {
      throw new FiscalCorrectionOwnershipError();
    }

    if (correction.status === "QUEUED") {
      const claim = await this.repo.claimFiscalCorrectionProcessing({
        id: correction.id,
        processingClaimId: ownership.processingClaimId,
        issuanceAttemptId: ownership.issuanceAttemptId,
        fiscalClaimId: ownership.fiscalClaimId
      });
      correction = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
      assertFiscalCorrectionOwnership(correction, ownership);
      if (claim === "terminal" || TERMINAL_FISCAL_CORRECTION_STATUSES.has(correction.status)) {
        await this.recordFiscalCorrectionAudit(correction, correction.status);
        return correction;
      }
      if (claim !== "claimed" && correction.status !== "PROCESSING") {
        throw new FiscalCorrectionOwnershipError();
      }
    }
    if (correction.status !== "PROCESSING") {
      throw new FiscalCorrectionOwnershipError();
    }
    await this.recordFiscalCorrectionAudit(correction, "STARTED");
    if (correction.mh_dispatch_started_at) {
      const reconciled = await this.reconcileKnownTerminalFiscalCorrection(
        correction,
        ownership.processingClaimId
      );
      if (reconciled) return reconciled;
      return this.finalizeFiscalCorrectionReview(correction, ownership);
    }
    if (correction.target_kind === "DTE_DOCUMENT") {
      try {
        return await this.processRejectedDocumentFiscalCorrection(correction, ownership);
      } catch (error) {
        if (
          error instanceof FiscalCorrectionBusyError
          || error instanceof FiscalCorrectionDispatchInFlightError
        ) {
          throw error;
        }
        return this.finalizeFiscalCorrectionProcessingError(correction, ownership, error);
      }
    }
    if (!correction.wompi_event_id || !ownership.issuanceAttemptId) {
      throw new FiscalCorrectionOwnershipError();
    }

    const event = await this.repo.getWompiEventById(correction.wompi_event_id);
    if (
      !event
      || event.issuance_attempt_id !== ownership.issuanceAttemptId
    ) {
      throw new FiscalCorrectionOwnershipError();
    }
    assertDeploymentAllowsAmbiente(this.env, event.environment);

    const existing = await this.repo.getDteDocumentByWompiEvent(event.id);
    if (existing && isTerminalDteStatus(existing.status)) {
      try {
        return await this.finishWompiFiscalCorrection(correction, existing, ownership);
      } catch (error) {
        if (
          error instanceof FiscalCorrectionBusyError
          || error instanceof FiscalCorrectionDispatchInFlightError
        ) {
          throw error;
        }
        return this.finalizeFiscalCorrectionProcessingError(correction, ownership, error);
      }
    }
    if (existing) {
      const claimed = await this.repo.claimWompiFiscalCorrectionDocument({
        correctionId: correction.id,
        processingClaimId: ownership.processingClaimId,
        issuanceAttemptId: ownership.issuanceAttemptId,
        documentId: existing.id
      });
      if (!claimed) {
        throw new FiscalCorrectionBusyError(
          "El CDE preexistente cambió antes de validar la corrección Wompi."
        );
      }
    }

    let payload: WompiWebhook;
    try {
      payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
    } catch (error) {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "FISCAL_CORRECTION_INVALID_SOURCE",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!isApprovedDonation(payload)) {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "WOMPI_PAYMENT_NOT_APPROVED",
        "El pago Wompi original no está aprobado."
      );
    }
    const binding = await resolveDonationIntentBinding(this.repo, payload);
    if (binding.kind === "unbound") {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "WOMPI_INTENT_QUARANTINED",
        WOMPI_INTENT_QUARANTINED_MESSAGE
      );
    }
    const intent = binding.kind === "bound" ? binding.intent : null;
    if (existing) {
      try {
        return await this.finishWompiFiscalCorrection(correction, existing, ownership);
      } catch (error) {
        if (
          error instanceof FiscalCorrectionBusyError
          || error instanceof FiscalCorrectionDispatchInFlightError
        ) {
          throw error;
        }
        return this.finalizeFiscalCorrectionProcessingError(correction, ownership, error);
      }
    }
    const config = getEmisorConfig(this.env);
    const correctionConfig = event.control_prefix
      ? { ...config, controlPrefix: event.control_prefix }
      : config;
    let correctedReceptor: FiscalReceptorCorrection;

    try {
      correctedReceptor = JSON.parse(
        correction.corrected_receptor_json
      ) as FiscalReceptorCorrection;
      buildCorrectedWompiCandidate({
        payload,
        intent,
        correction: correctedReceptor,
        config: correctionConfig,
        environment: event.environment,
        sequence: event.control_sequence ?? 1,
        codigoGeneracion: event.reserved_codigo_generacion ?? undefined
      });
    } catch (error) {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "FISCAL_CORRECTION_INVALID_CANDIDATE",
        error instanceof Error ? error.message : String(error)
      );
    }

    const issuanceClaimId = `wompi_correction_${correction.id}`;
    let eventClaimed = false;
    try {
      eventClaimed = await this.repo.claimCorrectedWompiEventIssuance({
        id: event.id,
        claimId: issuanceClaimId,
        correctionId: correction.id,
        processingClaimId: ownership.processingClaimId,
        issuanceAttemptId: ownership.issuanceAttemptId
      });
      if (!eventClaimed) {
        const createdByWinner = await this.repo.getDteDocumentByWompiEvent(event.id);
        if (createdByWinner) {
          return await this.finishWompiFiscalCorrection(correction, createdByWinner, ownership);
        }
        throw new FiscalCorrectionBusyError(
          "El evento corregido está ocupado por otro procesamiento."
        );
      }

      const reserved = await this.repo.reserveWompiDocumentIdentifiers(
        event.id,
        event.environment,
        correctionConfig.controlPrefix
      );
      const document = buildCorrectedWompiCandidate({
        payload,
        intent,
        correction: correctedReceptor,
        config: correctionConfig,
        environment: event.environment,
        sequence: reserved.sequence,
        codigoGeneracion: reserved.codigoGeneracion
      });
      const identifiers = extractCdeIdentifiers(document);
      const summary = cdeDocumentSummary(document);
      const created = await this.repo.createClaimedWompiDteDocument({
        wompiEventId: event.id,
        issuanceClaimId,
        environment: event.environment,
        codigoGeneracion: identifiers.codigoGeneracion,
        numeroControl: identifiers.numeroControl,
        plainJson: document,
        donorEmail: summary.donorEmail,
        donorName: summary.donorName,
        amountCents: amountCents(payload),
        issuedAt: nowIso()
      });
      if (!created) {
        const createdByWinner = await this.repo.getDteDocumentByWompiEvent(event.id);
        if (createdByWinner) {
          return await this.finishWompiFiscalCorrection(correction, createdByWinner, ownership);
        }
        throw new FiscalCorrectionBusyError(
          "No se pudo persistir el CDE corregido bajo su reserva."
        );
      }
      eventClaimed = false;
      return await this.finishWompiFiscalCorrection(correction, created, ownership);
    } catch (error) {
      if (eventClaimed) {
        await this.repo.releaseWompiEventIssuance(event.id, issuanceClaimId);
      }
      if (
        error instanceof FiscalCorrectionBusyError
        || error instanceof FiscalCorrectionDispatchInFlightError
      ) {
        throw error;
      }
      return this.finalizeFiscalCorrectionProcessingError(correction, ownership, error);
    }
  }

  private async processRejectedDocumentFiscalCorrection(
    correction: FiscalCorrectionRecord,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    if (
      !correction.document_id
      || !correction.fiscal_claim_id
      || ownership.fiscalClaimId !== correction.fiscal_claim_id
    ) {
      throw new FiscalCorrectionOwnershipError();
    }
    const current = await this.repo.getDteDocument(correction.document_id);
    if (
      !current
      || current.fiscal_operation_claim_id !== correction.fiscal_claim_id
      || current.fiscal_operation_kind !== "TRANSMISSION"
    ) {
      throw new FiscalCorrectionOwnershipError();
    }
    if (
      !current.wompi_event_id
      && !deploymentEnvironmentPolicy(this.env).directGenerationAllowed
    ) {
      return this.finalizeDirectFiscalCorrectionGenerationDisabled(
        correction,
        ownership
      );
    }
    if (current.status === "SIGNED") {
      return this.finishDocumentFiscalCorrection(correction, current.id, ownership);
    }
    if (current.status !== "REJECTED") {
      throw new FiscalCorrectionOwnershipError();
    }
    assertDeploymentAllowsAmbiente(this.env, current.environment);
    const config = getEmisorConfig(this.env);
    let source: DteDocumentRecord;
    let correctedReceptor: FiscalReceptorCorrection;
    let candidate: Record<string, unknown>;
    try {
      source = parseFiscalCorrectionSourceDocument(correction);
      if (
        source.id !== current.id
        || source.environment !== current.environment
        || source.status !== "REJECTED"
        || source.wompi_event_id !== current.wompi_event_id
      ) {
        throw new Error("La evidencia archivada no coincide con el documento reclamado.");
      }
      await assertDirectCorrectionSourceTrusted({
        sourceDocument: source,
        config,
        certificateXml: () => getMhCertificateXml(this.env)
      });
    } catch (error) {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "FISCAL_CORRECTION_INVALID_SOURCE",
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      correctedReceptor = JSON.parse(
        correction.corrected_receptor_json
      ) as FiscalReceptorCorrection;
      // Build and validate once before the durable sequence mutation. This creates
      // the one fresh generation code that will be persisted; only the placeholder
      // control number is replaced after the owned sequence allocation below.
      candidate = buildCorrectedDirectCandidate({
        sourceDocument: source,
        correction: correctedReceptor,
        config,
        sequence: 1
      });
    } catch (error) {
      return this.finalizeFiscalCorrectionFailure(
        correction,
        "FISCAL_CORRECTION_INVALID_CANDIDATE",
        error instanceof Error ? error.message : String(error)
      );
    }

    const identification = candidate.identificacion as Record<string, unknown>;
    const reserved = await this.repo.reserveFiscalCorrectionDocumentIdentifiers({
      correctionId: correction.id,
      documentId: current.id,
      processingClaimId: ownership.processingClaimId,
      fiscalClaimId: correction.fiscal_claim_id,
      environment: current.environment,
      controlPrefix: config.controlPrefix,
      codigoGeneracion: String(identification.codigoGeneracion)
    });
    if (!reserved) {
      throw new FiscalCorrectionBusyError(
        "La propiedad de la corrección cambió antes de reservar sus identificadores."
      );
    }
    identification.codigoGeneracion = reserved.codigoGeneracion;
    identification.numeroControl = reserved.numeroControl;
    validateCde(candidate);
    const identifiers = extractCdeIdentifiers(candidate);
    const summary = cdeDocumentSummary(candidate);
    const signingOwned = await this.repo.renewFiscalCorrectionDocumentSigningLease({
      correctionId: correction.id,
      documentId: current.id,
      processingClaimId: ownership.processingClaimId,
      fiscalClaimId: correction.fiscal_claim_id,
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl
    });
    if (!signingOwned) {
      throw new FiscalCorrectionBusyError(
        "La propiedad de la corrección cambió antes de firmar el documento."
      );
    }
    const signedJws = await signMhDocument(
      candidate,
      getMhCertificateXml(this.env),
      requireSecret(this.env, "MH_CERT_PASSWORD")
    );
    const prepared = await this.repo.prepareClaimedFiscalCorrectionDocument({
      correctionId: correction.id,
      documentId: current.id,
      processingClaimId: ownership.processingClaimId,
      claimId: correction.fiscal_claim_id,
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: candidate,
      signedJws,
      donorName: summary.donorName,
      donorEmail: summary.donorEmail
    });
    if (!prepared) {
      throw new FiscalCorrectionBusyError(
        "El documento rechazado cambió antes de persistir la corrección."
      );
    }
    return this.finishDocumentFiscalCorrection(correction, current.id, ownership);
  }

  private async finishDocumentFiscalCorrection(
    correction: FiscalCorrectionRecord,
    documentId: string,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    if (!ownership.fiscalClaimId) {
      throw new FiscalCorrectionOwnershipError();
    }
    const processed = await this.processDteDocument(documentId, undefined, {
      correctionId: correction.id,
      processingClaimId: ownership.processingClaimId,
      claimId: ownership.fiscalClaimId,
      preserveSignedOnPreDispatchFailure: true
    });
    if (processed.status !== "ACCEPTED" && processed.status !== "REJECTED") {
      throw new FiscalCorrectionBusyError(
        "El CDE corregido sigue ocupado antes de un resultado fiscal."
      );
    }
    const finalized = await this.repo.finalizeFiscalCorrection(
      correction.id,
      ownership.processingClaimId,
      {
        status: processed.status,
        document: this.fiscalCorrectionDocumentEvidence(correction, processed)
      }
    );
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (finalized || TERMINAL_FISCAL_CORRECTION_STATUSES.has(latest.status)) {
      await this.recordFiscalCorrectionAudit(latest, latest.status);
      return latest;
    }
    throw new Error("No se pudo finalizar el resultado de la corrección fiscal.");
  }

  private async finishWompiFiscalCorrection(
    correction: FiscalCorrectionRecord,
    document: DteDocumentRecord,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    const claimId = `fiscal_correction_${correction.id}`;
    const processed = await this.processDteDocument(
      document.id,
      ownership.issuanceAttemptId,
      {
        correctionId: correction.id,
        processingClaimId: ownership.processingClaimId,
        claimId
      }
    );
    if (processed.status !== "ACCEPTED" && processed.status !== "REJECTED") {
      throw new FiscalCorrectionBusyError(
        "El CDE corregido sigue ocupado antes de un resultado fiscal."
      );
    }
    const finalized = await this.repo.finalizeFiscalCorrection(
      correction.id,
      ownership.processingClaimId,
      {
        status: processed.status,
        document: this.fiscalCorrectionDocumentEvidence(correction, processed)
      }
    );
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (finalized || TERMINAL_FISCAL_CORRECTION_STATUSES.has(latest.status)) {
      await this.recordFiscalCorrectionAudit(latest, latest.status);
      return latest;
    }
    throw new Error("No se pudo finalizar el resultado de la corrección fiscal.");
  }

  private async finalizeFiscalCorrectionFailure(
    correction: FiscalCorrectionRecord,
    failureCode: string,
    failureMessage: string
  ): Promise<FiscalCorrectionRecord> {
    const retiredWompiEvent = correction.target_kind === "WOMPI_EVENT"
      ? await this.repo.finalizeWompiFiscalCorrectionFailure(
          correction.id,
          correction.processing_claim_id,
          { failureCode, failureMessage }
        )
      : false;
    const finalized = retiredWompiEvent || await this.repo.finalizeFiscalCorrection(
      correction.id,
      correction.processing_claim_id,
      {
        status: "FAILED",
        failureCode,
        failureMessage
      }
    );
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (finalized || TERMINAL_FISCAL_CORRECTION_STATUSES.has(latest.status)) {
      await this.recordFiscalCorrectionAudit(latest, latest.status);
      return latest;
    }
    throw new Error("No se pudo finalizar el fallo previo al despacho fiscal.");
  }

  private async finalizeDirectFiscalCorrectionGenerationDisabled(
    correction: FiscalCorrectionRecord,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    const finalized =
      await this.repo.finalizeDirectFiscalCorrectionGenerationDisabled(
        correction.id,
        ownership.processingClaimId
      );
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (finalized || TERMINAL_FISCAL_CORRECTION_STATUSES.has(latest.status)) {
      await this.recordFiscalCorrectionAudit(latest, latest.status);
      return latest;
    }
    throw new FiscalCorrectionBusyError(
      "No se pudo retirar la corrección directa deshabilitada por la política."
    );
  }

  private async finalizeFiscalCorrectionReview(
    correction: FiscalCorrectionRecord,
    ownership: FiscalCorrectionQueueOwnership
  ): Promise<FiscalCorrectionRecord> {
    const document = correction.document_id
      ? await this.repo.getDteDocument(correction.document_id)
      : correction.wompi_event_id
        ? await this.repo.getDteDocumentByWompiEvent(correction.wompi_event_id)
        : null;
    if (!document) {
      throw new FiscalCorrectionOwnershipError();
    }
    const finalized = await this.repo.finalizeFiscalCorrection(
      correction.id,
      ownership.processingClaimId,
      {
        status: "REVIEW_REQUIRED",
        failureCode: "MH_DISPATCH_UNCERTAIN",
        failureMessage: "La respuesta de Hacienda no pudo determinarse con certeza.",
        document: this.fiscalCorrectionDocumentEvidence(correction, document)
      }
    );
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (finalized || TERMINAL_FISCAL_CORRECTION_STATUSES.has(latest.status)) {
      await this.recordFiscalCorrectionAudit(latest, latest.status);
      return latest;
    }
    throw new Error("No se pudo registrar la revisión requerida de la corrección fiscal.");
  }

  private async finalizeFiscalCorrectionProcessingError(
    correction: FiscalCorrectionRecord,
    ownership: FiscalCorrectionQueueOwnership,
    error: unknown
  ): Promise<FiscalCorrectionRecord> {
    const latest = (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    const reconciled = await this.reconcileKnownTerminalFiscalCorrection(
      latest,
      ownership.processingClaimId
    );
    if (reconciled) return reconciled;
    if (error instanceof MhPreDispatchError) {
      if (latest.mh_dispatch_started_at) {
        await this.repo.clearFiscalCorrectionMhDispatchStarted(
          latest.id,
          ownership.processingClaimId
        );
      }
      return this.finalizeFiscalCorrectionFailure(
        latest,
        "MH_PRE_DISPATCH_ERROR",
        error.message
      );
    }
    if (latest.mh_dispatch_started_at) {
      return this.finalizeFiscalCorrectionReview(latest, ownership);
    }
    return this.finalizeFiscalCorrectionFailure(
      latest,
      "FISCAL_CORRECTION_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }

  private async reconcileKnownTerminalFiscalCorrection(
    correction: FiscalCorrectionRecord,
    processingClaimId: string
  ): Promise<FiscalCorrectionRecord | null> {
    const document = correction.document_id
      ? await this.repo.getDteDocument(correction.document_id)
      : correction.wompi_event_id
        ? await this.repo.getDteDocumentByWompiEvent(correction.wompi_event_id)
        : null;
    if (document?.status !== "ACCEPTED" && document?.status !== "REJECTED") {
      return null;
    }
    const finalized = await this.repo.finalizeFiscalCorrection(
      correction.id,
      processingClaimId,
      {
        status: document.status,
        document: this.fiscalCorrectionDocumentEvidence(correction, document)
      }
    );
    const terminalCorrection =
      (await this.repo.getFiscalCorrection(correction.id)) ?? correction;
    if (
      finalized
      || TERMINAL_FISCAL_CORRECTION_STATUSES.has(terminalCorrection.status)
    ) {
      await this.recordFiscalCorrectionAudit(
        terminalCorrection,
        terminalCorrection.status
      );
      return terminalCorrection;
    }
    return null;
  }

  private fiscalCorrectionDocumentEvidence(
    correction: FiscalCorrectionRecord,
    document: DteDocumentRecord
  ): FiscalCorrectionDocumentEvidence {
    const documentClaimId = correction.target_kind === "DTE_DOCUMENT"
      ? correction.fiscal_claim_id
      : `fiscal_correction_${correction.id}`;
    if (!documentClaimId || !document.signed_jws) {
      throw new FiscalCorrectionOwnershipError();
    }
    return {
      documentId: document.id,
      documentClaimId,
      signedJws: document.signed_jws
    };
  }

  private async recordFiscalCorrectionAudit(
    correction: FiscalCorrectionRecord,
    status: string
  ): Promise<void> {
    const actionStatus = status === "STARTED"
      ? status
      : TERMINAL_FISCAL_CORRECTION_STATUSES.has(status)
        ? status
        : null;
    if (!actionStatus) return;
    await this.repo.reconcileFiscalCorrectionAudits(correction);
  }

  private async recordStagingSmokeRun(
    documentId: string,
    transactionId: string
  ): Promise<void> {
    const runId = stagingSmokeRunIdFromTransaction(this.env, transactionId);
    if (!runId) {
      return;
    }
    await this.repo.createAuditIfAbsent({
      action: "STAGING_SMOKE_RUN",
      entityType: "dte_document",
      entityId: documentId,
      summary: "CDE creado por la prueba integral de staging",
      metadata: { runId, path: "webhook", source: "staging-smoke" }
    });
  }

  // A REJECTED verdict is MH's judgment on the document CONTENT: retransmitting
  // the same signed JWS can only be rejected identically. Retrying a rejected
  // Wompi CDE therefore rebuilds it from the original webhook (fresh
  // codigoGeneracion and numeroControl, re-signed) before transmitting again.
  async rebuildRejectedWompiDocument(record: DteDocumentRecord): Promise<MhResponse> {
    if (!record.wompi_event_id) {
      throw new Error("El documento no proviene de un evento Wompi");
    }
    const wompiEventId = record.wompi_event_id;
    const event = await this.repo.getWompiEventById(wompiEventId);
    if (!event) {
      throw new Error(`Evento Wompi ${wompiEventId} no encontrado`);
    }
    assertDeploymentAllowsAmbiente(this.env, record.environment);
    assertDeploymentAllowsAmbiente(this.env, event.environment);
    const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
    const config = getEmisorConfig(this.env);
    // Re-apply the same intent correlation as processWompiEvent: without it, an
    // operator retry would silently downgrade a rejected intent-backed CDE to the
    // raw-webhook fallback donor data.
    const correlation = await this.correlateIntent(payload);
    if (correlation.kind === "quarantined") {
      // Preserve the existing CAS-loser result for a caller holding a stale REJECTED
      // snapshot after another retry already claimed and completed this document.
      const current = await this.repo.getDteDocument(record.id);
      if (!current || current.status !== "REJECTED") {
        throw new RejectedWompiRetryConflictError();
      }
      await this.quarantineWompiEvent(wompiEventId, correlation);
      throw new WompiIntentQuarantinedError();
    }
    const intent = correlation.kind === "ready" ? correlation.intent : null;
    const claimId = newId("fiscal");
    // Win ownership before allocating the new control number. A concurrent loser must
    // not create a second fiscal identity or burn a sequence it can never transmit.
    if (!(await this.repo.claimRejectedWompiRetry(record.id, wompiEventId, claimId))) {
      throw new RejectedWompiRetryConflictError();
    }
    let fiscalCallStarted = false;
    try {
      const sequence = await this.repo.nextControlSequence(record.environment, config.controlPrefix);
      const rebuilt = buildCdeDocument(payload, config, {
        sequence,
        environment: record.environment,
        donorOverride: intent ? donorOverrideFromIntent(intent, payload) : undefined
      });
      const identifiers = extractCdeIdentifiers(rebuilt);
      assertCdeIssuerMatchesConfig(rebuilt, config);
      const signedJws = await signMhDocument(rebuilt, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
      if (
        !(await this.repo.prepareClaimedRejectedWompiRebuild(record.id, wompiEventId, claimId, {
          codigoGeneracion: identifiers.codigoGeneracion,
          numeroControl: identifiers.numeroControl,
          plainJson: rebuilt,
          signedJws
        }))
      ) {
        throw new RejectedWompiRetryConflictError();
      }

      let mhResult: MhResponse;
      try {
        fiscalCallStarted = true;
        mhResult = await this.mh.transmitDte({
          ambiente: record.environment,
          version: 2,
          tipoDte: "15",
          codigoGeneracion: identifiers.codigoGeneracion,
          signedJws
        });
      } catch (error) {
        if (error instanceof MhPreDispatchError) {
          // Authentication failed before the fiscal POST. The rebuilt normal CDE is
          // safe to defer with the same identity for the scheduled retry.
          const reason = String(error.message);
          await this.deferTransmission(record.id, claimId, reason);
          return { accepted: false, estado: "TRANSMISION_DIFERIDA", selloRecibido: null, observaciones: [reason], raw: { deferred: true } };
        }
        throw error;
      }

      const completed = await this.repo.completeDocumentTransmission(record.id, claimId, {
        status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: mhResult.selloRecibido,
        mhEstado: mhResult.estado,
        observaciones: mhResult.observaciones,
        acceptedAt: mhResult.accepted ? nowIso() : null
      });
      if (!completed) {
        throw new RejectedWompiRetryConflictError();
      }
      const updated = (await this.repo.getDteDocument(record.id)) ?? record;
      if (mhResult.accepted) {
        await this.finalizeAcceptedDocument(updated, {
          intent,
          auditAction: "DTE_ACCEPTED",
          auditSummary: `${updated.numero_control} ${mhResult.estado} (reconstruido)`,
          auditMetadata: mhResult.raw
        });
      } else {
        await this.repo.createAudit({
          action: "DTE_REJECTED",
          entityType: "dte_document",
          entityId: updated.id,
          summary: `${updated.numero_control} ${mhResult.estado} (reconstruido)`,
          metadata: mhResult.raw
        });
      }
      return mhResult;
    } catch (error) {
      if (!fiscalCallStarted) {
        await this.repo.releaseDocumentFiscalOperation(record.id, claimId);
      }
      throw error;
    }
  }

  async processDteDocument(
    documentId: string,
    issuanceIncidentId?: string,
    correctionContext?: FiscalCorrectionContext
  ): Promise<DteDocumentRecord> {
    let record = await this.repo.getDteDocument(documentId);
    if (!record) {
      throw new Error(`Documento DTE ${documentId} no encontrado`);
    }
    assertDeploymentAllowsAmbiente(this.env, record.environment);
    // Idempotencia ante reentregas de cola: un documento ya sellado por MH
    // (ACCEPTED/REJECTED) o invalidado es TERMINAL. No se re-firma ni se re-transmite,
    // y su veredicto no se sobrescribe. Los diferidos (SIGNED + marcador) NO son
    // terminales: siguen su reintento por el cron.
    if (isTerminalDteStatus(record.status)) {
      if (record.status === "ACCEPTED" && !record.post_accept_finalized_at) {
        await this.finalizeAcceptedDocument(record);
        return (await this.repo.getDteDocument(record.id)) ?? record;
      }
      return record;
    }
    const document = JSON.parse(record.plain_json) as Record<string, unknown>;
    const summary = cdeDocumentSummary(document);
    const wompiBacked = Boolean(record.wompi_event_id);
    assertDeploymentAllowsAmbiente(this.env, summary.environment);
    let claimId: string | null = null;
    try {
      let signedJws = record.signed_jws;
      let expectedStatus = record.status;
      const correctionClaimId = correctionContext?.claimId ?? null;
      const correctionOwnsClaim = Boolean(
        correctionClaimId
        && record.fiscal_operation_claim_id === correctionClaimId
        && record.fiscal_operation_kind === "TRANSMISSION"
        && record.fiscal_operation_event_id == null
      );
      if (!signedJws) {
        assertCdeIssuerMatchesConfig(document, getEmisorConfig(this.env));
        signedJws = await signMhDocument(document, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
        const updated = correctionOwnsClaim && correctionClaimId
          ? await this.repo.updateClaimedDocumentSigned(
              record.id,
              signedJws,
              expectedStatus,
              correctionClaimId
            )
          : await this.repo.updateDocumentSigned(record.id, signedJws, expectedStatus);
        if (!updated) {
          return (await this.repo.getDteDocument(record.id)) ?? record;
        }
        expectedStatus = "SIGNED";
        if (correctionOwnsClaim) {
          record = (await this.repo.getDteDocument(record.id)) ?? record;
        }
      } else if (
        correctionOwnsClaim
        && correctionClaimId
        && expectedStatus !== "SIGNED"
      ) {
        if (!(await this.repo.updateClaimedDocumentSigned(
          record.id,
          signedJws,
          expectedStatus,
          correctionClaimId
        ))) {
          return (await this.repo.getDteDocument(record.id)) ?? record;
        }
        expectedStatus = "SIGNED";
        record = (await this.repo.getDteDocument(record.id)) ?? record;
      }
      claimId = correctionClaimId ?? newId("fiscal");
      const alreadyClaimedByCorrection = Boolean(
        correctionContext
        && record.status === "SIGNED"
        && record.signed_jws === signedJws
        && record.fiscal_operation_claim_id === claimId
        && record.fiscal_operation_kind === "TRANSMISSION"
      );
      if (
        !alreadyClaimedByCorrection
        && !(await this.repo.claimDocumentTransmission(record.id, expectedStatus, signedJws, claimId))
      ) {
        return (await this.repo.getDteDocument(record.id)) ?? record;
      }
      if (correctionContext) {
        const marked = await this.repo.markFiscalCorrectionMhDispatchStarted({
          correctionId: correctionContext.correctionId,
          processingClaimId: correctionContext.processingClaimId,
          documentId: record.id,
          documentClaimId: claimId,
          signedJws
        });
        if (!marked) {
          throw new FiscalCorrectionDispatchInFlightError();
        }
      }
      const mhResult = await this.mh.transmitDte({
        ambiente: summary.environment,
        version: 2,
        tipoDte: "15",
        codigoGeneracion: summary.codigoGeneracion,
        signedJws
      });
      const completed = await this.repo.completeDocumentTransmission(record.id, claimId, {
        status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: mhResult.selloRecibido,
        mhEstado: mhResult.estado,
        observaciones: mhResult.observaciones,
        acceptedAt: mhResult.accepted ? nowIso() : null
      });
      if (!completed) {
        return (await this.repo.getDteDocument(record.id)) ?? record;
      }
      record = (await this.repo.getDteDocument(record.id)) ?? record;
      if (mhResult.accepted) {
        await this.finalizeAcceptedDocument(record, {
          auditAction: wompiBacked ? "DTE_ACCEPTED" : "ADVANCED_CDE_ACCEPTED",
          auditSummary: `${record.numero_control} ${mhResult.estado}`,
          auditMetadata: mhResult.raw
        });
      } else {
        await this.repo.createAudit({
          action: wompiBacked ? "DTE_REJECTED" : "ADVANCED_CDE_REJECTED",
          entityType: "dte_document",
          entityId: record.id,
          summary: `${record.numero_control} ${mhResult.estado}`,
          metadata: mhResult.raw
        });
      }
      return (await this.repo.getDteDocument(record.id)) ?? record;
    } catch (error) {
      if (error instanceof FiscalCorrectionDispatchInFlightError) {
        throw error;
      }
      if (error instanceof MhPreDispatchError && claimId) {
        if (correctionContext) {
          if (correctionContext.preserveSignedOnPreDispatchFailure) {
            throw error;
          }
          const failed = await this.repo.markDocumentFailed(record.id, claimId, {
            mhEstado: "MH_PRE_DISPATCH_ERROR",
            observaciones: [String(error.message)]
          });
          if (!failed) {
            await this.repo.releaseDocumentFiscalOperation(record.id, claimId);
          }
          throw error;
        }
        // Firmado pero sin poder transmitir: se difiere (no es un fallo del CDE).
        return this.deferTransmission(record.id, claimId, String(error.message));
      }
      // Entre nuestra lectura y este fallo, MH pudo haber sellado el documento
      // (ACCEPTED/REJECTED) o pudo invalidarse: si ya es TERMINAL, un fallo posterior de
      // bookkeeping (p. ej. la escritura de auditoría) NO debe degradarlo a FAILED. Se
      // conserva el sello y se devuelve el estado terminal.
      const latest = await this.repo.getDteDocument(record.id);
      if (latest?.status === "ACCEPTED" && !latest.post_accept_finalized_at) {
        throw error;
      }
      if (latest && isTerminalDteStatus(latest.status)) {
        if (wompiBacked && latest.status === "ACCEPTED") {
          throw error;
        }
        return latest;
      }
      if (claimId) {
        // Keep an outcome-ambiguous dispatch claimed. Queue redelivery may observe
        // the row, but it must stop before another MH request is issued.
        throw error;
      }
      // A deferred row whose local validation/signing still cannot proceed must
      // remain in the deferred sweep. Configuration can be corrected without
      // converting the recoverable CDE into an operator-facing FAILED record.
      if (record.status === "SIGNED" && record.transmission_deferred_at) {
        throw error;
      }
      const failed = await this.repo.markDocumentFailed(record.id, null, {
        mhEstado: "ADVANCED_PIPELINE_ERROR",
        observaciones: [error instanceof Error ? error.message : String(error)]
      });
      if (!failed) {
        const current = await this.repo.getDteDocument(record.id);
        if (current) return current;
      }
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failureIncidentId = issuanceIncidentId ?? newId("issuance_failure");
      await this.repo.createAudit({
        action: wompiBacked ? "DTE_FAILED" : "ADVANCED_CDE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: failureMessage,
        metadata: { incidentId: failureIncidentId }
      });
      await sendOperationalAlert(this.env, this.repo, {
        kind: wompiBacked ? "DTE_FAILED" : "ADVANCED_CDE_FAILED",
        title: wompiBacked ? "Fallo al emitir DTE" : "Fallo al emitir CDE avanzado",
        detail: `El documento ${record.numero_control} falló: ${failureMessage}`,
        entityType: "dte_document",
        entityId: record.id,
        incidentId: failureIncidentId
      });
      throw error;
    }
  }

  // Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
  // admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
  // está EXCLUIDO en la propia capa de validación de MH, por lo que un CDE jamás se
  // emite en contingencia. El manejo de una caída de MH es "transmisión diferida por
  // reintento": el documento (forma NORMAL, ya firmado) queda SIGNED con el marcador
  // transmission_deferred_at (D1 no puede reconstruir dte_documents para ampliar su
  // CHECK de status), el donante recibe de inmediato su comprobante TRANSITORIO, y este
  // cron de 15 minutos reintenta la transmisión hasta obtener el sello definitivo
  // (o un rechazo real de MH, que sigue el flujo normal de rechazados).
  async retryDeferredTransmissions(): Promise<{ transmitted: number; rejected: number; pending: number }> {
    const docs = await this.repo.listDeferredTransmissionDocuments();
    let transmitted = 0;
    let rejected = 0;
    let pending = 0;
    for (const record of docs) {
      let claimId: string | null = null;
      // Cada documento se reintenta aislado: un fallo no debe abortar el barrido.
      try {
        assertDeploymentAllowsAmbiente(this.env, record.environment);
        let signedJws = record.signed_jws;
        if (!signedJws) {
          // Defensivo: todos los caminos que difieren firman antes. RS512/PKCS1 es
          // determinista, así que re-firmar el mismo plain_json es idempotente.
          const document = JSON.parse(record.plain_json) as Record<string, unknown>;
          assertCdeIssuerMatchesConfig(document, getEmisorConfig(this.env));
          signedJws = await signMhDocument(document, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
        }
        if (!record.signed_jws && !(await this.repo.updateDocumentSigned(record.id, signedJws, record.status))) {
          pending += 1;
          continue;
        }
        claimId = newId("fiscal");
        if (!(await this.repo.claimDocumentTransmission(record.id, "SIGNED", signedJws, claimId))) {
          pending += 1;
          continue;
        }
        const mhResult = await this.mh.transmitDte({
          ambiente: record.environment,
          version: 2,
          tipoDte: record.tipo_dte || "15",
          codigoGeneracion: record.codigo_generacion,
          signedJws
        });
        // El status sale de SIGNED (ACCEPTED/REJECTED) y con eso el documento deja de
        // aparecer en listDeferredTransmissionDocuments; transmission_deferred_at se
        // conserva a propósito como evidencia histórica de que estuvo diferido.
        const completed = await this.repo.completeDocumentTransmission(record.id, claimId, {
          status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
          sello: mhResult.selloRecibido,
          mhEstado: mhResult.estado,
          observaciones: mhResult.observaciones,
          acceptedAt: mhResult.accepted ? nowIso() : null
        });
        if (!completed) {
          pending += 1;
          continue;
        }
        if (mhResult.accepted) transmitted += 1;
        else rejected += 1;
        const updated = (await this.repo.getDteDocument(record.id)) ?? record;
        if (mhResult.accepted) {
          await this.finalizeAcceptedDocument(updated, {
            auditAction: "DTE_ACCEPTED",
            auditSummary: `${updated.numero_control} ${mhResult.estado} (transmisión diferida)`,
            auditMetadata: mhResult.raw
          });
        } else {
          await this.repo.createAudit({
            action: "DTE_REJECTED",
            entityType: "dte_document",
            entityId: updated.id,
            summary: `${updated.numero_control} ${mhResult.estado} (transmisión diferida)`,
            metadata: mhResult.raw
          });
        }
      } catch (error) {
        if (claimId && error instanceof MhPreDispatchError) {
          // Authentication failed before the fiscal POST, so this claim is safe to
          // release. Every failure after dispatch starts remains claimed because MH
          // may already have processed the document.
          await this.repo.releaseDocumentFiscalOperation(record.id, claimId);
        }
        const latest = await this.repo.getDteDocument(record.id);
        if (latest && isTerminalDteStatus(latest.status)) {
          continue;
        }
        // MH sigue sin responder (u otro fallo transitorio): el documento permanece
        // diferido (SIGNED + marcador) sin auditoría por tick — auditar cada reintento de un
        // cron de 15 minutos sería puro ruido. La visibilidad la da la alerta de
        // backlog de alertOnDeferredBacklog.
        if (!(error instanceof MhPreDispatchError)) {
          logWorkerError(this.env, "deferred_transmission_retry_failed", error);
        }
        pending += 1;
      }
    }
    await this.alertOnDeferredBacklog();
    return { transmitted, rejected, pending };
  }

  async retryPendingPostAcceptFinalizations(limit = 100): Promise<{ finalized: number; failed: number }> {
    const documents = await this.repo.listPendingPostAcceptFinalizations(limit);
    let finalized = 0;
    let failed = 0;
    for (const document of documents) {
      try {
        if (await this.finalizeAcceptedDocument(document)) {
          finalized += 1;
        }
      } catch (error) {
        failed += 1;
        logWorkerError(this.env, "post_accept_finalization_failed", error);
      }
    }
    return { finalized, failed };
  }

  async retryAcceptedWompiFinalizations(): Promise<{ finalized: number; pending: number }> {
    const documents = await this.repo.listAcceptedWompiDocumentsMissingFinalization();
    let finalized = 0;
    let pending = 0;
    for (const record of documents) {
      try {
        if (await this.finalizeAcceptedDocument(record)) {
          finalized += 1;
        } else {
          pending += 1;
        }
      } catch (error) {
        logWorkerError(this.env, "accepted_wompi_finalization_failed", error);
        pending += 1;
      }
    }
    return { finalized, pending };
  }

  // Alerta operativa MH_UNAVAILABLE cuando algún CDE diferido lleva más de una hora
  // sin transmitirse. El id y la fecha de deferimiento del documento más antiguo
  // forman la identidad estable de ese episodio de atasco.
  private async alertOnDeferredBacklog(): Promise<void> {
    const remaining = await this.repo.listDeferredTransmissionDocuments();
    const cutoff = new Date(Date.now() - DEFERRED_ALERT_AGE_MS).toISOString();
    // La antigüedad se mide desde el MOMENTO del deferimiento, no desde la creación.
    const overdue = remaining.filter((record) => String(record.transmission_deferred_at ?? record.created_at) < cutoff);
    if (overdue.length === 0) {
      return;
    }
    await sendOperationalAlert(this.env, this.repo, {
      kind: "MH_UNAVAILABLE",
      title: "Ministerio de Hacienda no disponible",
      detail: `Hay ${overdue.length} CDE con transmisión diferida por más de una hora (el más antiguo: ${overdue[0].numero_control}). El sistema reintenta automáticamente cada 15 minutos; los donantes ya recibieron su comprobante transitorio.`,
      entityType: "dte_document",
      entityId: overdue[0].id,
      incidentId: `${overdue[0].id}:${overdue[0].transmission_deferred_at ?? overdue[0].created_at}`
    });
  }

  // Difiere la transmisión de un CDE ya firmado (forma normal). El donante recibe de
  // inmediato el comprobante TRANSITORIO — pdf.ts imprime "TRANSITORIO" como sello
  // cuando sello_recibido es null — y el cron reintenta la transmisión.
  private async deferTransmission(documentId: string, claimId: string, reason: string): Promise<DteDocumentRecord> {
    const deferred = await this.repo.markDocumentTransmissionDeferred(documentId, claimId, reason);
    const updated = await this.repo.getDteDocument(documentId);
    if (!updated) {
      throw new Error(`Documento DTE ${documentId} no encontrado al diferir su transmisión`);
    }
    if (!deferred) {
      return updated;
    }
    await this.repo.createAuditIfAbsent({
      action: "DTE_TRANSMISSION_DEFERRED",
      entityType: "dte_document",
      entityId: updated.id,
      summary: `${updated.numero_control}: ${reason}`
    });
    // Dedupe por evidencia en email_deliveries: una reentrega del mensaje de cola
    // (crash entre correo y ack) no debe duplicar el transitorio al donante.
    if (!(await this.repo.hasSentEmail(updated.id, "dteReceiptTransitorio"))) {
      await this.emailReceipt(updated);
    }
    return updated;
  }

  private async finalizeAcceptedDocument(
    record: DteDocumentRecord,
    options: {
      intent?: DonationIntentRecord | null;
      auditAction?: "DTE_ACCEPTED" | "ADVANCED_CDE_ACCEPTED";
      auditSummary?: string;
      auditMetadata?: unknown;
    } = {}
  ): Promise<boolean> {
    if (record.status !== "ACCEPTED" || record.post_accept_finalized_at) {
      return false;
    }

    const claimId = newId("finalize");
    if (!(await this.repo.claimDocumentPostAcceptFinalization(record.id, claimId))) {
      return false;
    }
    let emailDispatchStarted = false;
    try {
      const claimedRecord = await this.repo.getDteDocument(record.id);
      if (
        !claimedRecord ||
        claimedRecord.status !== "ACCEPTED" ||
        claimedRecord.post_accept_finalized_at ||
        claimedRecord.post_accept_finalization_claim_id !== claimId
      ) {
        throw new PostAcceptFinalizationOwnershipError(
          `El CDE aceptado ${record.id} perdió la propiedad antes de recargar el destinatario`
        );
      }
      // The list/acceptance caller can hold a stale snapshot. Reload only after the
      // claim is durable; donor-email edits reject that active claim, so whichever
      // write wins determines the one recipient used at provider dispatch.
      record = claimedRecord;

      let completedIntent = await this.repo.getCompletedIntentForDocument(record.id);
      let intent = options.intent ?? null;
      if (!completedIntent && !intent && record.wompi_event_id) {
        const event = await this.repo.getWompiEventById(record.wompi_event_id);
        if (!event) {
          throw new Error(`Evento Wompi ${record.wompi_event_id} no encontrado al finalizar ${record.id}`);
        }
        const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
        const binding = await resolveDonationIntentBinding(this.repo, payload);
        if (binding.kind === "bound") {
          intent = binding.intent;
        } else if (binding.kind === "unbound") {
          // An accepted intent-backed document must never be marked finalized while its
          // application intent remains unresolved. COMPLETED rows are found above by
          // document_id; every other unbound state needs operator-visible retry/recovery.
          throw new Error(`La intención ${binding.intentId} no pudo finalizarse: ${binding.reason}`);
        }
      }

      if (intent) {
        const completed = await this.repo.completeIntentForPostAcceptOwner(intent.id, record.id, claimId);
        completedIntent = await this.repo.getCompletedIntentForDocument(record.id);
        if (!completed || completedIntent?.id !== intent.id) {
          throw new Error(`La intención ${intent.id} no pudo vincularse al CDE aceptado ${record.id}`);
        }
      }

      if (record.donor_email) {
        if (!(await this.repo.hasHandledEmail(record.id, "dteReceipt", "ACCEPTED"))) {
          await this.emailReceipt(record, async () => {
            try {
              if (!(await this.repo.markDocumentPostAcceptEmailDispatchStarted(record.id, claimId))) {
                throw new Error(`El CDE aceptado ${record.id} perdió la propiedad antes de enviar su comprobante`);
              }
              emailDispatchStarted = true;
            } catch (error) {
              throw new PostAcceptFinalizationOwnershipError(
                `El CDE aceptado ${record.id} no pudo confirmar su propiedad antes de enviar el comprobante`,
                error
              );
            }
          });
        }
      } else if (!(await this.repo.ensurePostAcceptAudit({
        auditId: `audit_post_accept_email_skipped_${record.id}`,
        documentId: record.id,
        claimId,
        action: "EMAIL_SKIPPED",
        entityType: "dte_document",
        entityId: record.id,
        summary: "Documento sin correo del donante"
      }))) {
        throw new PostAcceptFinalizationOwnershipError(
          `El CDE aceptado ${record.id} perdió la propiedad antes de registrar EMAIL_SKIPPED`
        );
      }

      if (completedIntent && !(await this.repo.ensurePostAcceptAudit({
          auditId: `audit_post_accept_intent_${record.id}`,
          documentId: record.id,
          claimId,
          action: "DONATION_INTENT_COMPLETED",
          entityType: "donation_intent",
          entityId: completedIntent.id,
          summary: `Intención ${completedIntent.id} completada por el CDE ${record.id}`,
          metadata: { documentId: record.id }
        }))) {
        throw new PostAcceptFinalizationOwnershipError(
          `El CDE aceptado ${record.id} perdió la propiedad antes de auditar su intención`
        );
      }

      const auditAction = options.auditAction ?? (record.wompi_event_id ? "DTE_ACCEPTED" : "ADVANCED_CDE_ACCEPTED");
      if (!(await this.repo.ensurePostAcceptAudit({
          auditId: `audit_post_accept_${auditAction.toLowerCase()}_${record.id}`,
          documentId: record.id,
          claimId,
          action: auditAction,
          entityType: "dte_document",
          entityId: record.id,
          summary: options.auditSummary ?? `${record.numero_control} ${record.mh_estado ?? "ACEPTADO"}`,
          metadata: options.auditMetadata ?? { recoveredPostAcceptFinalization: true }
        }))) {
        throw new PostAcceptFinalizationOwnershipError(
          `El CDE aceptado ${record.id} perdió la propiedad antes de auditar su aceptación`
        );
      }

      if (record.wompi_event_id && !(await this.repo.ensurePostAcceptAudit({
          auditId: `audit_post_accept_finalized_${record.id}`,
          documentId: record.id,
          claimId,
          action: "DTE_ACCEPTED_FINALIZED",
          entityType: "dte_document",
          entityId: record.id,
          summary: "Finalización post-aceptación completada"
        }))) {
        throw new PostAcceptFinalizationOwnershipError(
          `El CDE aceptado ${record.id} perdió la propiedad antes de auditar su finalización`
        );
      }

      if (!(await this.repo.markDocumentPostAcceptFinalized(record.id, claimId))) {
        const current = await this.repo.getDteDocument(record.id);
        if (!current?.post_accept_finalized_at) {
          throw new Error(`El CDE aceptado ${record.id} cambió antes de completar su finalización`);
        }
      }
      return true;
    } catch (error) {
      // Release only when retry cannot duplicate an email side effect. Before dispatch
      // there is no external effect; after dispatch, a durable SENT row (or the local
      // EMAIL_SKIPPED outcome) lets a later owner safely resume audits/final marking.
      const safeReceiptEvidence = record.donor_email
        ? await this.repo.hasHandledEmail(record.id, "dteReceipt", "ACCEPTED")
        : await this.repo.hasAuditAction("EMAIL_SKIPPED", "dte_document", record.id);
      if (!emailDispatchStarted || safeReceiptEvidence) {
        await this.repo.releaseDocumentPostAcceptFinalization(record.id, claimId);
      }
      throw error;
    }
  }

  // The shared resolver is the only authority for both the synchronous paid marker
  // and fiscal correlation. It requires the canonical Wompi commerce id plus the exact
  // numeric link id; legacy static links remain on the raw-webhook path.
  private async correlateIntent(payload: WompiWebhook): Promise<IntentCorrelation> {
    const binding = await resolveDonationIntentBinding(this.repo, payload);
    if (binding.kind === "legacy") {
      return { kind: "legacy" };
    }
    if (binding.kind === "unbound") {
      return {
        kind: "quarantined",
        intentId: binding.intentId,
        reason: binding.reason,
        expectedLinkId: binding.expectedLinkId,
        payloadLinkId: binding.payloadLinkId
      };
    }
    const intent = binding.intent;
    if (!intent.donor_document || intent.donor_document.trim() === "") {
      return {
        kind: "quarantined",
        intentId: intent.id,
        reason: "incomplete_donor_data",
        expectedLinkId: intent.wompi_id_enlace,
        payloadLinkId: payload.EnlacePago?.Id ?? null
      };
    }
    // Money truth comes from Wompi: on a mismatch we audit and still correlate, but the
    // CDE amount is left as the webhook's (buildCdeDocument derives it from the payload).
    const eventAmountCents = amountCents(payload);
    if (intent.amount_cents !== eventAmountCents) {
      await this.repo.createAudit({
        action: "DONATION_INTENT_AMOUNT_MISMATCH",
        entityType: "donation_intent",
        entityId: intent.id,
        summary: `Monto de intención ${intent.amount_cents} ≠ monto del webhook ${eventAmountCents}; se usa el del webhook`,
        metadata: { intentAmountCents: intent.amount_cents, eventAmountCents }
      });
    }
    return { kind: "ready", intent };
  }

  private async quarantineWompiEvent(
    wompiEventId: string,
    correlation: Extract<IntentCorrelation, { kind: "quarantined" }>
  ): Promise<void> {
    await this.repo.quarantineWompiIntentBinding({
      wompiEventId,
      intentId: correlation.intentId,
      reason: correlation.reason,
      expectedLinkId: correlation.expectedLinkId,
      payloadLinkId: correlation.payloadLinkId
    });
  }

  private async emailReceipt(
    record: DteDocumentRecord,
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<boolean> {
    if (!record.donor_email) {
      await this.repo.createAuditIfAbsent({
        action: "EMAIL_SKIPPED",
        entityType: "dte_document",
        entityId: record.id,
        summary: "Documento sin correo del donante"
      });
      return true;
    }
    const emailType =
      record.status === "SIGNED" && record.transmission_deferred_at
        ? "dteReceiptTransitorio"
        : "dteReceipt";
    const deliveryClaim = await this.repo.claimEmailDelivery({
      documentId: record.id,
      toEmail: record.donor_email,
      emailType,
      documentStatusAtSend: record.status
    });
    if (!deliveryClaim) {
      return this.repo.hasSentEmail(record.id, emailType);
    }

    let response: EmailDeliveryResult;
    let providerDispatchStarted = false;
    try {
      const templates = parseEmailTemplates(await this.repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
      const branding = await loadEmailBranding(this.repo, this.env);
      response = await new EmailService(this.env, templates, branding).sendReceipt(
        record,
        record.donor_email,
        deliveryClaim.idempotencyKey,
        async () => {
          await beforeProviderDispatch?.();
          const marked = await this.repo.markEmailDeliveryDispatchStarted(
            deliveryClaim.id,
            deliveryClaim.claimToken
          );
          if (!marked) {
            throw new Error("La reserva de correo perdió propiedad antes del envío");
          }
          providerDispatchStarted = true;
        }
      );
    } catch (error) {
      if (error instanceof PostAcceptFinalizationOwnershipError) {
        throw error;
      }
      const failure = classifyEmailDispatchError(error, providerDispatchStarted);
      await this.repo.finalizeEmailDeliveryClaim(deliveryClaim.id, deliveryClaim.claimToken, {
        status: "FAILED",
        providerResponse: failure.providerResponse,
        emailType,
        documentStatusAtSend: record.status,
        outcomeClass: failure.outcomeClass,
        failureCode: failure.code,
        retrySafe: failure.retrySafe
      });
      await this.repo.createAudit({
        action: "EMAIL_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: failure.message
      });
      await sendOperationalAlert(this.env, this.repo, {
        kind: "EMAIL_FAILED",
        title: "Fallo al enviar comprobante",
        detail: `El comprobante ${record.numero_control} no pudo enviarse al donante: ${failure.message}`,
        entityType: "dte_document",
        entityId: record.id,
        incidentId: deliveryClaim.claimToken
      });
      return false;
    }

    await this.repo.finalizeEmailDeliveryClaim(deliveryClaim.id, deliveryClaim.claimToken, {
      status: "SENT",
      providerResponse: response.providerResponse,
      emailType: response.emailType,
      documentStatusAtSend: response.documentStatusAtSend,
      templateVersion: response.templateVersion,
      pdfRendererVersion: response.pdfRendererVersion,
      pdfSha256: response.pdfSha256,
      dteJsonSha256: response.dteJsonSha256,
      providerDeliveryId: response.providerDeliveryId
    });
    try {
      await this.repo.createAudit({
        action: "EMAIL_SENT",
        entityType: "dte_document",
        entityId: record.id,
        summary: "Comprobante enviado al correo registrado.",
        metadata: emailDeliveryAuditEvidence(response)
      });
    } catch (error) {
      // The durable SENT delivery is the side-effect authority. A secondary audit
      // failure must not turn an accepted fiscal document into retryable work.
      logWorkerError(this.env, "receipt_delivery_audit_failed", error);
    }
    return true;
  }
}

// Merge the correlated intent with the payment webhook into the CDE receptor:
// identity (tipoDocumento/numDocumento) and the catalog-coded direccion come from the
// intent (validated on the /donar form); correo comes from the WEBHOOK, because the
// donor types it on Wompi's hosted sheet. nombre prefers the intent's donor_name —
// the razón social, set only for NIT/empresa donors — else the webhook cardholder
// name. telefono prefers the intent's phone, else the webhook Celular. A foreign
// intent (donor_pais set) additionally marks the receptor as non-domiciled in its
// CAT-020 country; domestic intents leave codPais/codDomiciliado to the builder's
// payload-derived defaults.
function donorOverrideFromIntent(intent: DonationIntentRecord, payload: WompiWebhook): IntentDonorOverride {
  return {
    tipoDocumento: intent.donor_document_type,
    numDocumento: intent.donor_document,
    nombre: intent.donor_name ?? donorName(payload),
    correo: cleanNullable(payload.Cliente?.EMail),
    telefono: intent.donor_phone ?? cleanNullable(payload.Cliente?.Celular),
    direccion: {
      departamento: intent.direccion_departamento,
      municipio: intent.direccion_municipio,
      distrito: intent.direccion_distrito,
      complemento: intent.direccion_complemento
    },
    ...(intent.donor_pais ? { codPais: intent.donor_pais, codDomiciliado: 2 as const } : {}),
    // Diezmo/Ofrenda rides through here so the "TipoAportacion" apéndice line
    // survives every issuance path (normal, rejected-rebuild, contingency), all of
    // which build the override from this single helper.
    ...(intent.gift_type ? { giftType: intent.gift_type } : {})
  };
}

// Trim to null, mirroring dteBuilder's fallback normalization so an empty/whitespace
// webhook field becomes null rather than "" on the CDE receptor.
function cleanNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Pre-allocation guard: is the effective donor DUI invalid? Mirrors buildCdeDocument's
// receptor derivation so the answer matches what buildCdeDocument would validate. An
// intent override supplies tipoDocumento/numDocumento directly; a raw webhook declares
// DUI ("13") only when DocumentoIdentidad carries the 9 digits a DUI needs, so a
// document that is not a DUI simply passes. Returns a human-friendly reason on failure,
// else null. Runs BEFORE nextControlSequence so a bad DUI never consumes a control number.
function invalidWompiDonorDuiReason(payload: WompiWebhook, override: IntentDonorOverride | undefined): string | null {
  if (override) {
    return isDuiDocumentType(override.tipoDocumento) ? duiValidationReason(override.numDocumento) : null;
  }
  const donorDocumentRaw = cleanNullable(payload.Cliente?.DocumentoIdentidad);
  const donorIsDui = donorDocumentRaw !== null && cleanDui(donorDocumentRaw).length === 9;
  return donorIsDui ? duiValidationReason(donorDocumentRaw) : null;
}

function duiValidationReason(value: string | null): string | null {
  try {
    assertValidDui(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function extractCdeIdentifiers(document: Record<string, unknown>): { codigoGeneracion: string; numeroControl: string } {
  const identificacion = document.identificacion as { codigoGeneracion: string; numeroControl: string };
  return {
    codigoGeneracion: identificacion.codigoGeneracion,
    numeroControl: identificacion.numeroControl
  };
}

function parseFiscalCorrectionSourceDocument(
  correction: FiscalCorrectionRecord
): DteDocumentRecord {
  if (!correction.source_document_snapshot_json) {
    throw new Error("La corrección no contiene la evidencia archivada del rechazo.");
  }
  const parsed = JSON.parse(correction.source_document_snapshot_json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("La evidencia archivada del rechazo no es un documento válido.");
  }
  const source = parsed as Partial<DteDocumentRecord>;
  if (
    typeof source.id !== "string"
    || typeof source.plain_json !== "string"
    || (source.environment !== "00" && source.environment !== "01")
  ) {
    throw new Error("La evidencia archivada del rechazo está incompleta.");
  }
  return source as DteDocumentRecord;
}

function assertFiscalCorrectionOwnership(
  correction: FiscalCorrectionRecord,
  ownership: FiscalCorrectionQueueOwnership
): void {
  if (
    correction.processing_claim_id !== ownership.processingClaimId
    || correction.issuance_attempt_id !== (ownership.issuanceAttemptId ?? null)
    || correction.fiscal_claim_id !== (ownership.fiscalClaimId ?? null)
  ) {
    throw new FiscalCorrectionOwnershipError();
  }
}
