import {
  normalizeAuditIp,
  serializeAuditContext,
  type AuditRequestContext
} from "../../services/requestContext";
import { newId } from "../../utils/ids";
import { redactSensitiveAuditRows } from "../shared";

export async function createAudit(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    // Explicit overrides win over the request-scoped context injected at construction;
    // callers rarely need them since handleApi/webhook inject the context once.
    actorIp?: string | null;
    actorContext?: unknown;
    rateLimitClaimId?: string | null;
  }
): Promise<void> {
  const actorIp = normalizeAuditIp(
    input.actorIp ?? auditContext?.ip ?? null
  );
  // Persist context only when there is something to persist; an absent request
  // (cron/queue) or an all-undefined cf blob leaves actor_context NULL.
  const actorContext = serializeAuditContext(
    input.actorContext ?? auditContext?.context
  );
  await db
    .prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, summary, metadata_json, actor_ip, actor_context, rate_limit_claim_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId("audit"),
      input.actorType ?? "SYSTEM",
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      actorIp,
      actorContext,
      input.rateLimitClaimId ?? null
    )
    .run();
}

export async function ensurePostAcceptAudit(
  db: D1Database,
  _auditContext: AuditRequestContext | undefined,
  input: {
    auditId: string;
    documentId: string;
    claimId: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
  }
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, summary,
           metadata_json, actor_ip, actor_context, rate_limit_claim_id
         )
         SELECT ?, 'SYSTEM', NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL
           FROM dte_documents
          WHERE id = ? AND status = 'ACCEPTED'
            AND post_accept_finalized_at IS NULL
            AND fiscal_operation_claim_id IS NULL
            AND post_accept_finalization_claim_id = ?
         ON CONFLICT(id) DO UPDATE SET id = excluded.id
         RETURNING id`
    )
    .bind(
      input.auditId,
      input.action,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      input.documentId,
      input.claimId
    )
    .first<{ id: string }>();
  return Boolean(row);
}

// Idempotent lifecycle evidence. The existence check and insert live in one
// SQLite/D1 statement so concurrent queue deliveries cannot both observe an
// absent logical audit key and append duplicate evidence.
export async function createAuditIfAbsent(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    actorIp?: string | null;
    actorContext?: unknown;
  }
): Promise<boolean> {
  const actorIp = normalizeAuditIp(
    input.actorIp ?? auditContext?.ip ?? null
  );
  const actorContext = serializeAuditContext(
    input.actorContext ?? auditContext?.context
  );
  const result = await db
    .prepare(
      `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, summary, metadata_json, actor_ip, actor_context)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_logs
           WHERE action = ? AND entity_type = ? AND entity_id = ?
         )`
    )
    .bind(
      newId("audit"),
      input.actorType ?? "SYSTEM",
      input.actorId ?? null,
      input.action,
      input.entityType,
      input.entityId,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      actorIp,
      actorContext,
      input.action,
      input.entityType,
      input.entityId
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function listAudit(
  db: D1Database,
  entityType?: string,
  entityId?: string
): Promise<Array<Record<string, unknown>>> {
  // LEFT JOIN users on actor_id so USER rows resolve to a display name/email while
  // SYSTEM rows (and USER rows whose account was later deleted) fall through to NULL.
  // The join is on the users PK, so it is index-backed and does not touch the
  // audit_logs hot path beyond the existing ordered scan.
  if (entityType && entityId) {
    return db
      .prepare(
        `SELECT a.*, u.name AS actor_name, u.email AS actor_email
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 100`
      )
      .bind(entityType, entityId)
      .all<Record<string, unknown>>()
      .then((result) => redactSensitiveAuditRows(result.results ?? []));
  }
  return db
    .prepare(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 100`
    )
    .all<Record<string, unknown>>()
    .then((result) => redactSensitiveAuditRows(result.results ?? []));
}

// Página del historial general de auditoría: keyset (created_at, id) DESC — el mismo
// patrón de cursor del listado de documentos, porque OFFSET degenera con miles de
// filas. Devuelve limit+1 filas para que la ruta derive nextCursor sin un COUNT.
export async function listAuditPage(
  db: D1Database,
  cursor: { createdAt: string; id: string } | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const where = cursor ? "WHERE (a.created_at, a.id) < (?, ?)" : "";
  const bindings: string[] = cursor ? [cursor.createdAt, cursor.id] : [];
  return db
    .prepare(
      `SELECT a.*, u.name AS actor_name, u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
    )
    .bind(...bindings, bounded + 1)
    .all<Record<string, unknown>>()
    .then((result) => redactSensitiveAuditRows(result.results ?? []));
}
