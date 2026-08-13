import { utf8Bytes } from "../../../src/worker/utils/encoding";
import type { DteDocumentRecord, Env } from "../../../src/worker/types";

export function env(db: InMemoryD1, values: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ISSUANCE_QUEUE: { send: async () => undefined } as unknown as Queue,
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    ARCHIVE: new FakeArchiveBucket() as unknown as R2Bucket,
    APP_ENV: "local",
    // Default to mocked external services so tests that never touch email/MH stay
    // offline under the explicit-opt-in rule (isMockMode only mocks when "true").
    // Tests exercising real dispatch override this with "false".
    MOCK_EXTERNAL_SERVICES: "true",
    ...values
  };
}

// Minimal in-memory R2 fake for tests that don't exercise retention export
// directly but still need a well-typed ARCHIVE binding on Env.
export class FakeArchiveBucket {
  readonly objects = new Map<string, Uint8Array>();
  // Reported-size overrides so tests can simulate oversized R2 objects without
  // allocating them (the backup ZIP guard trusts object.size before reading).
  readonly sizeOverrides = new Map<string, number>();
  readonly contentTypes = new Map<string, string>();
  readonly putCalls: Array<{ key: string; bytes: Uint8Array }> = [];
  readonly headCalls: string[] = [];
  readonly deleteCalls: string[] = [];

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object> {
    const bytes = await archiveBytes(value);
    this.objects.set(key, bytes);
    if (options?.httpMetadata?.contentType) {
      this.contentTypes.set(key, options.httpMetadata.contentType);
    }
    this.putCalls.push({ key, bytes });
    return { key } as R2Object;
  }

  async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
    const parts = new Map<number, Uint8Array>();
    const bucket = this;
    return {
      key,
      uploadId: `upload-${crypto.randomUUID()}`,
      async uploadPart(partNumber: number, value: unknown): Promise<R2UploadedPart> {
        parts.set(partNumber, await archiveBytes(value));
        return { partNumber, etag: `etag-${partNumber}` };
      },
      async complete(uploadedParts: R2UploadedPart[]): Promise<R2Object> {
        const chunks = uploadedParts.map((part) => {
          const chunk = parts.get(part.partNumber);
          if (!chunk) throw new Error(`missing multipart part ${part.partNumber}`);
          return chunk;
        });
        const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        bucket.objects.set(key, bytes);
        return { key } as R2Object;
      },
      async abort(): Promise<void> {
        parts.clear();
      }
    } as R2MultipartUpload;
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
    this.contentTypes.delete(key);
  }

  async head(key: string): Promise<R2Object | null> {
    this.headCalls.push(key);
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);
    if (!bytes) {
      return null;
    }
    // The backups service consumes get() via arrayBuffer(); expose exactly that,
    // plus a body stream so a downloaded response can be streamed like production R2.
    // httpMetadata carries the stored content type back to the branding logo route.
    return {
      key,
      body: new Response(bytes).body,
      size: this.sizeOverrides.get(key) ?? bytes.byteLength,
      httpMetadata: this.contentTypes.has(key) ? { contentType: this.contentTypes.get(key) } : {},
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    } as unknown as R2ObjectBody;
  }

  async list(options?: { prefix?: string }): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }) as R2Object);
    return { objects, truncated: false, delimitedPrefixes: [] } as unknown as R2Objects;
  }
}

async function archiveBytes(value: unknown): Promise<Uint8Array> {
  return value instanceof ReadableStream
    ? new Uint8Array(await new Response(value).arrayBuffer())
    : value instanceof Uint8Array
      ? value
      : utf8Bytes(String(value));
}

export interface LoginRateLimitRow {
  window_started_at: string;
  attempt_count: number;
  expires_at: string;
}

export interface SecurityRateLimitClaimRow {
  id: string;
  scope: string;
  key_hash: string;
  subject_key_hash?: string | null;
  claimed_at: string;
  expires_at: string;
}

export function withWompiIssuanceDefaults(
  event: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!event) return undefined;
  event.issuance_status ??= null;
  event.control_prefix ??= null;
  event.control_sequence ??= null;
  event.reserved_numero_control ??= null;
  event.reserved_codigo_generacion ??= null;
  event.issuance_attempt_count ??= 0;
  event.issuance_attempt_id ??= null;
  event.issuance_error_code ??= null;
  event.issuance_error_message ??= null;
  event.issuance_last_attempt_at ??= null;
  event.issuance_failed_at ??= null;
  event.issuance_dead_lettered_at ??= null;
  return event;
}

export const WOMPI_ISSUANCE_FAILURE_FIELDS = [
  "id",
  "environment",
  "amount_cents",
  "donor_name",
  "donor_email",
  "received_at",
  "processed_at",
  "issuance_status",
  "issuance_attempt_count",
  "issuance_error_code",
  "issuance_error_message",
  "issuance_last_attempt_at",
  "issuance_failed_at",
  "issuance_dead_lettered_at",
  "reserved_numero_control"
] as const;

export function wompiIssuanceFailureProjection(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    WOMPI_ISSUANCE_FAILURE_FIELDS.map((field) => [field, event[field] ?? null])
  );
}

export class InMemoryD1 {
  readonly users: Array<Record<string, unknown>> = [];
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly loginRateLimits = new Map<string, LoginRateLimitRow>();
  readonly securityRateLimitClaims: SecurityRateLimitClaimRow[] = [];
  readonly documents: DteDocumentRecord[] = [];
  readonly preparedSql: string[] = [];
  readonly sequencePrefixes: string[] = [];
  readonly analyticsQueryLimits: Array<{
    reader: "documents" | "intents" | "emails";
    limit: number;
  }> = [];
  readonly emailDeliveries: Array<Record<string, unknown>> = [];
  readonly alertDeliveries: Array<Record<string, unknown>> = [];
  readonly wompiEvents: Array<Record<string, unknown>> = [];
  readonly contingencies: Array<Record<string, unknown>> = [];
  readonly contingencyBatches: Array<Record<string, unknown>> = [];
  readonly contingencyBatchLines: Array<Record<string, unknown>> = [];
  readonly dteEvents: Array<Record<string, unknown>> = [];
  readonly settings: Array<Record<string, unknown>> = [];
  readonly resetTokens: Array<Record<string, unknown>> = [];
  readonly donationIntents: Array<Record<string, unknown>> = [];
  readonly stripeCheckoutSessions: Array<Record<string, unknown>> = [];
  readonly stripeWebhookEvents: Array<Record<string, unknown>> = [];
  readonly stripeGifts: Array<Record<string, unknown>> = [];
  readonly stripeInvoiceSettlements: Array<Record<string, unknown>> = [];
  readonly stripeAcknowledgmentDeliveries: Array<Record<string, unknown>> = [];
  readonly stripeAnnualStatementDeliveries: Array<Record<string, unknown>> = [];
  documentLookupCount = 0;
  wompiIssuanceFailureLookupCount = 0;
  wompiIssuanceRetryClaimCount = 0;
  auditCreatedAt = "2026-06-26T01:46:47.015Z";
  loginCredentialReads = 0;
  nextSequence = 1;
  sessionUser: Record<string, string> | null = null;
  beforePasswordRehashCas: (() => void) | null = null;
  beforePasswordResetBatch: (() => void | Promise<void>) | null = null;
  beforeGuardedUserMutation: (() => void | Promise<void>) | null = null;
  beforeCredentialGuardedSessionBatch: (() => Promise<void>) | null = null;
  beforeCredentialGuardedResetTokenInsert: (() => Promise<void>) | null = null;
  beforeBindingAuditCount: (() => Promise<void>) | null = null;
  beforeDocumentRead: (() => void | Promise<void>) | null = null;
  beforeDocumentSignedUpdate: (() => void | Promise<void>) | null = null;
  beforeWompiIssuanceClaim: (() => void | Promise<void>) | null = null;
  beforeWompiIssuanceRetryClaim: (() => void | Promise<void>) | null = null;
  beforePostAcceptFinalizationClaim: (() => void | Promise<void>) | null = null;
  beforePostAcceptEmailDispatchMark: (() => void | Promise<void>) | null = null;
  beforeAuditCount: ((action: string, entityId: string) => Promise<void>) | null = null;
  beforeSentEmailLookup: ((documentId: string, emailType: string) => Promise<void>) | null = null;
  failPasswordResetBatchAfterStatement: number | null = null;
  failBindingQuarantineBatchAfterStatement: number | null = null;
  failInvalidationCompletionBatchAfterStatement: number | null = null;
  failNextAuditAction: string | null = null;
  passwordResetBatchCount = 0;
  maxCommittedSessionRows = 0;
  private batchTail: Promise<void> = Promise.resolve();

  prepare(sql: string): Statement {
    this.preparedSql.push(sql);
    return new Statement(this, sql);
  }

  async batch(statements: Statement[]): Promise<StatementRunResult[]> {
    const credentialGuarded = statements.some(
      (statement) =>
        statement.sql.includes("INSERT INTO sessions") &&
        statement.sql.includes("password_hash = ?") &&
        statement.sql.includes("password_salt = ?")
    );
    const passwordReset = statements.some(
      (statement) =>
        statement.sql.includes("UPDATE users") &&
        statement.sql.includes("SET password_hash = ?, password_salt = ?, updated_at = ?")
    );
    const passwordResetIssuance = statements.some(
      (statement) =>
        statement.sql.includes("INSERT INTO password_reset_tokens") &&
        statement.sql.includes("auth_generation = ?")
    );
    const guardedUserMutation = statements.some(
      (statement) =>
        statement.sql.includes("UPDATE users") &&
        statement.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')")
    );
    const bindingQuarantine = statements.some(
      (statement) =>
        statement.sql.includes("INSERT INTO audit_logs") &&
        statement.sql.includes("DONATION_INTENT_BINDING_REJECTED") &&
        statement.sql.includes("processed_at IS NULL")
    );
    const invalidationCompletion = statements.some(
      (statement) =>
        statement.sql.includes("UPDATE dte_events") &&
        statement.sql.includes("event_type = 'INVALIDACION'") &&
        statement.sql.includes("SET status = ?")
    );
    const wompiIssuanceRetry = statements.some(
      (statement) =>
        statement.sql.includes("UPDATE wompi_events") &&
        statement.sql.includes("issuance_status = 'RETRY_QUEUED'") &&
        statement.sql.includes("issuance_status IN ('FAILED', 'DEAD_LETTERED')")
    );
    if (credentialGuarded && this.beforeCredentialGuardedSessionBatch) {
      const beforeBatch = this.beforeCredentialGuardedSessionBatch;
      this.beforeCredentialGuardedSessionBatch = null;
      await beforeBatch();
    }
    if (passwordReset && this.beforePasswordResetBatch) {
      const beforeBatch = this.beforePasswordResetBatch;
      this.beforePasswordResetBatch = null;
      await beforeBatch();
    }
    if (passwordResetIssuance && this.beforeCredentialGuardedResetTokenInsert) {
      const beforeBatch = this.beforeCredentialGuardedResetTokenInsert;
      this.beforeCredentialGuardedResetTokenInsert = null;
      await beforeBatch();
    }
    if (guardedUserMutation && this.beforeGuardedUserMutation) {
      const beforeMutation = this.beforeGuardedUserMutation;
      this.beforeGuardedUserMutation = null;
      await beforeMutation();
    }
    if (wompiIssuanceRetry && this.beforeWompiIssuanceRetryClaim) {
      const beforeClaim = this.beforeWompiIssuanceRetryClaim;
      this.beforeWompiIssuanceRetryClaim = null;
      await beforeClaim();
    }

    const previous = this.batchTail;
    let release!: () => void;
    this.batchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const usersBefore = structuredClone(this.users);
    const sessionsBefore = structuredClone(this.sessions);
    const tokensBefore = structuredClone(this.resetTokens);
    const auditsBefore = structuredClone(this.audits);
    const wompiEventsBefore = structuredClone(this.wompiEvents);
    const documentsBefore = structuredClone(this.documents);
    const dteEventsBefore = structuredClone(this.dteEvents);
    try {
      if (passwordReset) {
        this.passwordResetBatchCount += 1;
      }
      const transaction = new InMemoryD1();
      transaction.users.push(...structuredClone(this.users));
      transaction.sessions.push(...structuredClone(this.sessions));
      transaction.resetTokens.push(...structuredClone(this.resetTokens));
      transaction.audits.push(...structuredClone(this.audits));
      transaction.wompiEvents.push(...structuredClone(this.wompiEvents));
      transaction.documents.push(...structuredClone(this.documents));
      transaction.dteEvents.push(...structuredClone(this.dteEvents));
      const results: StatementRunResult[] = [];
      for (const [index, statement] of statements.entries()) {
        results.push(await statement.withDatabase(transaction).run());
        if (passwordReset && this.failPasswordResetBatchAfterStatement === index + 1) {
          throw new Error("injected password-reset batch failure");
        }
        if (
          bindingQuarantine &&
          this.failBindingQuarantineBatchAfterStatement === index + 1
        ) {
          throw new Error("injected binding-quarantine batch failure");
        }
        if (
          invalidationCompletion &&
          this.failInvalidationCompletionBatchAfterStatement === index + 1
        ) {
          throw new Error("injected invalidation-completion batch failure");
        }
      }
      this.users.splice(0, this.users.length, ...transaction.users);
      this.sessions.splice(0, this.sessions.length, ...transaction.sessions);
      this.resetTokens.splice(0, this.resetTokens.length, ...transaction.resetTokens);
      this.audits.splice(0, this.audits.length, ...transaction.audits);
      this.wompiEvents.splice(0, this.wompiEvents.length, ...transaction.wompiEvents);
      this.documents.splice(0, this.documents.length, ...transaction.documents);
      this.dteEvents.splice(0, this.dteEvents.length, ...transaction.dteEvents);
      if (credentialGuarded) {
        this.maxCommittedSessionRows = Math.max(this.maxCommittedSessionRows, this.sessions.length);
      }
      return results;
    } catch (error) {
      this.users.splice(0, this.users.length, ...usersBefore);
      this.sessions.splice(0, this.sessions.length, ...sessionsBefore);
      this.resetTokens.splice(0, this.resetTokens.length, ...tokensBefore);
      this.audits.splice(0, this.audits.length, ...auditsBefore);
      this.wompiEvents.splice(0, this.wompiEvents.length, ...wompiEventsBefore);
      this.documents.splice(0, this.documents.length, ...documentsBefore);
      this.dteEvents.splice(0, this.dteEvents.length, ...dteEventsBefore);
      throw error;
    } finally {
      if (passwordReset) {
        this.failPasswordResetBatchAfterStatement = null;
      }
      if (bindingQuarantine) {
        this.failBindingQuarantineBatchAfterStatement = null;
      }
      if (invalidationCompletion) {
        this.failInvalidationCompletionBatchAfterStatement = null;
      }
      release();
    }
  }
}

export interface StatementRunResult {
  success: true;
  meta: { changes: number };
  results: never[];
}

export class Statement {
  private args: unknown[] = [];

  constructor(
    private readonly db: InMemoryD1,
    readonly sql: string
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  withDatabase(db: InMemoryD1): Statement {
    return new Statement(db, this.sql).bind(...this.args);
  }

  async first<T>(): Promise<T | null> {
    if (
      this.sql.includes("MAX(generation)") &&
      this.sql.includes("FROM stripe_retention_generations")
    ) {
      return {
        maxGeneration: "0",
        maxInvoiceSettlementGeneration: "0",
        materialMutationEpoch: "0"
      } as T;
    }
    if (
      this.sql.includes("verified_secret_slot = 'NEXT'")
      && this.sql.includes("verified_secret_generation = ?")
    ) {
      const [livemode, generation, receivedAfter] = this.args;
      return (this.db.stripeWebhookEvents.find((row) =>
        row.status === "PROCESSED"
        && row.livemode === livemode
        && row.verified_secret_slot === "NEXT"
        && row.verified_secret_generation === generation
        && String(row.received_at) >= String(receivedAfter)
      ) ?? null) as T | null;
    }
    if (
      this.sql.includes("FROM stripe_webhook_events") &&
      this.sql.includes("ORDER BY received_at DESC")
    ) {
      return (this.db.stripeWebhookEvents
        .slice()
        .sort((left, right) =>
          String(right.received_at).localeCompare(String(left.received_at)) ||
          String(right.id).localeCompare(String(left.id))
        )[0] ?? null) as T | null;
    }
    if (
      this.sql.includes("INSERT INTO operational_alert_deliveries") &&
      this.sql.includes("RETURNING id, claim_token")
    ) {
      const [
        id,
        kind,
        entityType,
        entityKeyHash,
        incidentId,
        channel,
        targetKeyHash,
        claimToken,
        claimAttemptedAt,
        staleBefore
      ] = this.args;
      const existing = this.db.alertDeliveries.find(
        (row) =>
          row.kind === kind &&
          row.entity_type === entityType &&
          row.entity_key_hash === entityKeyHash &&
          row.incident_id === incidentId &&
          row.channel === channel &&
          row.target_key_hash === targetKeyHash
      );
      if (!existing) {
        this.db.alertDeliveries.push({
          id,
          kind,
          entity_type: entityType,
          entity_key_hash: entityKeyHash,
          incident_id: incidentId,
          channel,
          target_key_hash: targetKeyHash,
          status: "PENDING",
          claim_token: claimToken,
          claim_attempted_at: claimAttemptedAt,
          provider_dispatch_started_at: null,
          finalized_at: null,
          outcome_class: null,
          failure_code: null,
          retry_safe: 0
        });
        return { id, claim_token: claimToken } as T;
      }
      const reclaimable =
        (existing.status === "FAILED" && Number(existing.retry_safe ?? 0) === 1) ||
        (
          existing.status === "PENDING" &&
          existing.provider_dispatch_started_at == null &&
          String(existing.claim_attempted_at) < String(staleBefore)
        );
      if (!reclaimable) return null;
      existing.status = "PENDING";
      existing.claim_token = claimToken;
      existing.claim_attempted_at = claimAttemptedAt;
      existing.provider_dispatch_started_at = null;
      existing.finalized_at = null;
      existing.outcome_class = null;
      existing.failure_code = null;
      existing.retry_safe = 0;
      return { id: existing.id, claim_token: claimToken } as T;
    }
    if (
      this.sql.includes("SELECT id, status, outcome_class") &&
      this.sql.includes("FROM operational_alert_deliveries")
    ) {
      const [kind, entityType, entityKeyHash, incidentId, channel, targetKeyHash] = this.args;
      return (this.db.alertDeliveries.find(
        (row) =>
          row.kind === kind &&
          row.entity_type === entityType &&
          row.entity_key_hash === entityKeyHash &&
          row.incident_id === incidentId &&
          row.channel === channel &&
          row.target_key_hash === targetKeyHash
      ) ?? null) as T | null;
    }
    if (
      this.sql.includes("UPDATE operational_alert_deliveries") &&
      this.sql.includes("SET provider_dispatch_started_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [startedAt, id, claimToken] = this.args;
      const row = this.db.alertDeliveries.find(
        (delivery) =>
          delivery.id === id &&
          delivery.status === "PENDING" &&
          delivery.claim_token === claimToken &&
          delivery.provider_dispatch_started_at == null
      );
      if (!row) return null;
      row.provider_dispatch_started_at = startedAt;
      return { id } as T;
    }
    if (
      this.sql.includes("INSERT INTO users") &&
      this.sql.includes("WHERE NOT EXISTS (SELECT 1 FROM users)") &&
      this.sql.includes("RETURNING id, email, name, role")
    ) {
      if (this.db.users.length > 0) return null;
      const [id, email, name, passwordHash, passwordSalt] = this.args;
      const now = new Date().toISOString();
      const user = {
        id,
        email,
        name,
        role: "OWNER",
        password_hash: passwordHash,
        password_salt: passwordSalt,
        disabled_at: null,
        created_at: now,
        updated_at: now
      };
      this.db.users.push(user);
      return user as T;
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_claim_id = ?, issuance_claimed_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      await this.db.beforeWompiIssuanceClaim?.();
      const [claimId, claimedAt, eventId, staleBefore] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === eventId);
      const currentClaim = event?.issuance_claim_id ?? null;
      const claimable = currentClaim === null || String(event?.issuance_claimed_at ?? "") < String(staleBefore);
      if (!event || event.processed_at != null || event.created_document_id != null || !claimable) {
        return null;
      }
      event.issuance_claim_id = String(claimId);
      event.issuance_claimed_at = String(claimedAt);
      return { id: event.id } as T;
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_claim_id = NULL, issuance_claimed_at = NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      const [eventId, claimId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === eventId &&
          row.processed_at == null &&
          row.created_document_id == null &&
          row.issuance_claim_id === claimId
      );
      if (!event) return null;
      event.issuance_claim_id = null;
      event.issuance_claimed_at = null;
      return { id: event.id } as T;
    }
    if (
      this.sql.includes("INSERT INTO password_reset_tokens") &&
      this.sql.includes("auth_generation = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      if (this.db.beforeCredentialGuardedResetTokenInsert) {
        const beforeInsert = this.db.beforeCredentialGuardedResetTokenInsert;
        this.db.beforeCredentialGuardedResetTokenInsert = null;
        await beforeInsert();
      }
      const [
        id,
        tokenHash,
        expiresAt,
        userId,
        expectedEmail,
        expectedAuthGeneration,
        expectedPasswordHash,
        expectedPasswordSalt
      ] = this.args;
      const user = this.db.users.find(
        (row) =>
          row.id === userId &&
          !row.disabled_at &&
          row.email === expectedEmail &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration) &&
          row.password_hash === expectedPasswordHash &&
          row.password_salt === expectedPasswordSalt
      );
      if (!user) return null;
      this.db.resetTokens.push({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
      return { id } as T;
    }
    if (
      this.sql.includes("UPDATE donation_intents") &&
      this.sql.includes("SET status = 'COMPLETED'") &&
      this.sql.includes("post_accept_finalization_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [documentId, updatedAt, intentId, expectedDocumentId, ownerDocumentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === ownerDocumentId &&
          row.status === "ACCEPTED" &&
          (row.post_accept_finalized_at ?? null) === null &&
          (row.fiscal_operation_claim_id ?? null) === null &&
          row.post_accept_finalization_claim_id === claimId
      );
      const intent = this.db.donationIntents.find(
        (row) =>
          row.id === intentId &&
          (((row.status === "LINK_CREATED" || row.status === "EXPIRED") && (row.document_id ?? null) === null) ||
            (row.status === "COMPLETED" && row.document_id === expectedDocumentId))
      );
      if (!document || !intent) return null;
      intent.status = "COMPLETED";
      intent.document_id = documentId;
      intent.updated_at = updatedAt;
      return { id: intent.id } as T;
    }
    if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("post_accept_finalization_claim_id = ?") &&
      this.sql.includes("ON CONFLICT(id) DO UPDATE") &&
      this.sql.includes("RETURNING id")
    ) {
      const [auditId, action, entityType, entityId, summary, metadataJson, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          (row.post_accept_finalized_at ?? null) === null &&
          (row.fiscal_operation_claim_id ?? null) === null &&
          row.post_accept_finalization_claim_id === claimId
      );
      if (!document) return null;
      if (this.db.failNextAuditAction === action) {
        this.db.failNextAuditAction = null;
        throw new Error(`injected ${String(action)} audit failure`);
      }
      const existing = this.db.audits.find((row) => row.id === auditId);
      if (!existing) {
        this.db.audits.push({
          id: auditId,
          actor_type: "SYSTEM",
          actor_id: null,
          action,
          entity_type: entityType,
          entity_id: entityId,
          summary,
          metadata_json: metadataJson,
          actor_ip: null,
          actor_context: null,
          rate_limit_claim_id: null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
      }
      return { id: auditId } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET post_accept_finalization_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      await this.db.beforePostAcceptFinalizationClaim?.();
      const [claimId, claimedAt, updatedAt, documentId, staleBefore] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      const handledEvidence = this.db.emailDeliveries.some(
        (delivery) =>
          delivery.document_id === documentId &&
          delivery.email_type === "dteReceipt" &&
          (delivery.status === "SENT" || delivery.status === "FAILED") &&
          delivery.document_status_at_send === "ACCEPTED"
      );
      const skippedEvidence = this.db.audits.some(
        (audit) =>
          audit.action === "EMAIL_SKIPPED" &&
          audit.entity_type === "dte_document" &&
          audit.entity_id === documentId
      );
      const currentClaim = document?.post_accept_finalization_claim_id ?? null;
      const canRecover =
        currentClaim !== null &&
        String(document?.post_accept_finalization_claimed_at ?? "") < String(staleBefore) &&
        ((document?.donor_email ?? null) === null ||
          (document?.post_accept_email_dispatch_started_at ?? null) === null ||
          handledEvidence ||
          skippedEvidence);
      if (
        !document ||
        document.status !== "ACCEPTED" ||
        (document.post_accept_finalized_at ?? null) !== null ||
        (document.fiscal_operation_claim_id ?? null) !== null ||
        (currentClaim !== null && !canRecover)
      ) {
        return null;
      }
      document.post_accept_finalization_claim_id = String(claimId);
      document.post_accept_finalization_claimed_at = String(claimedAt);
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET post_accept_email_dispatch_started_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      await this.db.beforePostAcceptEmailDispatchMark?.();
      const [startedAt, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          (row.post_accept_finalized_at ?? null) === null &&
          row.post_accept_finalization_claim_id === claimId &&
          (row.post_accept_email_dispatch_started_at ?? null) === null
      );
      if (!document) return null;
      document.post_accept_email_dispatch_started_at = String(startedAt);
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET post_accept_finalization_claim_id = NULL") &&
      this.sql.includes("post_accept_finalized_at IS NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      const [updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          (row.post_accept_finalized_at ?? null) === null &&
          row.post_accept_finalization_claim_id === claimId
      );
      if (!document) return null;
      document.post_accept_finalization_claim_id = null;
      document.post_accept_finalization_claimed_at = null;
      document.post_accept_email_dispatch_started_at = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET post_accept_finalized_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [finalizedAt, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          (row.post_accept_finalized_at ?? null) === null &&
          (row.fiscal_operation_claim_id ?? null) === null &&
          row.post_accept_finalization_claim_id === claimId
      );
      if (!document) return null;
      document.post_accept_finalized_at = String(finalizedAt);
      document.post_accept_finalization_claim_id = null;
      document.post_accept_finalization_claimed_at = null;
      document.post_accept_email_dispatch_started_at = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents SET signed_jws = ?") &&
      this.sql.includes("fiscal_operation_claim_id IS NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      await this.db.beforeDocumentSignedUpdate?.();
      const [signedJws, updatedAt, documentId, expectedStatus] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === expectedStatus &&
          (row.fiscal_operation_claim_id ?? null) === null
      );
      if (!document) return null;
      document.signed_jws = String(signedJws);
      document.status = "SIGNED";
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (this.sql.includes("INSERT INTO security_rate_limit_claims")) {
      const scope = this.sql.includes("'donation_intent'")
        ? "donation_intent"
        : this.sql.includes("'donation_datos'")
          ? "donation_datos"
          : "password_reset";
      if (scope === "password_reset" && this.sql.includes("subject_key_hash")) {
        const [
          id,
          pairKeyHash,
          accountKeyHash,
          claimedAt,
          expiresAt,
          countPairKeyHash,
          pairCutoff,
          pairLimit,
          countAccountKeyHash,
          accountCutoff,
          accountId,
          legacyCutoff,
          accountLimit
        ] = this.args;
        const pairCount = this.db.securityRateLimitClaims.filter(
          (claim) =>
            claim.scope === scope &&
            claim.key_hash === countPairKeyHash &&
            claim.claimed_at >= String(pairCutoff)
        ).length;
        const accountCount = this.db.securityRateLimitClaims.filter(
          (claim) =>
            claim.scope === scope &&
            claim.subject_key_hash === countAccountKeyHash &&
            claim.claimed_at >= String(accountCutoff)
        ).length;
        const legacyCount = this.db.audits.filter((audit) => {
          if (
            audit.entity_id !== accountId ||
            !["PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_EMAIL_FAILED"].includes(String(audit.action)) ||
            String(audit.created_at) < String(legacyCutoff)
          ) {
            return false;
          }
          const linkedClaim = this.db.securityRateLimitClaims.find(
            (claim) => claim.id === audit.rate_limit_claim_id
          );
          return audit.rate_limit_claim_id == null || linkedClaim?.subject_key_hash == null;
        }).length;
        if (pairCount >= Number(pairLimit) || accountCount + legacyCount >= Number(accountLimit)) {
          return null;
        }
        const claim = {
          id: String(id),
          scope,
          key_hash: String(pairKeyHash),
          subject_key_hash: String(accountKeyHash),
          claimed_at: String(claimedAt),
          expires_at: String(expiresAt)
        };
        this.db.securityRateLimitClaims.push(claim);
        return { id: claim.id } as T;
      }
      const [id, keyHash, claimedAt, expiresAt, countKeyHash, cutoff] = this.args;
      const legacyKey = scope === "donation_intent" ? this.args[6] : null;
      const legacyCutoff = scope === "donation_intent" ? this.args[7] : null;
      const limitValue = scope === "donation_intent" ? this.args[8] : this.args[6];
      const activeClaims = this.db.securityRateLimitClaims.filter(
        (claim) =>
          claim.scope === scope &&
          claim.key_hash === countKeyHash &&
          claim.claimed_at >= String(cutoff)
      );
      const legacyCount = scope === "donation_intent"
        ? this.db.donationIntents.filter(
            (intent) =>
              intent.client_ip === legacyKey &&
              String(intent.created_at) >= String(legacyCutoff) &&
              (intent.rate_limit_claim_id ?? null) === null
          ).length
        : 0;
      if (activeClaims.length + legacyCount >= Number(limitValue)) {
        return null;
      }
      const claim = {
        id: String(id),
        scope,
        key_hash: String(keyHash),
        claimed_at: String(claimedAt),
        expires_at: String(expiresAt)
      };
      this.db.securityRateLimitClaims.push(claim);
      return { id: claim.id } as T;
    }
    if (
      this.sql.includes("UPDATE email_deliveries") &&
      this.sql.includes("WHERE resend_request_id = ?") &&
      this.sql.includes("RETURNING id, idempotency_key, claim_token, attempt_no")
    ) {
      const [
        claimAttemptedAt,
        claimToken,
        resendRequestId,
        documentId,
        toEmail,
        emailType,
        documentStatusAtSend,
        staleBefore
      ] = this.args.map(String);
      const existing = this.db.emailDeliveries.find(
        (delivery) => delivery.resend_request_id === resendRequestId
      );
      const latest = this.db.emailDeliveries
        .filter(
          (delivery) =>
            delivery.document_id === documentId &&
            delivery.email_type === emailType
        )
        .sort((left, right) => {
          const attemptOrder = Number(right.attempt_no ?? 1) - Number(left.attempt_no ?? 1);
          if (attemptOrder !== 0) return attemptOrder;
          const leftOccurredAt = String(
            left.finalized_at ?? left.claim_attempted_at ?? left.created_at ?? ""
          );
          const rightOccurredAt = String(
            right.finalized_at ?? right.claim_attempted_at ?? right.created_at ?? ""
          );
          return (
            rightOccurredAt.localeCompare(leftOccurredAt) ||
            String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")) ||
            String(right.id ?? "").localeCompare(String(left.id ?? ""))
          );
        })[0];
      const sameRequest =
        existing?.document_id === documentId &&
        existing.to_email === toEmail &&
        existing.email_type === emailType &&
        existing.document_status_at_send === documentStatusAtSend;
      const reclaimable =
        (existing?.status === "FAILED" && Number(existing.retry_safe ?? 0) === 1) ||
        (
          existing?.status === "PENDING" &&
          (existing.provider_dispatch_started_at ?? null) === null &&
          existing.claim_attempted_at != null &&
          String(existing.claim_attempted_at) < staleBefore
        );
      if (!sameRequest || !reclaimable || existing !== latest) return null;
      existing.status = "PENDING";
      existing.provider_response_json = "{}";
      existing.sent_at = null;
      existing.claim_attempted_at = claimAttemptedAt;
      existing.claim_token = claimToken;
      existing.provider_dispatch_started_at = null;
      existing.outcome_class = null;
      existing.failure_code = null;
      existing.retry_safe = 0;
      existing.template_version = null;
      existing.pdf_renderer_version = null;
      existing.pdf_sha256 = null;
      existing.dte_json_sha256 = null;
      existing.provider_delivery_id = null;
      existing.finalized_at = null;
      existing.attempt_no = Math.max(
        ...this.db.emailDeliveries
          .filter((delivery) => delivery.document_id === documentId)
          .map((delivery) => Number(delivery.attempt_no ?? 1)),
        0
      ) + 1;
      return {
        id: String(existing.id),
        idempotency_key: String(existing.idempotency_key),
        claim_token: claimToken,
        attempt_no: Number(existing.attempt_no)
      } as T;
    }
    if (
      this.sql.includes("INSERT OR IGNORE INTO email_deliveries") &&
      this.sql.includes("resend_request_id") &&
      this.sql.includes("RETURNING id, idempotency_key, claim_token, attempt_no")
    ) {
      const [
        id,
        documentId,
        toEmail,
        emailType,
        documentStatusAtSend,
        claimAttemptedAt,
        idempotencyKey,
        claimToken,
        resendRequestId
      ] = this.args.map(String);
      const duplicateRequest = this.db.emailDeliveries.some(
        (delivery) => delivery.resend_request_id === resendRequestId
      );
      const latest = this.db.emailDeliveries
        .filter(
          (delivery) =>
            delivery.document_id === documentId &&
            delivery.email_type === emailType
        )
        .sort((left, right) => {
          const attemptOrder = Number(right.attempt_no ?? 1) - Number(left.attempt_no ?? 1);
          if (attemptOrder !== 0) return attemptOrder;
          const leftOccurredAt = String(
            left.finalized_at ?? left.claim_attempted_at ?? left.created_at ?? ""
          );
          const rightOccurredAt = String(
            right.finalized_at ?? right.claim_attempted_at ?? right.created_at ?? ""
          );
          return (
            rightOccurredAt.localeCompare(leftOccurredAt) ||
            String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")) ||
            String(right.id ?? "").localeCompare(String(left.id ?? ""))
          );
        })[0];
      const blocker =
        latest?.status === "PENDING" ||
        (
          latest?.status === "FAILED" &&
          ((latest.outcome_class ?? null) === null || latest.outcome_class === "UNKNOWN")
        )
          ? latest
          : undefined;
      if (duplicateRequest || blocker) return null;
      const attemptNo = Math.max(
        ...this.db.emailDeliveries
          .filter((delivery) => delivery.document_id === documentId)
          .map((delivery) => Number(delivery.attempt_no ?? 1)),
        0
      ) + 1;
      this.db.emailDeliveries.push({
        id,
        document_id: documentId,
        to_email: toEmail,
        status: "PENDING",
        provider_response_json: "{}",
        sent_at: null,
        email_type: emailType,
        document_status_at_send: documentStatusAtSend,
        template_version: null,
        pdf_renderer_version: null,
        pdf_sha256: null,
        dte_json_sha256: null,
        provider_delivery_id: null,
        claim_attempted_at: claimAttemptedAt,
        idempotency_key: idempotencyKey,
        claim_token: claimToken,
        provider_dispatch_started_at: null,
        finalized_at: null,
        outcome_class: null,
        failure_code: null,
        retry_safe: 0,
        resend_request_id: resendRequestId,
        attempt_no: attemptNo,
        created_at: "2026-07-17T17:00:00.000Z"
      });
      return {
        id,
        idempotency_key: idempotencyKey,
        claim_token: claimToken,
        attempt_no: attemptNo
      } as T;
    }
    if (
      this.sql.includes("FROM email_deliveries") &&
      this.sql.includes("WHERE resend_request_id = ?")
    ) {
      const existing = this.db.emailDeliveries.find(
        (delivery) => delivery.resend_request_id === this.args[0]
      );
      return (existing ?? null) as T | null;
    }
    if (
      this.sql.includes("SELECT id, status, outcome_class, attempt_no") &&
      this.sql.includes("FROM email_deliveries")
    ) {
      const [documentId, emailType] = this.args;
      const latest = this.db.emailDeliveries
        .filter(
          (delivery) =>
            delivery.document_id === documentId &&
            delivery.email_type === emailType
        )
        .sort((left, right) => {
          const attemptOrder = Number(right.attempt_no ?? 1) - Number(left.attempt_no ?? 1);
          if (attemptOrder !== 0) return attemptOrder;
          const leftOccurredAt = String(
            left.finalized_at ?? left.claim_attempted_at ?? left.created_at ?? ""
          );
          const rightOccurredAt = String(
            right.finalized_at ?? right.claim_attempted_at ?? right.created_at ?? ""
          );
          return (
            rightOccurredAt.localeCompare(leftOccurredAt) ||
            String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")) ||
            String(right.id ?? "").localeCompare(String(left.id ?? ""))
          );
        })[0];
      const blocker =
        latest?.status === "PENDING" ||
        (
          latest?.status === "FAILED" &&
          ((latest.outcome_class ?? null) === null || latest.outcome_class === "UNKNOWN")
        )
          ? latest
          : undefined;
      return (blocker ?? null) as T | null;
    }
    if (
      this.sql.includes("COALESCE(") &&
      this.sql.includes("finalized_at") &&
      this.sql.includes("FROM email_deliveries") &&
      this.sql.includes("dteReceiptTransitorio")
    ) {
      const documentId = this.args[0];
      const latest = this.db.emailDeliveries
        .filter(
          (delivery) =>
            delivery.document_id === documentId &&
            ["dteReceipt", "dteReceiptTransitorio"].includes(String(delivery.email_type))
        )
        .sort((left, right) => {
          const attempt = Number(right.attempt_no ?? 1) - Number(left.attempt_no ?? 1);
          if (attempt !== 0) return attempt;
          return String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
        })[0];
      if (!latest) return null;
      return {
        status: latest.status,
        outcome_class: latest.outcome_class ?? null,
        failure_code: latest.failure_code ?? null,
        retry_safe: Number(latest.retry_safe ?? 0),
        provider_dispatch_started_at: latest.provider_dispatch_started_at ?? null,
        attempt_no: Number(latest.attempt_no ?? 1),
        occurred_at:
          latest.finalized_at ??
          latest.sent_at ??
          latest.provider_dispatch_started_at ??
          latest.claim_attempted_at ??
          latest.created_at
      } as T;
    }
    if (
      this.sql.includes("UPDATE email_deliveries") &&
      this.sql.includes("SET provider_dispatch_started_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [startedAt, id, claimToken] = this.args;
      const delivery = this.db.emailDeliveries.find(
        (row) =>
          row.id === id &&
          row.status === "PENDING" &&
          row.claim_token === claimToken &&
          (row.provider_dispatch_started_at ?? null) === null
      );
      if (!delivery) return null;
      delivery.provider_dispatch_started_at = String(startedAt);
      return { id: delivery.id } as T;
    }
    if (
      this.sql.includes("INSERT INTO email_deliveries") &&
      this.sql.includes("ON CONFLICT(idempotency_key)") &&
      this.sql.includes("RETURNING id, idempotency_key, claim_token")
    ) {
      const [
        id,
        documentId,
        toEmail,
        emailType,
        documentStatusAtSend,
        claimAttemptedAt,
        idempotencyKey,
        claimToken,
        ,
        ,
        ,
        blockerDocumentStatus,
        staleBefore
      ] = this.args.map(String);
      const blocker = this.db.emailDeliveries.find(
        (delivery) =>
          delivery.document_id === documentId &&
          delivery.email_type === emailType &&
          delivery.document_status_at_send === blockerDocumentStatus &&
          (
            delivery.status === "SENT" ||
            (
              delivery.status === "PENDING" &&
              (
              delivery.claim_attempted_at == null ||
                delivery.provider_dispatch_started_at != null ||
                String(delivery.claim_attempted_at) >= staleBefore
              )
            )
            || (delivery.status === "FAILED" && Number(delivery.retry_safe ?? 0) === 0)
          )
      );
      if (blocker) return null;

      const existing = this.db.emailDeliveries.find(
        (delivery) => delivery.idempotency_key === idempotencyKey
      );
      if (existing) {
        const reclaimable =
          (existing.status === "FAILED" && Number(existing.retry_safe ?? 0) === 1) ||
          (
            existing.status === "PENDING" &&
            (existing.provider_dispatch_started_at ?? null) === null &&
            existing.claim_attempted_at != null &&
            String(existing.claim_attempted_at) < staleBefore
          );
        if (!reclaimable) return null;
        existing.to_email = toEmail;
        existing.status = "PENDING";
        existing.provider_response_json = "{}";
        existing.document_status_at_send = documentStatusAtSend;
        existing.claim_attempted_at = claimAttemptedAt;
        existing.claim_token = claimToken;
        existing.provider_dispatch_started_at = null;
        existing.finalized_at = null;
        existing.outcome_class = null;
        existing.failure_code = null;
        existing.retry_safe = 0;
        existing.attempt_no = Math.max(
          ...this.db.emailDeliveries
            .filter((delivery) => delivery.document_id === documentId)
            .map((delivery) => Number(delivery.attempt_no ?? 1)),
          0
        ) + 1;
        return { id: String(existing.id), idempotency_key: idempotencyKey, claim_token: claimToken } as T;
      }

      this.db.emailDeliveries.push({
        id,
        document_id: documentId,
        to_email: toEmail,
        status: "PENDING",
        provider_response_json: "{}",
        sent_at: null,
        email_type: emailType,
        document_status_at_send: documentStatusAtSend,
        template_version: null,
        pdf_renderer_version: null,
        pdf_sha256: null,
        dte_json_sha256: null,
        provider_delivery_id: null,
        claim_attempted_at: claimAttemptedAt,
        idempotency_key: idempotencyKey,
        claim_token: claimToken,
        provider_dispatch_started_at: null,
        finalized_at: null,
        outcome_class: null,
        failure_code: null,
        retry_safe: 0,
        resend_request_id: null,
        attempt_no: Math.max(
          ...this.db.emailDeliveries
            .filter((delivery) => delivery.document_id === documentId)
            .map((delivery) => Number(delivery.attempt_no ?? 1)),
          0
        ) + 1,
        created_at: "2026-07-17T17:00:00.000Z"
      });
      return { id, idempotency_key: idempotencyKey, claim_token: claimToken } as T;
    }
    if (this.sql.includes("INSERT INTO login_rate_limits")) {
      const [keyHash, now, expiresAt, cutoff, , , , limitValue] = this.args;
      const key = String(keyHash);
      const current = this.db.loginRateLimits.get(key);
      const limit = Number(limitValue);
      if (!current || current.window_started_at <= String(cutoff)) {
        const next = {
          window_started_at: String(now),
          attempt_count: 1,
          expires_at: String(expiresAt)
        };
        this.db.loginRateLimits.set(key, next);
        return { attempt_count: 1 } as T;
      }
      if (current.attempt_count >= limit) return null;
      current.attempt_count += 1;
      return { attempt_count: current.attempt_count } as T;
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_status = 'PROCESSING'") &&
      this.sql.includes("issuance_attempt_id") &&
      this.sql.includes("RETURNING id")
    ) {
      const legacyMessage = this.sql.includes("COALESCE(issuance_attempt_id, ?)");
      const [attemptId, attemptedAt, wompiEventId] = legacyMessage
        ? [String(this.args[0]), String(this.args[1]), String(this.args[2])]
        : [String(this.args[2]), String(this.args[0]), String(this.args[1])];
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      const currentAttempt = event?.issuance_attempt_id ?? null;
      const attemptMatches = legacyMessage
        ? currentAttempt === null || currentAttempt === attemptId
        : currentAttempt === attemptId;
      const statusMatches = event?.issuance_status == null ||
        ["RETRY_QUEUED", "PROCESSING", "FAILED"].includes(String(event.issuance_status));
      if (!event || event.created_document_id != null || !attemptMatches || !statusMatches) {
        return null;
      }
      event.issuance_status = "PROCESSING";
      event.issuance_attempt_id ??= attemptId;
      event.issuance_last_attempt_at = attemptedAt;
      return { id: wompiEventId } as T;
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_status = 'DEAD_LETTERED'") &&
      this.sql.includes("issuance_attempt_id") &&
      this.sql.includes("RETURNING id")
    ) {
      const [attemptId, fallbackCode, , fallbackMessage, deadLetteredAt, processedAt, rawWompiEventId] = this.args;
      const wompiEventId = String(rawWompiEventId);
      const legacyMessage = this.sql.includes("issuance_attempt_id IS NULL OR issuance_attempt_id = ?");
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      const currentAttempt = event?.issuance_attempt_id ?? null;
      const attemptMatches = legacyMessage
        ? currentAttempt === null || currentAttempt === attemptId
        : currentAttempt === attemptId;
      const statusMatches = event?.issuance_status == null ||
        ["RETRY_QUEUED", "PROCESSING", "FAILED"].includes(String(event.issuance_status));
      if (!event || event.created_document_id != null || !attemptMatches || !statusMatches) {
        return null;
      }
      event.issuance_status = "DEAD_LETTERED";
      event.issuance_attempt_id ??= String(attemptId);
      if (event.issuance_error_message == null) {
        event.issuance_error_code = String(fallbackCode);
        event.issuance_error_message = String(fallbackMessage);
      } else {
        event.issuance_error_code ??= String(fallbackCode);
      }
      event.issuance_dead_lettered_at = String(deadLetteredAt);
      event.processed_at ??= String(processedAt);
      return { id: wompiEventId } as T;
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'RETRY_QUEUED'") &&
      this.sql.includes("issuance_status IN ('FAILED', 'DEAD_LETTERED')") &&
      this.sql.includes("RETURNING id")
    ) {
      this.db.wompiIssuanceRetryClaimCount += 1;
      const [retryQueuedAt, rawWompiEventId] = this.args;
      const wompiEventId = String(rawWompiEventId);
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id == null &&
          row.issuance_claim_id == null &&
          (
            row.issuance_status === "FAILED"
            || row.issuance_status === "DEAD_LETTERED"
            || (
              (row.issuance_status === "RETRY_QUEUED" || row.issuance_status === "PROCESSING")
              && row.processed_at != null
            )
          )
      );
      if (!event) {
        return null;
      }
      event.processed_at = null;
      event.issuance_status = "RETRY_QUEUED";
      event.issuance_last_attempt_at = String(retryQueuedAt);
      return { id: wompiEventId } as T;
    }
    if (
      this.sql.includes("UPDATE users") &&
      this.sql.includes("password_hash = ?") &&
      this.sql.includes("password_salt = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [passwordHash, passwordSalt, updatedAt, userId, currentPasswordHash, currentPasswordSalt] = this.args;
      this.db.beforePasswordRehashCas?.();
      this.db.beforePasswordRehashCas = null;
      const user = this.db.users.find(
        (row) => row.id === userId && row.password_hash === currentPasswordHash && row.password_salt === currentPasswordSalt
      );
      if (!user) {
        return null;
      }
      user.password_hash = passwordHash;
      user.password_salt = passwordSalt;
      user.updated_at = updatedAt;
      return { id: user.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = 'SIGNED', fiscal_operation_claim_id = ?") &&
      this.sql.includes("WHERE id = ? AND status = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [claimId, claimedAt, updatedAt, documentId, expectedStatus, signedJws] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === expectedStatus &&
          row.signed_jws === signedJws &&
          (row.fiscal_operation_claim_id ?? null) === null
      );
      if (!document) return null;
      document.status = "SIGNED";
      document.fiscal_operation_claim_id = String(claimId);
      document.fiscal_operation_claimed_at = String(claimedAt);
      document.fiscal_operation_kind = "TRANSMISSION";
      document.fiscal_operation_event_id = null;
      document.post_accept_finalized_at = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET fiscal_operation_claim_id = ?, fiscal_operation_claimed_at = ?") &&
      this.sql.includes("status = 'ACCEPTED'") &&
      this.sql.includes("RETURNING id")
    ) {
      const [claimId, claimedAt, updatedAt, documentId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          row.sello_recibido != null &&
          row.accepted_at != null &&
          row.post_accept_finalized_at != null &&
          (row.fiscal_operation_claim_id ?? null) === null
      );
      if (!document) return null;
      document.fiscal_operation_claim_id = String(claimId);
      document.fiscal_operation_claimed_at = String(claimedAt);
      document.fiscal_operation_kind = "INVALIDATION";
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET fiscal_operation_event_id = ?") &&
      this.sql.includes("fiscal_operation_kind = 'INVALIDATION'") &&
      this.sql.includes("RETURNING id")
    ) {
      const [eventId, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          (row.fiscal_operation_event_id ?? null) === null
      );
      if (!document) return null;
      document.fiscal_operation_event_id = String(eventId);
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = ?, sello_recibido = ?") &&
      this.sql.includes("fiscal_operation_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [status, sello, mhEstado, observaciones, acceptedAt, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "SIGNED" &&
          row.fiscal_operation_claim_id === claimId
      );
      if (!document) return null;
      document.status = String(status);
      document.sello_recibido = sello == null ? null : String(sello);
      document.mh_estado = String(mhEstado);
      document.mh_observaciones_json = String(observaciones);
      document.accepted_at = acceptedAt == null ? null : String(acceptedAt);
      document.fiscal_operation_claim_id = null;
      document.fiscal_operation_claimed_at = null;
      document.fiscal_operation_kind = null;
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = 'FAILED'") &&
      this.sql.includes("fiscal_operation_claim_id") &&
      this.sql.includes("RETURNING id")
    ) {
      const [mhEstado, observaciones, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      const ownsClaim = claimId === undefined
        ? (document?.fiscal_operation_claim_id ?? null) === null
        : document?.fiscal_operation_claim_id === claimId;
      if (!document || ["ACCEPTED", "REJECTED", "INVALIDATED"].includes(document.status) || !ownsClaim) return null;
      document.status = "FAILED";
      document.sello_recibido = null;
      document.mh_estado = String(mhEstado);
      document.mh_observaciones_json = String(observaciones);
      document.fiscal_operation_claim_id = null;
      document.fiscal_operation_claimed_at = null;
      document.fiscal_operation_kind = null;
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = 'INVALIDATED'") &&
      this.sql.includes("fiscal_operation_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) => row.id === documentId && row.status === "ACCEPTED" && row.fiscal_operation_claim_id === claimId
      );
      if (!document) return null;
      document.status = "INVALIDATED";
      document.fiscal_operation_claim_id = null;
      document.fiscal_operation_claimed_at = null;
      document.fiscal_operation_kind = null;
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("transmission_deferred_at = ?") &&
      this.sql.includes("fiscal_operation_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [deferredAt, mhEstado, observaciones, updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) => row.id === documentId && row.status === "SIGNED" && row.fiscal_operation_claim_id === claimId
      );
      if (!document) return null;
      document.transmission_deferred_at = String(deferredAt);
      document.sello_recibido = null;
      document.mh_estado = String(mhEstado);
      document.mh_observaciones_json = String(observaciones);
      document.fiscal_operation_claim_id = null;
      document.fiscal_operation_claimed_at = null;
      document.fiscal_operation_kind = null;
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET fiscal_operation_claim_id = NULL") &&
      !this.sql.includes("SET status =") &&
      this.sql.includes("RETURNING id")
    ) {
      const [updatedAt, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) => row.id === documentId && row.fiscal_operation_claim_id === claimId
      );
      if (!document) return null;
      document.fiscal_operation_claim_id = null;
      document.fiscal_operation_claimed_at = null;
      document.fiscal_operation_kind = null;
      document.fiscal_operation_event_id = null;
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
    if (this.sql.includes("FROM sessions") && this.sql.includes("JOIN users")) {
      if (this.db.sessionUser) {
        return this.db.sessionUser as T;
      }
      const [tokenHash, nowIso] = this.args.map(String);
      const session = this.db.sessions.find(
        (row) =>
          row.token_hash === tokenHash &&
          !row.revoked_at &&
          String(row.expires_at) > nowIso
      );
      if (!session) {
        return null;
      }
      const user = this.db.users.find(
        (row) => row.id === session.user_id && !row.disabled_at
      );
      if (!user) {
        return null;
      }
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      } as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM users")) {
      return { count: this.db.users.length } as T;
    }
    if (this.sql.includes("FROM users WHERE id = ?")) {
      return (this.db.users.find((user) => user.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM users WHERE email = ?")) {
      this.db.loginCredentialReads += 1;
      return (this.db.users.find((user) => String(user.email).toLowerCase() === String(this.args[0]).toLowerCase()) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT id FROM audit_logs WHERE action = ?") && this.sql.includes("entity_type = ?")) {
      const [action, entityType, entityId] = this.args;
      const audit = this.db.audits.find(
        (row) => row.action === action && row.entity_type === entityType && row.entity_id === entityId
      );
      return (audit ? { id: audit.id } : null) as T | null;
    }
    if (this.sql.includes("SELECT 1 AS found") && this.sql.includes("json_extract(metadata_json")) {
      const [action, entityType, entityId, incidentId, channel] = this.args.map(String);
      const found = this.db.audits.some((audit) => {
        const metadata = JSON.parse(String(audit.metadata_json ?? "{}")) as Record<string, unknown>;
        return audit.action === action
          && audit.entity_type === entityType
          && audit.entity_id === entityId
          && metadata.incidentId === incidentId
          && metadata.channel === channel;
      });
      return (found ? { found: 1 } : null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs") && this.sql.includes("actor_ip IS ?")) {
      const [action, entityId, sinceIso, actorIp] = this.args;
      return {
        count: this.db.audits.filter(
          (audit) =>
            audit.action === action &&
            audit.entity_id === entityId &&
            String(audit.created_at) >= String(sinceIso) &&
            (audit.actor_ip ?? null) === (actorIp ?? null)
        ).length
      } as T;
    }
    if (
      this.sql.includes("SELECT COUNT(*) AS count") &&
      this.sql.includes("episode_member.key = 'stalledRequeueEpochAt'")
    ) {
      const [action, entityId, episodeId, exclusiveBoundary] = this.args.map(String);
      if (this.db.beforeAuditCount) {
        await this.db.beforeAuditCount(action, entityId);
      }
      return {
        count: this.db.audits.filter((audit) => {
          const auditEpisodeId = auditStalledRequeueEpisodeId(audit);
          return audit.action === action &&
            audit.entity_id === entityId &&
            (
              auditEpisodeId === episodeId ||
              (
                auditEpisodeId === null &&
                String(audit.created_at) > exclusiveBoundary
              )
            );
        }).length
      } as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs") && this.sql.includes("created_at >= ?")) {
      const [action, entityId, sinceIso] = this.args.map(String);
      if (this.db.beforeAuditCount) {
        await this.db.beforeAuditCount(action, entityId);
      }
      return {
        count: this.db.audits.filter(
          (audit) => audit.action === action && audit.entity_id === entityId && String(audit.created_at) >= sinceIso
        ).length
      } as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs")) {
      const [action, entityId] = this.args.map(String);
      if (this.db.beforeAuditCount) {
        await this.db.beforeAuditCount(action, entityId);
      }
      if (
        action === "DONATION_INTENT_BINDING_REJECTED" &&
        this.db.beforeBindingAuditCount
      ) {
        await this.db.beforeBindingAuditCount();
      }
      return { count: this.db.audits.filter((audit) => audit.action === action && audit.entity_id === entityId).length } as T;
    }
    if (this.sql.includes("FROM password_reset_tokens") && this.sql.includes("JOIN users")) {
      const [tokenHash, nowIso] = this.args.map(String);
      const token = this.db.resetTokens.find(
        (row) => row.token_hash === tokenHash && !row.used_at && String(row.expires_at) > nowIso
      );
      if (!token) return null;
      const user = this.db.users.find((row) => row.id === token.user_id && !row.disabled_at);
      if (!user) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role, token_id: token.id, user_id: user.id } as T;
    }
    if (this.sql.includes("SELECT MIN(created_at) AS earliest FROM dte_documents")) {
      const earliest = this.db.documents
        .map((document) => String(document.created_at))
        .sort()
        .at(0);
      return { earliest: earliest ?? null } as T;
    }
    if (this.sql.includes("SELECT * FROM dte_documents WHERE id = ?")) {
      this.db.documentLookupCount += 1;
      await this.db.beforeDocumentRead?.();
      const document = this.db.documents.find((candidate) => candidate.id === this.args[0]);
      return (document ? structuredClone(document) : null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM dte_documents WHERE wompi_event_id = ?")) {
      return (this.db.documents.find((document) => document.wompi_event_id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM donation_intents WHERE id = ?")) {
      return (this.db.donationIntents.find((intent) => intent.id === this.args[0]) ?? null) as T | null;
    }
    if (
      this.sql.includes("UPDATE donation_intents") &&
      this.sql.includes("datos_token_hash = NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      const [
        donorDocumentType,
        donorDocument,
        donorName,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        updatedAt,
        id,
        datosTokenHash,
        expiresAfter
      ] = this.args;
      const intent = this.db.donationIntents.find(
        (row) =>
          row.id === id &&
          row.datos_token_hash === datosTokenHash &&
          row.status === "LINK_CREATED" &&
          row.paid_at == null &&
          row.donor_document == null &&
          String(row.expires_at) > String(expiresAfter)
      );
      if (!intent) return null;
      intent.donor_document_type = String(donorDocumentType);
      intent.donor_document = String(donorDocument);
      intent.donor_name = donorName == null ? null : String(donorName);
      intent.donor_phone = donorPhone == null ? null : String(donorPhone);
      intent.direccion_departamento = String(direccionDepartamento);
      intent.direccion_municipio = String(direccionMunicipio);
      intent.direccion_distrito = String(direccionDistrito);
      // Nullable since /donar stopped collecting the address (Wompi forces it), so
      // model it like the other nullable columns instead of stringifying null.
      intent.direccion_complemento = direccionComplemento == null ? null : String(direccionComplemento);
      intent.donor_pais = donorPais == null ? null : String(donorPais);
      intent.datos_token_hash = null;
      intent.updated_at = String(updatedAt);
      return {
        id: String(id),
        wompi_url_enlace: intent.wompi_url_enlace,
        wompi_url_enlace_largo: intent.wompi_url_enlace_largo
      } as T;
    }
    if (this.sql.includes("FROM donation_intents WHERE document_id = ?") && this.sql.includes("status = 'COMPLETED'")) {
      const documentId = String(this.args[0]);
      return (this.db.donationIntents.find((intent) => intent.document_id === documentId && intent.status === "COMPLETED") ?? null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM donation_intents") && this.sql.includes("client_ip = ?")) {
      const [clientIp, sinceIso] = this.args.map(String);
      return {
        count: this.db.donationIntents.filter(
          (intent) => intent.client_ip === clientIp && String(intent.created_at) >= sinceIso
        ).length
      } as T;
    }
    if (
      this.sql.includes("FROM wompi_events") &&
      this.sql.includes("issuance_dead_lettered_at") &&
      this.sql.includes("WHERE id = ?") &&
      !this.sql.includes("SELECT *")
    ) {
      this.db.wompiIssuanceFailureLookupCount += 1;
      const event = withWompiIssuanceDefaults(
        this.db.wompiEvents.find((row) => row.id === this.args[0])
      );
      if (!event) return null;
      if (
        this.sql.includes("issuance_error_message IS NOT NULL") &&
        (event.created_document_id != null ||
          event.issuance_error_message == null ||
          !["FAILED", "DEAD_LETTERED", "RETRY_QUEUED", "PROCESSING"].includes(String(event.issuance_status)))
      ) {
        return null;
      }
      const failure = wompiIssuanceFailureProjection(event);
      if (this.sql.includes("issuance_attempt_id, issuance_claim_id")) {
        failure.issuance_attempt_id = event.issuance_attempt_id ?? null;
        failure.issuance_claim_id = event.issuance_claim_id ?? null;
        failure.stalled_requeue_epoch_at = event.stalled_requeue_epoch_at ?? null;
      }
      return failure as T;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE id = ?")) {
      return (withWompiIssuanceDefaults(
        this.db.wompiEvents.find((event) => event.id === this.args[0])
      ) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE transaction_id = ?")) {
      return (withWompiIssuanceDefaults(
        this.db.wompiEvents.find((event) => event.transaction_id === this.args[0])
      ) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE payment_link_id = ?")) {
      return (withWompiIssuanceDefaults(
        this.db.wompiEvents.find((event) => event.payment_link_id === this.args[0])
      ) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
      return (this.db.settings.find((setting) => setting.key === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM email_deliveries") && this.sql.includes("email_type = ?")) {
      // Receipt dedupe lookup: either SENT only or any terminal handling evidence.
      const [documentId, emailType, documentStatusAtSend] = this.args.map(String);
      const allowedStatuses = this.sql.includes("status IN ('SENT', 'FAILED')")
        ? new Set(["SENT", "FAILED"])
        : new Set(["SENT"]);
      if (this.db.beforeSentEmailLookup) {
        await this.db.beforeSentEmailLookup(documentId, emailType);
      }
      return (this.db.emailDeliveries.find(
        (row) =>
          row.document_id === documentId &&
          row.email_type === emailType &&
          allowedStatuses.has(String(row.status)) &&
          (!this.sql.includes("document_status_at_send = ?") || row.document_status_at_send === documentStatusAtSend)
      ) ?? null) as T | null;
    }
    if (this.sql.includes("FROM contingency_periods WHERE environment = ?")) {
      const environment = String(this.args[0]);
      return (
        this.db.contingencies
          .filter((period) => period.environment === environment && ["OPEN", "EVENT_ACCEPTED"].includes(String(period.status)))
          .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] ?? null
      ) as T | null;
    }
    if (this.sql.includes("FROM contingency_periods WHERE status IN")) {
      return (
        this.db.contingencies
          .filter((period) => ["OPEN", "EVENT_ACCEPTED"].includes(String(period.status)))
          .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] ?? null
      ) as T | null;
    }
    if (this.sql.includes("UPDATE document_sequences")) {
      return { value: this.db.nextSequence++ } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (
      this.sql.includes("FROM stripe_acknowledgment_deliveries AS delivery") &&
      this.sql.includes("delivery.status IN ('FAILED', 'REVIEW')")
    ) {
      const rows = this.db.stripeAcknowledgmentDeliveries
        .filter((row) => row.status === "FAILED" || row.status === "REVIEW")
        .sort(
          (left, right) =>
            String(right.updated_at).localeCompare(String(left.updated_at)) ||
            String(right.id).localeCompare(String(left.id))
        )
        .slice(0, 50)
        .map((row) => ({
          id: row.id,
          revision: row.revision,
          kind: row.kind,
          status: row.status,
          amount_cents: row.amount_cents,
          evidence_refunded_amount_cents:
            row.evidence_refunded_amount_cents ?? row.refunded_amount_cents ?? 0,
          failure_code: row.failure_code,
          created_at: row.created_at,
          updated_at: row.updated_at
        }));
      return { results: rows as T[] };
    }
    if (
      this.sql.includes("FROM dte_documents") &&
      this.sql.includes("post_accept_finalized_at IS NULL") &&
      this.sql.includes("ORDER BY created_at ASC, id ASC LIMIT ?")
    ) {
      const staleBefore = String(this.args[0]);
      const limit = Number(this.args[1] ?? 100);
      const documents = this.db.documents
        .filter((document) => {
          const handledEvidence = this.db.emailDeliveries.some(
            (delivery) =>
              delivery.document_id === document.id &&
              delivery.email_type === "dteReceipt" &&
              (delivery.status === "SENT" || delivery.status === "FAILED") &&
              delivery.document_status_at_send === "ACCEPTED"
          );
          const claimId = document.post_accept_finalization_claim_id ?? null;
          const claimable =
            claimId === null ||
            (String(document.post_accept_finalization_claimed_at ?? "") < staleBefore &&
              ((document.donor_email ?? null) === null ||
                (document.post_accept_email_dispatch_started_at ?? null) === null ||
                handledEvidence));
          return document.status === "ACCEPTED" &&
            (document.post_accept_finalized_at ?? null) === null &&
            (document.fiscal_operation_claim_id ?? null) === null &&
            claimable;
        })
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)))
        .slice(0, limit)
        .map((document) => ({ ...document }));
      return { results: documents as T[] };
    }
    if (
      this.sql.includes("SELECT d.* FROM dte_documents d") &&
      this.sql.includes("DTE_ACCEPTED_FINALIZED")
    ) {
      const limit = Number(this.args.at(-1));
      const documents = this.db.documents
        .filter(
          (document) =>
            document.status === "ACCEPTED" &&
            document.wompi_event_id != null &&
            !this.db.audits.some(
              (audit) =>
                audit.action === "DTE_ACCEPTED_FINALIZED" &&
                audit.entity_type === "dte_document" &&
                audit.entity_id === document.id
            )
        )
        .sort(
          (left, right) =>
            String(left.accepted_at ?? left.created_at).localeCompare(
              String(right.accepted_at ?? right.created_at)
            ) || left.id.localeCompare(right.id)
        )
        .slice(0, limit);
      return { results: documents as T[] };
    }
    // ----- Analítica (carril Wompi) -----
    // Documentos: dte_documents con wompi_event_id, LEFT JOIN a donation_intents por
    // document_id, filtrado por environment + ventana issued_at, paginado por (issued_at, id).
    if (this.sql.includes("FROM dte_documents d") && this.sql.includes("LEFT JOIN donation_intents i") && this.sql.includes("d.wompi_event_id IS NOT NULL")) {
      const [environment, startIso, endIso] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let documents = this.db.documents.filter(
        (document) =>
          document.wompi_event_id != null &&
          (document.fiscal_operation_claim_id ?? null) === null &&
          document.environment === environment &&
          String(document.issued_at) >= startIso &&
          String(document.issued_at) < endIso
      );
      if (this.sql.includes("(d.issued_at, d.id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[3]), String(this.args[4])];
        documents = documents.filter(
          (document) => String(document.issued_at) > afterIssued || (String(document.issued_at) === afterIssued && String(document.id) > afterId)
        );
      }
      documents.sort((left, right) => String(left.issued_at).localeCompare(String(right.issued_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      this.db.analyticsQueryLimits.push({ reader: "documents", limit });
      const rows = documents
        .slice(0, limit)
        .map((document) => analyticsDocumentRow(document, this.db.donationIntents));
      return { results: rows as T[] };
    }
    // Intents: donation_intents LEFT JOIN dte_documents, filtrado por ventana created_at
    // y (documento en el ambiente O sin documento). Distinguible por la proyección de
    // i.direccion_departamento.
    if (this.sql.includes("FROM donation_intents i") && this.sql.includes("i.direccion_departamento AS direccion_departamento") && this.sql.includes("LEFT JOIN dte_documents d")) {
      const [startIso, endIso, environment] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let intents = this.db.donationIntents.filter((intent) => String(intent.created_at) >= startIso && String(intent.created_at) < endIso);
      intents = intents.filter((intent) => {
        const document = this.db.documents.find((candidate) => candidate.id === intent.document_id);
        return document ? document.environment === environment : true;
      });
      if (this.sql.includes("(i.created_at, i.id) > (?, ?)")) {
        const [afterCreated, afterId] = [String(this.args[3]), String(this.args[4])];
        intents = intents.filter(
          (intent) => String(intent.created_at) > afterCreated || (String(intent.created_at) === afterCreated && String(intent.id) > afterId)
        );
      }
      intents.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      this.db.analyticsQueryLimits.push({ reader: "intents", limit });
      const rows = intents.slice(0, limit).map(analyticsIntentRow);
      return { results: rows as T[] };
    }
    // Emails: email_deliveries JOIN dte_documents (carril Wompi + environment), ventana created_at.
    if (this.sql.includes("FROM email_deliveries e") && this.sql.includes("JOIN dte_documents d")) {
      const [startIso, endIso, environment] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let deliveries = this.db.emailDeliveries.filter((delivery) => {
        const document = this.db.documents.find((candidate) => candidate.id === delivery.document_id);
        return (
          document != null &&
          document.wompi_event_id != null &&
          document.environment === environment &&
          String(delivery.created_at) >= startIso &&
          String(delivery.created_at) < endIso
        );
      });
      if (this.sql.includes("(e.created_at, e.id) > (?, ?)")) {
        const [afterCreated, afterId] = [String(this.args[3]), String(this.args[4])];
        deliveries = deliveries.filter(
          (delivery) => String(delivery.created_at) > afterCreated || (String(delivery.created_at) === afterCreated && String(delivery.id) > afterId)
        );
      }
      deliveries.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      this.db.analyticsQueryLimits.push({ reader: "emails", limit });
      const rows = deliveries.slice(0, limit).map((delivery) => ({
        id: delivery.id,
        document_id: delivery.document_id,
        status: delivery.status,
        created_at: delivery.created_at
      }));
      return { results: rows as T[] };
    }
    if (
      this.sql.includes("FROM donation_intents") &&
      this.sql.includes("status IN ('LINK_CREATED','EXPIRED')") &&
      this.sql.includes("created_at >= ?") &&
      this.sql.includes("updated_at < ?")
    ) {
      const createdAfter = String(this.args[0]);
      const checkedBefore = String(this.args[1]);
      const limit = Number(this.args[2] ?? Number.POSITIVE_INFINITY);
      const rows = this.db.donationIntents
        .filter((intent) =>
          (intent.status === "LINK_CREATED" || intent.status === "EXPIRED") &&
          intent.wompi_id_enlace != null &&
          intent.paid_at == null &&
          typeof intent.created_at === "string" &&
          intent.created_at >= createdAfter &&
          typeof intent.updated_at === "string" &&
          intent.updated_at < checkedBefore
        )
        .sort((left, right) =>
          String(left.updated_at).localeCompare(String(right.updated_at)) ||
          String(left.id).localeCompare(String(right.id))
        )
        .slice(0, limit)
        .map((intent) => ({
          id: intent.id,
          wompi_id_enlace: intent.wompi_id_enlace,
          amount_cents: intent.amount_cents,
          status: intent.status,
          gift_type: intent.gift_type ?? null,
          updated_at: intent.updated_at
        }));
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM donation_intents") && this.sql.includes("status IN ('PENDING','LINK_CREATED')") && this.sql.includes("expires_at < ?")) {
      // listIntentsExpiringBefore: same predicate as the EXPIRED update, projecting
      // the fields the deactivation sweep needs, capped oldest-first by the bound limit.
      const nowIso = String(this.args[0]);
      const limit = Number(this.args[1] ?? Number.POSITIVE_INFINITY);
      const rows = this.db.donationIntents
        .filter((intent) =>
          (intent.status === "PENDING" || intent.status === "LINK_CREATED") &&
          intent.paid_at == null &&
          String(intent.expires_at) < nowIso
        )
        .sort((left, right) => String(left.expires_at).localeCompare(String(right.expires_at)) || String(left.id).localeCompare(String(right.id)))
        .slice(0, limit)
        .map((intent) => ({
          id: intent.id,
          wompi_id_enlace: intent.wompi_id_enlace ?? null,
          amount_cents: intent.amount_cents,
          status: intent.status,
          // Projected so the sweep's deactivate PUT resends the create nombreProducto.
          gift_type: intent.gift_type ?? null
        }));
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM donation_intents") && this.sql.includes("LEFT JOIN dte_documents")) {
      const limit = Number(this.args.at(-1) ?? 50);
      const rows = [...this.db.donationIntents]
        .sort(
          (left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id))
        )
        .slice(0, limit)
        .map((intent) => {
          const document = this.db.documents.find((candidate) => candidate.id === intent.document_id);
          // Mirror the repository's allowlisted projection: the listing exposes only the
          // fields the admin panel renders, never donor PII or payment-link metadata.
          return {
            id: intent.id,
            status: intent.status,
            amount_cents: intent.amount_cents,
            document_id: intent.document_id ?? null,
            gift_type: intent.gift_type ?? null,
            created_at: intent.created_at,
            numero_control: document?.numero_control ?? null,
            document_donor_name: document?.donor_name ?? null
          };
        });
      return { results: rows as T[] };
    }
    if (this.sql.includes("ORDER BY retention_generation.generation ASC")) {
      const table = retentionTableFor(this.db, this.sql) ?? [];
      const afterGeneration = this.sql.includes("retention_generation.generation > ?")
        ? Number(this.args[0])
        : 0;
      const limit = Number(this.args.at(-1) ?? 500);
      return {
        results: table
          .map((row, index) => ({ ...row, __retention_generation: String(index + 1) }))
          .filter((row) => Number(row.__retention_generation) > afterGeneration)
          .slice(0, limit) as T[]
      };
    }
    const orderByMatch = this.sql.match(/ORDER BY (created_at|received_at) ASC, id ASC LIMIT \?/);
    if (orderByMatch) {
      const column = orderByMatch[1];
      const table = retentionTableFor(this.db, this.sql);
      if (table) {
        let rows = [...table];
        const windowRe = new RegExp(`${column} >= \\? AND ${column} < \\?`);
        const cursorRe = new RegExp(`\\(${column}, id\\) > \\(\\?, \\?\\)`);
        if (windowRe.test(this.sql)) {
          const hasCursor = cursorRe.test(this.sql);
          const [start, end] = this.args.map(String);
          rows = rows.filter((row) => String(row[column]) >= start && String(row[column]) < end);
          if (hasCursor) {
            const [afterColumn, afterId] = [this.args[2], this.args[3]].map(String);
            rows = rows.filter((row) => {
              const value = String(row[column]);
              const id = String(row.id);
              return value > afterColumn || (value === afterColumn && id > afterId);
            });
          }
        } else if (cursorRe.test(this.sql)) {
          const [afterColumn, afterId] = [this.args[0], this.args[1]].map(String);
          rows = rows.filter((row) => {
            const value = String(row[column]);
            const id = String(row.id);
            return value > afterColumn || (value === afterColumn && id > afterId);
          });
        }
        rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) || String(left.id).localeCompare(String(right.id)));
        const limit = Number(this.args.at(-1) ?? 500);
        return { results: rows.slice(0, limit) as T[] };
      }
    }
    if (
      this.sql.includes("FROM wompi_events") &&
      this.sql.includes("issuance_error_message IS NOT NULL") &&
      this.sql.includes("issuance_status IN ('FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'PROCESSING')")
    ) {
      const limit = Number(this.args.at(-1));
      const failures = this.db.wompiEvents
        .filter(
          (event) =>
            event.created_document_id == null &&
            event.issuance_error_message != null &&
            ["FAILED", "DEAD_LETTERED", "RETRY_QUEUED", "PROCESSING"].includes(String(event.issuance_status))
        )
        .sort(
          (left, right) =>
            String(right.issuance_failed_at ?? right.received_at).localeCompare(
              String(left.issuance_failed_at ?? left.received_at)
            ) || String(right.id).localeCompare(String(left.id))
        )
        .slice(0, limit)
        .map((event) => wompiIssuanceFailureProjection(withWompiIssuanceDefaults(event)!));
      return { results: failures as T[] };
    }
    if (this.sql.includes("FROM wompi_events") && this.sql.includes("created_document_id IS NULL")) {
      // The real wompi_events schema has no created_at column (only received_at) —
      // require the query to reference the column that actually exists, so a
      // regression back to `created_at < ?` fails here instead of silently
      // matching on a column the fake happens to also carry.
      if (!this.sql.includes("received_at < ?") || this.sql.includes("created_at < ?")) {
        throw new Error(`SQLITE_ERROR: no such column: created_at (simulated) for SQL: ${this.sql}`);
      }
      if (!this.sql.includes("COALESCE(issuance_last_attempt_at, received_at) < ?")) {
        throw new Error(`Stalled Wompi SQL must use the last-attempt cutoff: ${this.sql}`);
      }
      const [receivedCutoff, retryCutoff] = this.args.map(String);
      const stalled = this.db.wompiEvents.filter(
        (event) =>
          event.created_document_id == null &&
          event.result === "ExitosaAprobada" &&
          (
            (
              !event.processed_at &&
              event.issuance_status == null &&
              String(event.received_at) < receivedCutoff
            ) ||
            (
              !event.processed_at &&
              (event.issuance_status === "RETRY_QUEUED" || event.issuance_status === "PROCESSING") &&
              String(event.issuance_last_attempt_at ?? event.received_at) < retryCutoff
            )
          )
      );
      return { results: stalled as T[] };
    }
    if (this.sql.includes("FROM contingency_batches")) {
      let batches = [...this.db.contingencyBatches];
      if (this.sql.includes("WHERE contingency_period_id = ?")) {
        batches = batches.filter((batch) => batch.contingency_period_id === this.args[0]);
      }
      batches.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      return { results: batches as T[] };
    }
    if (this.sql.includes("FROM contingency_batch_lines")) {
      let lines = [...this.db.contingencyBatchLines];
      if (this.sql.includes("WHERE batch_id = ?")) {
        lines = lines.filter((line) => line.batch_id === this.args[0]);
      }
      if (this.sql.includes("WHERE contingency_period_id = ?")) {
        lines = lines.filter((line) => line.contingency_period_id === this.args[0]);
      }
      lines.sort((left, right) => Number(left.line_no ?? 0) - Number(right.line_no ?? 0));
      return { results: lines as T[] };
    }
    if (this.sql.includes("annual_certificate_targets")) {
      let argIndex = 0;
      const startIso = String(this.args[argIndex++]);
      const endIso = String(this.args[argIndex++]);
      let documents = this.db.documents.filter(
        (document) =>
          document.status === "ACCEPTED" &&
          (document.fiscal_operation_claim_id ?? null) === null &&
          document.issued_at >= startIso &&
          document.issued_at < endIso
      );
      if (this.sql.includes("dte_document_search MATCH ?")) {
        const ftsQuery = String(this.args[argIndex++]);
        const matchingKeys = new Set(
          documents
            .filter((document) => documentMatchesFtsQuery(document, ftsQuery))
            .map(annualCertificateRecipientKey)
        );
        documents = documents.filter((document) => matchingKeys.has(annualCertificateRecipientKey(document)));
      }
      const groups = new Map<string, DteDocumentRecord[]>();
      for (const document of documents) {
        const key = annualCertificateRecipientKey(document);
        const existing = groups.get(key);
        if (existing) existing.push(document);
        else groups.set(key, [document]);
      }
      let targets = [...groups.entries()].map(([groupKey, groupDocuments]) => {
        groupDocuments.sort(
          (left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id)
        );
        const earliest = groupDocuments[0];
        const donorEmail = normalizedCertificateText(earliest.donor_email);
        return {
          recipient_key: groupKey,
          donor_name: normalizedCertificateText(earliest.donor_name) ?? donorEmail ?? "(sin identificar)",
          donor_email: donorEmail,
          document_count: groupDocuments.length,
          total_cents: groupDocuments.reduce((total, document) => total + document.amount_cents, 0),
          has_test_environment: groupDocuments.some((document) => document.environment === "00") ? 1 : 0
        };
      });
      if (this.sql.includes("recipient_key = ?")) {
        const groupKey = String(this.args[argIndex++]);
        targets = targets.filter((target) => target.recipient_key === groupKey);
      } else if (this.sql.includes("recipient_key > ?")) {
        const afterGroupKey = String(this.args[argIndex++]);
        targets = targets.filter((target) => target.recipient_key > afterGroupKey);
      }
      if (this.sql.includes("DONOR_CERTIFICATE_SENT")) {
        const year = String(this.args[argIndex++]);
        targets = targets.filter(
          (target) =>
            target.donor_email !== null &&
            !this.db.audits.some(
              (audit) =>
                audit.action === "DONOR_CERTIFICATE_SENT" &&
                audit.entity_id === `${year}:${target.donor_email}`
            )
        );
      }
      targets.sort((left, right) => left.recipient_key.localeCompare(right.recipient_key));
      const limit = Number(this.args.at(-1));
      return { results: targets.slice(0, limit) as T[] };
    }
    if (this.sql.includes("annual_certificate_documents")) {
      const [startIso, endIso, groupKey, rawLimit] = this.args;
      const documents = this.db.documents
        .filter(
          (document) =>
            document.status === "ACCEPTED" &&
            (document.fiscal_operation_claim_id ?? null) === null &&
            document.issued_at >= String(startIso) &&
            document.issued_at < String(endIso) &&
            annualCertificateRecipientKey(document) === String(groupKey)
        )
        .sort(
          (left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id)
        )
        .slice(0, Number(rawLimit));
      return { results: documents as T[] };
    }
    if (this.sql.includes("FROM dte_documents") && this.sql.includes("ORDER BY issued_at ASC, id ASC")) {
      // Annual donor certificate aggregation (Task 4): keyset-paged ACCEPTED-in-year read.
      let documents = this.db.documents.filter(
        (document) =>
          document.status === "ACCEPTED" &&
          (document.fiscal_operation_claim_id ?? null) === null
      );
      const [startIso, endIso] = [String(this.args[0]), String(this.args[1])];
      documents = documents.filter((document) => document.issued_at >= startIso && document.issued_at < endIso);
      if (this.sql.includes("(issued_at, id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[2]), String(this.args[3])];
        documents = documents.filter(
          (document) => document.issued_at > afterIssued || (document.issued_at === afterIssued && document.id > afterId)
        );
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id));
      const limit = Number(this.args.at(-1) ?? 500);
      return { results: documents.slice(0, limit) as T[] };
    }
    if (this.sql.includes("FROM dte_documents") && this.sql.includes("LEFT JOIN donation_intents") && this.sql.includes("ORDER BY dte_documents.issued_at ASC, dte_documents.id ASC")) {
      // CRM contacts export: keyset-paged Wompi-lane ACCEPTED docs for one ambiente,
      // LEFT JOINed to their correlated COMPLETED intent (0 or 1 per document).
      const environment = String(this.args[0]);
      // Binding order mirrors the repository: [environment, startIso, (endIso if
      // windowed), (cursor issued, cursor id if cursor), limit]. Lower bound is always
      // present ("" matches all when unwindowed).
      const startIso = String(this.args[1]);
      let documents = this.db.documents.filter(
        (document) =>
          document.status === "ACCEPTED" &&
          (document.fiscal_operation_claim_id ?? null) === null &&
          document.wompi_event_id != null &&
          document.environment === environment &&
          document.issued_at >= startIso
      );
      let cursorBase = 2;
      if (this.sql.includes("dte_documents.issued_at < ?")) {
        const endIso = String(this.args[2]);
        documents = documents.filter((document) => document.issued_at < endIso);
        cursorBase = 3;
      }
      if (this.sql.includes("(dte_documents.issued_at, dte_documents.id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[cursorBase]), String(this.args[cursorBase + 1])];
        documents = documents.filter(
          (document) => document.issued_at > afterIssued || (document.issued_at === afterIssued && document.id > afterId)
        );
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id));
      const limit = Number(this.args.at(-1) ?? 500);
      const joined = documents.slice(0, limit).map((document) => {
        const intent = this.db.donationIntents.find(
          (candidate) => candidate.document_id === document.id && candidate.status === "COMPLETED"
        );
        return {
          id: document.id,
          donor_email: document.donor_email,
          donor_name: document.donor_name,
          amount_cents: document.amount_cents,
          issued_at: document.issued_at,
          intent_donor_phone: intent?.donor_phone ?? null,
          intent_direccion_complemento: intent?.direccion_complemento ?? null,
          intent_direccion_departamento: intent?.direccion_departamento ?? null,
          intent_donor_pais: intent?.donor_pais ?? null,
          intent_gift_type: intent?.gift_type ?? null,
          intent_created_at: intent?.created_at ?? null
        };
      });
      return { results: joined as T[] };
    }
    if (this.sql.includes("FROM dte_documents")) {
      let documents = [...this.db.documents];
      if (
        this.sql.includes("status = 'SIGNED' AND (transmission_deferred_at IS NOT NULL OR wompi_event_id IS NOT NULL)") &&
        this.sql.includes("status = 'TRANSMITTED'") &&
        this.sql.includes("updated_at < ?")
      ) {
        const staleBefore = String(this.args[0]);
        const limit = Number(this.args[1] ?? 100);
        documents = documents.filter((document) =>
          (
            document.status === "SIGNED" &&
            (document.transmission_deferred_at != null || document.wompi_event_id != null)
          ) ||
          (document.status === "TRANSMITTED" && document.sello_recibido == null && document.updated_at < staleBefore)
        );
        documents.sort((left, right) =>
          String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id))
        );
        return { results: documents.slice(0, limit) as T[] };
      }
      if (this.sql.includes("ORDER BY dte_documents.created_at DESC, dte_documents.id DESC")) {
        let argIndex = 0;
        const latestReceipt = (documentId: string) =>
          this.db.emailDeliveries
            .filter(
              (delivery) =>
                delivery.document_id === documentId &&
                (delivery.email_type === "dteReceipt" || delivery.email_type === "dteReceiptTransitorio")
            )
            .sort((left, right) => {
              const attemptOrder = Number(right.attempt_no ?? 1) - Number(left.attempt_no ?? 1);
              if (attemptOrder !== 0) return attemptOrder;
              const leftAttemptedAt = String(
                left.finalized_at ?? left.claim_attempted_at ?? left.created_at ?? ""
              );
              const rightAttemptedAt = String(
                right.finalized_at ?? right.claim_attempted_at ?? right.created_at ?? ""
              );
              return (
                rightAttemptedAt.localeCompare(leftAttemptedAt) ||
                String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")) ||
                String(right.id ?? "").localeCompare(String(left.id ?? ""))
              );
            })[0];
        if (
          this.sql.includes("dte_documents.status IN ('FAILED', 'REJECTED')") &&
          this.sql.includes("latest_receipt.status = 'FAILED'")
        ) {
          documents = documents.filter((document) => {
            if (document.status === "FAILED" || document.status === "REJECTED") return true;
            const receipt = latestReceipt(document.id);
            return document.status === "ACCEPTED" && (
              receipt?.status === "FAILED" ||
              (
                receipt?.status === "PENDING" &&
                receipt.provider_dispatch_started_at != null
              )
            );
          });
        } else if (this.sql.includes("dte_documents.status = 'SIGNED' AND dte_documents.transmission_deferred_at IS NOT NULL")) {
          // Virtual "TRANSMISSION_PENDING" filter: deferred docs only, not plain SIGNED.
          documents = documents.filter((document) => document.status === "SIGNED" && document.transmission_deferred_at != null);
        } else if (this.sql.includes("status IN")) {
          const statusPlaceholderList = this.sql.match(/status IN \(([^)]*)\)/)?.[1] ?? "";
          const statusCount = (statusPlaceholderList.match(/\?/g) ?? []).length;
          const statuses = this.args.slice(argIndex, argIndex + statusCount).map(String);
          argIndex += statusCount;
          documents = documents.filter((document) => statuses.includes(String(document.status)));
        } else if (this.sql.includes("status = ?")) {
          const status = String(this.args[argIndex]);
          argIndex += 1;
          documents = documents.filter((document) => document.status === status);
        }
        if (this.sql.includes("dte_document_search MATCH ?")) {
          const ftsQuery = String(this.args[argIndex] ?? "");
          argIndex += 1;
          documents = documents.filter((document) => documentMatchesFtsQuery(document, ftsQuery));
        }
        if (this.sql.includes("created_at < ?")) {
          const createdAt = String(this.args[argIndex]);
          const id = String(this.args[argIndex + 2]);
          documents = documents.filter((document) => document.created_at < createdAt || (document.created_at === createdAt && document.id < id));
        }
        const limit = Number(this.args.at(-1) ?? 100);
        documents.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
        return {
          results: documents.slice(0, limit).map((document) => ({
            ...document,
            receipt_email_status: latestReceipt(document.id)?.status ?? null,
            receipt_email_outcome_class: latestReceipt(document.id)?.outcome_class ?? null,
            receipt_email_failure_code: latestReceipt(document.id)?.failure_code ?? null,
            receipt_email_retry_safe: latestReceipt(document.id)?.retry_safe ?? null,
            receipt_email_requires_review: (() => {
              const receipt = latestReceipt(document.id);
              return (
                (
                  receipt?.status === "PENDING" &&
                  receipt.provider_dispatch_started_at != null
                ) ||
                (
                  receipt?.status === "FAILED" &&
                  ((receipt.outcome_class ?? null) === null || receipt.outcome_class === "UNKNOWN")
                )
              ) ? 1 : 0;
            })()
          })) as T[]
        };
      }
      if (this.sql.includes("status = ?")) {
        const status = String(this.args[0]);
        documents = documents.filter((document) => document.status === status);
      }
      if (this.sql.includes("transmission_deferred_at IS NOT NULL")) {
        documents = documents.filter((document) => document.transmission_deferred_at != null);
      }
      if (this.sql.includes("contingency_period_id = ?")) {
        const periodId = String(this.args[0]);
        documents = documents.filter((document) => document.contingency_period_id === periodId && document.status === "CONTINGENCY_PENDING");
      }
      if (this.sql.includes("status = 'CONTINGENCY_PENDING'")) {
        documents = documents.filter((document) => document.status === "CONTINGENCY_PENDING");
      }
      if (this.sql.includes("status = 'ACCEPTED'")) {
        documents = documents.filter((document) => document.status === "ACCEPTED");
      }
      if (this.sql.includes("fiscal_operation_claim_id IS NULL")) {
        documents = documents.filter((document) => (document.fiscal_operation_claim_id ?? null) === null);
      }
      if (this.sql.includes("sello_recibido IS NOT NULL")) {
        documents = documents.filter((document) => document.sello_recibido !== null);
      }
      if (this.sql.includes("issued_at >= ?") && this.sql.includes("issued_at < ?")) {
        const start = String(this.args[1]);
        const end = String(this.args[2]);
        documents = documents.filter((document) => document.issued_at >= start && document.issued_at < end);
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at));
      return { results: documents as T[] };
    }
    if (this.sql.includes("FROM contingency_periods")) {
      const limit = Number(this.args[0] ?? 100);
      const periods = [...this.db.contingencies]
        .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))
        .slice(0, limit);
      return { results: periods as T[] };
    }
    if (this.sql.includes("FROM dte_events")) {
      const eventType = String(this.args[0]);
      const limit = Number(this.args[1] ?? 100);
      const events = this.db.dteEvents
        .filter((event) => event.event_type === eventType)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .slice(0, limit);
      return { results: events as T[] };
    }
    if (this.sql.includes("FROM audit_logs")) {
      let audits = [...this.db.audits];
      let argIndex = 0;
      if (this.sql.includes("a.entity_type = ? AND a.entity_id = ?")) {
        audits = audits.filter((audit) => audit.entity_type === this.args[0] && audit.entity_id === this.args[1]);
        argIndex = 2;
      }
      if (this.sql.includes("(a.created_at, a.id) < (?, ?)")) {
        const cursorCreated = String(this.args[argIndex]);
        const cursorId = String(this.args[argIndex + 1]);
        argIndex += 2;
        audits = audits.filter((audit) => {
          const created = String(audit.created_at);
          return created < cursorCreated || (created === cursorCreated && String(audit.id) < cursorId);
        });
      }
      audits.sort(
        (left, right) =>
          String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id))
      );
      if (this.sql.includes("ORDER BY a.created_at DESC, a.id DESC LIMIT ?")) {
        audits = audits.slice(0, Number(this.args[argIndex] ?? 100));
      }
      // Mirror the LEFT JOIN users ON u.id = a.actor_id: USER rows resolve to a name/email,
      // SYSTEM rows (and deleted-actor rows) keep NULLs.
      const joined = audits.map((audit) => {
        const actor = this.db.users.find((user) => user.id === audit.actor_id);
        return {
          ...audit,
          actor_name: actor?.name ?? null,
          actor_email: actor?.email ?? null
        };
      });
      return { results: joined as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<StatementRunResult> {
    let changes = 0;
    if (
      this.sql.includes("UPDATE stripe_acknowledgment_deliveries") &&
      this.sql.includes("owner_confirmed_not_sent")
    ) {
      const resolution = String(this.args[0]);
      const now = String(this.args[2]);
      const id = String(this.args[11]);
      const row = this.db.stripeAcknowledgmentDeliveries.find(
        (candidate) => candidate.id === id &&
          (candidate.status === "FAILED" || candidate.status === "REVIEW")
      );
      const evidenceRefunded = Number(
        row?.evidence_refunded_amount_cents ?? row?.refunded_amount_cents ?? 0
      );
      const currentRefunded = Number(row?.refunded_amount_cents ?? evidenceRefunded);
      if (row && (resolution === "CONFIRMED_SENT" || evidenceRefunded === currentRefunded)) {
        row.status = resolution === "CONFIRMED_SENT" ? "SENT" : "FAILED";
        row.processing_claim_id = null;
        row.dispatch_started_at = resolution === "CONFIRMED_SENT"
          ? row.dispatch_started_at ?? now
          : null;
        row.provider_id_hash = resolution === "CONFIRMED_SENT"
          ? row.provider_id_hash ?? "owner-confirmed"
          : null;
        row.failure_code = resolution === "CONFIRMED_SENT" ? null : "owner_confirmed_not_sent";
        row.retry_safe = resolution === "CONFIRMED_NOT_SENT" ? 1 : 0;
        row.next_attempt_at = resolution === "CONFIRMED_NOT_SENT" ? now : null;
        row.sent_at = resolution === "CONFIRMED_SENT" ? row.sent_at ?? now : null;
        row.updated_at = now;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE operational_alert_deliveries") &&
      this.sql.includes("SET status = ?, finalized_at = ?")
    ) {
      const [
        status,
        finalizedAt,
        outcomeClass,
        failureCode,
        retrySafe,
        id,
        claimToken
      ] = this.args;
      const row = this.db.alertDeliveries.find(
        (delivery) =>
          delivery.id === id &&
          delivery.status === "PENDING" &&
          delivery.claim_token === claimToken
      );
      if (row) {
        row.status = status;
        row.finalized_at = finalizedAt;
        row.outcome_class = outcomeClass;
        row.failure_code = failureCode;
        row.retry_safe = retrySafe;
        changes = 1;
      }
    }
    if (
      this.sql.includes("INSERT INTO dte_events") &&
      this.sql.includes("FROM dte_documents") &&
      this.sql.includes("fiscal_operation_kind = 'INVALIDATION'")
    ) {
      const [eventId, environment, codigoGeneracion, plainJson, signedJws, legalDeadlineAt, createdBy, documentId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          (row.fiscal_operation_event_id ?? null) === null
      );
      if (document) {
        this.db.dteEvents.push({
          id: eventId,
          document_id: documentId,
          event_type: "INVALIDACION",
          environment,
          codigo_generacion: codigoGeneracion,
          status: "SIGNED",
          plain_json: plainJson,
          signed_jws: signedJws,
          sello_recibido: null,
          mh_estado: null,
          mh_observaciones_json: "[]",
          legal_deadline_at: legalDeadlineAt,
          created_by: createdBy,
          created_at: "2026-06-26T01:46:47.015Z",
          accepted_at: null
        });
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET fiscal_operation_event_id = ?, updated_at = ?") &&
      this.sql.includes("EXISTS (")
    ) {
      const [eventId, updatedAt, documentId, claimId, eventGuardId] = this.args;
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventGuardId &&
          row.document_id === documentId &&
          row.event_type === "INVALIDACION" &&
          row.status === "SIGNED"
      );
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          (row.fiscal_operation_event_id ?? null) === null
      );
      if (document && event) {
        document.fiscal_operation_event_id = eventId == null ? null : String(eventId);
        document.updated_at = String(updatedAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE dte_events") &&
      this.sql.includes("SET status = 'FAILED'") &&
      this.sql.includes("PRE_DISPATCH_FAILED")
    ) {
      const [observacionesJson, eventId, documentId, documentGuardId, claimId, eventGuardId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentGuardId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          row.fiscal_operation_event_id === eventGuardId
      );
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventId &&
          row.document_id === documentId &&
          row.event_type === "INVALIDACION" &&
          row.status === "SIGNED"
      );
      if (document && event) {
        event.status = "FAILED";
        event.sello_recibido = null;
        event.mh_estado = "PRE_DISPATCH_FAILED";
        event.mh_observaciones_json = observacionesJson;
        event.accepted_at = null;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("fiscal_operation_claim_id = NULL") &&
      this.sql.includes("PRE_DISPATCH_FAILED")
    ) {
      const [updatedAt, documentId, claimId, eventId, eventGuardId] = this.args;
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventGuardId &&
          row.document_id === documentId &&
          row.event_type === "INVALIDACION" &&
          row.status === "FAILED" &&
          row.mh_estado === "PRE_DISPATCH_FAILED"
      );
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          row.fiscal_operation_event_id === eventId
      );
      if (document && event) {
        document.fiscal_operation_claim_id = null;
        document.fiscal_operation_claimed_at = null;
        document.fiscal_operation_kind = null;
        document.fiscal_operation_event_id = null;
        document.updated_at = String(updatedAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE dte_events") &&
      this.sql.includes("SET status = ?") &&
      this.sql.includes("event_type = 'INVALIDACION'")
    ) {
      const [status, sello, mhEstado, observacionesJson, acceptedAt, eventId, documentId, documentGuardId, claimId, eventGuardId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentGuardId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          row.fiscal_operation_event_id === eventGuardId
      );
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventId &&
          row.document_id === documentId &&
          row.event_type === "INVALIDACION" &&
          row.status === "SIGNED"
      );
      if (document && event) {
        event.status = status;
        event.sello_recibido = sello;
        event.mh_estado = mhEstado;
        event.mh_observaciones_json = observacionesJson;
        event.accepted_at = acceptedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = ?, fiscal_operation_claim_id = NULL") &&
      this.sql.includes("event_type = 'INVALIDACION'")
    ) {
      const [status, updatedAt, documentId, claimId, eventId, eventGuardId, eventStatus] = this.args;
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventGuardId &&
          row.document_id === documentId &&
          row.event_type === "INVALIDACION" &&
          row.status === eventStatus
      );
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === "ACCEPTED" &&
          row.fiscal_operation_claim_id === claimId &&
          row.fiscal_operation_kind === "INVALIDATION" &&
          row.fiscal_operation_event_id === eventId
      );
      if (document && event) {
        document.status = String(status);
        document.fiscal_operation_claim_id = null;
        document.fiscal_operation_claimed_at = null;
        document.fiscal_operation_kind = null;
        document.fiscal_operation_event_id = null;
        document.updated_at = String(updatedAt);
        changes = 1;
      }
    }
    if (this.sql.includes("DELETE FROM security_rate_limit_claims")) {
      const [now] = this.args.map(String);
      for (let index = this.db.securityRateLimitClaims.length - 1; index >= 0; index -= 1) {
        if (this.db.securityRateLimitClaims[index].expires_at <= now) {
          this.db.securityRateLimitClaims.splice(index, 1);
          changes += 1;
        }
      }
    }
    if (this.sql.includes("INSERT OR IGNORE INTO document_sequences")) {
      this.db.sequencePrefixes.push(String(this.args[1]));
    }
    if (this.sql.includes("DELETE FROM login_rate_limits")) {
      const [now] = this.args.map(String);
      for (const [key, row] of this.db.loginRateLimits) {
        if (row.expires_at <= now) {
          this.db.loginRateLimits.delete(key);
          changes += 1;
        }
      }
    }
    if (this.sql.includes("INSERT INTO users")) {
      const [id, email, name, role, passwordHash, passwordSalt] = this.args.map(String);
      this.db.users.push({
        id,
        email,
        name,
        role,
        password_hash: passwordHash,
        password_salt: passwordSalt,
        disabled_at: ""
      });
    }
    if (this.sql.includes("INSERT INTO password_reset_tokens")) {
      const [id, tokenHash, expiresAt, userId, expectedEmail, expectedAuthGeneration, expectedPasswordHash, expectedPasswordSalt] = this.args;
      const user = this.db.users.find(
        (row) =>
          row.id === userId &&
          !row.disabled_at &&
          row.email === expectedEmail &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration) &&
          row.password_hash === expectedPasswordHash &&
          row.password_salt === expectedPasswordSalt
      );
      if (user) {
        this.db.resetTokens.push({ id: String(id), user_id: String(userId), token_hash: String(tokenHash), expires_at: String(expiresAt), used_at: null });
        changes = 1;
      }
    }
    if (
      this.sql.includes("DELETE FROM sessions") &&
      this.sql.includes("revoked_at IS NOT NULL OR expires_at <= ?")
    ) {
      const [userId, expiresAt, guardUserId, passwordHash, passwordSalt, expectedEmail, expectedAuthGeneration] = this.args;
      const currentCredentials = this.db.users.some(
        (row) =>
          row.id === guardUserId &&
          !row.disabled_at &&
          row.password_hash === passwordHash &&
          row.password_salt === passwordSalt &&
          row.email === expectedEmail &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration)
      );
      if (currentCredentials) {
        for (let index = this.db.sessions.length - 1; index >= 0; index -= 1) {
          const session = this.db.sessions[index];
          if (
            session.user_id === userId &&
            (Boolean(session.revoked_at) || String(session.expires_at) <= String(expiresAt))
          ) {
            this.db.sessions.splice(index, 1);
            changes += 1;
          }
        }
      }
    }
    if (
      this.sql.includes("DELETE FROM sessions") &&
      this.sql.includes("LIMIT -1 OFFSET 7")
    ) {
      const [userId, expiresAt, guardUserId, passwordHash, passwordSalt, expectedEmail, expectedAuthGeneration] = this.args;
      const currentCredentials = this.db.users.some(
        (row) =>
          row.id === guardUserId &&
          !row.disabled_at &&
          row.password_hash === passwordHash &&
          row.password_salt === passwordSalt &&
          row.email === expectedEmail &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration)
      );
      if (currentCredentials) {
        const prunedIds = new Set(
          this.db.sessions
            .filter(
              (row) =>
                row.user_id === userId &&
                !row.revoked_at &&
                String(row.expires_at) > String(expiresAt)
            )
            .sort(
              (left, right) =>
                String(right.created_at).localeCompare(String(left.created_at)) ||
                String(right.id).localeCompare(String(left.id))
            )
            .slice(7)
            .map((row) => row.id)
        );
        for (let index = this.db.sessions.length - 1; index >= 0; index -= 1) {
          if (prunedIds.has(this.db.sessions[index].id)) {
            this.db.sessions.splice(index, 1);
            changes += 1;
          }
        }
      }
    }
    if (
      this.sql.includes("INSERT INTO sessions") &&
      this.sql.includes("password_hash = ?") &&
      this.sql.includes("password_salt = ?")
    ) {
      const [id, tokenHash, expiresAt, createdAt, userId, passwordHash, passwordSalt, expectedEmail, expectedAuthGeneration] = this.args;
      const user = this.db.users.find(
        (row) =>
          row.id === userId &&
          !row.disabled_at &&
          row.password_hash === passwordHash &&
          row.password_salt === passwordSalt &&
          row.email === expectedEmail &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration)
      );
      if (user) {
        this.db.sessions.push({
          id,
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          created_at: createdAt,
          revoked_at: null
        });
        changes = 1;
      }
    }
    if (this.sql.includes("UPDATE password_reset_tokens") && this.sql.includes("SET used_at = ?")) {
      if (this.sql.includes("WHERE user_id = ?")) {
        const [usedAt, userId, markerUserId, expectedValue, expectedState, expectedVersion, expectedSalt] = this.args;
        const marker = !this.sql.includes("EXISTS (")
          ? true
          : this.sql.includes("AND email = ?") && this.sql.includes("AND password_hash = ?")
            ? this.db.users.some(
                (row) =>
                  row.id === markerUserId &&
                  row.email === expectedValue &&
                  !row.disabled_at &&
                  Number(row.auth_generation ?? 0) === Number(expectedState) &&
                  row.password_hash === expectedVersion &&
                  row.password_salt === expectedSalt
              )
            : this.sql.includes("AND email = ?")
              ? this.db.users.some(
                  (row) =>
                    row.id === markerUserId &&
                    row.email === expectedValue &&
                    (row.disabled_at ?? null) === (expectedState ?? null) &&
                    Number(row.auth_generation ?? 0) === Number(expectedVersion)
                )
            : this.db.users.some(
                (row) =>
                  row.id === markerUserId &&
                  row.password_hash === expectedValue &&
                  row.password_salt === expectedState &&
                  row.updated_at === expectedVersion
              );
        if (marker) {
          for (const token of this.db.resetTokens.filter((row) => row.user_id === userId && !row.used_at)) {
            token.used_at = usedAt;
            changes += 1;
          }
        }
      } else {
        const [usedAt, id] = this.args.map(String);
        const token = this.db.resetTokens.find((row) => row.id === id);
        if (token) {
          token.used_at = usedAt;
          changes += 1;
        }
      }
    }
    if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("SELECT ?, 'USER'") &&
      this.sql.includes("event_type = 'INVALIDACION'")
    ) {
      const [id, actorId, action, entityId, summary, metadataJson, eventId, eventDocumentId, eventStatus, documentId, documentStatus] = this.args;
      const event = this.db.dteEvents.find(
        (row) =>
          row.id === eventId &&
          row.document_id === eventDocumentId &&
          row.event_type === "INVALIDACION" &&
          row.status === eventStatus
      );
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.status === documentStatus &&
          (row.fiscal_operation_claim_id ?? null) === null
      );
      if (event && document && !this.db.audits.some((audit) => audit.id === id)) {
        this.db.audits.push({
          id,
          actor_type: "USER",
          actor_id: actorId,
          action,
          entity_type: "dte_document",
          entity_id: entityId,
          summary,
          metadata_json: metadataJson,
          actor_ip: null,
          actor_context: null,
          rate_limit_claim_id: null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("DONATION_INTENT_BINDING_REJECTED") &&
      this.sql.includes("processed_at IS NULL")
    ) {
      const [id, entityId, summary, metadataJson, eventGuardId, auditGuardEntityId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) => row.id === eventGuardId && row.processed_at == null
      );
      const existingAudit = this.db.audits.some(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === auditGuardEntityId
      );
      const idConflict = this.db.audits.some((row) => row.id === id);
      if (event && !existingAudit && !idConflict) {
        this.db.audits.push({
          id,
          actor_type: "SYSTEM",
          actor_id: null,
          action: "DONATION_INTENT_BINDING_REJECTED",
          entity_type: "wompi_event",
          entity_id: entityId,
          summary,
          metadata_json: metadataJson,
          actor_ip: null,
          actor_context: null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("WOMPI_ISSUANCE_RETRY_QUEUED") &&
      this.sql.includes("issuance_attempt_id = ?")
    ) {
      const [id, actorId, summary, metadataJson, actorIp, actorContext, eventId, attemptId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === eventId &&
          row.created_document_id == null &&
          row.issuance_status === "RETRY_QUEUED" &&
          row.issuance_attempt_id === attemptId
      );
      if (event) {
        this.db.audits.push({
          id,
          actor_type: "USER",
          actor_id: actorId,
          action: "WOMPI_ISSUANCE_RETRY_QUEUED",
          entity_type: "wompi_event",
          entity_id: eventId,
          summary,
          metadata_json: metadataJson,
          actor_ip: actorIp ?? null,
          actor_context: actorContext ?? null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("WOMPI_ISSUANCE_FAILED")
    ) {
      const [id, summary, metadataJson, eventId, failedAt, attemptId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === eventId &&
          row.created_document_id == null &&
          row.issuance_failed_at === failedAt &&
          row.issuance_attempt_id === attemptId &&
          row.issuance_status === "FAILED"
      );
      if (event) {
        this.db.audits.push({
          id,
          actor_type: "SYSTEM",
          actor_id: null,
          action: "WOMPI_ISSUANCE_FAILED",
          entity_type: "wompi_event",
          entity_id: event.id,
          summary,
          metadata_json: metadataJson,
          actor_ip: null,
          actor_context: null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("FROM wompi_events") &&
      this.sql.includes("issuance_attempt_id = ?")
    ) {
      const [id, action, summary, metadataJson, eventId, attemptId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === eventId &&
          row.created_document_id == null &&
          row.issuance_attempt_id === attemptId
      );
      if (event) {
        this.db.audits.push({
          id,
          actor_type: "SYSTEM",
          actor_id: null,
          action,
          entity_type: "wompi_event",
          entity_id: eventId,
          summary,
          metadata_json: metadataJson,
          actor_ip: null,
          actor_context: null,
          created_at: this.db.auditCreatedAt
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("episode_member.key = 'stalledRequeueEpochAt'") &&
      this.sql.includes("WHERE NOT EXISTS")
    ) {
      const [
        id,
        actorType,
        actorId,
        action,
        entityType,
        entityId,
        summary,
        metadataJson,
        actorIp,
        actorContext,
        rateLimitClaimId,
        guardAction,
        guardEntityType,
        guardEntityId,
        rawEpisodeId,
        ,
        rawExclusiveBoundary
      ] = this.args;
      if (this.db.failNextAuditAction === action) {
        this.db.failNextAuditAction = null;
        throw new Error(`injected ${String(action)} audit failure`);
      }
      const episodeId = rawEpisodeId == null ? null : String(rawEpisodeId);
      const exclusiveBoundary = rawExclusiveBoundary == null
        ? null
        : String(rawExclusiveBoundary);
      const exists = this.db.audits.some((audit) => {
        const auditEpisodeId = auditStalledRequeueEpisodeId(audit);
        return audit.action === guardAction &&
          audit.entity_type === guardEntityType &&
          audit.entity_id === guardEntityId &&
          (
            episodeId === null ||
            auditEpisodeId === episodeId ||
            (
              auditEpisodeId === null &&
              exclusiveBoundary !== null &&
              String(audit.created_at) > exclusiveBoundary
            )
          );
      });
      if (!exists) {
        this.db.audits.push({
          id,
          actor_type: actorType,
          actor_id: actorId,
          action,
          entity_type: entityType,
          entity_id: entityId,
          summary,
          metadata_json: metadataJson,
          actor_ip: actorIp ?? null,
          actor_context: actorContext ?? null,
          rate_limit_claim_id: rateLimitClaimId ?? null,
          created_at: this.db.auditCreatedAt
        });
        changes = 1;
      }
    } else if (
      this.sql.includes("INSERT INTO audit_logs") &&
      this.sql.includes("WHERE NOT EXISTS")
    ) {
      const [
        id,
        actorType,
        actorId,
        action,
        entityType,
        entityId,
        summary,
        metadataJson,
        actorIp,
        actorContext
      ] = this.args;
      const exists = this.db.audits.some(
        (audit) =>
          audit.action === action &&
          audit.entity_type === entityType &&
          audit.entity_id === entityId
      );
      if (!exists) {
        this.db.audits.push({
          id,
          actor_type: actorType,
          actor_id: actorId,
          action,
          entity_type: entityType,
          entity_id: entityId,
          summary,
          metadata_json: metadataJson,
          actor_ip: actorIp ?? null,
          actor_context: actorContext ?? null,
          created_at: "2026-06-26T01:46:47.015Z"
        });
        changes = 1;
      }
    } else if (this.sql.includes("INSERT INTO audit_logs")) {
      const [id, actorType, actorId, action, entityType, entityId, summary, metadataJson, actorIp, actorContext, rateLimitClaimId] = this.args;
      if (this.db.failNextAuditAction === action) {
        this.db.failNextAuditAction = null;
        throw new Error(`injected ${String(action)} audit failure`);
      }
      this.db.audits.push({
        id,
        actor_type: actorType,
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata_json: metadataJson,
        actor_ip: actorIp ?? null,
        actor_context: actorContext ?? null,
        rate_limit_claim_id: rateLimitClaimId ?? null,
        created_at: this.db.auditCreatedAt
      });
    }
    if (this.sql.includes("INSERT INTO app_settings")) {
      const [key, value, updatedBy, updatedAt] = this.args;
      const setting = this.db.settings.find((row) => row.key === key);
      if (setting) {
        setting.value = value;
        setting.updated_by = updatedBy;
        setting.updated_at = updatedAt;
      } else {
        this.db.settings.push({ key, value, updated_by: updatedBy, updated_at: updatedAt });
      }
    }
    if (
      this.sql.includes("INSERT INTO email_deliveries") &&
      this.sql.includes("WHERE NOT EXISTS")
    ) {
      const [
        id,
        documentId,
        toEmail,
        emailType,
        documentStatusAtSend
      ] = this.args;
      const exists = this.db.emailDeliveries.some(
        (delivery) =>
          delivery.document_id === documentId &&
          delivery.email_type === emailType &&
          (delivery.status === "PENDING" || delivery.status === "SENT")
      );
      if (!exists) {
        this.db.emailDeliveries.push({
          id,
          document_id: documentId,
          to_email: toEmail,
          status: "PENDING",
          provider_response_json: "{}",
          sent_at: null,
          email_type: emailType,
          document_status_at_send: documentStatusAtSend,
          template_version: null,
          pdf_renderer_version: null,
          pdf_sha256: null,
          dte_json_sha256: null,
          provider_delivery_id: null
        });
        changes = 1;
      }
    } else if (this.sql.includes("INSERT INTO email_deliveries")) {
      const [
        id,
        documentId,
        toEmail,
        status,
        providerResponseJson,
        sentAt,
        emailType,
        documentStatusAtSend,
        templateVersion,
        pdfRendererVersion,
        pdfSha256,
        dteJsonSha256,
        providerDeliveryId
      ] = this.args;
      this.db.emailDeliveries.push({
        id,
        document_id: documentId,
        to_email: toEmail,
        status,
        provider_response_json: providerResponseJson,
        sent_at: sentAt,
        email_type: emailType,
        document_status_at_send: documentStatusAtSend,
        template_version: templateVersion,
        pdf_renderer_version: pdfRendererVersion,
        pdf_sha256: pdfSha256,
        dte_json_sha256: dteJsonSha256,
        provider_delivery_id: providerDeliveryId
      });
      changes = 1;
    }
    if (
      this.sql.includes("UPDATE email_deliveries") &&
      this.sql.includes("status = 'PENDING'")
    ) {
      const [
        status,
        providerResponseJson,
        sentAt,
        finalizedAt,
        emailType,
        documentStatusAtSend,
        templateVersion,
        pdfRendererVersion,
        pdfSha256,
        dteJsonSha256,
        providerDeliveryId,
        outcomeClass,
        failureCode,
        retrySafe,
        id,
        claimToken
      ] = this.args;
      const delivery = this.db.emailDeliveries.find(
        (row) =>
          row.id === id &&
          row.status === "PENDING" &&
          row.claim_token === claimToken
      );
      if (delivery) {
        delivery.status = status;
        delivery.provider_response_json = providerResponseJson;
        delivery.sent_at = sentAt;
        delivery.finalized_at = finalizedAt;
        delivery.email_type = emailType;
        delivery.document_status_at_send = documentStatusAtSend;
        delivery.template_version = templateVersion;
        delivery.pdf_renderer_version = pdfRendererVersion;
        delivery.pdf_sha256 = pdfSha256;
        delivery.dte_json_sha256 = dteJsonSha256;
        delivery.provider_delivery_id = providerDeliveryId;
        delivery.outcome_class = outcomeClass;
        delivery.failure_code = failureCode;
        delivery.retry_safe = retrySafe;
        changes = 1;
      }
    }
    if (this.sql.includes("INSERT") && this.sql.includes("INTO wompi_events")) {
      const [
        id,
        transactionId,
        paymentLinkId,
        environment,
        result,
        amountCents,
        donorEmail,
        donorName,
        rawBody,
        headersJson
      ] = this.args;
      const duplicate = this.db.wompiEvents.some(
        (event) =>
          event.transaction_id === transactionId ||
          (paymentLinkId != null && event.payment_link_id === paymentLinkId)
      );
      if (!duplicate) {
        this.db.wompiEvents.push({
          id,
          transaction_id: transactionId,
          payment_link_id: paymentLinkId,
          environment,
          result,
          amount_cents: amountCents,
          donor_email: donorEmail,
          donor_name: donorName,
          raw_body: rawBody,
          headers_json: headersJson,
          received_at: "2026-06-26T01:46:47.015Z",
          processed_at: null,
          created_document_id: null
        });
        changes = 1;
      }
    }
    if (this.sql.includes("INSERT INTO donation_intents")) {
      const [
        id,
        amountCents,
        donorName,
        donorDocumentType,
        donorDocument,
        donorEmail,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        clientIp,
        expiresAt,
        giftType,
        datosTokenHash,
        rateLimitClaimId
      ] = this.args;
      this.db.donationIntents.push({
        id: String(id),
        status: "PENDING",
        amount_cents: Number(amountCents),
        donor_name: donorName == null ? null : String(donorName),
        donor_document_type: String(donorDocumentType),
        // Document + address are nullable now (0015): a draft binds them null.
        donor_document: donorDocument == null ? null : String(donorDocument),
        donor_email: donorEmail == null ? null : String(donorEmail),
        donor_phone: donorPhone == null ? null : String(donorPhone),
        direccion_departamento: direccionDepartamento == null ? null : String(direccionDepartamento),
        direccion_municipio: direccionMunicipio == null ? null : String(direccionMunicipio),
        direccion_distrito: direccionDistrito == null ? null : String(direccionDistrito),
        direccion_complemento: direccionComplemento == null ? null : String(direccionComplemento),
        donor_pais: donorPais == null ? null : String(donorPais),
        // gift_type is the last bound arg (appended by migration 0012).
        gift_type: giftType == null ? null : String(giftType),
        wompi_id_enlace: null,
        wompi_url_enlace: null,
        wompi_url_enlace_largo: null,
        document_id: null,
        client_ip: clientIp == null ? null : String(clientIp),
        datos_token_hash: datosTokenHash == null ? null : String(datosTokenHash),
        rate_limit_claim_id: rateLimitClaimId == null ? null : String(rateLimitClaimId),
        // paid_at (migration 0016): stamped only by the webhook's markIntentPaid,
        // never on create — a fresh intent has not been paid.
        paid_at: null,
        created_at: "2026-06-26T01:46:47.015Z",
        updated_at: "2026-06-26T01:46:47.015Z",
        expires_at: String(expiresAt)
      });
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("donor_document_type = ?") && this.sql.includes("direccion_departamento = ?")) {
      // The /datos completion: attaches donor data, leaving amount/gift_type/status/link untouched.
      const [
        donorDocumentType,
        donorDocument,
        donorName,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        updatedAt,
        id
      ] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (intent) {
        intent.donor_document_type = String(donorDocumentType);
        intent.donor_document = donorDocument == null ? null : String(donorDocument);
        intent.donor_name = donorName == null ? null : String(donorName);
        intent.donor_phone = donorPhone == null ? null : String(donorPhone);
        intent.direccion_departamento = direccionDepartamento == null ? null : String(direccionDepartamento);
        intent.direccion_municipio = direccionMunicipio == null ? null : String(direccionMunicipio);
        intent.direccion_distrito = direccionDistrito == null ? null : String(direccionDistrito);
        intent.direccion_complemento = direccionComplemento == null ? null : String(direccionComplemento);
        intent.donor_pais = donorPais == null ? null : String(donorPais);
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("status = 'LINK_CREATED'")) {
      const [idEnlace, urlEnlace, urlEnlaceLargo, updatedAt, id] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (intent) {
        intent.wompi_id_enlace = Number(idEnlace);
        intent.wompi_url_enlace = String(urlEnlace);
        intent.wompi_url_enlace_largo = String(urlEnlaceLargo);
        intent.status = "LINK_CREATED";
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("SET status = 'COMPLETED'")) {
      const [documentId, updatedAt, id, expectedDocumentId] = this.args;
      const intent = this.db.donationIntents.find(
        (row) =>
          row.id === id &&
          (((row.status === "LINK_CREATED" || row.status === "EXPIRED") && (row.document_id ?? null) === null) ||
            (row.status === "COMPLETED" && row.document_id === expectedDocumentId))
      );
      if (intent) {
        intent.status = "COMPLETED";
        intent.document_id = documentId == null ? null : String(documentId);
        intent.updated_at = String(updatedAt);
        changes = 1;
      }
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("SET paid_at = ?")) {
      // markIntentPaid also backfills the contact data only Wompi's sheet collects.
      const [paidAt, updatedAt, donorPhone, direccionComplemento, id, expectedLinkId] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (
        intent &&
        intent.wompi_id_enlace === expectedLinkId &&
        (intent.status === "LINK_CREATED" || intent.status === "EXPIRED") &&
        (intent.paid_at == null || intent.paid_at === "")
      ) {
        intent.paid_at = paidAt == null ? null : String(paidAt);
        intent.updated_at = String(updatedAt);
        // COALESCE(column, ?): the bound value only lands when the column is still empty.
        intent.donor_phone = intent.donor_phone ?? (donorPhone == null ? null : String(donorPhone));
        intent.direccion_complemento =
          intent.direccion_complemento ?? (direccionComplemento == null ? null : String(direccionComplemento));
      }
    }
    if (
      this.sql.includes("UPDATE donation_intents") &&
      this.sql.includes("SET updated_at = ?") &&
      this.sql.includes("status IN ('LINK_CREATED','EXPIRED')") &&
      this.sql.includes("updated_at = ?")
    ) {
      const [checkedAt, id, expectedLinkId, observedUpdatedAt] = this.args;
      const intent = this.db.donationIntents.find(
        (row) =>
          row.id === id &&
          row.wompi_id_enlace === expectedLinkId &&
          (row.status === "LINK_CREATED" || row.status === "EXPIRED") &&
          row.paid_at == null &&
          row.updated_at === observedUpdatedAt
      );
      if (intent) {
        intent.updated_at = String(checkedAt);
        changes = 1;
      }
    }
    if (this.sql.includes("UPDATE donation_intents SET status = 'EXPIRED'")) {
      const [updatedAt, secondArg] = this.args.map(String);
      // expireDonationIntentsByIds binds an id list; expireUnpaidIntentsBefore binds
      // the expiry cutoff. Route on the SQL shape so both paths are modeled.
      const ids = this.sql.includes("id IN") ? new Set(this.args.slice(1).map(String)) : null;
      for (const intent of this.db.donationIntents.filter((row) => {
        if (row.status !== "PENDING" && row.status !== "LINK_CREATED") {
          return false;
        }
        if (row.paid_at != null) {
          return false;
        }
        if (ids) {
          return ids.has(String(row.id));
        }
        return String(row.expires_at) < secondArg;
      })) {
        intent.status = "EXPIRED";
        intent.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("INSERT INTO dte_documents") && this.sql.includes("FROM wompi_events")) {
      const [
        id,
        environment,
        codigoGeneracion,
        numeroControl,
        plainJson,
        donorEmail,
        donorName,
        amountCents,
        issuedAt,
        wompiEventId,
        expectedDocumentId
      ] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id === expectedDocumentId &&
          row.issuance_claim_id == null
      );
      if (event) {
        this.db.documents.push({
          id: String(id),
          wompi_event_id: String(wompiEventId),
          tipo_dte: "15",
          environment: environment === "01" ? "01" : "00",
          codigo_generacion: String(codigoGeneracion),
          numero_control: String(numeroControl),
          status: "PENDING",
          plain_json: String(plainJson),
          signed_jws: null,
          sello_recibido: null,
          mh_estado: null,
          mh_observaciones_json: "[]",
          donor_email: donorEmail === null ? null : String(donorEmail),
          donor_name: donorName === null ? null : String(donorName),
          amount_cents: Number(amountCents),
          issued_at: String(issuedAt),
          accepted_at: null,
          contingency_period_id: null,
          transmission_deferred_at: null,
          transmission_claim_id: null,
          created_at: String(issuedAt),
          updated_at: String(issuedAt)
        });
        changes = 1;
      }
    } else if (this.sql.includes("INSERT INTO dte_documents")) {
      const [id, wompiEventId, environment, codigoGeneracion, numeroControl, status, plainJson, donorEmail, donorName, amountCents, issuedAt, contingencyPeriodId] = this.args;
      this.db.documents.push({
        id: String(id),
        wompi_event_id: wompiEventId == null ? null : String(wompiEventId),
        tipo_dte: "15",
        environment: environment === "01" ? "01" : "00",
        codigo_generacion: String(codigoGeneracion),
        numero_control: String(numeroControl),
        status: String(status),
        plain_json: String(plainJson),
        signed_jws: null,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        donor_email: donorEmail === null ? null : String(donorEmail),
        donor_name: donorName === null ? null : String(donorName),
        amount_cents: Number(amountCents),
        issued_at: String(issuedAt),
        accepted_at: null,
        contingency_period_id: contingencyPeriodId === null ? null : String(contingencyPeriodId),
        transmission_deferred_at: null,
        transmission_claim_id: null,
        created_at: String(issuedAt),
        updated_at: String(issuedAt)
      });
      changes = 1;
    }
    if (this.sql.includes("INSERT INTO dte_events") && !this.sql.includes("FROM dte_documents")) {
      const [id, documentId, eventType, environment, codigoGeneracion, status, plainJson, signedJws, legalDeadlineAt, createdBy] = this.args;
      this.db.dteEvents.push({
        id,
        document_id: documentId,
        event_type: eventType,
        environment,
        codigo_generacion: codigoGeneracion,
        status,
        plain_json: plainJson,
        signed_jws: signedJws,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        legal_deadline_at: legalDeadlineAt,
        created_by: createdBy,
        created_at: "2026-06-26T01:46:47.015Z",
        accepted_at: null
      });
    }
    if (this.sql.includes("INSERT INTO contingency_periods")) {
      const [id, environment, reason, tipoContingencia, startedAt] = this.args;
      this.db.contingencies.push({
        id,
        environment,
        status: "OPEN",
        reason,
        tipo_contingencia: Number(tipoContingencia),
        started_at: startedAt,
        ended_at: null,
        event_id: null,
        event_sello: null,
        transmit_deadline_at: null,
        created_at: startedAt
      });
    }
    if (this.sql.includes("INSERT INTO contingency_batches")) {
      const [id, periodId, environment, idEnvio, lineCount, pendingCount] = this.args;
      this.db.contingencyBatches.push({
        id,
        contingency_period_id: periodId,
        environment,
        id_envio: idEnvio,
        status: "DRAFT",
        codigo_lote: null,
        request_json: "{}",
        response_json: "{}",
        last_error: null,
        line_count: Number(lineCount),
        accepted_count: 0,
        rejected_count: 0,
        pending_count: Number(pendingCount),
        created_at: "2026-06-26T01:46:47.015Z",
        submitted_at: null,
        last_polled_at: null,
        updated_at: "2026-06-26T01:46:47.015Z"
      });
    }
    if (this.sql.includes("INSERT INTO contingency_batch_lines")) {
      const [id, batchId, periodId, documentId, lineNo, codigoGeneracion, tipoDte, signedJws] = this.args;
      this.db.contingencyBatchLines.push({
        id,
        batch_id: batchId,
        contingency_period_id: periodId,
        document_id: documentId,
        line_no: Number(lineNo),
        status: "LOCAL_ISSUED",
        codigo_generacion: codigoGeneracion,
        tipo_dte: tipoDte,
        signed_jws: signedJws,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:46:47.015Z",
        updated_at: "2026-06-26T01:46:47.015Z"
      });
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET created_document_id = ?, processed_at = ?") &&
      this.sql.includes("issuance_claim_id = NULL")
    ) {
      const [documentId, processedAt, wompiEventId, issuanceClaimId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.issuance_claim_id === issuanceClaimId &&
          row.processed_at == null &&
          row.created_document_id == null
      );
      if (event) {
        event.created_document_id = documentId;
        event.processed_at = processedAt;
        event.issuance_status = "DOCUMENT_CREATED";
        event.issuance_claim_id = null;
        event.issuance_claimed_at = null;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET control_prefix = ?, reserved_codigo_generacion = ?")
    ) {
      const [controlPrefix, codigoGeneracion, wompiEventId, environment] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.environment === environment &&
          row.control_prefix == null &&
          row.control_sequence == null &&
          row.reserved_numero_control == null &&
          row.reserved_codigo_generacion == null
      );
      if (event) {
        const sequence = this.db.nextSequence;
        this.db.nextSequence += 1;
        event.control_prefix = String(controlPrefix);
        event.control_sequence = sequence;
        event.reserved_numero_control = `DTE-15-${String(controlPrefix)}-${String(sequence).padStart(15, "0")}`;
        event.reserved_codigo_generacion = String(codigoGeneracion);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'RETRY_QUEUED'") &&
      this.sql.includes("issuance_status IS NULL") &&
      !this.sql.includes("COALESCE(issuance_last_attempt_at")
    ) {
      const [attemptId, queuedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id == null &&
          row.issuance_attempt_id == null &&
          row.issuance_status == null
      );
      if (event) {
        event.processed_at = null;
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = String(attemptId);
        event.issuance_last_attempt_at = String(queuedAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'RETRY_QUEUED'") &&
      this.sql.includes("issuance_status IN ('FAILED', 'DEAD_LETTERED')")
    ) {
      const [attemptId, queuedAt, stalledEpochAt, wompiEventId] = this.args;
      const observed = this.sql.includes("AND issuance_error_code IS ?")
        ? {
            status: this.args[4],
            processedAt: this.args[5],
            attemptId: this.args[6],
            claimId: this.args[7],
            errorCode: this.args[8],
            errorMessage: this.args[9],
            lastAttemptAt: this.args[10],
            stalledEpochAt: this.args[11]
          }
        : null;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id == null &&
          row.issuance_claim_id == null &&
          (
            row.issuance_status === "FAILED"
            || row.issuance_status === "DEAD_LETTERED"
            || (
              (row.issuance_status === "RETRY_QUEUED" || row.issuance_status === "PROCESSING")
              && row.processed_at != null
            )
          ) &&
          (
            observed === null
            || (
              (row.issuance_status ?? null) === observed.status
              && (row.processed_at ?? null) === observed.processedAt
              && (row.issuance_attempt_id ?? null) === observed.attemptId
              && (row.issuance_claim_id ?? null) === observed.claimId
              && (row.issuance_error_code ?? null) === observed.errorCode
              && (row.issuance_error_message ?? null) === observed.errorMessage
              && (row.issuance_last_attempt_at ?? null) === observed.lastAttemptAt
              && (row.stalled_requeue_epoch_at ?? null) === observed.stalledEpochAt
            )
          )
      );
      if (event) {
        event.processed_at = null;
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = String(attemptId);
        event.issuance_last_attempt_at = String(queuedAt);
        event.stalled_requeue_epoch_at = String(stalledEpochAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'RETRY_QUEUED'") &&
      this.sql.includes("COALESCE(issuance_last_attempt_at, received_at) < ?")
    ) {
      const guardsExistingAttempt = this.sql.includes("AND issuance_attempt_id = ?");
      const [attemptId, queuedAt, wompiEventId, expectedAttempt, staleBefore] = guardsExistingAttempt
        ? [
            String(this.args[0]),
            String(this.args[1]),
            String(this.args[2]),
            String(this.args[3]),
            String(this.args[4])
          ]
        : [
            String(this.args[0]),
            String(this.args[1]),
            String(this.args[2]),
            null,
            String(this.args[3])
          ];
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      const attemptMatches = guardsExistingAttempt
        ? event?.issuance_attempt_id === expectedAttempt
        : event?.issuance_attempt_id == null;
      const statusEligible = guardsExistingAttempt
        ? event?.issuance_status === "RETRY_QUEUED" || event?.issuance_status === "PROCESSING"
        : event?.issuance_status == null;
      if (
        event &&
        event.created_document_id == null &&
        attemptMatches &&
        event.processed_at == null &&
        statusEligible &&
        String(event.issuance_last_attempt_at ?? event.received_at) < staleBefore
      ) {
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = attemptId;
        event.stalled_requeue_epoch_at ??= event.issuance_last_attempt_at ?? event.received_at;
        event.issuance_last_attempt_at = queuedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'FAILED'")
    ) {
      const [code, message, lastAttemptAt, failedAt, wompiEventId, attemptId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id == null &&
          row.issuance_attempt_id === attemptId &&
          row.issuance_status === "PROCESSING"
      );
      if (event) {
        event.issuance_status = "FAILED";
        event.issuance_attempt_count = Number(event.issuance_attempt_count ?? 0) + 1;
        event.issuance_error_code = code;
        event.issuance_error_message = message;
        event.issuance_last_attempt_at = lastAttemptAt;
        event.issuance_failed_at = failedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("issuance_status = 'IGNORED'")
    ) {
      const [processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) => row.id === wompiEventId && row.created_document_id == null
      );
      if (event) {
        event.issuance_status = "IGNORED";
        event.issuance_attempt_count ??= 0;
        event.processed_at ??= processedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET processed_at = ?")
    ) {
      const [processedAt, wompiEventId, auditEntityId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      const auditRequired = this.sql.includes("DONATION_INTENT_BINDING_REJECTED");
      const auditExists = this.db.audits.some(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === auditEntityId
      );
      if (
        event &&
        event.processed_at == null &&
        (!auditRequired || auditExists)
      ) {
        event.processed_at = processedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("created_document_id = ?")
    ) {
      const [documentId, processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      if (event) {
        event.created_document_id = documentId;
        event.processed_at = processedAt;
        if (this.sql.includes("issuance_status = 'DOCUMENT_CREATED'")) {
          event.issuance_status = "DOCUMENT_CREATED";
        }
        changes = 1;
      }
    }
    if (this.sql.includes("transmission_deferred_at = COALESCE(transmission_deferred_at, ?)")) {
      // markDocumentTransmissionDeferred: SIGNED + deferral marker + MH_NO_DISPONIBLE.
      const [deferredAt, mhEstado, observacionesJson, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "SIGNED";
        document.transmission_deferred_at ??= String(deferredAt);
        document.sello_recibido = null;
        document.mh_estado = String(mhEstado);
        document.mh_observaciones_json = String(observacionesJson);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents") && this.sql.includes("SET codigo_generacion = ?")) {
      const [codigoGeneracion, numeroControl, plainJson, signedJws, status, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.codigo_generacion = String(codigoGeneracion);
        document.numero_control = String(numeroControl);
        document.plain_json = String(plainJson);
        document.signed_jws = signedJws === null ? null : String(signedJws);
        document.status = String(status);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents") && this.sql.includes("SET donor_email = ?")) {
      const [email, updatedAt, documentId] = this.args;
      const document = this.db.documents.find(
        (row) => row.id === documentId && (row.post_accept_finalization_claim_id ?? null) === null
      );
      if (document) {
        document.donor_email = String(email);
        document.updated_at = String(updatedAt);
        changes = 1;
      }
    }
    if (this.sql.includes("UPDATE users SET name = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")) {
      const [name, role, disabledAt, updatedAt, userId] = this.args;
      const user = this.db.users.find((row) => row.id === userId);
      if (user) {
        user.name = name;
        user.role = role;
        user.disabled_at = disabledAt;
        user.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("SET name = ?, email = ?, role = ?, disabled_at = ?, updated_at = ?")) {
      if (this.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')") && this.db.beforeGuardedUserMutation) {
        const beforeMutation = this.db.beforeGuardedUserMutation;
        this.db.beforeGuardedUserMutation = null;
        await beforeMutation();
      }
      const [name, email, role, disabledAt, updatedAt, authGenerationDelta, userId, allowOwnerTarget, expectedEmail, expectedDisabledAt, expectedAuthGeneration, expectedName, expectedRole] = this.args;
      const user = this.db.users.find(
        (row) =>
          row.id === userId &&
          (!this.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')") ||
            Number(allowOwnerTarget) === 1 ||
            ["VIEWER", "OPERATOR", "ADMIN"].includes(String(row.role))) &&
          row.email === expectedEmail &&
          (row.disabled_at ?? null) === (expectedDisabledAt ?? null) &&
          Number(row.auth_generation ?? 0) === Number(expectedAuthGeneration) &&
          row.name === expectedName &&
          row.role === expectedRole
      );
      if (user) {
        user.name = name;
        user.email = email;
        user.role = role;
        user.disabled_at = disabledAt;
        user.updated_at = updatedAt;
        user.auth_generation = Number(user.auth_generation ?? 0) + Number(authGenerationDelta);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE users") &&
      this.sql.includes("SET password_hash = ?, password_salt = ?, updated_at = ?") &&
      !this.sql.includes("RETURNING id")
    ) {
      if (this.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')") && this.db.beforeGuardedUserMutation) {
        const beforeMutation = this.db.beforeGuardedUserMutation;
        this.db.beforeGuardedUserMutation = null;
        await beforeMutation();
      }
      const [passwordHash, passwordSalt, updatedAt, userId] = this.args;
      const allowOwnerTarget = this.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')")
        ? this.args[4]
        : 1;
      const user = this.db.users.find(
        (row) =>
          row.id === userId &&
          (!this.sql.includes("role IN ('VIEWER','OPERATOR','ADMIN')") ||
            Number(allowOwnerTarget) === 1 ||
            ["VIEWER", "OPERATOR", "ADMIN"].includes(String(row.role)))
      );
      if (this.sql.includes("FROM password_reset_tokens")) {
        const [, , , , tokenUserId, tokenHash, expiresAfter] = this.args;
        const activeToken = this.db.resetTokens.some(
          (row) =>
            row.user_id === tokenUserId &&
            row.token_hash === tokenHash &&
            !row.used_at &&
            String(row.expires_at) > String(expiresAfter)
        );
        if (user && !user.disabled_at && activeToken) {
          user.password_hash = passwordHash;
          user.password_salt = passwordSalt;
          user.updated_at = updatedAt;
          changes = 1;
        }
      } else if (user) {
        user.password_hash = passwordHash;
        user.password_salt = passwordSalt;
        user.updated_at = updatedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE sessions") &&
      this.sql.includes("SET revoked_at = ?") &&
      this.sql.includes("WHERE token_hash = ?")
    ) {
      const [revokedAt, tokenHash] = this.args;
      const session = this.db.sessions.find(
        (row) => row.token_hash === tokenHash && !row.revoked_at
      );
      if (session) {
        session.revoked_at = revokedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE sessions") &&
      this.sql.includes("SET revoked_at = ?") &&
      this.sql.includes("WHERE user_id = ?")
    ) {
      const [revokedAt, userId] = this.args;
      const marker = this.sql.includes("SELECT 1")
        ? this.sql.includes("AND email = ?")
          ? this.db.users.some(
              (row) =>
                row.id === this.args[2] &&
                row.email === this.args[3] &&
                (row.disabled_at ?? null) === (this.args[4] ?? null) &&
                Number(row.auth_generation ?? 0) === Number(this.args[5])
            )
          : this.db.users.some(
              (row) =>
                row.id === this.args[2] &&
                row.password_hash === this.args[3] &&
                row.password_salt === this.args[4] &&
                row.updated_at === this.args[5]
            )
        : true;
      if (marker) {
        for (const session of this.db.sessions.filter((row) => row.user_id === userId && !row.revoked_at)) {
          session.revoked_at = revokedAt;
          changes += 1;
        }
      }
    }
    if (this.sql.includes("UPDATE dte_events") && !this.sql.includes("event_type = 'INVALIDACION'")) {
      const [status, sello, mhEstado, observacionesJson, acceptedAt, eventId] = this.args;
      const event = this.db.dteEvents.find((row) => row.id === eventId);
      if (event) {
        event.status = status;
        event.sello_recibido = sello;
        event.mh_estado = mhEstado;
        event.mh_observaciones_json = observacionesJson;
        event.accepted_at = acceptedAt;
      }
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET status = ?") &&
      !this.sql.includes("event_type = 'INVALIDACION'")
    ) {
      const [status, sello, mhEstado, observacionesJson, acceptedAt, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = String(status);
        document.sello_recibido = sello === null ? null : String(sello);
        document.mh_estado = String(mhEstado);
        document.mh_observaciones_json = String(observacionesJson);
        document.accepted_at = acceptedAt === null ? document.accepted_at : String(acceptedAt);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'SUBMITTED'")) {
      const [codigoLote, requestJson, responseJson, submittedAt, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "SUBMITTED";
        batch.codigo_lote = codigoLote;
        batch.request_json = requestJson;
        batch.response_json = responseJson;
        batch.last_error = null;
        batch.submitted_at = batch.submitted_at ?? submittedAt;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines SET status = 'BATCH_SENT'")) {
      const [updatedAt, batchId] = this.args;
      for (const line of this.db.contingencyBatchLines.filter((row) => row.batch_id === batchId && row.status === "LOCAL_ISSUED")) {
        line.status = "BATCH_SENT";
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'PROCESSING'")) {
      const [responseJson, polledAt, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "PROCESSING";
        batch.response_json = responseJson;
        batch.last_polled_at = polledAt;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'FAILED'")) {
      const [responseJson, message, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "FAILED";
        batch.response_json = responseJson;
        batch.last_error = message;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines") && this.sql.includes("SET status = 'ACCEPTED'")) {
      const [sello, mhEstado, observacionesJson, updatedAt, lineId] = this.args;
      const line = this.db.contingencyBatchLines.find((row) => row.id === lineId);
      if (line) {
        line.status = "ACCEPTED";
        line.sello_recibido = sello;
        line.mh_estado = mhEstado;
        line.mh_observaciones_json = observacionesJson;
        line.last_error = null;
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines") && this.sql.includes("SET status = 'REJECTED'")) {
      const [mhEstado, observacionesJson, message, updatedAt, lineId] = this.args;
      const line = this.db.contingencyBatchLines.find((row) => row.id === lineId);
      if (line) {
        line.status = "REJECTED";
        line.mh_estado = mhEstado;
        line.mh_observaciones_json = observacionesJson;
        line.last_error = message;
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = ?, line_count = ?")) {
      const [status, lineCount, acceptedCount, rejectedCount, pendingCount, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = status;
        batch.line_count = lineCount;
        batch.accepted_count = acceptedCount;
        batch.rejected_count = rejectedCount;
        batch.pending_count = pendingCount;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_periods") && this.sql.includes("SET status = 'EVENT_ACCEPTED'")) {
      const [eventId, sello, deadlineAt, periodId] = this.args;
      const period = this.db.contingencies.find((row) => row.id === periodId);
      if (period) {
        period.status = "EVENT_ACCEPTED";
        period.event_id = eventId;
        period.event_sello = sello;
        period.transmit_deadline_at = deadlineAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_periods") && this.sql.includes("SET status = 'CLOSED'")) {
      const [endedAt, periodId] = this.args;
      const period = this.db.contingencies.find((row) => row.id === periodId);
      if (period) {
        period.status = "CLOSED";
        period.ended_at = period.ended_at ?? endedAt;
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET status = 'CONTINGENCY_PENDING'")) {
      const [periodId, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "CONTINGENCY_PENDING";
        document.contingency_period_id = String(periodId);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET status = 'INVALIDATED'")) {
      const [updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "INVALIDATED";
        document.updated_at = String(updatedAt);
      }
    }
    return { success: true, meta: { changes }, results: [] };
  }
}

function auditMetadata(audit: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(audit.metadata_json ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function auditStalledRequeueEpisodeId(audit: Record<string, unknown>): string | null {
  const value = auditMetadata(audit).stalledRequeueEpochAt;
  return typeof value === "string" && value ? value : null;
}

export function authedDb(role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER", db: InMemoryD1): InMemoryD1 {
  db.sessionUser = {
    id: `user_${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@example.org`,
    name: role,
    role
  };
  return db;
}

// Maps a retention-export SELECT's table name to its backing in-memory array,
// so the generic "ORDER BY created_at ASC, id ASC LIMIT ?" branch above can
// serve every table the retention service reads without one bespoke branch per table.
export function retentionTableFor(db: InMemoryD1, sql: string): Array<Record<string, unknown>> | null {
  if (sql.includes("FROM dte_documents")) return db.documents as unknown as Array<Record<string, unknown>>;
  if (sql.includes("FROM donation_intents")) return db.donationIntents;
  if (sql.includes("FROM dte_events")) return db.dteEvents;
  if (sql.includes("FROM email_deliveries")) return db.emailDeliveries;
  if (sql.includes("FROM wompi_events")) return db.wompiEvents;
  if (sql.includes("FROM audit_logs")) return db.audits;
  if (sql.includes("FROM contingency_periods")) return db.contingencies;
  if (sql.includes("FROM contingency_batch_lines")) return db.contingencyBatchLines;
  if (sql.includes("FROM contingency_batches")) return db.contingencyBatches;
  if (sql.includes("JOIN stripe_checkout_sessions AS snapshot")) return db.stripeCheckoutSessions;
  if (sql.includes("JOIN stripe_webhook_events AS snapshot")) return db.stripeWebhookEvents;
  if (sql.includes("JOIN stripe_gifts AS snapshot")) return db.stripeGifts;
  if (sql.includes("JOIN stripe_invoice_settlements AS snapshot")) return db.stripeInvoiceSettlements;
  if (sql.includes("JOIN stripe_acknowledgment_deliveries AS snapshot")) return db.stripeAcknowledgmentDeliveries;
  if (sql.includes("JOIN stripe_annual_statement_deliveries AS snapshot")) return db.stripeAnnualStatementDeliveries;
  return null;
}

export function documentMatchesFtsQuery(document: DteDocumentRecord, query: string): boolean {
  const prefixes = query
    .split(/\s+AND\s+/i)
    .map((part) => part.replace(/\*$/, "").toLowerCase())
    .filter(Boolean);
  if (prefixes.length === 0) {
    return true;
  }
  const controlTail = document.numero_control.split("-").at(-1) ?? "";
  const corpus = [
    document.codigo_generacion,
    document.codigo_generacion.replace(/[^a-z0-9]+/gi, ""),
    document.numero_control,
    document.numero_control.replace(/[^a-z0-9]+/gi, ""),
    controlTail.replace(/^0+/, "") || controlTail,
    document.donor_email,
    document.donor_name
  ];
  const tokens = corpus.flatMap((value) => String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return prefixes.every((prefix) => tokens.some((token) => token.startsWith(prefix)));
}

function normalizedCertificateText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

function annualCertificateRecipientKey(document: DteDocumentRecord): string {
  return normalizedCertificateText(document.donor_email) ?? normalizedCertificateText(document.donor_name) ?? "(sin identificar)";
}

export function analyticsDocumentRow(
  document: DteDocumentRecord,
  intents: Array<Record<string, unknown>>
): Record<string, unknown> {
  const intent = intents.find(
    (candidate) => candidate.document_id === document.id
  );
  return {
    id: document.id,
    wompi_event_id: document.wompi_event_id,
    environment: document.environment,
    status: document.status,
    donor_email: document.donor_email ?? null,
    donor_name: document.donor_name ?? null,
    amount_cents: document.amount_cents,
    issued_at: document.issued_at,
    accepted_at: document.accepted_at ?? null,
    transmission_deferred_at: document.transmission_deferred_at ?? null,
    direccion_departamento: intent?.direccion_departamento ?? null,
    donor_pais: intent?.donor_pais ?? null,
    gift_type: intent?.gift_type ?? null
  };
}

export function analyticsIntentRow(intent: Record<string, unknown>): Record<string, unknown> {
  return {
    id: intent.id,
    status: intent.status,
    document_id: intent.document_id ?? null,
    donor_document: intent.donor_document ?? null,
    gift_type: intent.gift_type ?? null,
    created_at: intent.created_at,
    paid_at: intent.paid_at ?? null,
    direccion_departamento: intent.direccion_departamento ?? null,
    donor_pais: intent.donor_pais ?? null
  };
}
