import { getEmisorConfig, getMhCertificateXml, requireSecret } from "../config";
import { buildCdeDocument, buildContingenciaEvent, cdeDocumentSummary } from "../domain/dteBuilder";
import { signMhDocument } from "../domain/signer";
import { amountCents, donorName, isApprovedDonation, normalizeWompiWebhook } from "../domain/wompi";
import { Repository } from "../storage/repository";
import type { ContingencyBatchRecord, ContingencyBatchLineRecord, DteDocumentRecord, Env, WompiWebhook } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { EmailService } from "./email";
import { EMAIL_TEMPLATES_SETTING_KEY, parseEmailTemplates } from "./emailTemplates";
import { MhClient, MhUnavailableError } from "./mhClient";

export class IssuancePipeline {
  private readonly repo: Repository;
  private readonly mh: MhClient;

  constructor(private readonly env: Env) {
    this.repo = new Repository(env.DB);
    this.mh = new MhClient(env);
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
    const sequence = await this.repo.nextControlSequence(environment, config.controlPrefix);
    const normalDocument = buildCdeDocument(payload, config, { sequence, environment });
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
        await this.emailReceipt(record);
      }
      return record;
    } catch (error) {
      if (error instanceof MhUnavailableError) {
        return this.moveToContingency(record, payload, sequence, String(error.message));
      }
      await this.repo.updateDocumentMhResult(record.id, {
        status: "FAILED",
        sello: null,
        mhEstado: "PIPELINE_ERROR",
        observaciones: [error instanceof Error ? error.message : String(error)]
      });
      await this.repo.createAudit({
        action: "DTE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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
      await this.repo.createAudit({
        action: "ADVANCED_CDE_FAILED",
        entityType: "dte_document",
        entityId: record.id,
        summary: error instanceof Error ? error.message : String(error)
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

  private async moveToContingency(record: DteDocumentRecord, payload: WompiWebhook, sequence: number, reason: string): Promise<DteDocumentRecord> {
    const config = getEmisorConfig(this.env);
    const contingencyDocument = buildCdeDocument(payload, config, { sequence, environment: record.environment, contingency: true });
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
    await this.emailReceipt(updated);
    return updated;
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
