import type { Ambiente, ContingencyBatchLineRecord, ContingencyBatchRecord, DonationIntentRecord, DteDocumentRecord, WompiEventRecord, WompiPaymentLink, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { amountCents, donorName } from "../domain/wompi";

export interface DteDocumentListPage {
  documents: DteDocumentRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

interface DteDocumentCursor {
  createdAt: string;
  id: string;
}

export const RETENTION_PAGE_SIZE = 500;

export const RETENTION_WINDOWED_TABLES = ["dte_documents", "dte_events", "email_deliveries", "wompi_events", "audit_logs"] as const;
export type RetentionTable = (typeof RETENTION_WINDOWED_TABLES)[number];

export const RETENTION_SNAPSHOT_TABLES = ["contingency_periods", "contingency_batches", "contingency_batch_lines"] as const;
export type RetentionSnapshotTable = (typeof RETENTION_SNAPSHOT_TABLES)[number];

export interface RetentionCursor {
  createdAt: string;
  id: string;
}

// wompi_events has no created_at column — it records received_at instead
// (migrations/0001_init.sql). Every other windowed retention table uses created_at.
function retentionTimestampColumn(table: RetentionTable): "created_at" | "received_at" {
  return table === "wompi_events" ? "received_at" : "created_at";
}

export class Repository {
  constructor(private readonly db: D1Database) {}

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .bind(key, value, updatedBy ?? null, nowIso())
      .run();
  }

  async insertWompiEvent(payload: WompiWebhook, rawBody: string, headers: Record<string, string>, environment: Ambiente): Promise<{ record: WompiEventRecord; inserted: boolean }> {
    const existing = await this.getWompiEventByTransaction(payload.IdTransaccion);
    if (existing) {
      return { record: existing, inserted: false };
    }
    const id = newId("wompi");
    await this.db
      .prepare(
        `INSERT INTO wompi_events (
          id, transaction_id, environment, result, amount_cents, donor_email, donor_name, raw_body, headers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        payload.IdTransaccion,
        environment,
        payload.ResultadoTransaccion,
        amountCents(payload),
        payload.Cliente?.EMail ?? null,
        donorName(payload),
        rawBody,
        JSON.stringify(headers)
      )
      .run();
    const record = await this.getWompiEventById(id);
    if (!record) {
      throw new Error("No se pudo leer el evento Wompi creado");
    }
    return { record, inserted: true };
  }

  async getWompiEventById(id: string): Promise<WompiEventRecord | null> {
    return this.db.prepare("SELECT * FROM wompi_events WHERE id = ?").bind(id).first<WompiEventRecord>();
  }

  async getWompiEventByTransaction(transactionId: string): Promise<WompiEventRecord | null> {
    return this.db.prepare("SELECT * FROM wompi_events WHERE transaction_id = ?").bind(transactionId).first<WompiEventRecord>();
  }

  async createDonationIntent(input: {
    id: string;
    amountCents: number;
    donorName: string;
    donorDocumentType: "13" | "37";
    donorDocument: string;
    donorEmail: string;
    donorPhone: string | null;
    direccionDepartamento: string;
    direccionMunicipio: string;
    direccionDistrito: string;
    direccionComplemento: string;
    clientIp: string | null;
    expiresAt: string;
  }): Promise<DonationIntentRecord> {
    await this.db
      .prepare(
        `INSERT INTO donation_intents (
          id, status, amount_cents, donor_name, donor_document_type, donor_document, donor_email, donor_phone,
          direccion_departamento, direccion_municipio, direccion_distrito, direccion_complemento, client_ip, expires_at
        ) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.amountCents,
        input.donorName,
        input.donorDocumentType,
        input.donorDocument,
        input.donorEmail,
        input.donorPhone,
        input.direccionDepartamento,
        input.direccionMunicipio,
        input.direccionDistrito,
        input.direccionComplemento,
        input.clientIp,
        input.expiresAt
      )
      .run();
    const record = await this.getDonationIntent(input.id);
    if (!record) {
      throw new Error("No se pudo leer la intención de donación creada");
    }
    return record;
  }

  async getDonationIntent(id: string): Promise<DonationIntentRecord | null> {
    return this.db.prepare("SELECT * FROM donation_intents WHERE id = ?").bind(id).first<DonationIntentRecord>();
  }

  async attachIntentLink(id: string, link: WompiPaymentLink): Promise<void> {
    await this.db
      .prepare(
        `UPDATE donation_intents
         SET wompi_id_enlace = ?, wompi_url_enlace = ?, status = 'LINK_CREATED', updated_at = ?
         WHERE id = ?`
      )
      .bind(link.idEnlace, link.urlEnlace, nowIso(), id)
      .run();
  }

  async markIntentCompleted(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE donation_intents SET status = 'COMPLETED', updated_at = ? WHERE id = ?")
      .bind(nowIso(), id)
      .run();
  }

  // Bulk sweep of intents that were never paid: PENDING rows past their expiry
  // flip to EXPIRED. Filters on (status, expires_at) — the index added in 0009.
  async expirePendingIntentsBefore(nowIso: string): Promise<void> {
    await this.db
      .prepare("UPDATE donation_intents SET status = 'EXPIRED', updated_at = ? WHERE status = 'PENDING' AND expires_at < ?")
      .bind(nowIso, nowIso)
      .run();
  }

  // Per-IP throttle: counts intents created by one client_ip at or after sinceIso.
  async countRecentIntentsByIp(clientIp: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM donation_intents WHERE client_ip = ? AND created_at >= ?")
      .bind(clientIp, sinceIso)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async nextControlSequence(environment: Ambiente, controlPrefix: string): Promise<number> {
    await this.db
      .prepare("INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value) VALUES (?, ?, 1)")
      .bind(environment, controlPrefix)
      .run();
    const row = await this.db
      .prepare("UPDATE document_sequences SET next_value = next_value + 1 WHERE environment = ? AND control_prefix = ? RETURNING next_value - 1 AS value")
      .bind(environment, controlPrefix)
      .first<{ value: number }>();
    if (!row) {
      throw new Error("No se pudo asignar la secuencia de control");
    }
    return row.value;
  }

  async createDteDocument(input: {
    wompiEventId?: string | null;
    environment: Ambiente;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    donorEmail: string | null;
    donorName: string | null;
    amountCents: number;
    issuedAt: string;
    status?: string;
    contingencyPeriodId?: string | null;
  }): Promise<DteDocumentRecord> {
    const id = newId("dte");
    await this.db
      .prepare(
        `INSERT INTO dte_documents (
          id, wompi_event_id, environment, codigo_generacion, numero_control, status, plain_json,
          donor_email, donor_name, amount_cents, issued_at, contingency_period_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.wompiEventId ?? null,
        input.environment,
        input.codigoGeneracion,
        input.numeroControl,
        input.status ?? "PENDING",
        JSON.stringify(input.plainJson),
        input.donorEmail,
        input.donorName,
        input.amountCents,
        input.issuedAt,
        input.contingencyPeriodId ?? null
      )
      .run();
    if (input.wompiEventId) {
      await this.db.prepare("UPDATE wompi_events SET created_document_id = ?, processed_at = ? WHERE id = ?").bind(id, nowIso(), input.wompiEventId).run();
    }
    const record = await this.getDteDocument(id);
    if (!record) {
      throw new Error("No se pudo leer el documento DTE creado");
    }
    await this.indexDteDocument(record);
    return record;
  }

  async getDteDocument(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE id = ?").bind(id).first<DteDocumentRecord>();
  }

  async getDteDocumentByWompiEvent(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE wompi_event_id = ?").bind(id).first<DteDocumentRecord>();
  }

  async listDteDocuments(params: { status?: string | null; q?: string | null; limit?: number; cursor?: string | null } = {}): Promise<DteDocumentListPage> {
    const limit = normalizeDocumentListLimit(params.limit);
    const filters: string[] = [];
    const bindings: Array<string | number> = [];
    if (params.status) {
      filters.push("dte_documents.status = ?");
      bindings.push(params.status);
    }
    const ftsQuery = buildDteSearchQuery(params.q);
    if (ftsQuery) {
      filters.push("dte_document_search MATCH ?");
      bindings.push(ftsQuery);
    }
    const cursor = parseDocumentCursor(params.cursor);
    if (cursor) {
      filters.push("(dte_documents.created_at < ? OR (dte_documents.created_at = ? AND dte_documents.id < ?))");
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const from = ftsQuery
      ? "FROM dte_documents JOIN dte_document_search ON dte_document_search.document_id = dte_documents.id"
      : "FROM dte_documents";
    const rows = await this.db
      .prepare(`SELECT dte_documents.* ${from} ${where} ORDER BY dte_documents.created_at DESC, dte_documents.id DESC LIMIT ?`)
      .bind(...bindings, limit + 1)
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
    const documents = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      documents,
      hasMore,
      nextCursor: hasMore && documents.length > 0 ? encodeDocumentCursor(documents[documents.length - 1]) : null,
      limit
    };
  }

  async listAcceptedDteDocumentsForExport(): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE status = 'ACCEPTED' AND sello_recibido IS NOT NULL ORDER BY issued_at ASC")
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
  }

  // Keyset-paged read of ACCEPTED documents issued within [startIso, endIso) for the
  // annual donor certificate (Task 4). Mirrors the retention paged-read style: a
  // (issued_at, id) cursor bounds each page so a busy year is read in fixed chunks
  // rather than one unpaged scan. INVALIDATED (and every non-ACCEPTED) status is
  // excluded by the WHERE clause, matching the certificate's "accepted only" rule.
  async listAcceptedDocumentsInYear(
    range: { startIso: string; endIso: string },
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<DteDocumentRecord[]> {
    const conditions = ["status = 'ACCEPTED'", "issued_at >= ?", "issued_at < ?"];
    const bindings: Array<string | number> = [range.startIso, range.endIso];
    if (cursor) {
      conditions.push("(issued_at, id) > (?, ?)");
      bindings.push(cursor.issuedAt, cursor.id);
    }
    const rows = await this.db
      .prepare(`SELECT * FROM dte_documents WHERE ${conditions.join(" AND ")} ORDER BY issued_at ASC, id ASC LIMIT ?`)
      .bind(...bindings, limit)
      .all<DteDocumentRecord>();
    return rows.results ?? [];
  }

  async updateDocumentSigned(id: string, signedJws: string): Promise<void> {
    await this.db
      .prepare("UPDATE dte_documents SET signed_jws = ?, status = 'SIGNED', updated_at = ? WHERE id = ?")
      .bind(signedJws, nowIso(), id)
      .run();
  }

  async replaceDocumentPayload(id: string, input: { codigoGeneracion: string; numeroControl: string; plainJson: Record<string, unknown>; signedJws: string | null; status: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dte_documents
         SET codigo_generacion = ?, numero_control = ?, plain_json = ?, signed_jws = ?, status = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(input.codigoGeneracion, input.numeroControl, JSON.stringify(input.plainJson), input.signedJws, input.status, nowIso(), id)
      .run();
    await this.indexDteDocumentById(id);
  }

  async updateDocumentMhResult(id: string, result: { status: string; sello: string | null; mhEstado: string; observaciones: string[]; acceptedAt?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dte_documents
         SET status = ?, sello_recibido = ?, mh_estado = ?, mh_observaciones_json = ?, accepted_at = COALESCE(?, accepted_at), updated_at = ?
         WHERE id = ?`
      )
      .bind(result.status, result.sello, result.mhEstado, JSON.stringify(result.observaciones), result.acceptedAt ?? null, nowIso(), id)
      .run();
  }

  async markDocumentInvalidated(id: string): Promise<void> {
    await this.db.prepare("UPDATE dte_documents SET status = 'INVALIDATED', updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }

  async updateDocumentDonorEmail(id: string, email: string): Promise<void> {
    await this.db.prepare("UPDATE dte_documents SET donor_email = ?, updated_at = ? WHERE id = ?").bind(email, nowIso(), id).run();
    await this.indexDteDocumentById(id);
  }

  private async indexDteDocumentById(id: string): Promise<void> {
    const record = await this.getDteDocument(id);
    if (record) {
      await this.indexDteDocument(record);
    }
  }

  private async indexDteDocument(record: DteDocumentRecord): Promise<void> {
    await this.db.prepare("DELETE FROM dte_document_search WHERE document_id = ?").bind(record.id).run();
    await this.db
      .prepare(
        `INSERT INTO dte_document_search (
          document_id, codigo_generacion, codigo_generacion_compact, numero_control, numero_control_compact,
          numero_control_serial, donor_email, donor_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.codigo_generacion,
        compactSearchIdentifier(record.codigo_generacion),
        record.numero_control,
        compactSearchIdentifier(record.numero_control),
        controlSerial(record.numero_control),
        record.donor_email,
        record.donor_name
      )
      .run();
  }

  async createAudit(input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, summary, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("audit"),
        input.actorType ?? "SYSTEM",
        input.actorId ?? null,
        input.action,
        input.entityType,
        input.entityId,
        input.summary,
        JSON.stringify(input.metadata ?? {})
      )
      .run();
  }

  async listAudit(entityType?: string, entityId?: string): Promise<Array<Record<string, unknown>>> {
    if (entityType && entityId) {
      return this.db
        .prepare("SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(entityType, entityId)
        .all<Record<string, unknown>>()
        .then((result) => result.results ?? []);
    }
    return this.db
      .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100")
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async createDteEvent(input: {
    documentId: string | null;
    eventType: "INVALIDACION" | "CONTINGENCIA";
    environment: Ambiente;
    codigoGeneracion: string;
    plainJson: Record<string, unknown>;
    signedJws?: string | null;
    legalDeadlineAt?: string | null;
    createdBy?: string | null;
  }): Promise<string> {
    const id = newId("event");
    await this.db
      .prepare(
        `INSERT INTO dte_events (
          id, document_id, event_type, environment, codigo_generacion, status, plain_json, signed_jws, legal_deadline_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.documentId,
        input.eventType,
        input.environment,
        input.codigoGeneracion,
        input.signedJws ? "SIGNED" : "PENDING",
        JSON.stringify(input.plainJson),
        input.signedJws ?? null,
        input.legalDeadlineAt ?? null,
        input.createdBy ?? null
      )
      .run();
    return id;
  }

  async updateDteEventResult(id: string, result: { status: string; sello: string | null; mhEstado: string; observaciones: string[]; acceptedAt?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE dte_events
         SET status = ?, sello_recibido = ?, mh_estado = ?, mh_observaciones_json = ?, accepted_at = ?
         WHERE id = ?`
      )
      .bind(result.status, result.sello, result.mhEstado, JSON.stringify(result.observaciones), result.acceptedAt ?? null, id)
      .run();
  }

  async openContingency(environment: Ambiente, reason: string, tipoContingencia = 1): Promise<string> {
    const existing = await this.getOpenContingency(environment);
    if (existing) {
      return String(existing.id);
    }
    const id = newId("cont");
    await this.db
      .prepare(
        `INSERT INTO contingency_periods (id, environment, status, reason, tipo_contingencia, started_at)
         VALUES (?, ?, 'OPEN', ?, ?, ?)`
      )
      .bind(id, environment, reason, tipoContingencia, nowIso())
      .run();
    return id;
  }

  async getOpenContingency(environment?: Ambiente): Promise<Record<string, unknown> | null> {
    if (environment) {
      return this.db
        .prepare("SELECT * FROM contingency_periods WHERE environment = ? AND status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
        .bind(environment)
        .first<Record<string, unknown>>();
    }
    return this.db
      .prepare("SELECT * FROM contingency_periods WHERE status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
      .first<Record<string, unknown>>();
  }

  async listContingencyPeriods(limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare("SELECT * FROM contingency_periods ORDER BY started_at DESC LIMIT ?")
      .bind(Math.min(limit, 100))
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async listContingencyDocuments(periodId: string): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE contingency_period_id = ? AND status = 'CONTINGENCY_PENDING' ORDER BY created_at ASC")
      .bind(periodId)
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
  }

  async listContingencyBatches(periodId?: string): Promise<ContingencyBatchRecord[]> {
    if (periodId) {
      return this.db
        .prepare("SELECT * FROM contingency_batches WHERE contingency_period_id = ? ORDER BY created_at ASC")
        .bind(periodId)
        .all<ContingencyBatchRecord>()
        .then((result) => result.results ?? []);
    }
    return this.db
      .prepare("SELECT * FROM contingency_batches ORDER BY created_at DESC LIMIT 100")
      .all<ContingencyBatchRecord>()
      .then((result) => result.results ?? []);
  }

  async listContingencyBatchLines(input: { periodId?: string; batchId?: string } = {}): Promise<ContingencyBatchLineRecord[]> {
    if (input.batchId) {
      return this.db
        .prepare("SELECT * FROM contingency_batch_lines WHERE batch_id = ? ORDER BY line_no ASC")
        .bind(input.batchId)
        .all<ContingencyBatchLineRecord>()
        .then((result) => result.results ?? []);
    }
    if (input.periodId) {
      return this.db
        .prepare("SELECT * FROM contingency_batch_lines WHERE contingency_period_id = ? ORDER BY created_at ASC, line_no ASC")
        .bind(input.periodId)
        .all<ContingencyBatchLineRecord>()
        .then((result) => result.results ?? []);
    }
    return this.db
      .prepare("SELECT * FROM contingency_batch_lines ORDER BY created_at DESC LIMIT 500")
      .all<ContingencyBatchLineRecord>()
      .then((result) => result.results ?? []);
  }

  async createContingencyBatch(input: { periodId: string; environment: Ambiente; idEnvio: string; documents: DteDocumentRecord[] }): Promise<string> {
    const id = newId("batch");
    await this.db
      .prepare(
        `INSERT INTO contingency_batches (
          id, contingency_period_id, environment, id_envio, status, line_count, pending_count
        ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?)`
      )
      .bind(id, input.periodId, input.environment, input.idEnvio, input.documents.length, input.documents.length)
      .run();
    for (const [index, document] of input.documents.entries()) {
      await this.db
        .prepare(
          `INSERT INTO contingency_batch_lines (
            id, batch_id, contingency_period_id, document_id, line_no, status,
            codigo_generacion, tipo_dte, signed_jws
          ) VALUES (?, ?, ?, ?, ?, 'LOCAL_ISSUED', ?, ?, ?)`
        )
        .bind(
          newId("batch_line"),
          id,
          input.periodId,
          document.id,
          index + 1,
          document.codigo_generacion,
          document.tipo_dte,
          document.signed_jws
        )
        .run();
    }
    return id;
  }

  async markContingencyBatchSubmitted(batchId: string, input: { codigoLote: string; request: unknown; response: unknown }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_batches
         SET status = 'SUBMITTED', codigo_lote = ?, request_json = ?, response_json = ?, last_error = NULL,
             submitted_at = COALESCE(submitted_at, ?), updated_at = ?
         WHERE id = ?`
      )
      .bind(input.codigoLote, JSON.stringify(input.request), JSON.stringify(input.response), nowIso(), nowIso(), batchId)
      .run();
    await this.db
      .prepare("UPDATE contingency_batch_lines SET status = 'BATCH_SENT', updated_at = ? WHERE batch_id = ? AND status = 'LOCAL_ISSUED'")
      .bind(nowIso(), batchId)
      .run();
    await this.syncContingencyBatchCounts(batchId);
  }

  async markContingencyBatchProcessing(batchId: string, response: unknown): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_batches
         SET status = 'PROCESSING', response_json = ?, last_polled_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(JSON.stringify(response), nowIso(), nowIso(), batchId)
      .run();
    await this.syncContingencyBatchCounts(batchId, "PROCESSING");
  }

  async markContingencyBatchFailed(batchId: string, message: string, response?: unknown): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_batches
         SET status = 'FAILED', response_json = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(JSON.stringify(response ?? { error: message }), message, nowIso(), batchId)
      .run();
  }

  async markContingencyBatchLineAccepted(input: { lineId: string; documentId: string; sello: string | null; mhEstado: string; observaciones: string[]; response: unknown }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_batch_lines
         SET status = 'ACCEPTED', sello_recibido = ?, mh_estado = ?, mh_observaciones_json = ?,
             last_error = NULL, updated_at = ?
         WHERE id = ?`
      )
      .bind(input.sello, input.mhEstado, JSON.stringify(input.observaciones), nowIso(), input.lineId)
      .run();
    await this.updateDocumentMhResult(input.documentId, {
      status: "ACCEPTED",
      sello: input.sello,
      mhEstado: input.mhEstado,
      observaciones: input.observaciones,
      acceptedAt: nowIso()
    });
  }

  async markContingencyBatchLineRejected(input: { lineId: string; documentId: string; mhEstado: string; observaciones: string[]; message: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_batch_lines
         SET status = 'REJECTED', mh_estado = ?, mh_observaciones_json = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(input.mhEstado, JSON.stringify(input.observaciones), input.message, nowIso(), input.lineId)
      .run();
    await this.updateDocumentMhResult(input.documentId, {
      status: "REJECTED",
      sello: null,
      mhEstado: input.mhEstado,
      observaciones: input.observaciones.length ? input.observaciones : [input.message]
    });
  }

  async syncContingencyBatchCounts(batchId: string, forcedStatus?: string): Promise<void> {
    const lines = await this.listContingencyBatchLines({ batchId });
    const accepted = lines.filter((line) => line.status === "ACCEPTED").length;
    const rejected = lines.filter((line) => line.status === "REJECTED" || line.status === "MANUAL_REVIEW").length;
    const pending = Math.max(lines.length - accepted - rejected, 0);
    const status = forcedStatus ?? (pending > 0 ? "PROCESSING" : rejected > 0 ? (accepted > 0 ? "PARTIAL" : "REJECTED") : "DONE");
    await this.db
      .prepare(
        `UPDATE contingency_batches
         SET status = ?, line_count = ?, accepted_count = ?, rejected_count = ?, pending_count = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(status, lines.length, accepted, rejected, pending, nowIso(), batchId)
      .run();
  }

  async attachDocumentToContingency(documentId: string, periodId: string): Promise<void> {
    await this.db
      .prepare("UPDATE dte_documents SET status = 'CONTINGENCY_PENDING', contingency_period_id = ?, updated_at = ? WHERE id = ?")
      .bind(periodId, nowIso(), documentId)
      .run();
  }

  async markContingencyEventAccepted(periodId: string, input: { eventId: string; sello: string | null; deadlineAt: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE contingency_periods
         SET status = 'EVENT_ACCEPTED', event_id = ?, event_sello = ?, transmit_deadline_at = ?
         WHERE id = ?`
      )
      .bind(input.eventId, input.sello, input.deadlineAt, periodId)
      .run();
  }

  async listDteEventsByType(eventType: "INVALIDACION" | "CONTINGENCIA", limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare(
        `SELECT id, document_id, event_type, environment, codigo_generacion, status, sello_recibido,
                mh_estado, mh_observaciones_json, legal_deadline_at, created_by, created_at, accepted_at
         FROM dte_events
         WHERE event_type = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(eventType, Math.min(limit, 100))
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async closeContingency(periodId: string): Promise<void> {
    await this.db
      .prepare("UPDATE contingency_periods SET status = 'CLOSED', ended_at = COALESCE(ended_at, ?) WHERE id = ?")
      .bind(nowIso(), periodId)
      .run();
  }

  async recordEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    status: "SENT" | "FAILED";
    providerResponse?: unknown;
    emailType?: string | null;
    documentStatusAtSend?: string | null;
    templateVersion?: string | null;
    pdfRendererVersion?: string | null;
    pdfSha256?: string | null;
    dteJsonSha256?: string | null;
    providerDeliveryId?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO email_deliveries (
           id, document_id, to_email, status, provider_response_json, sent_at,
           email_type, document_status_at_send, template_version, pdf_renderer_version,
           pdf_sha256, dte_json_sha256, provider_delivery_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("email"),
        input.documentId,
        input.toEmail,
        input.status,
        JSON.stringify(input.providerResponse ?? {}),
        input.status === "SENT" ? nowIso() : null,
        input.emailType ?? null,
        input.documentStatusAtSend ?? null,
        input.templateVersion ?? null,
        input.pdfRendererVersion ?? null,
        input.pdfSha256 ?? null,
        input.dteJsonSha256 ?? null,
        input.providerDeliveryId ?? null
      )
      .run();
  }

  async listUsers(): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 100")
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async countUsers(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    return row?.count ?? 0;
  }

  async createUser(input: { email: string; name: string; role: string; passwordHash: string; passwordSalt: string }): Promise<Record<string, unknown>> {
    const id = newId("user");
    await this.db
      .prepare("INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, input.email.toLowerCase(), input.name, input.role, input.passwordHash, input.passwordSalt)
      .run();
    const user = await this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!user) {
      throw new Error("No se pudo leer el usuario creado");
    }
    return user;
  }

  async getUserForLogin(email: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare("SELECT id, email, name, role, password_hash, password_salt, disabled_at FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first<Record<string, string>>();
  }

  async createSession(userId: string, tokenHash: string, expiresAt: string): Promise<string> {
    const id = newId("session");
    await this.db
      .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(id, userId, tokenHash, expiresAt)
      .run();
    return id;
  }

  async getSessionUser(tokenHash: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare(
        `SELECT users.id, users.email, users.name, users.role
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ?
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > ?
           AND users.disabled_at IS NULL`
      )
      .bind(tokenHash, nowIso())
      .first<Record<string, string>>();
  }

  async updateUser(id: string, input: { role?: string; disabled?: boolean; name?: string; email?: string }): Promise<Record<string, unknown>> {
    const existing = await this.db.prepare("SELECT id, email, name, role, disabled_at FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!existing) {
      throw new Error("Usuario no encontrado");
    }
    await this.db
      .prepare("UPDATE users SET name = ?, email = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")
      .bind(
        input.name ?? existing.name,
        String(input.email ?? existing.email).toLowerCase(),
        input.role ?? existing.role,
        input.disabled === undefined ? existing.disabled_at : input.disabled ? nowIso() : null,
        nowIso(),
        id
      )
      .run();
    const updated = await this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!updated) {
      throw new Error("No se pudo leer el usuario actualizado");
    }
    return updated;
  }

  async listStalledApprovedWompiEvents(cutoffIso: string): Promise<Array<Record<string, unknown>>> {
    // wompi_events has no created_at column — it records received_at (migrations/0001_init.sql).
    const rows = await this.db
      .prepare(
        `SELECT id, transaction_id, received_at FROM wompi_events
         WHERE created_document_id IS NULL
           AND processed_at IS NULL
           AND result = 'ExitosaAprobada'
           AND received_at < ?`
      )
      .bind(cutoffIso)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  async countAuditEntries(action: string, entityId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?")
      .bind(action, entityId)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  // Windowed variant for the auth rate limiter: counts (action, entity_id) audits
  // whose created_at is at or after `sinceIso`. Reads use the (action, entity_id,
  // created_at) index added in migration 0008.
  async countAuditEntriesSince(action: string, entityId: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ? AND created_at >= ?")
      .bind(action, entityId, sinceIso)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  // Paged reads for the monthly legal-retention export (Task 1). Each call reads at
  // most `limit` rows via a (timestamp, id) keyset cursor so a month with more rows
  // than fit in memory at once is still read in bounded chunks — never an unpaged
  // full-table scan. `cursor` is the (timestamp, id) of the last row from the
  // previous page, or null for the first page. The timestamp column is per-table:
  // wompi_events has no created_at column, only received_at (migrations/0001_init.sql);
  // every other windowed table uses created_at.
  async listRowsCreatedBetween(
    table: RetentionTable,
    range: { startIso: string; endIso: string },
    cursor: RetentionCursor | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<Record<string, unknown>>> {
    const column = retentionTimestampColumn(table);
    const conditions = [`${column} >= ?`, `${column} < ?`];
    const bindings: Array<string | number> = [range.startIso, range.endIso];
    if (cursor) {
      conditions.push(`(${column}, id) > (?, ?)`);
      bindings.push(cursor.createdAt, cursor.id);
    }
    const rows = await this.db
      .prepare(`SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY ${column} ASC, id ASC LIMIT ?`)
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  // Full-snapshot paged reads for the small contingency tables (no created_at
  // window — the brief asks for a full snapshot, simpler than windowing).
  async listAllRowsPaged(table: RetentionSnapshotTable, cursor: RetentionCursor | null, limit = RETENTION_PAGE_SIZE): Promise<Array<Record<string, unknown>>> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (cursor) {
      conditions.push("(created_at, id) > (?, ?)");
      bindings.push(cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.db
      .prepare(`SELECT * FROM ${table} ${where} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  async createPasswordResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<string> {
    const id = newId("reset");
    await this.db
      .prepare("INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
      .bind(id, userId, tokenHash, expiresAt)
      .run();
    return id;
  }

  async getActivePasswordResetUser(tokenHash: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare(
        `SELECT users.id, users.email, users.name, users.role, users.id AS user_id, password_reset_tokens.id AS token_id
         FROM password_reset_tokens
         JOIN users ON users.id = password_reset_tokens.user_id
         WHERE password_reset_tokens.token_hash = ?
           AND password_reset_tokens.used_at IS NULL
           AND password_reset_tokens.expires_at > ?
           AND users.disabled_at IS NULL`
      )
      .bind(tokenHash, nowIso())
      .first<Record<string, string>>();
  }

  async markPasswordResetTokenUsed(id: string): Promise<void> {
    await this.db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }

  async setUserPassword(userId: string, passwordHash: string, passwordSalt: string): Promise<void> {
    const existing = await this.db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first<Record<string, unknown>>();
    if (!existing) {
      throw new Error("Usuario no encontrado");
    }
    await this.db
      .prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .bind(passwordHash, passwordSalt, nowIso(), userId)
      .run();
    await this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), userId).run();
  }
}

function normalizeDocumentListLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 50;
  }
  return Math.min(Math.trunc(value), 100);
}

function encodeDocumentCursor(record: DteDocumentRecord): string {
  return `${encodeURIComponent(record.created_at)}|${encodeURIComponent(record.id)}`;
}

function parseDocumentCursor(value: string | null | undefined): DteDocumentCursor | null {
  if (!value) {
    return null;
  }
  const parts = value.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  try {
    return {
      createdAt: decodeURIComponent(parts[0]),
      id: decodeURIComponent(parts[1])
    };
  } catch {
    return null;
  }
}

function buildDteSearchQuery(value: string | null | undefined): string | null {
  const tokens = Array.from((value ?? "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0])
    .filter((token) => token.length > 0)
    .slice(0, 8)
    .map((token) => token.slice(0, 64));
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}*`).join(" AND ");
}

function compactSearchIdentifier(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function controlSerial(value: string | null | undefined): string {
  const lastSegment = (value ?? "").split("-").at(-1) ?? "";
  return lastSegment.replace(/^0+/, "") || lastSegment || "";
}
