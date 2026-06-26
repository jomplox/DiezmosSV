import { getEmisorConfig, getMhCertificateXml, requireSecret } from "../config";
import { buildCdeDocument, buildContingenciaEvent, cdeDocumentSummary } from "../domain/dteBuilder";
import { signMhDocument } from "../domain/signer";
import { amountCents, ambienteFromWompi, donorName, isApprovedDonation } from "../domain/wompi";
import { Repository } from "../storage/repository";
import type { DteDocumentRecord, Env, WompiWebhook } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { EmailService } from "./email";
import { MhClient, MhUnavailableError } from "./mhClient";

export class IssuancePipeline {
  private readonly repo: Repository;
  private readonly mh: MhClient;
  private readonly email: EmailService;

  constructor(private readonly env: Env) {
    this.repo = new Repository(env.DB);
    this.mh = new MhClient(env);
    this.email = new EmailService(env);
  }

  async processWompiEvent(wompiEventId: string): Promise<DteDocumentRecord | null> {
    const event = await this.repo.getWompiEventById(wompiEventId);
    if (!event) {
      throw new Error(`Wompi event ${wompiEventId} not found`);
    }
    const existing = await this.repo.getDteDocumentByWompiEvent(wompiEventId);
    if (existing) {
      return existing;
    }
    const payload = JSON.parse(event.raw_body) as WompiWebhook;
    if (!isApprovedDonation(payload)) {
      await this.repo.createAudit({
        action: "WOMPI_IGNORED",
        entityType: "wompi_event",
        entityId: wompiEventId,
        summary: `Ignored Wompi result ${payload.ResultadoTransaccion}`
      });
      return null;
    }

    const config = getEmisorConfig(this.env);
    const environment = ambienteFromWompi(payload);
    const sequence = await this.repo.nextControlSequence(environment, config.controlPrefix);
    const normalDocument = buildCdeDocument(payload, config, { sequence });
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
      throw new Error(`DTE document ${documentId} not found`);
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

    let transmitted = 0;
    for (const document of docs) {
      if (!document.signed_jws) {
        continue;
      }
      const result = await this.mh.transmitDte({
        ambiente: document.environment,
        version: 2,
        tipoDte: document.tipo_dte,
        codigoGeneracion: document.codigo_generacion,
        signedJws: document.signed_jws
      });
      await this.repo.updateDocumentMhResult(document.id, {
        status: result.accepted ? "ACCEPTED" : "REJECTED",
        sello: result.selloRecibido,
        mhEstado: result.estado,
        observaciones: result.observaciones,
        acceptedAt: result.accepted ? nowIso() : null
      });
      transmitted += result.accepted ? 1 : 0;
      await this.repo.createAudit({
        action: result.accepted ? "CONTINGENCY_DTE_ACCEPTED" : "CONTINGENCY_DTE_REJECTED",
        entityType: "dte_document",
        entityId: document.id,
        summary: result.estado,
        metadata: result.raw
      });
    }
    if (transmitted === docs.length) {
      await this.repo.closeContingency(periodId);
    }
    return { transmitted, periodId };
  }

  private async moveToContingency(record: DteDocumentRecord, payload: WompiWebhook, sequence: number, reason: string): Promise<DteDocumentRecord> {
    const config = getEmisorConfig(this.env);
    const contingencyDocument = buildCdeDocument(payload, config, { sequence, contingency: true });
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
        summary: "Document has no donor email"
      });
      return;
    }
    try {
      const response = await this.email.sendReceipt(record, record.donor_email);
      await this.repo.recordEmailDelivery({ documentId: record.id, toEmail: record.donor_email, status: "SENT", providerResponse: response });
      await this.repo.createAudit({
        action: "EMAIL_SENT",
        entityType: "dte_document",
        entityId: record.id,
        summary: `Receipt sent to ${record.donor_email}`,
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
