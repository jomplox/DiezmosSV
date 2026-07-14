import { getEmisorConfig, getMhCertificateXml, requireSecret } from "../config";
import { assertCdeIssuerMatchesConfig, buildCdeDocument, cdeDocumentSummary } from "../domain/dteBuilder";
import type { IntentDonorOverride } from "../domain/dteBuilder";
import { signMhDocument } from "../domain/signer";
import { amountCents, donorName, isApprovedDonation, normalizeWompiWebhook } from "../domain/wompi";
import { assertValidDui, cleanDui, isDuiDocumentType } from "../../shared/dui";
import { legacyIssuanceAttemptId, Repository } from "../storage/repository";
import type { DonationIntentRecord, DteDocumentRecord, Env, MhResponse, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { sendOperationalAlert } from "./alerts";
import { loadEmailBranding } from "./branding";
import { EmailService, type EmailDeliveryResult } from "./email";
import { EMAIL_TEMPLATES_SETTING_KEY, parseEmailTemplates } from "./emailTemplates";
import { resolveDonationIntentBinding } from "./donationIntentBinding";
import type { DonationIntentBinding } from "./donationIntentBinding";
import { MhClient, MhUnavailableError } from "./mhClient";
import { assertDeploymentAllowsAmbiente, EnvironmentNotAllowedError } from "./environmentPolicy";

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
const MAX_WOMPI_EVENT_REQUEUES = 3;
// Un CDE diferido que sigue sin transmitirse una hora después de emitido dispara
// una alerta operativa MH_UNAVAILABLE (una sola vez por documento, vía dedupe).
const DEFERRED_ALERT_AGE_MS = 60 * 60 * 1000;
const DTE_TRANSMISSION_LEASE_MS = 5 * 60 * 1000;

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
        // if the email send itself failed (ALERT_FAILED), that audit alone must not
        // permanently suppress future attempts. sendOperationalAlert has its own
        // ALERT_SENT:WOMPI_EVENT_STALLED dedupe, so once a send succeeds this becomes a no-op.
        await sendOperationalAlert(this.env, this.repo, {
          kind: "WOMPI_EVENT_STALLED",
          title: "Evento Wompi sin procesar",
          detail: summary,
          entityType: "wompi_event",
          entityId: eventId
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
      return this.processDteDocument(existing.id);
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
    const reserved = await this.repo.reserveWompiDocumentIdentifiers(
      wompiEventId,
      environment,
      config.controlPrefix
    );
    const normalDocument = buildCdeDocument(payload, config, {
      sequence: reserved.sequence,
      codigoGeneracion: reserved.codigoGeneracion,
      environment,
      donorOverride
    });
    const identifiers = extractCdeIdentifiers(normalDocument);
    // Persist the donor metadata from the EMITTED CDE receptor, not the raw webhook: for
    // an empresa (NIT 36) intent the receptor nombre is the razón social, so storing the
    // webhook cardholder name here would diverge from the signed document. For a natural
    // person the receptor nombre/correo are the webhook values, so this is unchanged.
    const summary = cdeDocumentSummary(normalDocument);
    const record = await this.repo.createDteDocument({
      wompiEventId,
      environment,
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: normalDocument,
      donorEmail: summary.donorEmail,
      donorName: summary.donorName,
      amountCents: amountCents(payload),
      issuedAt: nowIso()
    });
    return this.processDteDocument(record.id);
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
    const sequence = await this.repo.nextControlSequence(record.environment, config.controlPrefix);
    const rebuilt = buildCdeDocument(payload, config, { sequence, environment: record.environment, donorOverride: intent ? donorOverrideFromIntent(intent, payload) : undefined });
    const identifiers = extractCdeIdentifiers(rebuilt);
    assertCdeIssuerMatchesConfig(rebuilt, config);
    const signedJws = await signMhDocument(rebuilt, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
    // Atomically claim the rebuild before transmitting: only one concurrent operator
    // retry may move this REJECTED CDE to SIGNED with the freshly rebuilt payload. The
    // loser matches 0 rows and stops here — it must not transmit a second distinct legal
    // DTE for the same Wompi event, nor leave the stored payload and the MH result
    // describing different documents. Signing happens first (above) so a failure before
    // the claim leaves the row REJECTED and still retryable.
    const claimed = await this.repo.claimRejectedWompiRebuild(record.id, wompiEventId, {
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: rebuilt,
      signedJws
    });
    if (!claimed) {
      throw new RejectedWompiRetryConflictError();
    }
    const updated = await this.processDteDocument(record.id);
    return mhResponseFromDocument(updated);
  }

  async processDteDocument(documentId: string): Promise<DteDocumentRecord> {
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
      if (record.status === "ACCEPTED" && record.wompi_event_id) {
        await this.finalizeAcceptedWompiDocument(record);
      }
      return record;
    }
    const document = JSON.parse(record.plain_json) as Record<string, unknown>;
    const summary = cdeDocumentSummary(document);
    const wompiBacked = Boolean(record.wompi_event_id);
    assertDeploymentAllowsAmbiente(this.env, summary.environment);
    let transmissionClaimed = false;
    try {
      let signedJws = record.signed_jws;
      if (!signedJws) {
        assertCdeIssuerMatchesConfig(document, getEmisorConfig(this.env));
        signedJws = await signMhDocument(document, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
      }
      const staleBefore = new Date(Date.now() - DTE_TRANSMISSION_LEASE_MS).toISOString();
      transmissionClaimed = await this.repo.claimDteTransmission(record.id, signedJws, staleBefore);
      if (!transmissionClaimed) {
        const current = await this.repo.getDteDocument(record.id);
        if (!current) {
          throw new Error(`Documento DTE ${record.id} no encontrado después de reclamar transmisión`);
        }
        if (current.status === "ACCEPTED" && current.wompi_event_id) {
          await this.finalizeAcceptedWompiDocument(current);
        }
        return current;
      }
      const mhResult = await this.mh.transmitDte({
        ambiente: summary.environment,
        version: 2,
        tipoDte: "15",
        codigoGeneracion: summary.codigoGeneracion,
        signedJws
      });
      const resultStored = await this.repo.updateDocumentMhResult(record.id, {
        status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: mhResult.selloRecibido,
        mhEstado: mhResult.estado,
        observaciones: mhResult.observaciones,
        acceptedAt: mhResult.accepted ? nowIso() : null
      });
      if (!resultStored) {
        const current = await this.repo.getDteDocument(record.id);
        if (!current) {
          throw new Error(`Documento DTE ${record.id} no encontrado después de transmitir`);
        }
        if (current.status === "ACCEPTED" && current.wompi_event_id) {
          await this.finalizeAcceptedWompiDocument(current);
        }
        return current;
      }
      record = (await this.repo.getDteDocument(record.id)) ?? record;
      if (mhResult.accepted && wompiBacked) {
        await this.finalizeAcceptedWompiDocument(record, mhResult.raw);
      } else {
        await this.repo.createAudit({
          action: mhResult.accepted
            ? "ADVANCED_CDE_ACCEPTED"
            : wompiBacked ? "DTE_REJECTED" : "ADVANCED_CDE_REJECTED",
          entityType: "dte_document",
          entityId: record.id,
          summary: `${record.numero_control} ${mhResult.estado}`,
          metadata: mhResult.raw
        });
      }
      if (mhResult.accepted && !wompiBacked) {
        if (!(await this.repo.hasSentEmail(record.id, "dteReceipt"))) {
          await this.emailReceipt(record);
        }
      }
      return record;
    } catch (error) {
      if (error instanceof MhUnavailableError && transmissionClaimed) {
        // Firmado pero sin poder transmitir: se difiere (no es un fallo del CDE).
        return this.deferTransmission(record.id, String(error.message));
      }
      // Entre nuestra lectura y este fallo, MH pudo haber sellado el documento
      // (ACCEPTED/REJECTED) o pudo invalidarse: si ya es TERMINAL, un fallo posterior de
      // bookkeeping (p. ej. la escritura de auditoría) NO debe degradarlo a FAILED. Se
      // conserva el sello y se devuelve el estado terminal.
      const latest = await this.repo.getDteDocument(record.id);
      if (latest && isTerminalDteStatus(latest.status)) {
        if (wompiBacked && latest.status === "ACCEPTED") {
          throw error;
        }
        return latest;
      }
      // A deferred row whose local validation/signing still cannot proceed must
      // remain in the deferred sweep. Configuration can be corrected without
      // converting the recoverable CDE into an operator-facing FAILED record.
      if (!transmissionClaimed && record.status === "SIGNED" && record.transmission_deferred_at) {
        throw error;
      }
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failureStored = transmissionClaimed
        ? await this.repo.updateDocumentMhResult(record.id, {
            status: "FAILED",
            sello: null,
            mhEstado: wompiBacked ? "PIPELINE_ERROR" : "ADVANCED_PIPELINE_ERROR",
            observaciones: [failureMessage],
            acceptedAt: null
          })
        : await this.repo.markDocumentPipelineFailure(record.id, {
            mhEstado: wompiBacked ? "PIPELINE_ERROR" : "ADVANCED_PIPELINE_ERROR",
            observaciones: [failureMessage]
          });
      if (!failureStored) {
        const current = await this.repo.getDteDocument(record.id);
        if (current) return current;
      }
      await this.repo.createAudit({
        action: wompiBacked ? "DTE_FAILED" : "ADVANCED_CDE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: failureMessage
      });
      await sendOperationalAlert(this.env, this.repo, {
        kind: wompiBacked ? "DTE_FAILED" : "ADVANCED_CDE_FAILED",
        title: wompiBacked ? "Fallo al emitir DTE" : "Fallo al emitir CDE avanzado",
        detail: `El documento ${record.numero_control} falló: ${failureMessage}`,
        entityType: "dte_document",
        entityId: record.id
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
    const staleBefore = new Date(Date.now() - DTE_TRANSMISSION_LEASE_MS).toISOString();
    const docs = await this.repo.listDeferredTransmissionDocuments(staleBefore);
    let transmitted = 0;
    let rejected = 0;
    let pending = 0;
    for (const record of docs) {
      // Cada documento se reintenta aislado: un fallo no debe abortar el barrido.
      try {
        const updated = await this.processDteDocument(record.id);
        if (updated.status === "ACCEPTED") {
          transmitted += 1;
        } else if (updated.status === "REJECTED") {
          rejected += 1;
        } else {
          pending += 1;
        }
      } catch (error) {
        // MH sigue sin responder (u otro fallo transitorio): el documento permanece
        // diferido (SIGNED + marcador) sin auditoría por tick — auditar cada reintento de un
        // cron de 15 minutos sería puro ruido. La visibilidad la da la alerta de
        // backlog de alertOnDeferredBacklog.
        if (!(error instanceof MhUnavailableError)) {
          console.error("Reintento de transmisión diferida falló", record.id, error);
        }
        pending += 1;
      }
    }
    await this.alertOnDeferredBacklog();
    return { transmitted, rejected, pending };
  }

  // Alerta operativa MH_UNAVAILABLE cuando algún CDE diferido lleva más de una hora
  // sin transmitirse. sendOperationalAlert dedupe por (kind, entityId): usar el id
  // del documento más antiguo la dispara UNA sola vez por atasco.
  private async alertOnDeferredBacklog(): Promise<void> {
    const staleBefore = new Date(Date.now() - DTE_TRANSMISSION_LEASE_MS).toISOString();
    const remaining = await this.repo.listDeferredTransmissionDocuments(staleBefore);
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
      entityId: overdue[0].id
    });
  }

  // Difiere la transmisión de un CDE ya firmado (forma normal). El donante recibe de
  // inmediato el comprobante TRANSITORIO — pdf.ts imprime "TRANSITORIO" como sello
  // cuando sello_recibido es null — y el cron reintenta la transmisión.
  private async deferTransmission(documentId: string, reason: string): Promise<DteDocumentRecord> {
    const deferred = await this.repo.markDocumentTransmissionDeferred(documentId, reason);
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

  // Resuelve la intención de donación de un documento respaldado por Wompi para
  // completarla cuando MH acepta el reintento. Documentos rápidos/avanzados no
  // tienen intención; fallos reales de lectura/correlación se propagan para que la
  // cola reintente la finalización sin retransmitir el CDE ya aceptado.
  private async correlateIntentForDocument(record: DteDocumentRecord): Promise<DonationIntentRecord | null> {
    if (!record.wompi_event_id) {
      return null;
    }
    const event = await this.repo.getWompiEventById(record.wompi_event_id);
    if (!event) {
      return null;
    }
    const correlation = await this.correlateIntent(
      normalizeWompiWebhook(JSON.parse(event.raw_body))
    );
    return correlation.kind === "ready" ? correlation.intent : null;
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

  private async completeIntent(intent: DonationIntentRecord, documentId: string): Promise<void> {
    const completed = await this.repo.getCompletedIntentForDocument(documentId);
    if (completed && completed.id !== intent.id) {
      throw new Error("El CDE ya está vinculado a otra intención completada");
    }
    if (!completed) {
      await this.repo.markIntentCompleted(intent.id, documentId);
    }
    await this.ensureIntentCompletionAudit(intent.id, documentId);
  }

  private async finalizeAcceptedWompiDocument(
    record: DteDocumentRecord,
    metadata?: unknown
  ): Promise<void> {
    await this.repo.createAuditIfAbsent({
      action: "DTE_ACCEPTED",
      entityType: "dte_document",
      entityId: record.id,
      summary: `${record.numero_control} ${record.mh_estado ?? "PROCESADO"}`,
      metadata
    });

    const completed = await this.repo.getCompletedIntentForDocument(record.id);
    if (completed) {
      await this.ensureIntentCompletionAudit(completed.id, record.id);
    } else {
      const intent = await this.correlateIntentForDocument(record);
      if (intent) {
        await this.completeIntent(intent, record.id);
      }
    }

    await this.emailReceipt(record);
  }

  private async ensureIntentCompletionAudit(intentId: string, documentId: string): Promise<void> {
    await this.repo.createAuditIfAbsent({
      action: "DONATION_INTENT_COMPLETED",
      entityType: "donation_intent",
      entityId: intentId,
      summary: `Intención ${intentId} completada por el CDE ${documentId}`,
      metadata: { documentId }
    });
  }

  private async emailReceipt(record: DteDocumentRecord): Promise<void> {
    if (!record.donor_email) {
      await this.repo.createAudit({
        action: "EMAIL_SKIPPED",
        entityType: "dte_document",
        entityId: record.id,
        summary: "Documento sin correo del donante"
      });
      return;
    }
    const emailType =
      record.status === "SIGNED" && record.transmission_deferred_at
        ? "dteReceiptTransitorio"
        : "dteReceipt";
    const deliveryClaimId = await this.repo.claimEmailDelivery({
      documentId: record.id,
      toEmail: record.donor_email,
      emailType,
      documentStatusAtSend: record.status
    });
    if (!deliveryClaimId) {
      return;
    }

    let response: EmailDeliveryResult;
    try {
      const templates = parseEmailTemplates(await this.repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
      const branding = await loadEmailBranding(this.repo, this.env);
      response = await new EmailService(this.env, templates, branding).sendReceipt(record, record.donor_email);
    } catch (error) {
      await this.repo.finalizeEmailDeliveryClaim(deliveryClaimId, {
        status: "FAILED",
        providerResponse: { error: error instanceof Error ? error.message : String(error) },
        emailType,
        documentStatusAtSend: record.status
      });
      await this.repo.createAudit({
        action: "EMAIL_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    await this.repo.finalizeEmailDeliveryClaim(deliveryClaimId, {
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
    await this.repo.createAudit({
      action: "EMAIL_SENT",
      entityType: "dte_document",
      entityId: record.id,
      summary: `Comprobante enviado a ${record.donor_email}`,
      metadata: response
    });
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

function mhResponseFromDocument(record: DteDocumentRecord): MhResponse {
  if (record.status === "SIGNED" && record.transmission_deferred_at) {
    return {
      accepted: false,
      estado: "TRANSMISION_DIFERIDA",
      selloRecibido: null,
      observaciones: parseMhObservaciones(record.mh_observaciones_json),
      raw: { deferred: true }
    };
  }
  return {
    accepted: record.status === "ACCEPTED",
    estado: record.mh_estado ?? record.status,
    selloRecibido: record.sello_recibido,
    observaciones: parseMhObservaciones(record.mh_observaciones_json),
    raw: { stored: true }
  };
}

function parseMhObservaciones(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
