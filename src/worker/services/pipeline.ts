import { getEmisorConfig, getMhCertificateXml, requireSecret } from "../config";
import { buildCdeDocument, buildContingenciaEvent, cdeDocumentSummary } from "../domain/dteBuilder";
import type { IntentDonorOverride } from "../domain/dteBuilder";
import { signMhDocument } from "../domain/signer";
import { amountCents, donorName, isApprovedDonation, normalizeWompiWebhook } from "../domain/wompi";
import { Repository } from "../storage/repository";
import type { ContingencyBatchRecord, ContingencyBatchLineRecord, DonationIntentRecord, DteDocumentRecord, Env, MhResponse, WompiWebhook } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { sendOperationalAlert } from "./alerts";
import { EmailService } from "./email";
import { EMAIL_TEMPLATES_SETTING_KEY, parseEmailTemplates } from "./emailTemplates";
import { MhClient, MhUnavailableError } from "./mhClient";

const STALLED_WOMPI_EVENT_AGE_MS = 60 * 60 * 1000;
const MAX_WOMPI_EVENT_REQUEUES = 3;

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
      const requeues = await this.repo.countAuditEntries("WOMPI_EVENT_REQUEUED", eventId);
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
      await this.env.ISSUANCE_QUEUE.send({ wompiEventId: eventId });
      await this.repo.createAudit({
        action: "WOMPI_EVENT_REQUEUED",
        entityType: "wompi_event",
        entityId: eventId,
        summary: "Reencolado por barrido: donación aprobada sin CDE después de una hora"
      });
    }
  }

  async processWompiEvent(wompiEventId: string): Promise<DteDocumentRecord | null> {
    const event = await this.repo.getWompiEventById(wompiEventId);
    if (!event) {
      throw new Error(`Evento Wompi ${wompiEventId} no encontrado`);
    }
    const existing = await this.repo.getDteDocumentByWompiEvent(wompiEventId);
    if (existing) {
      return existing;
    }
    const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
    if (!isApprovedDonation(payload)) {
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
    const intent = await this.correlateIntent(payload);
    const sequence = await this.repo.nextControlSequence(environment, config.controlPrefix);
    const normalDocument = buildCdeDocument(payload, config, { sequence, environment, donorOverride: intent ? donorOverrideFromIntent(intent, payload) : undefined });
    const identifiers = extractCdeIdentifiers(normalDocument);
    let record = await this.repo.createDteDocument({
      wompiEventId,
      environment,
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: normalDocument,
      donorEmail: payload.Cliente?.EMail ?? null,
      donorName: donorName(payload),
      amountCents: amountCents(payload),
      issuedAt: nowIso()
    });

    try {
      const signedJws = await signMhDocument(normalDocument, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
      await this.repo.updateDocumentSigned(record.id, signedJws);
      const mhResult = await this.mh.transmitDte({
        ambiente: environment,
        version: 2,
        tipoDte: "15",
        codigoGeneracion: identifiers.codigoGeneracion,
        signedJws
      });
      await this.repo.updateDocumentMhResult(record.id, {
        status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: mhResult.selloRecibido,
        mhEstado: mhResult.estado,
        observaciones: mhResult.observaciones,
        acceptedAt: mhResult.accepted ? nowIso() : null
      });
      record = (await this.repo.getDteDocument(record.id)) ?? record;
      await this.repo.createAudit({
        action: mhResult.accepted ? "DTE_ACCEPTED" : "DTE_REJECTED",
        entityType: "dte_document",
        entityId: record.id,
        summary: `${record.numero_control} ${mhResult.estado}`,
        metadata: mhResult.raw
      });
      if (mhResult.accepted) {
        if (intent) {
          await this.completeIntent(intent, record.id);
        }
        await this.emailReceipt(record);
      }
      return record;
    } catch (error) {
      if (error instanceof MhUnavailableError) {
        return this.moveToContingency(record, payload, sequence, String(error.message), intent);
      }
      await this.repo.updateDocumentMhResult(record.id, {
        status: "FAILED",
        sello: null,
        mhEstado: "PIPELINE_ERROR",
        observaciones: [error instanceof Error ? error.message : String(error)]
      });
      const failureMessage = error instanceof Error ? error.message : String(error);
      await this.repo.createAudit({
        action: "DTE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: failureMessage
      });
      await sendOperationalAlert(this.env, this.repo, {
        kind: "DTE_FAILED",
        title: "Fallo al emitir DTE",
        detail: `El documento ${record.numero_control} falló: ${failureMessage}`,
        entityType: "dte_document",
        entityId: record.id
      });
      throw error;
    }
  }

  // A REJECTED verdict is MH's judgment on the document CONTENT: retransmitting
  // the same signed JWS can only be rejected identically. Retrying a rejected
  // Wompi CDE therefore rebuilds it from the original webhook (fresh
  // codigoGeneracion and numeroControl, re-signed) before transmitting again.
  async rebuildRejectedWompiDocument(record: DteDocumentRecord): Promise<MhResponse> {
    if (!record.wompi_event_id) {
      throw new Error("El documento no proviene de un evento Wompi");
    }
    const event = await this.repo.getWompiEventById(record.wompi_event_id);
    if (!event) {
      throw new Error(`Evento Wompi ${record.wompi_event_id} no encontrado`);
    }
    const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
    const config = getEmisorConfig(this.env);
    // Re-apply the same intent correlation as processWompiEvent: without it, an
    // operator retry would silently downgrade a rejected intent-backed CDE to the
    // raw-webhook fallback donor data.
    const intent = await this.correlateIntent(payload);
    const sequence = await this.repo.nextControlSequence(record.environment, config.controlPrefix);
    const rebuilt = buildCdeDocument(payload, config, { sequence, environment: record.environment, donorOverride: intent ? donorOverrideFromIntent(intent, payload) : undefined });
    const identifiers = extractCdeIdentifiers(rebuilt);
    const signedJws = await signMhDocument(rebuilt, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
    await this.repo.replaceDocumentPayload(record.id, {
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: rebuilt,
      signedJws,
      status: "SIGNED"
    });
    const mhResult = await this.mh.transmitDte({
      ambiente: record.environment,
      version: 2,
      tipoDte: "15",
      codigoGeneracion: identifiers.codigoGeneracion,
      signedJws
    });
    await this.repo.updateDocumentMhResult(record.id, {
      status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
      sello: mhResult.selloRecibido,
      mhEstado: mhResult.estado,
      observaciones: mhResult.observaciones,
      acceptedAt: mhResult.accepted ? nowIso() : null
    });
    const updated = (await this.repo.getDteDocument(record.id)) ?? record;
    await this.repo.createAudit({
      action: mhResult.accepted ? "DTE_ACCEPTED" : "DTE_REJECTED",
      entityType: "dte_document",
      entityId: updated.id,
      summary: `${updated.numero_control} ${mhResult.estado} (reconstruido)`,
      metadata: mhResult.raw
    });
    if (mhResult.accepted) {
      if (intent) {
        await this.completeIntent(intent, updated.id);
      }
      await this.emailReceipt(updated);
    }
    return mhResult;
  }

  async processDteDocument(documentId: string): Promise<DteDocumentRecord> {
    let record = await this.repo.getDteDocument(documentId);
    if (!record) {
      throw new Error(`Documento DTE ${documentId} no encontrado`);
    }
    const document = JSON.parse(record.plain_json) as Record<string, unknown>;
    const summary = cdeDocumentSummary(document);
    try {
      const signedJws = record.signed_jws ?? await signMhDocument(document, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
      if (!record.signed_jws) {
        await this.repo.updateDocumentSigned(record.id, signedJws);
      }
      const mhResult = await this.mh.transmitDte({
        ambiente: summary.environment,
        version: 2,
        tipoDte: "15",
        codigoGeneracion: summary.codigoGeneracion,
        signedJws
      });
      await this.repo.updateDocumentMhResult(record.id, {
        status: mhResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: mhResult.selloRecibido,
        mhEstado: mhResult.estado,
        observaciones: mhResult.observaciones,
        acceptedAt: mhResult.accepted ? nowIso() : null
      });
      record = (await this.repo.getDteDocument(record.id)) ?? record;
      await this.repo.createAudit({
        action: mhResult.accepted ? "ADVANCED_CDE_ACCEPTED" : "ADVANCED_CDE_REJECTED",
        entityType: "dte_document",
        entityId: record.id,
        summary: `${record.numero_control} ${mhResult.estado}`,
        metadata: mhResult.raw
      });
      if (mhResult.accepted) {
        await this.emailReceipt(record);
      }
      return record;
    } catch (error) {
      await this.repo.updateDocumentMhResult(record.id, {
        status: "FAILED",
        sello: null,
        mhEstado: "ADVANCED_PIPELINE_ERROR",
        observaciones: [error instanceof Error ? error.message : String(error)]
      });
      const failureMessage = error instanceof Error ? error.message : String(error);
      await this.repo.createAudit({
        action: "ADVANCED_CDE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: failureMessage
      });
      await sendOperationalAlert(this.env, this.repo, {
        kind: "ADVANCED_CDE_FAILED",
        title: "Fallo al emitir CDE avanzado",
        detail: `El documento ${record.numero_control} falló: ${failureMessage}`,
        entityType: "dte_document",
        entityId: record.id
      });
      throw error;
    }
  }

  async runContingencySweep(): Promise<{ transmitted: number; periodId: string | null }> {
    const open = await this.repo.getOpenContingency();
    if (!open) {
      return { transmitted: 0, periodId: null };
    }
    const periodId = String(open.id);
    const docs = await this.repo.listContingencyDocuments(periodId);
    if (docs.length === 0) {
      await this.repo.closeContingency(periodId);
      return { transmitted: 0, periodId };
    }
    const config = getEmisorConfig(this.env);

    if (!open.event_sello || !open.event_id) {
      const startedAt = new Date(String(open.started_at));
      const endedAt = new Date();
      const eventDocument = buildContingenciaEvent(config, {
        ambiente: docs[0].environment,
        documents: docs.map((document) => ({ codigoGeneracion: document.codigo_generacion, tipoDoc: document.tipo_dte })),
        startedAt,
        endedAt,
        tipoContingencia: Number(open.tipo_contingencia ?? 1),
        motivoContingencia: String(open.reason)
      });
      const eventJws = await signMhDocument(eventDocument, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
      const eventId = await this.repo.createDteEvent({
        documentId: null,
        eventType: "CONTINGENCIA",
        environment: docs[0].environment,
        codigoGeneracion: extractEventGenerationCode(eventDocument),
        plainJson: eventDocument,
        signedJws: eventJws
      });
      const eventResult = await this.mh.transmitContingencia({ ambiente: docs[0].environment, signedJws: eventJws });
      await this.repo.updateDteEventResult(eventId, {
        status: eventResult.accepted ? "ACCEPTED" : "REJECTED",
        sello: eventResult.selloRecibido,
        mhEstado: eventResult.estado,
        observaciones: eventResult.observaciones,
        acceptedAt: eventResult.accepted ? nowIso() : null
      });
      if (!eventResult.accepted) {
        return { transmitted: 0, periodId };
      }
      await this.repo.markContingencyEventAccepted(periodId, { eventId, sello: eventResult.selloRecibido, deadlineAt: addHours(nowIso(), 72) });
    }

    await this.ensureContingencyBatches(periodId, docs);
    const batches = await this.repo.listContingencyBatches(periodId);
    for (const batch of batches.filter((item) => ["DRAFT", "FAILED"].includes(item.status))) {
      await this.submitContingencyBatch(batch, config.numDocumento);
    }

    let transmitted = 0;
    for (const batch of await this.repo.listContingencyBatches(periodId)) {
      if (batch.codigo_lote && !["DONE", "PARTIAL", "REJECTED"].includes(batch.status)) {
        transmitted += await this.pollContingencyBatch(batch);
      }
    }

    const remaining = await this.repo.listContingencyDocuments(periodId);
    if (remaining.length === 0) {
      await this.repo.closeContingency(periodId);
    }
    return { transmitted, periodId };
  }

  private async ensureContingencyBatches(periodId: string, docs: DteDocumentRecord[]): Promise<void> {
    const existingLines = await this.repo.listContingencyBatchLines({ periodId });
    const batchedDocumentIds = new Set(existingLines.map((line) => line.document_id));
    const candidates = docs.filter((document) => document.signed_jws && !batchedDocumentIds.has(document.id));
    for (const chunk of chunks(candidates, 100)) {
      await this.repo.createContingencyBatch({
        periodId,
        environment: chunk[0].environment,
        idEnvio: crypto.randomUUID().toUpperCase(),
        documents: chunk
      });
    }
  }

  private async submitContingencyBatch(batch: ContingencyBatchRecord, nitEmisor: string): Promise<void> {
    const lines = await this.repo.listContingencyBatchLines({ batchId: batch.id });
    const documentos = lines.map((line) => line.signed_jws).filter((jws): jws is string => Boolean(jws));
    if (!documentos.length) {
      await this.repo.markContingencyBatchFailed(batch.id, "El lote no tiene CDE firmados.");
      return;
    }
    const request = {
      ambiente: batch.environment,
      idEnvio: batch.id_envio,
      version: 2,
      nitEmisor: normalizeNit(nitEmisor),
      documentos
    };
    const result = await this.mh.transmitLote(request);
    if (!result.accepted || !result.codigoLote) {
      await this.repo.markContingencyBatchFailed(batch.id, result.observaciones.join("; ") || result.estado, result.raw);
      return;
    }
    await this.repo.markContingencyBatchSubmitted(batch.id, {
      codigoLote: result.codigoLote,
      request,
      response: result.raw
    });
    await this.repo.createAudit({
      action: "CONTINGENCY_BATCH_SUBMITTED",
      entityType: "contingency_period",
      entityId: batch.contingency_period_id,
      summary: `${result.codigoLote} ${documentos.length} CDE`,
      metadata: result.raw
    });
  }

  private async pollContingencyBatch(batch: ContingencyBatchRecord): Promise<number> {
    if (!batch.codigo_lote) {
      return 0;
    }
    const result = await this.mh.consultarLote({ ambiente: batch.environment, codigoLote: batch.codigo_lote });
    const lines = await this.repo.listContingencyBatchLines({ batchId: batch.id });
    const linesByGeneration = new Map(lines.map((line) => [line.codigo_generacion, line]));
    let accepted = 0;
    for (const item of result.procesados) {
      const line = linesByGeneration.get(String(item.codigoGeneracion ?? ""));
      if (!line || line.status === "ACCEPTED") {
        continue;
      }
      await this.repo.markContingencyBatchLineAccepted({
        lineId: line.id,
        documentId: line.document_id,
        sello: stringValue(item.selloRecibido),
        mhEstado: stringValue(item.estado) ?? result.estado,
        observaciones: arrayStrings(item.observaciones),
        response: item
      });
      accepted += 1;
      await this.repo.createAudit({
        action: "CONTINGENCY_DTE_ACCEPTED",
        entityType: "dte_document",
        entityId: line.document_id,
        summary: stringValue(item.estado) ?? result.estado,
        metadata: item
      });
    }
    for (const item of result.rechazados) {
      const line = linesByGeneration.get(String(item.codigoGeneracion ?? ""));
      if (!line || line.status === "REJECTED") {
        continue;
      }
      const observaciones = arrayStrings(item.observaciones);
      const message = observaciones.join("; ") || stringValue(item.descripcionMsg) || "El Ministerio de Hacienda rechazó el CDE en lote.";
      await this.repo.markContingencyBatchLineRejected({
        lineId: line.id,
        documentId: line.document_id,
        mhEstado: stringValue(item.estado) ?? "RECHAZADO",
        observaciones,
        message
      });
      await this.repo.createAudit({
        action: "CONTINGENCY_DTE_REJECTED",
        entityType: "dte_document",
        entityId: line.document_id,
        summary: message,
        metadata: item
      });
    }
    if (!result.procesados.length && !result.rechazados.length) {
      await this.repo.markContingencyBatchProcessing(batch.id, result.raw);
    } else {
      await this.repo.syncContingencyBatchCounts(batch.id);
    }
    return accepted;
  }

  private async moveToContingency(record: DteDocumentRecord, payload: WompiWebhook, sequence: number, reason: string, intent?: DonationIntentRecord | null): Promise<DteDocumentRecord> {
    const config = getEmisorConfig(this.env);
    // Preserve the donor override so a contingency rebuild never downgrades an
    // intent-backed CDE to fallback donor data. The intent stays LINK_CREATED/EXPIRED
    // — it is only marked COMPLETED once MH actually accepts (contingency sweep).
    const contingencyDocument = buildCdeDocument(payload, config, {
      sequence,
      environment: record.environment,
      contingency: true,
      donorOverride: intent ? donorOverrideFromIntent(intent, payload) : undefined
    });
    const identifiers = extractCdeIdentifiers(contingencyDocument);
    const signedJws = await signMhDocument(contingencyDocument, getMhCertificateXml(this.env), requireSecret(this.env, "MH_CERT_PASSWORD"));
    await this.repo.replaceDocumentPayload(record.id, {
      codigoGeneracion: identifiers.codigoGeneracion,
      numeroControl: identifiers.numeroControl,
      plainJson: contingencyDocument,
      signedJws,
      status: "SIGNED"
    });
    const periodId = await this.repo.openContingency(record.environment, reason);
    await this.repo.attachDocumentToContingency(record.id, periodId);
    const updated = (await this.repo.getDteDocument(record.id)) ?? record;
    await this.repo.createAudit({
      action: "DTE_CONTINGENCY_PENDING",
      entityType: "dte_document",
      entityId: updated.id,
      summary: reason,
      metadata: { contingencyPeriodId: periodId }
    });
    await sendOperationalAlert(this.env, this.repo, {
      kind: "CONTINGENCY_OPENED",
      title: "Contingencia abierta",
      detail: `Se abrió un período de contingencia automáticamente: ${reason}`,
      entityType: "contingency_period",
      entityId: periodId
    });
    await this.emailReceipt(updated);
    return updated;
  }

  // Resolve the donation intent this payment fulfills, or null for legacy/static-link
  // payments. The intent id doubles as identificadorEnlaceComercio on the minted link
  // (payload.IdExterno), with the raw enlace identifier as a fallback source. Only ids
  // that look like an intent id ("di_" prefix) are looked up, so legacy static-link
  // payloads skip the query entirely. LINK_CREATED and EXPIRED both correlate — a donor
  // can pay in the link's final minute after our sweep expired the intent — but a
  // COMPLETED intent must NOT correlate twice (a replayed webhook falls back to
  // non-intent behavior; processWompiEvent is already idempotent per event).
  private async correlateIntent(payload: WompiWebhook): Promise<DonationIntentRecord | null> {
    const intentId = payload.IdExterno ?? payload.EnlacePago?.IdentificadorEnlaceComercio;
    if (!intentId || !intentId.startsWith("di_")) {
      return null;
    }
    const intent = await this.repo.getDonationIntent(intentId);
    if (!intent || (intent.status !== "LINK_CREATED" && intent.status !== "EXPIRED")) {
      return null;
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
    return intent;
  }

  private async completeIntent(intent: DonationIntentRecord, documentId: string): Promise<void> {
    await this.repo.markIntentCompleted(intent.id, documentId);
    await this.repo.createAudit({
      action: "DONATION_INTENT_COMPLETED",
      entityType: "donation_intent",
      entityId: intent.id,
      summary: `Intención ${intent.id} completada por el CDE ${documentId}`,
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
    try {
      const templates = parseEmailTemplates(await this.repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
      const response = await new EmailService(this.env, templates).sendReceipt(record, record.donor_email);
      await this.repo.recordEmailDelivery({
        documentId: record.id,
        toEmail: record.donor_email,
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
    } catch (error) {
      await this.repo.recordEmailDelivery({
        documentId: record.id,
        toEmail: record.donor_email,
        status: "FAILED",
        providerResponse: { error: error instanceof Error ? error.message : String(error) }
      });
      await this.repo.createAudit({
        action: "EMAIL_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

// Merge the correlated intent with the payment webhook into the CDE receptor:
// identity (tipoDocumento/numDocumento) and the catalog-coded direccion come from the
// intent (validated on the /donar form); nombre and correo come from the WEBHOOK,
// because the donor types those on Wompi's hosted sheet and the intent no longer
// stores them. telefono prefers the intent's phone, else the webhook Celular. This
// keeps the canonical DUI and clean address while carrying the real donor contact.
function donorOverrideFromIntent(intent: DonationIntentRecord, payload: WompiWebhook): IntentDonorOverride {
  return {
    tipoDocumento: intent.donor_document_type,
    numDocumento: intent.donor_document,
    nombre: donorName(payload),
    correo: cleanNullable(payload.Cliente?.EMail),
    telefono: intent.donor_phone ?? cleanNullable(payload.Cliente?.Celular),
    direccion: {
      departamento: intent.direccion_departamento,
      municipio: intent.direccion_municipio,
      distrito: intent.direccion_distrito,
      complemento: intent.direccion_complemento
    }
  };
}

// Trim to null, mirroring dteBuilder's fallback normalization so an empty/whitespace
// webhook field becomes null rather than "" on the CDE receptor.
function cleanNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function extractCdeIdentifiers(document: Record<string, unknown>): { codigoGeneracion: string; numeroControl: string } {
  const identificacion = document.identificacion as { codigoGeneracion: string; numeroControl: string };
  return {
    codigoGeneracion: identificacion.codigoGeneracion,
    numeroControl: identificacion.numeroControl
  };
}

function extractEventGenerationCode(document: Record<string, unknown>): string {
  return (document.identificacion as { codigoGeneracion: string }).codigoGeneracion;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function normalizeNit(value: string): string {
  return value.replace(/\D/g, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
