import type { Ambiente, DteDocumentRecord, WompiEventRecord, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { amountCents, donorName } from "../domain/wompi";

export class Repository {
  constructor(private readonly db: D1Database) {}

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
      throw new Error("Failed to read inserted Wompi event");
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
      throw new Error("Could not allocate control sequence");
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
      throw new Error("Failed to read inserted DTE document");
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

  async listContingencyDocuments(periodId: string): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE contingency_period_id = ? AND status = 'CONTINGENCY_PENDING' ORDER BY created_at ASC")
      .bind(periodId)
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
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

  async closeContingency(periodId: string): Promise<void> {
    await this.db
      .prepare("UPDATE contingency_periods SET status = 'CLOSED', ended_at = COALESCE(ended_at, ?) WHERE id = ?")
      .bind(nowIso(), periodId)
      .run();
  }

  async recordEmailDelivery(input: { documentId: string; toEmail: string; status: "SENT" | "FAILED"; providerResponse?: unknown }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO email_deliveries (id, document_id, to_email, status, provider_response_json, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(newId("email"), input.documentId, input.toEmail, input.status, JSON.stringify(input.providerResponse ?? {}), input.status === "SENT" ? nowIso() : null)
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
      throw new Error("Failed to read inserted user");
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

  async updateUser(id: string, input: { role?: string; disabled?: boolean; name?: string }): Promise<void> {
    const existing = await this.db.prepare("SELECT id, name, role, disabled_at FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!existing) {
      throw new Error("User not found");
    }
    await this.db
      .prepare("UPDATE users SET name = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")
      .bind(
        input.name ?? existing.name,
        input.role ?? existing.role,
        input.disabled === undefined ? existing.disabled_at : input.disabled ? nowIso() : null,
        nowIso(),
        id
      )
      .run();
  }

  async setUserPassword(userId: string, passwordHash: string, passwordSalt: string): Promise<void> {
    await this.db
      .prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .bind(passwordHash, passwordSalt, nowIso(), userId)
      .run();
    await this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), userId).run();
  }
}
