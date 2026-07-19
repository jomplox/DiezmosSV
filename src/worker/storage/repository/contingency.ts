import type {
  Ambiente,
  ContingencyBatchLineRecord,
  ContingencyBatchRecord,
  DteDocumentRecord
} from "../../types";

export async function getOpenContingency(
  db: D1Database,
  environment?: Ambiente
): Promise<Record<string, unknown> | null> {
  if (environment) {
    return db
      .prepare("SELECT * FROM contingency_periods WHERE environment = ? AND status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
      .bind(environment)
      .first<Record<string, unknown>>();
  }
  return db
    .prepare("SELECT * FROM contingency_periods WHERE status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
    .first<Record<string, unknown>>();
}

export async function listContingencyPeriods(
  db: D1Database,
  limit = 20
): Promise<Array<Record<string, unknown>>> {
  return db
    .prepare("SELECT * FROM contingency_periods ORDER BY started_at DESC LIMIT ?")
    .bind(Math.min(limit, 100))
    .all<Record<string, unknown>>()
    .then((result) => result.results ?? []);
}

export async function listContingencyDocuments(
  db: D1Database,
  periodId: string
): Promise<DteDocumentRecord[]> {
  return db
    .prepare("SELECT * FROM dte_documents WHERE contingency_period_id = ? AND status = 'CONTINGENCY_PENDING' ORDER BY created_at ASC")
    .bind(periodId)
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
}

export async function listContingencyBatches(
  db: D1Database,
  periodId?: string
): Promise<ContingencyBatchRecord[]> {
  if (periodId) {
    return db
      .prepare("SELECT * FROM contingency_batches WHERE contingency_period_id = ? ORDER BY created_at ASC")
      .bind(periodId)
      .all<ContingencyBatchRecord>()
      .then((result) => result.results ?? []);
  }
  return db
    .prepare("SELECT * FROM contingency_batches ORDER BY created_at DESC LIMIT 100")
    .all<ContingencyBatchRecord>()
    .then((result) => result.results ?? []);
}

export async function listContingencyBatchLines(
  db: D1Database,
  input: { periodId?: string; batchId?: string } = {}
): Promise<ContingencyBatchLineRecord[]> {
  if (input.batchId) {
    return db
      .prepare("SELECT * FROM contingency_batch_lines WHERE batch_id = ? ORDER BY line_no ASC")
      .bind(input.batchId)
      .all<ContingencyBatchLineRecord>()
      .then((result) => result.results ?? []);
  }
  if (input.periodId) {
    return db
      .prepare("SELECT * FROM contingency_batch_lines WHERE contingency_period_id = ? ORDER BY created_at ASC, line_no ASC")
      .bind(input.periodId)
      .all<ContingencyBatchLineRecord>()
      .then((result) => result.results ?? []);
  }
  return db
    .prepare("SELECT * FROM contingency_batch_lines ORDER BY created_at DESC LIMIT 500")
    .all<ContingencyBatchLineRecord>()
    .then((result) => result.results ?? []);
}

export async function listDteEventsByType(
  db: D1Database,
  eventType: "INVALIDACION" | "CONTINGENCIA",
  limit = 20
): Promise<Array<Record<string, unknown>>> {
  return db
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
