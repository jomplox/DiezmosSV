import type { Ambiente, ContingencyBatchLineRecord, ContingencyBatchRecord, DteDocumentRecord, WompiEventRecord, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { amountCents, donorName } from "../domain/wompi";

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
    wompiEventId: string;
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
        input.wompiEventId,
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
    await this.db.prepare("UPDATE wompi_events SET created_document_id = ?, processed_at = ? WHERE id = ?").bind(id, nowIso(), input.wompiEventId).run();
    const record = await this.getDteDocument(id);
    if (!record) {
      throw new Error("No se pudo leer el documento DTE creado");
    }
    return record;
  }

  async getDteDocument(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE id = ?").bind(id).first<DteDocumentRecord>();
  }

  async getDteDocumentByWompiEvent(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE wompi_event_id = ?").bind(id).first<DteDocumentRecord>();
  }

  async listDteDocuments(params: { status?: string | null; q?: string | null; limit?: number } = {}): Promise<DteDocumentRecord[]> {
    const limit = Math.min(params.limit ?? 50, 100);
    const filters: string[] = [];
    const bindings: Array<string | number> = [];
    if (params.status) {
      filters.push("status = ?");
      bindings.push(params.status);
    }
    if (params.q) {
      filters.push("(codigo_generacion LIKE ? OR numero_control LIKE ? OR donor_email LIKE ? OR donor_name LIKE ?)");
      const q = `%${params.q}%`;
      bindings.push(q, q, q, q);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM dte_documents ${where} ORDER BY created_at DESC LIMIT ?`)
      .bind(...bindings, limit)
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
  }

  async listAcceptedDteDocumentsForExport(): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE status = 'ACCEPTED' AND sello_recibido IS NOT NULL ORDER BY issued_at ASC")
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
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
