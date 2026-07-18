import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument, buildDirectCdeDocument } from "../../src/worker/domain/dteBuilder";
import worker from "../../src/worker/index";
import { AuthService, hashPassword } from "../../src/worker/services/auth";
import {
  IssuancePipeline,
  RejectedWompiRetryConflictError,
  WompiIntentQuarantinedError
} from "../../src/worker/services/pipeline";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import { EmailService } from "../../src/worker/services/email";
import { MhClient, MhPreDispatchError } from "../../src/worker/services/mhClient";
import { previousElSalvadorMonth } from "../../src/worker/services/retention";
import { INTENT_EXPIRY_SWEEP_LIMIT, Repository } from "../../src/worker/storage/repository";
import { bytesToBase64, hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { DteDocumentRecord, Env, FiscalCorrectionRecord, IssuanceMessage, WompiWebhook } from "../../src/worker/types";

const nativeCrypto = crypto;

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  readonly digest: Promise<ArrayBuffer>;

  constructor() {
    const chunks: Uint8Array[] = [];
    let resolveDigest!: (value: ArrayBuffer) => void;
    let rejectDigest!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        const view =
          chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        chunks.push(view.slice());
      },
      async close() {
        const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          resolveDigest(await nativeCrypto.subtle.digest("SHA-256", bytes));
        } catch (error) {
          rejectDigest(error);
        }
      },
      abort(reason) {
        rejectDigest(reason);
      }
    });
    this.digest = digest;
  }
}

beforeEach(() => {
  vi.stubGlobal("crypto", {
    ...nativeCrypto,
    subtle: nativeCrypto.subtle,
    getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
    randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
    DigestStream: TestDigestStream
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Worker fetch error handling", () => {
  it("converts async API auth errors into JSON responses", async () => {
    const response = await worker.fetch(new Request("https://example.org/api/documents"), {
      DB: {} as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher
    } as Env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "auth_error" });
  });

  it("logs unexpected failures without returning their raw message", async () => {
    const sensitiveMessage = "D1 credential sentinel must stay server-side";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env({
        prepare: () => {
          throw new Error(sensitiveMessage);
        }
      } as unknown as InMemoryD1)
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: "internal_error", message: "Ocurrió un error interno." });
    expect(JSON.stringify(payload)).not.toContain(sensitiveMessage);
    expect(errorSpy).toHaveBeenCalledWith({
      event: "unhandled_worker_request_error",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });
});

describe("Worker non-fetch handler error containment", () => {
  it("contains a DLQ failure and retries every unresolved message", async () => {
    const sensitiveMessage = "DLQ failed for ana@example.org at https://private.example/dte_123";
    const ack = vi.fn();
    const retry = vi.fn();
    const retryAll = vi.fn();
    const batch = {
      queue: "diezmossv-staging-issuance-example-dlq",
      messages: [{
        id: "msg_private",
        timestamp: new Date(),
        body: { advancedDocumentId: "dte_123" },
        attempts: 1,
        ack,
        retry
      }],
      ackAll: vi.fn(),
      retryAll
    } as unknown as MessageBatch<IssuanceMessage>;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      worker.queue(batch, {
        DB: {
          prepare() {
            throw new Error(sensitiveMessage);
          }
        } as unknown as D1Database,
        APP_ENV: "staging"
      } as Env)
    ).resolves.toBeUndefined();

    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(retryAll).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: "queue_handler_failed",
      app_env: "staging",
      error_name: "error",
      error_code: "unknown"
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveMessage);
  });

  it("contains a scheduled prerequisite failure and aborts later sweeps", async () => {
    const sensitiveMessage = "D1 credential sk_live_private for owner@example.org";
    const preparedSql: string[] = [];
    const retryDeferred = vi.spyOn(
      IssuancePipeline.prototype,
      "retryDeferredTransmissions"
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        {
          DB: {
            prepare(sql: string) {
              preparedSql.push(sql);
              return {
                bind() {
                  return this;
                },
                async run() {
                  throw new Error(sensitiveMessage);
                }
              };
            }
          } as unknown as D1Database,
          APP_ENV: "production"
        } as Env
      )
    ).resolves.toBeUndefined();

    expect(preparedSql).toEqual(["DELETE FROM login_rate_limits WHERE expires_at <= ?"]);
    expect(retryDeferred).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith({
      event: "scheduled_handler_failed",
      app_env: "production",
      error_name: "error",
      error_code: "unknown"
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveMessage);
  });
});

describe("static document security policy", () => {
  it("adds anti-framing and no-referrer headers without changing the asset response", async () => {
    const db = new InMemoryD1();
    const assetResponse = new Response("<!doctype html><title>DiezmosSV</title>", {
      status: 202,
      statusText: "Asset response",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        ETag: '"asset-v1"',
        "Content-Security-Policy": "default-src 'self'; frame-ancestors https://legacy.example; script-src 'self'"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/admin"),
      env(db, {
        ASSETS: { fetch: () => Promise.resolve(assetResponse) } as unknown as Fetcher
      })
    );

    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Asset response");
    await expect(response.text()).resolves.toBe("<!doctype html><title>DiezmosSV</title>");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("ETag")).toBe('"asset-v1"');
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp.match(/frame-ancestors/gi)).toHaveLength(1);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("legacy.example");
  });

  it("leaves non-document asset responses unchanged", async () => {
    const db = new InMemoryD1();
    const assetResponse = new Response("console.log('ok')", {
      headers: { "Content-Type": "application/javascript", ETag: '"script-v1"' }
    });

    const response = await worker.fetch(
      new Request("https://example.org/assets/app.js"),
      env(db, {
        ASSETS: { fetch: () => Promise.resolve(assetResponse) } as unknown as Fetcher
      })
    );

    expect(response).toBe(assetResponse);
    expect(response.headers.has("X-Frame-Options")).toBe(false);
    expect(response.headers.get("ETag")).toBe('"script-v1"');
  });
});

describe("Wompi document identifier reservation", () => {
  it("returns the same identifiers without consuming a second sequence", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation());
    const repo = new Repository(db as unknown as D1Database);

    const identifiers = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004");
    const repeated = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004");

    expect(identifiers).toMatchObject({
      sequence: 1,
      numeroControl: "DTE-15-M001P004-000000000000001"
    });
    expect(repeated).toEqual(identifiers);
    expect(db.nextSequence).toBe(2);
  });

  it("normalizes a lowercase punctuated control prefix before reserving", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation());
    const repo = new Repository(db as unknown as D1Database);

    const identifiers = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "m001-p004");

    expect(identifiers.numeroControl).toBe("DTE-15-M001P004-000000000000001");
  });

  it("normalizes the direct allocator prefix identically", async () => {
    const db = new InMemoryD1();
    const repo = new Repository(db as unknown as D1Database);

    await repo.nextControlSequence("00", "m001-p004");

    expect(db.sequencePrefixes).toEqual(["M001P004"]);
  });

  it("rejects prefix drift after identifiers have already been reserved", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation());
    const repo = new Repository(db as unknown as D1Database);

    const reserved = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004");

    await expect(
      repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P005")
    ).rejects.toThrow(/prefijo/i);
    await expect(
      repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "m001-p004")
    ).resolves.toEqual(reserved);
    expect(db.wompiEvents[0]).toMatchObject({
      control_prefix: "M001P004",
      reserved_numero_control: reserved.numeroControl,
      reserved_codigo_generacion: reserved.codigoGeneracion
    });
    expect(db.nextSequence).toBe(2);
  });

  it("rejects a control prefix that does not normalize to eight characters", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation());
    const repo = new Repository(db as unknown as D1Database);

    await expect(repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "short")).rejects.toThrow();
    expect(db.nextSequence).toBe(1);
  });

  it("rejects an environment that differs from the Wompi event", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation());
    const repo = new Repository(db as unknown as D1Database);

    await expect(repo.reserveWompiDocumentIdentifiers("wompi_1", "01", "M001P004")).rejects.toThrow();
    expect(db.nextSequence).toBe(1);
  });

  it("rejects a partial identifier reservation", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation({ control_prefix: "M001P004" }));
    const repo = new Repository(db as unknown as D1Database);

    await expect(repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004")).rejects.toThrow();
    expect(db.nextSequence).toBe(1);
  });
});

describe("Wompi issuance failure recovery API", () => {
  const authorization = { Authorization: "Bearer test-token" };
  const safeOperationalError = {
    error: "wompi_issuance_operation_failed",
    message: "No se pudo completar la operación de emisión. Intente de nuevo."
  };

  function unsafeOperationalError(): Error {
    return new Error(
      `FORBIDDEN_SENTINEL Bearer sk-live-secret https://internal.example/retry\n${"x".repeat(1_200)}\n    at retryIssuance (worker.ts:1:1)`
    );
  }

  function failedWompiEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return wompiEventForReservation({
      id: "wompi_failed",
      transaction_id: "transaction_failed",
      amount_cents: 111,
      donor_name: "Example Person",
      donor_email: "donor@example.org",
      raw_body: JSON.stringify({ donorDocument: "secret" }),
      headers_json: JSON.stringify({ authorization: "secret" }),
      received_at: "2026-07-13T22:06:32.756Z",
      processed_at: "2026-07-13T22:06:52.000Z",
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_count: 4,
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_last_attempt_at: "2026-07-13T22:06:49.000Z",
      issuance_failed_at: "2026-07-13T22:06:49.000Z",
      issuance_dead_lettered_at: "2026-07-13T22:06:52.000Z",
      reserved_numero_control: "DTE-15-M001P004-000000000000031",
      ...overrides
    });
  }

  function expectedFailureItem(
    status = "DEAD_LETTERED",
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: "wompi_failed",
      environment: "00",
      amount_cents: 111,
      donor_name: "Example Person",
      donor_email: "donor@example.org",
      received_at: "2026-07-13T22:06:32.756Z",
      issuance_status: status,
      issuance_attempt_count: 4,
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_last_attempt_at: "2026-07-13T22:06:49.000Z",
      issuance_failed_at: "2026-07-13T22:06:49.000Z",
      issuance_dead_lettered_at: "2026-07-13T22:06:52.000Z",
      reserved_numero_control: "DTE-15-M001P004-000000000000031",
      ...overrides
    };
  }

  it("requires authentication before listing or looking up a retry target", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(failedWompiEvent());

    const list = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures"),
      env(db)
    );
    const retry = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", { method: "POST" }),
      env(db)
    );

    expect(list.status).toBe(401);
    expect(retry.status).toBe(401);
    expect(db.wompiIssuanceFailureLookupCount).toBe(0);
    expect(db.wompiIssuanceRetryClaimCount).toBe(0);
  });

  it("lets a VIEWER list only the exact allowlisted unresolved failure shape", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.wompiEvents.push(failedWompiEvent());
    db.wompiEvents.push(failedWompiEvent({
      id: "wompi_created",
      created_document_id: "dte_created",
      issuance_status: "DOCUMENT_CREATED"
    }));
    db.wompiEvents.push(failedWompiEvent({ id: "wompi_ignored", issuance_status: "IGNORED" }));
    db.wompiEvents.push(failedWompiEvent({ id: "wompi_without_error", issuance_error_message: null }));

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", { headers: authorization }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { failures: Array<Record<string, unknown>> };
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toEqual(expectedFailureItem());
    expect(JSON.stringify(body.failures[0])).not.toContain("raw_body");
    expect(JSON.stringify(body.failures[0])).not.toContain("headers_json");
  });

  it("orders failures newest-first and caps an oversized repository limit at 100", async () => {
    const db = new InMemoryD1();
    for (let index = 0; index < 101; index += 1) {
      const failedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      db.wompiEvents.push(failedWompiEvent({
        id: `wompi_failed_${String(index).padStart(3, "0")}`,
        issuance_status: "FAILED",
        issuance_failed_at: failedAt,
        issuance_last_attempt_at: failedAt,
        issuance_dead_lettered_at: null
      }));
    }
    const repo = new Repository(db as unknown as D1Database);

    const failures = await repo.listWompiIssuanceFailures(1_000);

    expect(failures).toHaveLength(100);
    expect(failures[0].id).toBe("wompi_failed_100");
    expect(failures.at(-1)?.id).toBe("wompi_failed_001");
  });

  it("rejects a VIEWER retry before looking up either an existing or missing event", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.wompiEvents.push(failedWompiEvent());
    const init = { method: "POST", headers: authorization };

    const existing = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", init),
      env(db)
    );
    const missing = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_missing/retry", init),
      env(db)
    );

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(db.wompiIssuanceFailureLookupCount).toBe(0);
    expect(db.wompiIssuanceRetryClaimCount).toBe(0);
  });

  it("lets an OPERATOR claim before queueing the same event id and audits the retry", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({ issuance_status: "FAILED", processed_at: null }));
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
        method: "POST",
        headers: authorization
      }),
      env(db, {
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => {
            expect(db.wompiEvents[0].issuance_status).toBe("RETRY_QUEUED");
            queued.push(message);
          }
        } as unknown as Queue<IssuanceMessage>
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
    expect(queued).toEqual([{
      wompiEventId: "wompi_failed",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.wompiEvents[0].issuance_last_attempt_at).not.toBe("2026-07-13T22:06:49.000Z");
    expect(db.audits).toContainEqual(expect.objectContaining({
      actor_id: "user_operator",
      action: "WOMPI_ISSUANCE_RETRY_QUEUED",
      entity_type: "wompi_event",
      entity_id: "wompi_failed"
    }));
  });

  it("allows only one concurrent retry claim and returns the safe current state to the loser", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent());
    const queued: IssuanceMessage[] = [];
    const workerEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });
    const retryRequest = () => new Request(
      "https://example.org/api/wompi-events/wompi_failed/retry",
      { method: "POST", headers: authorization }
    );

    const responses = await Promise.all([
      worker.fetch(retryRequest(), workerEnv),
      worker.fetch(retryRequest(), workerEnv)
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(queued).toEqual([{
      wompiEventId: "wompi_failed",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.audits.filter((audit) => audit.action === "WOMPI_ISSUANCE_RETRY_QUEUED")).toHaveLength(1);
    const loser = responses.find((response) => response.status === 200);
    await expect(loser?.json()).resolves.toEqual({
      queued: false,
      failure: expectedFailureItem("RETRY_QUEUED", {
        issuance_last_attempt_at: db.wompiEvents[0].issuance_last_attempt_at
      })
    });
  });

  it("returns conflict for a created event and not-found for an unknown id without queueing", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({
      created_document_id: "dte_created",
      issuance_status: "DOCUMENT_CREATED"
    }));
    const queued: IssuanceMessage[] = [];
    const workerEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });
    const init = { method: "POST", headers: authorization };

    const created = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", init),
      workerEnv
    );
    const missing = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_missing/retry", init),
      workerEnv
    );

    expect(created.status).toBe(409);
    expect(missing.status).toBe(404);
    expect(queued).toHaveLength(0);
    expect(JSON.stringify(await created.json())).not.toContain("raw_body");
    expect(JSON.stringify(await missing.json())).not.toContain("headers_json");
  });

  it("returns a stable generic error when retry queueing fails without leaking failure detail", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({ issuance_status: "FAILED", processed_at: null }));
    const failure = unsafeOperationalError();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
        method: "POST",
        headers: authorization
      }),
      env(db, {
        ISSUANCE_QUEUE: { send: async () => { throw failure; } } as unknown as Queue<IssuanceMessage>
      })
    );

    expect(response.status).toBe(500);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual(safeOperationalError);
    expect(responseText).not.toContain("FORBIDDEN_SENTINEL");
    expect(responseText).not.toContain("https://");
    expect(responseText).not.toContain("Bearer");
    expect(responseText).not.toContain("sk-live");
    expect(responseText).not.toContain("at retryIssuance");
    expect(responseText.length).toBeLessThan(256);
    expect(db.wompiEvents[0].issuance_status).toBe("RETRY_QUEUED");
    expect(db.wompiEvents[0].issuance_attempt_id).toEqual(expect.any(String));
    expect(db.audits).toContainEqual(expect.objectContaining({
      actor_id: "user_operator",
      action: "WOMPI_ISSUANCE_RETRY_QUEUED",
      entity_id: "wompi_failed"
    }));
    expect(consoleError).toHaveBeenCalledWith({
      event: "wompi_issuance_retry_failed",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });

  it("returns the same stable generic error when the failure list query rejects", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const failure = unsafeOperationalError();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (sql.includes("issuance_error_message IS NOT NULL")) {
        statement.all = async () => { throw failure; };
      }
      return statement;
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", { headers: authorization }),
      env(db)
    );

    expect(response.status).toBe(500);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual(safeOperationalError);
    expect(responseText).not.toContain("FORBIDDEN_SENTINEL");
    expect(responseText).not.toContain("https://");
    expect(responseText).not.toContain("Bearer");
    expect(responseText).not.toContain("sk-live");
    expect(responseText).not.toContain("at retryIssuance");
    expect(responseText.length).toBeLessThan(256);
    expect(consoleError).toHaveBeenCalledWith({
      event: "wompi_issuance_failure_list_failed",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });
});

describe("guarded fiscal correction API", () => {
  const authorization = { Authorization: "Bearer test-token" };

  function correctionDb(role: string | null = "OPERATOR"): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = role
      ? {
          id: `user_${role.toLowerCase()}`,
          email: `${role.toLowerCase()}@example.org`,
          name: role,
          role
        }
      : null;
    return db;
  }

  function correctionWebhook(overrides: Record<string, unknown> = {}): WompiWebhook {
    return {
      ...(wompiSample as WompiWebhook),
      Cliente: {
        ...(wompiSample.Cliente as WompiWebhook["Cliente"]),
        DocumentoIdentidad: "12345678-9",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  function correctionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const payload = correctionWebhook();
    return wompiEventForReservation({
      id: "wompi_bad_dui",
      transaction_id: payload.IdTransaccion,
      environment: "00",
      result: payload.ResultadoTransaccion,
      amount_cents: 1000,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-17T17:00:00.000Z",
      created_document_id: null,
      issuance_claim_id: null,
      issuance_status: "FAILED",
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "El DUI del receptor es inválido.",
      ...overrides
    });
  }

  function correctionReceptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nrc: null,
      nombre: "Ana Donante",
      codActividad: null,
      descActividad: null,
      correo: "ana@example.org",
      telefono: "70001111",
      codDomiciliado: 1,
      codPais: "SV",
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Colonia Centro",
      ...overrides
    };
  }

  function correctionRequest(
    path: string,
    body: Record<string, unknown>,
    method = "POST"
  ): Request {
    return new Request(`https://example.org${path}`, {
      method,
      headers: {
        ...authorization,
        "Content-Type": "application/json"
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) })
    });
  }

  function correctionRecord(
    overrides: Partial<FiscalCorrectionRecord> = {}
  ): FiscalCorrectionRecord {
    return {
      id: "fiscal_correction_1",
      request_id: "11111111-1111-4111-8111-111111111111",
      request_payload_sha256: "payload-sha",
      attempt_number: 1,
      target_kind: "WOMPI_EVENT",
      wompi_event_id: "wompi_bad_dui",
      document_id: null,
      environment: "00",
      status: "QUEUED",
      before_receptor_json: JSON.stringify(correctionReceptor({ numDocumento: "12345678-9" })),
      corrected_receptor_json: JSON.stringify(correctionReceptor()),
      changed_fields_json: JSON.stringify(["numDocumento"]),
      source_document_snapshot_json: null,
      issuance_attempt_id: "issuance_attempt_1",
      fiscal_claim_id: null,
      processing_claim_id: "correction_processing_1",
      mh_dispatch_started_at: null,
      failure_code: null,
      failure_message: null,
      created_by: "user_operator",
      created_at: "2026-07-18T12:00:00.000Z",
      processing_started_at: null,
      completed_at: null,
      updated_at: "2026-07-18T12:00:00.000Z",
      ...overrides
    };
  }

  function stubQueuedCorrectionLifecycle(
    correction: FiscalCorrectionRecord,
    event: Record<string, unknown>,
    db: InMemoryD1
  ): void {
    const ownedDocument = () => {
      const currentEvent = db.wompiEvents.find(
        (candidate) => candidate.id === correction.wompi_event_id
      );
      return db.documents.find(
        (document) =>
          document.id === currentEvent?.created_document_id
          && document.wompi_event_id === correction.wompi_event_id
      );
    };
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing").mockImplementation(async (input) => {
      if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
        return "terminal";
      }
      if (
        input.id !== correction.id
        || input.processingClaimId !== correction.processing_claim_id
        || input.issuanceAttemptId !== correction.issuance_attempt_id
        || input.fiscalClaimId !== undefined
        || event.issuance_attempt_id !== correction.issuance_attempt_id
        || event.issuance_status !== "RETRY_QUEUED"
        || correction.status !== "QUEUED"
      ) {
        return "busy";
      }
      correction.status = "PROCESSING";
      correction.processing_started_at = new Date().toISOString();
      return "claimed";
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          !document
          || input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== document.id
          || input.documentClaimId !== `fiscal_correction_${correction.id}`
          || input.signedJws !== document.signed_jws
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || document.status !== "SIGNED"
          || document.fiscal_operation_claim_id !== input.documentClaimId
          || document.fiscal_operation_kind !== "TRANSMISSION"
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "clearFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (id, processingClaimId) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at === null
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = null;
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeWompiFiscalCorrectionFailure")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || event.created_document_id != null
          || !["RETRY_QUEUED", "PROCESSING"].includes(String(event.issuance_status))
          || event.issuance_attempt_id !== correction.issuance_attempt_id
        ) {
          return false;
        }
        const completedAt = new Date().toISOString();
        event.issuance_status = "FAILED";
        event.issuance_error_code = outcome.failureCode ?? "FISCAL_CORRECTION_FAILED";
        event.issuance_error_message = outcome.failureMessage ?? "La corrección fiscal falló.";
        event.issuance_last_attempt_at = completedAt;
        event.issuance_failed_at = completedAt;
        event.processed_at = completedAt;
        event.issuance_attempt_id = null;
        event.issuance_claim_id = null;
        event.issuance_claimed_at = null;
        correction.status = "FAILED";
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = completedAt;
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const dispatchStateMatches = outcome.status === "FAILED"
          ? correction.mh_dispatch_started_at === null
          : correction.mh_dispatch_started_at !== null;
        const document = ownedDocument();
        const evidenceMatches = outcome.status === "FAILED" || Boolean(
          document
          && outcome.document?.documentId === document.id
          && outcome.document.documentClaimId === `fiscal_correction_${correction.id}`
          && outcome.document.signedJws === document.signed_jws
          && (
            outcome.status === "REVIEW_REQUIRED"
              ? document.status === "SIGNED"
                && document.fiscal_operation_claim_id === outcome.document.documentClaimId
                && document.fiscal_operation_kind === "TRANSMISSION"
              : document.status === outcome.status
                && document.fiscal_operation_claim_id === null
                && document.fiscal_operation_kind === null
          )
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || !dispatchStateMatches
          || !evidenceMatches
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        return true;
      });
  }

  function stubDocumentCorrectionLifecycle(
    correction: FiscalCorrectionRecord,
    db: InMemoryD1
  ): void {
    const ownedDocument = () => db.documents.find(
      (document) => document.id === correction.document_id
    );
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
          return "terminal";
        }
        if (
          input.id !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.issuanceAttemptId !== undefined
          || input.fiscalClaimId !== correction.fiscal_claim_id
          || correction.status !== "QUEUED"
          || !document
          || document.status !== "REJECTED"
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return "busy";
        }
        correction.status = "PROCESSING";
        correction.processing_started_at = new Date().toISOString();
        return "claimed";
      });
    vi.spyOn(Repository.prototype, "prepareClaimedFiscalCorrectionDocument")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.documentId !== correction.document_id
          || input.claimId !== correction.fiscal_claim_id
          || correction.status !== "PROCESSING"
          || !document
          || document.status !== "REJECTED"
          || document.fiscal_operation_claim_id !== correction.fiscal_claim_id
        ) {
          return false;
        }
        document.codigo_generacion = input.codigoGeneracion;
        document.numero_control = input.numeroControl;
        document.plain_json = JSON.stringify(input.plainJson);
        document.signed_jws = input.signedJws;
        document.donor_name = input.donorName;
        document.donor_email = input.donorEmail;
        document.status = "SIGNED";
        document.sello_recibido = null;
        document.mh_estado = null;
        document.mh_observaciones_json = "[]";
        document.accepted_at = null;
        document.transmission_deferred_at = null;
        document.post_accept_finalized_at = null;
        document.updated_at = new Date().toISOString();
        return true;
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const document = ownedDocument();
        if (
          input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== correction.document_id
          || input.documentClaimId !== correction.fiscal_claim_id
          || input.signedJws !== document?.signed_jws
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at !== null
          || !document
          || document.status !== "SIGNED"
          || document.fiscal_operation_claim_id !== input.documentClaimId
          || document.fiscal_operation_kind !== "TRANSMISSION"
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "clearFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (id, processingClaimId) => {
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || correction.mh_dispatch_started_at === null
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = null;
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const dispatchStateMatches = outcome.status === "FAILED"
          ? correction.mh_dispatch_started_at === null
          : correction.mh_dispatch_started_at !== null;
        const document = ownedDocument();
        const evidenceMatches = outcome.status === "FAILED" || Boolean(
          document
          && outcome.document?.documentId === document.id
          && outcome.document.documentClaimId === correction.fiscal_claim_id
          && outcome.document.signedJws === document.signed_jws
          && (
            outcome.status === "REVIEW_REQUIRED"
              ? document.status === "SIGNED"
                && document.fiscal_operation_claim_id === outcome.document.documentClaimId
                && document.fiscal_operation_kind === "TRANSMISSION"
              : document.status === outcome.status
                && document.fiscal_operation_claim_id === null
                && document.fiscal_operation_kind === null
          )
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || correction.status !== "PROCESSING"
          || !dispatchStateMatches
          || !evidenceMatches
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        if (outcome.status !== "REVIEW_REQUIRED") {
          const document = ownedDocument();
          if (document?.fiscal_operation_claim_id === correction.fiscal_claim_id) {
            document.fiscal_operation_claim_id = null;
            document.fiscal_operation_claimed_at = null;
            document.fiscal_operation_kind = null;
            document.fiscal_operation_event_id = null;
          }
        }
        return true;
      });
  }

  async function consumeCorrectionMessage(
    runtime: Env,
    body: IssuanceMessage,
    id = crypto.randomUUID()
  ): Promise<{ ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }> {
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({
      queue: "diezmossv-staging-issuance-example",
      messages: [{ id, timestamp: new Date(), body, attempts: 1, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>, runtime);
    return { ack, retry };
  }

  function rejectedCorrectionDocument(
    overrides: Partial<DteDocumentRecord> = {}
  ): DteDocumentRecord {
    const plain = buildDirectCdeDocument({
      amount: "10.00",
      donorName: "Donante Original",
      donorEmail: "original@example.org",
      donorDocumentType: "13",
      donorDocument: "10000002-7",
      donorPhone: "70001111",
      donorAddress: "Dirección original"
    }, emisorConfig(), {
      sequence: 7,
      environment: "00",
      issuedAt: new Date("2026-07-17T10:30:00-06:00")
    }) as Record<string, any>;
    return testDocument({
      id: "doc_rejected_correction",
      wompi_event_id: null,
      status: "REJECTED",
      plain_json: JSON.stringify(plain),
      signed_jws: "original.signed.jws",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: JSON.stringify([
        "Campo #/receptor/numDocumento contiene un valor inválido"
      ]),
      accepted_at: null,
      fiscal_operation_claim_id: null,
      ...overrides
    });
  }

  function correctionRuntime(
    db: InMemoryD1,
    queue?: Queue<IssuanceMessage>
  ): Env {
    return env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ...(queue ? { ISSUANCE_QUEUE: queue } : {})
    });
  }

  function expectCorrectionAudits(
    db: InMemoryD1,
    correction: FiscalCorrectionRecord,
    terminalStatus: "ACCEPTED" | "REJECTED" | "FAILED" | "REVIEW_REQUIRED",
    changedFields = ["numDocumento"]
  ): void {
    const audits = db.audits.filter(
      (audit) =>
        audit.entity_type === "fiscal_correction"
        && audit.entity_id === correction.id
    );
    expect(audits.map((audit) => audit.action)).toEqual([
      "FISCAL_CORRECTION_STARTED",
      `FISCAL_CORRECTION_${terminalStatus}`
    ]);
    for (const audit of audits) {
      expect(JSON.parse(String(audit.metadata_json))).toEqual({
        correctionId: correction.id,
        changedFields
      });
    }
  }

  it("requires OPERATOR before reading either correction target", async () => {
    const unauthenticated = correctionDb(null);
    const viewer = correctionDb("VIEWER");
    const eventLookup = vi.spyOn(Repository.prototype, "getWompiEventById");
    const documentLookup = vi.spyOn(Repository.prototype, "getDteDocument");

    const responses = await Promise.all([
      worker.fetch(new Request("https://example.org/api/wompi-events/wompi_bad_dui/correction-data"), correctionRuntime(unauthenticated)),
      worker.fetch(correctionRequest("/api/documents/doc_rejected_correction/correct-and-retry", {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor()
      }), correctionRuntime(viewer))
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 403]);
    expect(eventLookup).not.toHaveBeenCalled();
    expect(documentLookup).not.toHaveBeenCalled();
  });

  it("returns only editable correction data and active status to an OPERATOR", async () => {
    const db = correctionDb();
    const event = correctionEvent();
    const document = rejectedCorrectionDocument();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getActiveFiscalCorrectionForTarget")
      .mockResolvedValue({ id: "fiscal_correction_active", status: "REVIEW_REQUIRED" });

    const wompi = await worker.fetch(
      correctionRequest("/api/wompi-events/wompi_bad_dui/correction-data", {}, "GET"),
      correctionRuntime(db)
    );
    const direct = await worker.fetch(
      correctionRequest("/api/documents/doc_rejected_correction/correction-data", {}, "GET"),
      correctionRuntime(db)
    );

    expect(wompi.status).toBe(200);
    expect(direct.status).toBe(200);
    const wompiText = await wompi.text();
    expect(JSON.parse(wompiText)).toMatchObject({
      receptor: expect.objectContaining({
        tipoDocumento: "13",
        numDocumento: "12345678-9"
      }),
      targetStatus: "FAILED",
      correctable: true,
      activeCorrection: { id: "fiscal_correction_active", status: "REVIEW_REQUIRED" }
    });
    expect(Object.keys(JSON.parse(wompiText))).toEqual([
      "receptor", "targetStatus", "failureReason", "correctable", "guidance", "activeCorrection"
    ]);
    for (const responseText of [wompiText, await direct.text()]) {
      for (const forbidden of [
        "raw_body", "signed_jws", "amount_cents", "emisor",
        "codigo_generacion", "numero_control", "sello_recibido"
      ]) {
        expect(responseText).not.toContain(forbidden);
      }
    }
  });

  it("returns 404 for missing targets and 409 for ineligible fiscal states", async () => {
    const db = correctionDb();
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const getEvent = vi.spyOn(Repository.prototype, "getWompiEventById");
    const getDocument = vi.spyOn(Repository.prototype, "getDteDocument");

    getEvent.mockResolvedValueOnce(null).mockResolvedValueOnce(
      correctionEvent({
        result: "Denegada",
        raw_body: JSON.stringify(correctionWebhook({ ResultadoTransaccion: "Denegada" }))
      }) as any
    );
    getDocument
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rejectedCorrectionDocument({ status: "ACCEPTED" }))
      .mockResolvedValueOnce(rejectedCorrectionDocument({ status: "INVALIDATED" }))
      .mockResolvedValueOnce(rejectedCorrectionDocument({ fiscal_operation_claim_id: "pending-claim" }));

    const requestBody = {
      correctionRequestId: crypto.randomUUID(),
      receptor: correctionReceptor({ nombre: "Nombre cambiado" })
    };
    const responses = [];
    responses.push(await worker.fetch(correctionRequest("/api/wompi-events/missing/correction-data", {}, "GET"), correctionRuntime(db)));
    responses.push(await worker.fetch(correctionRequest("/api/documents/missing/correction-data", {}, "GET"), correctionRuntime(db)));
    responses.push(await worker.fetch(correctionRequest("/api/wompi-events/wompi_bad_dui/correct-and-retry", requestBody), correctionRuntime(db)));
    for (let index = 0; index < 3; index += 1) {
      responses.push(await worker.fetch(correctionRequest("/api/documents/doc_rejected_correction/correct-and-retry", {
        ...requestBody,
        correctionRequestId: crypto.randomUUID()
      }), correctionRuntime(db)));
    }

    expect(responses.map((response) => response.status)).toEqual([404, 404, 409, 409, 409, 409]);
  });

  it("rejects protected keys and unchanged corrections before claiming", async () => {
    const db = correctionDb();
    const payload = correctionWebhook({
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7",
        Nombre: "Ana",
        Apellidos: "Donante",
        EMail: "ana@example.org",
        Celular: "70001111",
        CodigoPais: "GT",
        Direccion: "Direccion demo"
      }
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ raw_body: JSON.stringify(payload) }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const claim = vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection");

    const topLevelProtected = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor(),
        amount_cents: 1
      }
    ), correctionRuntime(db));
    const receptorProtected = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: { ...correctionReceptor(), emisor: { nombre: "Ataque" } }
      }
    ), correctionRuntime(db));
    const unchanged = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: crypto.randomUUID(),
        receptor: correctionReceptor({
          codDomiciliado: 2,
          codPais: "GT",
          departamento: "00",
          municipio: "00",
          distrito: "00",
          complemento: "Direccion demo"
        })
      }
    ), correctionRuntime(db));

    expect([topLevelProtected.status, receptorProtected.status, unchanged.status]).toEqual([400, 400, 400]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("queues claimed Wompi and document corrections with every ownership token", async () => {
    const db = correctionDb();
    const event = correctionEvent();
    const document = rejectedCorrectionDocument();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_document",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_document"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);

    const wompi = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: "11111111-1111-4111-8111-111111111111",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);
    const direct = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "70000003-2222-4222-8222-700000032222",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), runtime);

    expect([wompi.status, direct.status]).toEqual([202, 202]);
    await expect(wompi.json()).resolves.toEqual({
      ok: true,
      queued: true,
      correctionId: "fiscal_correction_1",
      status: "QUEUED"
    });
    expect(queued).toEqual([
      {
        wompiEventId: "wompi_bad_dui",
        fiscalCorrectionId: "fiscal_correction_1",
        fiscalCorrectionProcessingClaimId: "correction_processing_1",
        issuanceAttemptId: "issuance_attempt_1"
      },
      {
        advancedDocumentId: "doc_rejected_correction",
        fiscalCorrectionId: "fiscal_correction_document",
        fiscalCorrectionProcessingClaimId: "correction_processing_1",
        fiscalClaimId: "fiscal_claim_document"
      }
    ]);
  });

  it("issues a corrected pre-CDE Wompi failure with its existing reservation", async () => {
    const db = correctionDb();
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const numeroControl = "DTE-15-M001P004-000000000000041";
    const event = correctionEvent({
      control_prefix: "M001P004",
      control_sequence: 41,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    });
    db.wompiEvents.push(event);
    db.nextSequence = 42;
    const rawBodyBefore = String(event.raw_body);
    const intentsBefore = JSON.stringify(db.donationIntents);
    const sequenceBefore = db.nextSequence;
    const correction = correctionRecord({
      wompi_event_id: String(event.id),
      issuance_attempt_id: "issuance_attempt_corrected_1",
      processing_claim_id: "correction_processing_corrected_1",
      changed_fields_json: JSON.stringify([
        "numDocumento",
        "raw_body",
        "numDocumento",
        42
      ])
    });
    const queued: IssuanceMessage[] = [];
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockImplementation(async () => {
      event.processed_at = null;
      event.issuance_status = "RETRY_QUEUED";
      event.issuance_attempt_id = correction.issuance_attempt_id;
      return { kind: "claimed", correction };
    });
    vi.spyOn(Repository.prototype, "getFiscalCorrection").mockImplementation(async (id) =>
      id === correction.id ? correction : null
    );
    vi.spyOn(Repository.prototype, "claimFiscalCorrectionProcessing").mockImplementation(async (input) => {
      if (
        input.id !== correction.id
        || input.processingClaimId !== correction.processing_claim_id
        || input.issuanceAttemptId !== correction.issuance_attempt_id
        || correction.status !== "QUEUED"
      ) {
        return "busy";
      }
      correction.status = "PROCESSING";
      correction.processing_started_at = new Date().toISOString();
      return "claimed";
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        const currentEvent = db.wompiEvents.find((candidate) =>
          candidate.id === correction.wompi_event_id
        );
        const document = db.documents.find((candidate) =>
          candidate.id === currentEvent?.created_document_id
        );
        if (
          input.correctionId !== correction.id
          || input.processingClaimId !== correction.processing_claim_id
          || input.documentId !== document?.id
          || input.documentClaimId !== `fiscal_correction_${correction.id}`
          || input.signedJws !== document?.signed_jws
        ) {
          return false;
        }
        correction.mh_dispatch_started_at = new Date().toISOString();
        return true;
      });
    vi.spyOn(Repository.prototype, "finalizeFiscalCorrection")
      .mockImplementation(async (id, processingClaimId, outcome) => {
        const currentEvent = db.wompiEvents.find((candidate) =>
          candidate.id === correction.wompi_event_id
        );
        const document = db.documents.find((candidate) =>
          candidate.id === currentEvent?.created_document_id
        );
        if (
          id !== correction.id
          || processingClaimId !== correction.processing_claim_id
          || !document
          || outcome.document?.documentId !== document.id
          || outcome.document.documentClaimId !== `fiscal_correction_${correction.id}`
          || outcome.document.signedJws !== document.signed_jws
          || document.status !== outcome.status
        ) {
          return false;
        }
        correction.status = outcome.status;
        correction.failure_code = outcome.failureCode ?? null;
        correction.failure_message = outcome.failureMessage ?? null;
        correction.completed_at = new Date().toISOString();
        return true;
      });
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    runtime.EMISOR_CONFIG_JSON = JSON.stringify({
      ...emisorConfig(),
      controlPrefix: "M009P009"
    });
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const response = await worker.fetch(correctionRequest(
      `/api/wompi-events/${String(event.id)}/correct-and-retry`,
      {
        correctionRequestId: correction.request_id,
        receptor: correctionReceptor()
      }
    ), runtime);

    expect(response.status).toBe(202);
    expect(queued).toEqual([expect.objectContaining({
      fiscalCorrectionId: expect.any(String),
      fiscalCorrectionProcessingClaimId: expect.any(String),
      issuanceAttemptId: expect.any(String)
    })]);
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({
      queue: "diezmossv-staging-issuance-example",
      messages: [{
        id: "msg_corrected_wompi_1",
        timestamp: new Date(),
        body: queued[0],
        attempts: 1,
        ack,
        retry
      }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>, runtime);

    expect(correction).toMatchObject({
      status: "ACCEPTED",
      failure_code: null,
      failure_message: null
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const created = db.documents[0];
    expect(created.numero_control).toBe(numeroControl);
    expect(created.codigo_generacion).toBe(codigoGeneracion);
    expect(JSON.parse(created.plain_json).receptor.numDocumento).toBe("10000002-7");
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(event.raw_body).toBe(rawBodyBefore);
    expect(JSON.stringify(db.donationIntents)).toBe(intentsBefore);
    expectCorrectionAudits(db, correction, "ACCEPTED");
  });

  it("validates before allocating one reservation for a corrected event without identifiers", async () => {
    const db = correctionDb();
    db.nextSequence = 51;
    const correction = correctionRecord({
      id: "fiscal_correction_unreserved",
      wompi_event_id: "wompi_correction_unreserved",
      issuance_attempt_id: "issuance_attempt_unreserved",
      processing_claim_id: "correction_processing_unreserved"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].numero_control).toBe(
      `DTE-15-M001P004-${String(sequenceBefore).padStart(15, "0")}`
    );
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("does not allocate when the durable corrected candidate fails validation", async () => {
    const db = correctionDb();
    db.nextSequence = 56;
    const correction = correctionRecord({
      id: "fiscal_correction_invalid_candidate",
      wompi_event_id: "wompi_correction_invalid_candidate",
      issuance_attempt_id: "issuance_attempt_invalid_candidate",
      processing_claim_id: "correction_processing_invalid_candidate",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        numDocumento: "12345678-9"
      }))
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      received_at: "2026-07-17T12:00:00.000Z",
      issuance_last_attempt_at: "2026-07-17T12:01:00.000Z",
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const queued: IssuanceMessage[] = [];
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      failure_code: "FISCAL_CORRECTION_INVALID_CANDIDATE",
      mh_dispatch_started_at: null
    });
    expect(event.issuance_claim_id ?? null).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();

    await new IssuancePipeline(runtime).sweepStalledWompiEvents();

    expect(queued).toHaveLength(0);
    expect(event).toMatchObject({
      issuance_status: "FAILED",
      processed_at: expect.any(String),
      issuance_attempt_id: null,
      issuance_claim_id: null
    });
  });

  it("acks a duplicate correction delivery without allocating or transmitting twice", async () => {
    const db = correctionDb();
    db.nextSequence = 61;
    const correction = correctionRecord({
      id: "fiscal_correction_duplicate",
      wompi_event_id: "wompi_correction_duplicate",
      issuance_attempt_id: "issuance_attempt_duplicate",
      processing_claim_id: "correction_processing_duplicate"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const body: IssuanceMessage = {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    };
    const sequenceBefore = db.nextSequence;

    const first = await consumeCorrectionMessage(runtime, body, "msg_correction_duplicate_1");
    const second = await consumeCorrectionMessage(runtime, body, "msg_correction_duplicate_2");

    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("allows only the correction CAS winner to transmit under concurrent delivery", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_concurrent_dispatch",
      wompi_event_id: "wompi_correction_concurrent_dispatch",
      issuance_attempt_id: "issuance_attempt_concurrent_dispatch",
      processing_claim_id: "correction_processing_concurrent_dispatch",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z"
    });
    const payload = correctionWebhook({
      IdTransaccion: "wompi_correction_concurrent_dispatch_tx",
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7"
      }
    });
    const document = buildCdeDocument(payload, emisorConfig(), {
      sequence: 62,
      environment: "00",
      issuedAt: new Date(payload.FechaTransaccion)
    });
    const identifiers = (document.identificacion ?? {}) as Record<string, unknown>;
    const documentId = "dte_correction_concurrent_dispatch";
    const event = correctionEvent({
      id: correction.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-18T12:02:00.000Z",
      created_document_id: documentId,
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: documentId,
      wompi_event_id: String(event.id),
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: "signed-corrected-document",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      codigo_generacion: String(identifiers.codigoGeneracion),
      numero_control: String(identifiers.numeroControl),
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_claimed_at: "2026-07-18T12:02:01.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    let arrivals = 0;
    let releaseArrivals!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input) => {
        expect(input).toEqual({
          correctionId: correction.id,
          processingClaimId: correction.processing_claim_id,
          documentId,
          documentClaimId: `fiscal_correction_${correction.id}`,
          signedJws: "signed-corrected-document"
        });
        arrivals += 1;
        if (arrivals === 2) releaseArrivals();
        await bothArrived;
        if (correction.mh_dispatch_started_at) return false;
        correction.mh_dispatch_started_at = "2026-07-18T12:03:00.000Z";
        return true;
      });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-CONCURRENT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    const body: IssuanceMessage = {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    };

    const [first, second] = await Promise.all([
      consumeCorrectionMessage(runtime, body, "msg_correction_concurrent_1"),
      consumeCorrectionMessage(runtime, body, "msg_correction_concurrent_2")
    ]);

    expect(transmit).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(first.retry).not.toHaveBeenCalled();
    expect(second.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "ACCEPTED",
      mh_dispatch_started_at: "2026-07-18T12:03:00.000Z"
    });
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-CORRECTION"
    });
  });

  it("keeps a durable MH acceptance when post-accept bookkeeping throws", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_post_accept_failure",
      wompi_event_id: "wompi_correction_post_accept_failure",
      issuance_attempt_id: "issuance_attempt_post_accept_failure",
      processing_claim_id: "correction_processing_post_accept_failure"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    vi.spyOn(Repository.prototype, "claimDocumentPostAcceptFinalization")
      .mockRejectedValueOnce(new Error("injected post-accept bookkeeping failure"));
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      post_accept_finalized_at: null
    });
    expect(correction.status).toBe("ACCEPTED");
    expectCorrectionAudits(db, correction, "ACCEPTED");
  });

  it("acks missing or stale correction ownership without allocating, signing, or transmitting", async () => {
    const db = correctionDb();
    db.nextSequence = 71;
    const correction = correctionRecord({
      id: "fiscal_correction_stale_ownership",
      wompi_event_id: "wompi_correction_stale_ownership",
      issuance_attempt_id: "issuance_attempt_owned",
      processing_claim_id: "correction_processing_owned"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id,
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const sign = vi.spyOn(crypto.subtle, "sign");
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    const sequenceBefore = db.nextSequence;
    const messages: IssuanceMessage[] = [
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        issuanceAttemptId: correction.issuance_attempt_id!
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: "correction_processing_stale",
        issuanceAttemptId: correction.issuance_attempt_id!
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: "issuance_attempt_stale"
      },
      {
        wompiEventId: String(event.id),
        fiscalCorrectionId: correction.id,
        fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
        issuanceAttemptId: correction.issuance_attempt_id!,
        fiscalClaimId: "unexpected_fiscal_claim"
      }
    ];

    const dispositions = [];
    for (const [index, message] of messages.entries()) {
      dispositions.push(await consumeCorrectionMessage(
        runtime,
        message,
        `msg_correction_stale_${index}`
      ));
    }

    for (const disposition of dispositions) {
      expect(disposition.ack).toHaveBeenCalledTimes(1);
      expect(disposition.retry).not.toHaveBeenCalled();
    }
    expect(correction.status).toBe("QUEUED");
    expect(event.issuance_claim_id ?? null).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(sign).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it("finalizes a corrected CDE rejected by MH as REJECTED", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_rejected",
      wompi_event_id: "wompi_correction_rejected",
      issuance_attempt_id: "issuance_attempt_rejected",
      processing_claim_id: "correction_processing_rejected"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      expect(correction.mh_dispatch_started_at).toBeTruthy();
      return {
        accepted: false,
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: ["#/receptor/numDocumento rechazado"],
        raw: { estado: "RECHAZADO" }
      };
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction.status).toBe("REJECTED");
    expect(correction.mh_dispatch_started_at).toBeTruthy();
    expect(db.documents[0]).toMatchObject({
      status: "REJECTED",
      fiscal_operation_claim_id: null
    });
    expectCorrectionAudits(db, correction, "REJECTED");
  });

  it("marks a proven MH pre-dispatch correction failure FAILED and clears claims", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_pre_dispatch",
      wompi_event_id: "wompi_correction_pre_dispatch",
      issuance_attempt_id: "issuance_attempt_pre_dispatch",
      processing_claim_id: "correction_processing_pre_dispatch"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new MhPreDispatchError("MH auth unavailable", new Error("auth unavailable"))
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "FAILED",
      mh_dispatch_started_at: null,
      failure_code: "MH_PRE_DISPATCH_ERROR"
    });
    expect(db.documents[0]).toMatchObject({
      status: "FAILED",
      fiscal_operation_claim_id: null
    });
    expectCorrectionAudits(db, correction, "FAILED");
  });

  it("keeps an ambiguous corrected MH dispatch claimed and REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_uncertain",
      wompi_event_id: "wompi_correction_uncertain",
      issuance_attempt_id: "issuance_attempt_uncertain",
      processing_claim_id: "correction_processing_uncertain"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: null,
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      expect(correction.mh_dispatch_started_at).toBeTruthy();
      throw new Error("connection reset after request write");
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: expect.any(String),
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_kind: "TRANSMISSION"
    });
    expectCorrectionAudits(db, correction, "REVIEW_REQUIRED");
  });

  it("turns a redelivered post-boundary PROCESSING correction into REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const documentId = "dte_correction_post_boundary_redelivery";
    const correction = correctionRecord({
      id: "fiscal_correction_post_boundary_redelivery",
      wompi_event_id: "wompi_correction_post_boundary_redelivery",
      issuance_attempt_id: "issuance_attempt_post_boundary_redelivery",
      processing_claim_id: "correction_processing_post_boundary_redelivery",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z",
      mh_dispatch_started_at: "2026-07-18T12:02:00.000Z"
    });
    const event = correctionEvent({
      id: correction.wompi_event_id,
      processed_at: "2026-07-18T12:01:30.000Z",
      created_document_id: documentId,
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: documentId,
      wompi_event_id: String(correction.wompi_event_id),
      status: "SIGNED",
      signed_jws: "signed-post-boundary-correction",
      fiscal_operation_claim_id: `fiscal_correction_${correction.id}`,
      fiscal_operation_claimed_at: "2026-07-18T12:01:59.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = correctionRuntime(db);

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: "2026-07-18T12:02:00.000Z",
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
  });

  it("retries token-owned safe pre-dispatch work while its CDE claim is busy", async () => {
    const db = correctionDb();
    const correction = correctionRecord({
      id: "fiscal_correction_safe_busy",
      wompi_event_id: "wompi_correction_safe_busy",
      issuance_attempt_id: "issuance_attempt_safe_busy",
      processing_claim_id: "correction_processing_safe_busy",
      status: "PROCESSING",
      processing_started_at: "2026-07-18T12:01:00.000Z"
    });
    const payload = correctionWebhook({
      IdTransaccion: "wompi_correction_safe_busy_tx",
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7"
      }
    });
    const document = buildCdeDocument(payload, emisorConfig(), {
      sequence: 81,
      environment: "00",
      issuedAt: new Date(payload.FechaTransaccion)
    });
    const identifiers = (document.identificacion ?? {}) as Record<string, unknown>;
    const event = correctionEvent({
      id: correction.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      processed_at: "2026-07-18T12:02:00.000Z",
      created_document_id: "dte_correction_safe_busy",
      issuance_status: "DOCUMENT_CREATED",
      issuance_attempt_id: correction.issuance_attempt_id
    });
    db.wompiEvents.push(event);
    db.documents.push(testDocument({
      id: "dte_correction_safe_busy",
      wompi_event_id: String(event.id),
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: "signed-by-other-owner",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      codigo_generacion: String(identifiers.codigoGeneracion),
      numero_control: String(identifiers.numeroControl),
      fiscal_operation_claim_id: "foreign-safe-predispatch-claim",
      fiscal_operation_claimed_at: "2026-07-18T12:02:01.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));
    stubQueuedCorrectionLifecycle(correction, event, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);

    const disposition = await consumeCorrectionMessage(runtime, {
      wompiEventId: String(event.id),
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      issuanceAttemptId: correction.issuance_attempt_id!
    });

    expect(disposition.ack).not.toHaveBeenCalled();
    expect(disposition.retry).toHaveBeenCalledTimes(1);
    expect(transmit).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "PROCESSING",
      mh_dispatch_started_at: null
    });
    expect(db.documents[0].fiscal_operation_claim_id).toBe("foreign-safe-predispatch-claim");
  });

  it("does not dispatch when a corrected document loses its exact claim before the marker", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_correction_dispatch_owner_lost",
      fiscal_operation_claim_id: "fiscal_claim_dispatch_owner_lost",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_dispatch_owner_lost",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_dispatch_owner_lost",
      processing_claim_id: "correction_processing_dispatch_owner_lost",
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    let markerInput: unknown;
    vi.spyOn(Repository.prototype, "markFiscalCorrectionMhDispatchStarted")
      .mockImplementation(async (input: any) => {
        markerInput = input;
        source.fiscal_operation_claim_id = "foreign-claim-before-marker";
        return false;
      });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).not.toHaveBeenCalled();
    expect(disposition.retry).toHaveBeenCalledTimes(1);
    expect(transmit).not.toHaveBeenCalled();
    expect(markerInput).toEqual({
      correctionId: correction.id,
      processingClaimId: correction.processing_claim_id,
      documentId: source.id,
      documentClaimId: correction.fiscal_claim_id,
      signedJws: source.signed_jws
    });
    expect(correction).toMatchObject({
      status: "PROCESSING",
      mh_dispatch_started_at: null
    });
    expect(source.fiscal_operation_claim_id).toBe("foreign-claim-before-marker");
  });

  it("rebuilds a claimed direct rejected document from its immutable snapshot", async () => {
    const db = correctionDb();
    db.nextSequence = 91;
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_direct_correction",
      fiscal_operation_claim_id: "fiscal_claim_direct_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_direct_document",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_direct_correction",
      processing_claim_id: "correction_processing_direct_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor Directo Corregido",
        correo: null
      })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-DIRECT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const original = JSON.parse(source.plain_json) as Record<string, any>;
    const originalIdentifiers = {
      codigoGeneracion: source.codigo_generacion,
      numeroControl: source.numero_control
    };
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: correction.document_id!,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    const updated = db.documents[0];
    const corrected = JSON.parse(updated.plain_json) as Record<string, any>;
    expect(updated.id).toBe(source.id);
    expect(updated.wompi_event_id).toBeNull();
    expect(updated.codigo_generacion).not.toBe(originalIdentifiers.codigoGeneracion);
    expect(updated.numero_control).not.toBe(originalIdentifiers.numeroControl);
    expect(corrected.receptor.nombre).toBe("Receptor Directo Corregido");
    expect(corrected.emisor).toEqual(original.emisor);
    expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
    expect(corrected.resumen).toEqual(original.resumen);
    expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
    expect(JSON.parse(correction.source_document_snapshot_json!)).toMatchObject({
      codigo_generacion: originalIdentifiers.codigoGeneracion,
      numero_control: originalIdentifiers.numeroControl,
      signed_jws: "original.signed.jws"
    });
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({
      signedJws: expect.not.stringMatching(/^original\.signed\.jws$/)
    }));
  });

  it("preserves Wompi evidence and runs normal accepted finalization on the same row", async () => {
    const db = correctionDb();
    db.nextSequence = 101;
    const payload = correctionWebhook({
      IdTransaccion: "wompi_rejected_correction_tx",
      Monto: "25.00",
      CodigoAutorizacion: "authorization_original",
      IdExterno: "di_document_correction",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_document_correction",
        NombreProducto: "Ofrenda"
      },
      Cliente: {
        ...(correctionWebhook().Cliente ?? {}),
        DocumentoIdentidad: "10000002-7",
        EMail: "original@example.org"
      }
    });
    const sourcePlain = buildCdeDocument(payload, emisorConfig(), {
      sequence: 23,
      environment: "00",
      issuedAt: new Date(payload.FechaTransaccion),
      donorOverride: {
        tipoDocumento: "13",
        numDocumento: "10000002-7",
        nombre: "Receptor Wompi Original",
        correo: "original@example.org",
        telefono: "70001111",
        direccion: {
          departamento: "06",
          municipio: "22",
          distrito: "01",
          complemento: "Dirección original"
        },
        codPais: "SV",
        codDomiciliado: 1,
        giftType: "OFRENDA"
      }
    }) as Record<string, any>;
    const sourceIds = sourcePlain.identificacion as Record<string, string>;
    const source = testDocument({
      id: "doc_rejected_wompi_correction",
      wompi_event_id: "wompi_rejected_correction",
      status: "REJECTED",
      codigo_generacion: sourceIds.codigoGeneracion,
      numero_control: sourceIds.numeroControl,
      plain_json: JSON.stringify(sourcePlain),
      signed_jws: "original-wompi.signed.jws",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: JSON.stringify(["#/receptor/nombre rechazado"]),
      donor_name: "Receptor Wompi Original",
      donor_email: "original@example.org",
      amount_cents: 2500,
      accepted_at: null,
      fiscal_operation_claim_id: "fiscal_claim_wompi_document",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_wompi_document_processing",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_wompi_document",
      processing_claim_id: "correction_processing_wompi_document",
      corrected_receptor_json: JSON.stringify(correctionReceptor({
        nombre: "Receptor Wompi Corregido",
        correo: "corrected@example.org"
      })),
      changed_fields_json: JSON.stringify(["nombre", "correo"]),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    db.wompiEvents.push(correctionEvent({
      id: source.wompi_event_id,
      transaction_id: payload.IdTransaccion,
      raw_body: JSON.stringify(payload),
      created_document_id: source.id,
      processed_at: "2026-07-18T12:00:00.000Z",
      issuance_status: "DOCUMENT_CREATED"
    }));
    db.donationIntents.push({
      id: "di_document_correction",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: "06",
      direccion_municipio: "22",
      direccion_distrito: "01",
      direccion_complemento: "Dirección original",
      donor_pais: null,
      gift_type: "OFRENDA",
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-07-18T11:00:00.000Z",
      updated_at: "2026-07-18T11:00:00.000Z",
      expires_at: "2099-07-18T12:00:00.000Z"
    });
    stubDocumentCorrectionLifecycle(correction, db);
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-WOMPI-DOCUMENT-CORRECTION",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";
    const sequenceBefore = db.nextSequence;

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.documents).toHaveLength(1);
    const updated = db.documents[0];
    const corrected = JSON.parse(updated.plain_json) as Record<string, any>;
    const snapshot = JSON.parse(correction.source_document_snapshot_json!) as DteDocumentRecord;
    const original = JSON.parse(snapshot.plain_json) as Record<string, any>;
    expect(updated.id).toBe(source.id);
    expect(updated.wompi_event_id).toBe(source.wompi_event_id);
    expect(updated.codigo_generacion).not.toBe(snapshot.codigo_generacion);
    expect(updated.numero_control).not.toBe(snapshot.numero_control);
    expect(snapshot.signed_jws).toBe("original-wompi.signed.jws");
    expect(corrected.receptor).toMatchObject({
      nombre: "Receptor Wompi Corregido",
      correo: "corrected@example.org"
    });
    expect(corrected.resumen).toEqual(original.resumen);
    expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
    expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
    expect(corrected.apendice).toEqual(original.apendice);
    expect(transmit).toHaveBeenCalledWith(expect.objectContaining({
      signedJws: expect.not.stringMatching(/^original-wompi\.signed\.jws$/)
    }));
    expect(db.donationIntents[0]).toMatchObject({
      status: "COMPLETED",
      document_id: source.id
    });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: source.id,
      email_type: "dteReceipt",
      status: "SENT"
    }));
    expectCorrectionAudits(db, correction, "ACCEPTED", ["nombre", "correo"]);
  });

  it("leaves a durable corrected SIGNED row on the safe retry path after proven pre-dispatch failure", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_predispatch_correction",
      fiscal_operation_claim_id: "fiscal_claim_predispatch_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_document_predispatch",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_predispatch_correction",
      processing_claim_id: "correction_processing_predispatch_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({ correo: null })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new MhPreDispatchError("MH auth unavailable", new Error("auth unavailable"))
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "FAILED",
      mh_dispatch_started_at: null,
      failure_code: "MH_PRE_DISPATCH_ERROR"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: null,
      fiscal_operation_kind: null
    });
  });

  it("keeps an ambiguous corrected document dispatch claimed and REVIEW_REQUIRED", async () => {
    const db = correctionDb();
    const source = rejectedCorrectionDocument({
      id: "doc_rejected_ambiguous_correction",
      fiscal_operation_claim_id: "fiscal_claim_ambiguous_correction",
      fiscal_operation_claimed_at: "2026-07-18T12:00:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    });
    const correction = correctionRecord({
      id: "fiscal_correction_document_ambiguous",
      target_kind: "DTE_DOCUMENT",
      wompi_event_id: null,
      document_id: source.id,
      issuance_attempt_id: null,
      fiscal_claim_id: "fiscal_claim_ambiguous_correction",
      processing_claim_id: "correction_processing_ambiguous_correction",
      corrected_receptor_json: JSON.stringify(correctionReceptor({ correo: null })),
      source_document_snapshot_json: JSON.stringify(source)
    });
    db.documents.push(source);
    stubDocumentCorrectionLifecycle(correction, db);
    vi.spyOn(MhClient.prototype, "transmitDte").mockRejectedValue(
      new Error("connection reset after request write")
    );
    const runtime = correctionRuntime(db);
    runtime.MH_CERT_XML = await generatedCertificateXml("cert-password");
    runtime.MH_CERT_PASSWORD = "cert-password";

    const disposition = await consumeCorrectionMessage(runtime, {
      advancedDocumentId: source.id,
      fiscalCorrectionId: correction.id,
      fiscalCorrectionProcessingClaimId: correction.processing_claim_id,
      fiscalClaimId: correction.fiscal_claim_id!
    });

    expect(disposition.ack).toHaveBeenCalledTimes(1);
    expect(disposition.retry).not.toHaveBeenCalled();
    expect(correction).toMatchObject({
      status: "REVIEW_REQUIRED",
      mh_dispatch_started_at: expect.any(String),
      failure_code: "MH_DISPATCH_UNCERTAIN"
    });
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: correction.fiscal_claim_id,
      fiscal_operation_kind: "TRANSMISSION"
    });
    expectCorrectionAudits(db, correction, "REVIEW_REQUIRED");
  });

  it("preflights a Wompi-backed rejected document from its durable source", async () => {
    const db = correctionDb();
    const document = rejectedCorrectionDocument({
      wompi_event_id: "wompi_rejected_source"
    });
    const event = correctionEvent({
      id: "wompi_rejected_source",
      raw_body: JSON.stringify(correctionWebhook({ Monto: "not-a-number" }))
    });
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "claimDocumentFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        id: "fiscal_correction_wompi_document",
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_wompi_document"
      })
    });
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        correctionRequestId: "33333333-3333-4333-8333-333333333333",
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(202);
    expect(queued).toEqual([{
      advancedDocumentId: document.id,
      fiscalCorrectionId: "fiscal_correction_wompi_document",
      fiscalCorrectionProcessingClaimId: "correction_processing_1",
      fiscalClaimId: "fiscal_claim_wompi_document"
    }]);
  });

  it("refuses non-receptor corrections before durable claim or queue send", async () => {
    const db = correctionDb();
    const event = correctionEvent({
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "NIT del emisor inválido"
    });
    const document = rejectedCorrectionDocument({
      mh_observaciones_json: JSON.stringify(["Actividad del emisor inválida"])
    });
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(event as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "getDteDocument").mockResolvedValue(document);
    const wompiClaim = vi.spyOn(
      Repository.prototype,
      "claimWompiFiscalCorrection"
    ).mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord()
    });
    const documentClaim = vi.spyOn(
      Repository.prototype,
      "claimDocumentFiscalCorrection"
    ).mockResolvedValue({
      kind: "claimed",
      correction: correctionRecord({
        target_kind: "DTE_DOCUMENT",
        wompi_event_id: null,
        document_id: document.id,
        issuance_attempt_id: null,
        fiscal_claim_id: "fiscal_claim_noncorrectable"
      })
    });
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const requestBody = {
      receptor: correctionReceptor({ nombre: "Nombre corregido" })
    };

    const wompi = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        ...requestBody,
        correctionRequestId: "44444444-4444-4444-8444-444444444444"
      }
    ), runtime);
    const direct = await worker.fetch(correctionRequest(
      "/api/documents/doc_rejected_correction/correct-and-retry",
      {
        ...requestBody,
        correctionRequestId: "55555555-5555-4555-8555-555555555555"
      }
    ), runtime);

    expect([wompi.status, direct.status]).toEqual([409, 409]);
    for (const response of [wompi, direct]) {
      await expect(response.json()).resolves.toEqual({
        error: "fiscal_correction_not_allowed",
        message: "Revise Configuración y la evidencia técnica antes de volver a intentar."
      });
    }
    expect(wompiClaim).not.toHaveBeenCalled();
    expect(documentClaim).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  it("suppresses duplicate queue sends and rejects a conflicting request id", async () => {
    const db = correctionDb();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(
      correctionEvent({ issuance_status: "RETRY_QUEUED" }) as any
    );
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    const existing = correctionRecord({
      corrected_receptor_json: JSON.stringify(
        correctionReceptor({ nombre: "Nombre corregido" })
      )
    });
    vi.spyOn(Repository.prototype, "getFiscalCorrectionByRequestId")
      .mockResolvedValue(existing);
    const claim = vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection");
    const queued: IssuanceMessage[] = [];
    const runtime = correctionRuntime(db, {
      send: async (message: IssuanceMessage) => queued.push(message)
    } as unknown as Queue<IssuanceMessage>);
    const body = {
      correctionRequestId: "11111111-1111-4111-8111-111111111111",
      receptor: correctionReceptor({ nombre: "Nombre corregido" })
    };

    const duplicate = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      body
    ), runtime);
    const conflict = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        ...body,
        receptor: correctionReceptor({ nombre: "Otro nombre" })
      }
    ), runtime);

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ok: true,
      queued: false,
      duplicate: true,
      correctionId: "fiscal_correction_1",
      status: "QUEUED"
    });
    expect(conflict.status).toBe(409);
    expect(queued).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps a durable QUEUED correction when queue submission fails", async () => {
    const db = correctionDb();
    const correction = correctionRecord();
    vi.spyOn(Repository.prototype, "getWompiEventById").mockResolvedValue(correctionEvent() as any);
    vi.spyOn(Repository.prototype, "getDonationIntent").mockResolvedValue(null);
    vi.spyOn(Repository.prototype, "claimWompiFiscalCorrection").mockResolvedValue({
      kind: "claimed",
      correction
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(correctionRequest(
      "/api/wompi-events/wompi_bad_dui/correct-and-retry",
      {
        correctionRequestId: correction.request_id,
        receptor: correctionReceptor({ nombre: "Nombre corregido" })
      }
    ), correctionRuntime(db, {
      send: async () => { throw new Error("private queue failure"); }
    } as unknown as Queue<IssuanceMessage>));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "fiscal_correction_queue_failed",
      message: "La corrección quedó guardada y será reintentada automáticamente."
    });
    expect(correction.status).toBe("QUEUED");
  });
});

describe("request body limits", () => {
  it("rejects an oversized login body before authentication or throttling", async () => {
    const db = new InMemoryD1();
    const body = JSON.stringify({ email: `${"a".repeat(16 * 1024)}@example.org`, password: "Password#2026" });
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      }),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an oversized Wompi body before HMAC verification", async () => {
    const db = new InMemoryD1();
    const body = JSON.stringify({ padding: "x".repeat(64 * 1024) });
    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      }),
      env(db, { WOMPI_API_SECRET: "test-secret" })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.wompiEvents).toHaveLength(0);
  });

  it("maps malformed JSON on strict public routes to invalid_json_body", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json_body" });
    expect(db.audits).toHaveLength(0);
  });

  it("preserves tolerant malformed-JSON behavior on donation intent creation", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_amount" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects an oversized authenticated admin body before changing credentials", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    const body = JSON.stringify({ password: "x".repeat(257 * 1024) });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "Content-Length": String(body.length)
        },
        body
      }),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.users[0]).toMatchObject({ password_hash: "old-hash", password_salt: "old-salt" });
    expect(db.audits).toHaveLength(0);
  });
});

describe("document route authorization order", () => {
  it("returns 401 without looking up either an existing or missing document", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ id: "doc_existing" }));

    const existing = await worker.fetch(new Request("https://example.org/api/documents/doc_existing"), env(db));
    const missing = await worker.fetch(new Request("https://example.org/api/documents/doc_missing"), env(db));

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(db.documentLookupCount).toBe(0);
  });

  it("returns 403 to a VIEWER mutation without looking up either document", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_existing" }));
    const init = { method: "POST", headers: { Authorization: "Bearer test-token" } };

    const existing = await worker.fetch(new Request("https://example.org/api/documents/doc_existing/resend", init), env(db));
    const missing = await worker.fetch(new Request("https://example.org/api/documents/doc_missing/resend", init), env(db));

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(db.documentLookupCount).toBe(0);
  });
});

const VALID_BOOTSTRAP_TOKEN = `bt_${"A".repeat(43)}`;
const OTHER_BOOTSTRAP_TOKEN = `bt_${"B".repeat(43)}`;

describe("owner bootstrap", () => {
  it("reports bootstrap availability before the first user exists", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bootstrapAvailable: true });
  });

  it("reports bootstrap unavailable after an owner exists", async () => {
    const db = new InMemoryD1();
    db.users.push({
      id: "user_owner",
      email: "owner@example.org",
      name: "Owner",
      role: "OWNER",
      password_hash: "hash",
      password_salt: "salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bootstrapAvailable: false });
  });

  it("rejects first-owner bootstrap when the setup token is missing", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest(),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("rejects first-owner bootstrap when the setup token is wrong", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "wrong-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("fails closed when the configured setup token is not a generated token", async () => {
    const db = new InMemoryD1();
    const status = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );
    const creation = await worker.fetch(
      bootstrapRequest({ token: "setup-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    await expect(status.json()).resolves.toEqual({ bootstrapAvailable: false });
    expect(creation.status).toBe(503);
    await expect(creation.json()).resolves.toMatchObject({ error: "bootstrap_configuration_invalid" });
    expect(db.users).toHaveLength(0);
  });

  it("limits every bootstrap-token guess from one source before parsing the owner body", async () => {
    const db = new InMemoryD1();
    const runtime = env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await worker.fetch(
        new Request("https://example.org/api/auth/bootstrap-owner", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "203.0.113.88",
            "X-Bootstrap-Owner-Token": `invalid-${attempt}`
          },
          body: "not-json"
        }),
        runtime
      );
      expect(response.status).toBe(403);
    }

    const denied = await worker.fetch(
      bootstrapRequest({ token: OTHER_BOOTSTRAP_TOKEN }, "203.0.113.88"),
      runtime
    );

    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
    expect(db.users).toHaveLength(0);
    expect([...db.loginRateLimits.keys()]).toHaveLength(1);
    expect([...db.loginRateLimits.keys()][0]).not.toContain("203.0.113.88");
  });

  it("creates the first owner when the setup token matches", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        email: "legacy-contact-3@example.com",
        name: "Example Person",
        role: "OWNER"
      }
    });
    expect(db.users).toHaveLength(1);
    expect(db.users[0].role).toBe("OWNER");
  });

  it("returns a closed-bootstrap conflict after the first owner is created", async () => {
    const db = new InMemoryD1();
    const runtime = env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN });

    const first = await worker.fetch(bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }), runtime);
    const second = await worker.fetch(bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }), runtime);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "bootstrap_unavailable" });
    expect(db.users).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "OWNER_BOOTSTRAPPED")).toHaveLength(1);
  });

  it("uses one conditional insert to admit only one initial owner", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        disabled_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`);
      const repo = new Repository(sqliteD1(sqlite));
      const results = await Promise.all([
        repo.createInitialOwner({
          email: "owner-one@example.org",
          name: "Owner One",
          passwordHash: "hash-one",
          passwordSalt: "salt-one"
        }),
        repo.createInitialOwner({
          email: "owner-two@example.org",
          name: "Owner Two",
          passwordHash: "hash-two",
          passwordSalt: "salt-two"
        })
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT role FROM users").get()).toEqual({ role: "OWNER" });
    } finally {
      sqlite.close();
    }
  });
});

describe("auth rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedAudit(db: InMemoryD1, action: string, entityId: string, createdAt: string, actorIp: string | null = null): void {
    db.audits.push({
      id: `audit_${action}_${db.audits.length}`,
      actor_type: "SYSTEM",
      actor_id: null,
      action,
      entity_type: "user",
      entity_id: entityId,
      summary: "seeded",
      metadata_json: "{}",
      actor_ip: actorIp,
      created_at: createdAt
    });
  }

  function loginRequest(email: string, password = "whatever") {
    return new Request("https://example.org/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
  }

  describe("aggregate login attempts", () => {
    it("blocks the sixty-first login attempt from one IP across distinct account names", async () => {
      const db = new InMemoryD1();
      for (let index = 0; index < 60; index += 1) {
        const response = await worker.fetch(
          new Request("https://example.org/api/auth/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "CF-Connecting-IP": "203.0.113.70"
            },
            body: JSON.stringify({ email: `user-${index}@example.org`, password: "invalid" })
          }),
          env(db)
        );
        expect(response.status).toBe(401);
      }

      const auditsBeforeDenial = db.audits.length;
      const readsBeforeDenial = db.loginCredentialReads;
      const denied = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "203.0.113.70"
          },
          body: JSON.stringify({ email: "sixty-first@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(denied.status).toBe(429);
      await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
      expect(db.loginCredentialReads).toBe(readsBeforeDenial);
      expect(db.audits).toHaveLength(auditsBeforeDenial);
      expect([...db.loginRateLimits.keys()]).toHaveLength(1);
      expect([...db.loginRateLimits.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
      expect([...db.loginRateLimits.keys()][0]).not.toContain("203.0.113.70");
    });

    it("resets an expired aggregate login bucket before normal credential handling", async () => {
      const db = new InMemoryD1();
      const callerIp = "198.51.100.9";
      const keyHash = await sha256Hex(utf8Bytes(callerIp));
      db.loginRateLimits.set(keyHash, {
        window_started_at: "2026-07-04T11:00:00.000Z",
        attempt_count: 60,
        expires_at: "2026-07-04T11:15:00.000Z"
      });

      const response = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": callerIp
          },
          body: JSON.stringify({ email: "other@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(response.status).toBe(401);
      expect(db.loginCredentialReads).toBe(1);
      expect(db.loginRateLimits.get(keyHash)).toEqual({
        window_started_at: "2026-07-04T12:00:00.000Z",
        attempt_count: 1,
        expires_at: "2026-07-04T12:15:00.000Z"
      });
    });

    it("resets an expired aggregate login bucket with SQLite UPSERT semantics", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE login_rate_limits (
          key_hash TEXT PRIMARY KEY,
          window_started_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
          expires_at TEXT NOT NULL
        )`);
        const callerIp = "198.51.100.9";
        const keyHash = await sha256Hex(utf8Bytes(callerIp));
        sqlite
          .prepare(
            `INSERT INTO login_rate_limits (
               key_hash, window_started_at, attempt_count, expires_at
             ) VALUES (?, ?, ?, ?)`
          )
          .run(keyHash, "2026-07-04T11:00:00.000Z", 60, "2026-07-04T11:15:00.000Z");

        const repo = new Repository(sqliteD1(sqlite));
        const accepted = await repo.claimLoginAttempt(
          keyHash,
          "2026-07-04T12:00:00.000Z",
          "2026-07-04T11:45:00.000Z",
          "2026-07-04T12:15:00.000Z",
          60
        );

        expect(accepted).toBe(true);
        expect(
          sqlite
            .prepare(
              `SELECT window_started_at, attempt_count, expires_at
               FROM login_rate_limits
               WHERE key_hash = ?`
            )
            .get(keyHash)
        ).toEqual({
          window_started_at: "2026-07-04T12:00:00.000Z",
          attempt_count: 1,
          expires_at: "2026-07-04T12:15:00.000Z"
        });
      } finally {
        sqlite.close();
      }
    });

    it("combines legacy activity and atomic claims with the production SQLite statement", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE donation_intents (
          id TEXT PRIMARY KEY,
          client_ip TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO donation_intents (id, client_ip, created_at) VALUES
          ('legacy_1', '203.0.113.7', '2026-07-04T11:50:00.000Z'),
          ('legacy_2', '203.0.113.7', '2026-07-04T11:51:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));
        const accepted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimDonationIntentRateLimit(
              "hashed-client-ip",
              "203.0.113.7",
              "2026-07-04T12:00:00.000Z",
              "2026-07-04T11:45:00.000Z",
              "2026-07-04T12:15:00.000Z",
              5
            )
          )
        );

        expect(accepted.filter(Boolean)).toHaveLength(3);
        expect(
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM security_rate_limit_claims
                WHERE scope = ? AND key_hash = ?`
            )
            .get("donation_intent", "hashed-client-ip")
        ).toEqual({ count: 3 });
      } finally {
        sqlite.close();
      }
    });

    it("counts a late legacy donation row after the first ledger claim", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE donation_intents (
          id TEXT PRIMARY KEY,
          client_ip TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
          VALUES ('first_new_claim', 'donation_intent', 'hashed-client-ip', '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z');
        INSERT INTO donation_intents (id, client_ip, rate_limit_claim_id, created_at)
          VALUES ('late_legacy_intent', '203.0.113.7', NULL, '2026-07-04T12:01:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));

        const admitted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimDonationIntentRateLimit(
              "hashed-client-ip",
              "203.0.113.7",
              "2026-07-04T12:02:00.000Z",
              "2026-07-04T11:47:00.000Z",
              "2026-07-04T12:17:00.000Z",
              5
            )
          )
        );

        expect(admitted.filter(Boolean)).toHaveLength(3);
      } finally {
        sqlite.close();
      }
    });

    it("atomically composes reset pair and account budgets across the legacy cutover", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          subject_key_hash TEXT,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
          VALUES ('first_new_claim', 'password_reset', 'hashed-source-account', '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z');
        INSERT INTO audit_logs (id, action, entity_id, rate_limit_claim_id, created_at)
          VALUES ('late_legacy_audit', 'PASSWORD_RESET_REQUESTED', 'user_operator', NULL, '2026-07-04T12:01:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));

        const admitted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimPasswordResetBudgets(
              "hashed-source-account",
              "hashed-account",
              "user_operator",
              "2026-07-04T12:02:00.000Z",
              "2026-07-04T11:47:00.000Z",
              "2026-07-04T12:17:00.000Z",
              3,
              3
            )
          )
        );

        expect(admitted.filter(Boolean)).toHaveLength(2);
        expect(
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM security_rate_limit_claims
                WHERE scope = 'password_reset'
                  AND subject_key_hash = ?`
            )
            .get("hashed-account")
        ).toEqual({ count: 2 });
      } finally {
        sqlite.close();
      }
    });

    it("keeps aggregate login buckets independent and deletes expired buckets during scheduled cleanup", async () => {
      const db = new InMemoryD1();
      db.loginRateLimits.set("expired-hash", {
        window_started_at: "2026-07-04T11:00:00.000Z",
        attempt_count: 60,
        expires_at: "2026-07-04T11:15:00.000Z"
      });
      db.securityRateLimitClaims.push({
        id: "expired-claim",
        scope: "password_reset",
        key_hash: "expired-hash",
        claimed_at: "2026-07-04T11:00:00.000Z",
        expires_at: "2026-07-04T11:15:00.000Z"
      });

      const otherIp = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "192.0.2.18"
          },
          body: JSON.stringify({ email: "independent@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(otherIp.status).toBe(401);
      await worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        env(db)
      );
      expect(db.loginRateLimits.has("expired-hash")).toBe(false);
      expect(db.loginRateLimits.size).toBe(1);
      expect(db.securityRateLimitClaims).toHaveLength(0);
    });

    it("blocks the sixty-first login attempt in the shared unknown IP bucket", async () => {
      const db = new InMemoryD1();
      for (let index = 0; index < 60; index += 1) {
        const response = await worker.fetch(
          new Request("https://example.org/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: `unknown-${index}@example.org`, password: "invalid" })
          }),
          env(db)
        );
        expect(response.status).toBe(401);
      }

      const denied = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "unknown-sixty-first@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(denied.status).toBe(429);
      await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
      expect([...db.loginRateLimits.keys()]).toHaveLength(1);
    });
  });

  it("blocks the sixth failed login within 15 minutes without attempting authentication", async () => {
    const db = new InMemoryD1();
    // Five recent failures inside the window, keyed on the normalized (lowercase) email.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "abuser@example.org", `2026-07-04T11:5${i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("ABuser@example.org"), env(db));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "too_many_attempts",
      message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
    });
    // No authentication was attempted, so no additional LOGIN_FAILED audit is written.
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(5);
  });

  it("ignores failures older than the 15-minute window", async () => {
    const db = new InMemoryD1();
    // Five failures, but all older than 15 minutes — must not trip the limiter.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "olduser@example.org", `2026-07-04T11:${10 + i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("olduser@example.org"), env(db));

    // No such user exists, so the credential error surfaces (not the throttle).
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    // A fresh LOGIN_FAILED audit is recorded for this attempt.
    const recent = db.audits.filter((audit) => audit.action === "LOGIN_FAILED");
    expect(recent).toHaveLength(6);
    expect(recent.at(-1)).toMatchObject({ action: "LOGIN_FAILED", entity_type: "user", entity_id: "olduser@example.org", summary: "Credenciales inválidas" });
  });

  it("audits a failed login and returns the credential error below the threshold", async () => {
    const db = new InMemoryD1();

    const response = await worker.fetch(loginRequest("nobody@example.org"), env(db));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "LOGIN_FAILED", entity_type: "user", entity_id: "nobody@example.org", summary: "Credenciales inválidas" })
    );
  });

  it("lets a valid login succeed despite older failures in the window", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_ok",
      email: "good@example.org",
      name: "Good User",
      role: "OPERATOR",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: ""
    });
    // Four prior failures (below the 5 threshold) inside the window must not block a valid login.
    for (let i = 0; i < 4; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "good@example.org", `2026-07-04T11:5${i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("good@example.org", "Valid#Pass2026"), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "good@example.org", role: "OPERATOR" } });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_ok" }));
  });

  it("does not let attacker failures from one IP lock out a victim on another IP", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_victim",
      email: "victim@example.org",
      name: "Victim User",
      role: "ADMIN",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: ""
    });
    // An attacker seeds the failure threshold for the victim's email from their own IP.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "victim@example.org", `2026-07-04T11:5${i}:00.000Z`, "203.0.113.7");
    }

    // The victim, arriving from a different IP with the correct password, must not be
    // throttled by the attacker's failures.
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.4" },
        body: JSON.stringify({ email: "victim@example.org", password: "Valid#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "victim@example.org", role: "ADMIN" } });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_victim" }));
  });

  it("still throttles repeated failures from the same IP", async () => {
    const db = new InMemoryD1();
    // Five recent failures from a single IP for one email — the sixth must be throttled
    // before any credential work runs.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "abuser@example.org", `2026-07-04T11:5${i}:00.000Z`, "203.0.113.7");
    }

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ email: "abuser@example.org", password: "whatever" })
      }),
      env(db)
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: "too_many_attempts" });
    // No credential work ran, so no additional LOGIN_FAILED audit was written.
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(5);
  });

  it("throttles password-reset requests but stays enumeration-safe with a 200", async () => {
    const db = new InMemoryD1();
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: ""
    });
    const sentMessages: unknown[] = [];
    const sourceAccountKey = await sha256Hex(utf8Bytes("password-reset:user_operator:unknown"));
    for (let i = 0; i < 3; i += 1) {
      db.securityRateLimitClaims.push({
        id: `reset_rate_${i}`,
        scope: "password_reset",
        key_hash: sourceAccountKey,
        claimed_at: `2026-07-04T11:5${i}:00.000Z`,
        expires_at: "2026-07-04T12:15:00.000Z"
      });
    }

    const auditCountBefore = db.audits.length;
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: "cf-email-reset" };
        }
      } as SendEmail
    });
    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      runtime
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(db.resetTokens).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
    expect(db.audits).toHaveLength(auditCountBefore);
    expect(db.audits.some((row) => row.action === "PASSWORD_RESET_THROTTLED")).toBe(false);
  });

  it.each([
    ["active", true],
    ["unknown", false]
  ] as const)("schedules the same background reset unit for an %s account", async (_label, active) => {
    const db = new InMemoryD1();
    if (active) {
      db.users.push({
        id: "user_reset",
        email: "candidate@example.org",
        name: "Reset Candidate",
        role: "ADMIN",
        password_hash: "old-hash",
        password_salt: "old-salt",
        disabled_at: ""
      });
    }
    const tasks: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.23" },
        body: JSON.stringify({ email: "candidate@example.org" })
      }),
      env(db),
      executionContextCapturing(tasks)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(db.resetTokens).toHaveLength(active ? 1 : 0);
  });
});

describe("session logout", () => {
  it("revokes the presented bearer on the server and remains idempotent", async () => {
    const db = new InMemoryD1();
    const rawToken = "copied-session-token";
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Admin",
      role: "ADMIN",
      password_hash: "hash",
      password_salt: "salt",
      disabled_at: null
    });
    db.sessions.push({
      id: "session_logout",
      user_id: "user_admin",
      token_hash: await sha256Hex(utf8Bytes(rawToken)),
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      revoked_at: null
    });
    const runtime = env(db);
    const authorization = { Authorization: `Bearer ${rawToken}` };

    const before = await worker.fetch(new Request("https://example.org/api/users", { headers: authorization }), runtime);
    const logout = await worker.fetch(
      new Request("https://example.org/api/auth/logout", { method: "POST", headers: authorization }),
      runtime
    );
    const after = await worker.fetch(new Request("https://example.org/api/users", { headers: authorization }), runtime);
    const repeated = await worker.fetch(
      new Request("https://example.org/api/auth/logout", { method: "POST", headers: authorization }),
      runtime
    );
    const missing = await worker.fetch(new Request("https://example.org/api/auth/logout", { method: "POST" }), runtime);

    expect(before.status).toBe(200);
    expect(logout.status).toBe(204);
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(after.status).toBe(401);
    expect(repeated.status).toBe(204);
    expect(missing.status).toBe(401);
  });
});

describe("credential-current session issuance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["self-reset", "admin-reset"] as const)(
    "does not issue a session when %s wins after password verification",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      const old = await hashPassword("Old#Password2026", "old-salt", {
        enforcePolicy: false
      });
      db.users.push({
        id: "user_race",
        email: "race@example.org",
        name: "Race",
        role: "OPERATOR",
        password_hash: old.hash,
        password_salt: old.salt,
        disabled_at: null
      });

      if (mutation === "self-reset") {
        const resetToken = "self-reset-token";
        db.resetTokens.push({
          id: "reset_race",
          user_id: "user_race",
          token_hash: await sha256Hex(utf8Bytes(resetToken)),
          expires_at: "2026-07-04T13:00:00.000Z",
          used_at: null
        });
        db.beforeCredentialGuardedSessionBatch = async () => {
          db.beforeCredentialGuardedSessionBatch = null;
          await new AuthService(runtime).confirmPasswordReset(resetToken, "New#Password2026");
        };
      } else {
        db.beforeCredentialGuardedSessionBatch = async () => {
          db.beforeCredentialGuardedSessionBatch = null;
          await new AuthService(runtime).resetUserPassword("user_race", "Admin#Password2026");
        };
      }

      await expect(
        new AuthService(runtime).login("race@example.org", "Old#Password2026")
      ).rejects.toThrow("Credenciales inválidas");
      expect(db.sessions).toHaveLength(0);
    }
  );

  it("does not prune valid sessions when a stale credential guard loses", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const old = await hashPassword("Old#Password2026", "old-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_stale",
      email: "stale@example.org",
      name: "Stale",
      role: "OPERATOR",
      password_hash: old.hash,
      password_salt: old.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `session_${index}`,
        user_id: "user_stale",
        token_hash: `existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }
    db.beforeCredentialGuardedSessionBatch = async () => {
      db.beforeCredentialGuardedSessionBatch = null;
      await new AuthService(runtime).resetUserPassword(
        "user_stale",
        "Changed#Password2026"
      );
    };

    await expect(
      new AuthService(runtime).login("stale@example.org", "Old#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.sessions.map((row) => row.id)).toEqual([
      "session_0",
      "session_1",
      "session_2",
      "session_3",
      "session_4",
      "session_5",
      "session_6",
      "session_7"
    ]);
  });

  it("does not issue or prune sessions when user is disabled after password verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    const passwordHash = `pbkdf2$100000$${stored.hash}`;
    db.users.push({
      id: "user_disabled_race",
      email: "disabled-race@example.org",
      name: "Disabled Race",
      role: "OPERATOR",
      password_hash: passwordHash,
      password_salt: stored.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `disabled_session_${index}`,
        user_id: "user_disabled_race",
        token_hash: `disabled_existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }
    const sessionsBefore = structuredClone(db.sessions);
    db.beforeCredentialGuardedSessionBatch = async () => {
      db.users[0].disabled_at = "2026-07-04T12:00:00.000Z";
    };

    await expect(
      new AuthService(runtime).login(
        "disabled-race@example.org",
        "Valid#Password2026"
      )
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({
      password_hash: passwordHash,
      password_salt: stored.salt,
      disabled_at: "2026-07-04T12:00:00.000Z"
    });
    expect(db.sessions).toStrictEqual(sessionsBefore);
  });

  it("does not issue a session when an email change wins after password verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_email_race",
      email: "before@example.org",
      name: "Email Race",
      role: "OPERATOR",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-07-04T11:00:00.000Z",
      updated_at: "2026-07-04T11:00:00.000Z"
    });
    db.beforeCredentialGuardedSessionBatch = async () => {
      await new Repository(runtime.DB).updateUser("user_email_race", {
        email: "after@example.org"
      });
    };

    await expect(
      new AuthService(runtime).login("before@example.org", "Valid#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({ email: "after@example.org", auth_generation: 1 });
    expect(db.sessions).toHaveLength(0);
  });

  it("does not issue a session after a disable and re-enable cycle completed post-verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_reenabled_race",
      email: "reenabled@example.org",
      name: "Re-enabled Race",
      role: "OPERATOR",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-07-04T11:00:00.000Z",
      updated_at: "2026-07-04T11:00:00.000Z"
    });
    db.beforeCredentialGuardedSessionBatch = async () => {
      const repository = new Repository(runtime.DB);
      await repository.updateUser("user_reenabled_race", { disabled: true });
      await repository.updateUser("user_reenabled_race", { disabled: false });
    };

    await expect(
      new AuthService(runtime).login("reenabled@example.org", "Valid#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({ disabled_at: null, auth_generation: 2 });
    expect(db.sessions).toHaveLength(0);
  });

  it("keeps at most eight active session rows and evicts the oldest bearer", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_cap",
      email: "cap@example.org",
      name: "Cap",
      role: "VIEWER",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `session_${index}`,
        user_id: "user_cap",
        token_hash: `existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }

    const newest = await new AuthService(runtime).login(
      "cap@example.org",
      "Valid#Password2026"
    );

    expect(db.sessions).toHaveLength(8);
    expect(db.sessions.some((row) => row.id === "session_0")).toBe(false);
    const newestTokenHash = await sha256Hex(utf8Bytes(newest.token));
    expect(
      db.sessions.some((row) => row.token_hash === newestTokenHash)
    ).toBe(true);
  });

  it("keeps concurrent committed session rows at or below eight", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_concurrent_cap",
      email: "concurrent-cap@example.org",
      name: "Concurrent Cap",
      role: "VIEWER",
      password_hash: `pbkdf2$100000$${stored.hash}`,
      password_salt: stored.salt,
      disabled_at: null
    });

    const logins = await Promise.all(
      Array.from({ length: 9 }, () =>
        new AuthService(runtime).login(
          "concurrent-cap@example.org",
          "Valid#Password2026"
        )
      )
    );

    expect(logins).toHaveLength(9);
    expect(db.sessions).toHaveLength(8);
    expect(db.maxCommittedSessionRows).toBe(8);
  });
});

describe("donation intents", () => {
  // A checksum-valid DUI (10000001-9) and a deliberately invalid one that only
  // fails the verifier digit (01234567-0; correct check digit is 8).
  const VALID_DUI = "10000001-9";
  const BAD_CHECKSUM_DUI = "01234567-0";

  function validIntentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // Name and email are collected on Wompi's hosted sheet, not on the /donar form,
    // so the intent body carries only documento, teléfono, dirección, and monto.
    return {
      amount: "25.50",
      donorDocumentType: "13",
      donorDocument: VALID_DUI,
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador",
      ...overrides
    };
  }

  function intentRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
    return new Request("https://example.org/api/donations/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(body)
    });
  }

  it.each([
    [undefined, validIntentBody()],
    ["preview", validIntentBody()],
    [undefined, { amount: "25.00", giftType: "DIEZMO" }],
    ["preview", { amount: "25.00", giftType: "DIEZMO" }]
  ] as const)("rejects payment creation in APP_ENV %s before DB or Wompi work", async (appEnv, body) => {
    const db = new InMemoryD1();
    const outbound = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      intentRequest(body as Record<string, unknown>),
      env(db, { APP_ENV: appEnv })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "payment_collection_disabled"
    });
    expect(db.preparedSql).toHaveLength(0);
    expect(db.donationIntents).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects payment creation for a non-string runtime APP_ENV before DB or Wompi work", async () => {
    const db = new InMemoryD1();
    const outbound = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      intentRequest(validIntentBody()),
      env(db, { APP_ENV: 42 } as unknown as Partial<Env>)
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "payment_collection_disabled"
    });
    expect(db.preparedSql).toHaveLength(0);
    expect(db.donationIntents).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("creates a PENDING intent, attaches a mock Wompi link, and returns all three link fields", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { intentId: string; urlEnlace: string; urlEnlaceLargo: string; datosToken?: string };
    expect(payload.intentId).toMatch(/^di_/);
    expect(payload.urlEnlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
    expect(payload.urlEnlaceLargo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
    expect(payload.datosToken).toBeUndefined();

    expect(db.donationIntents).toHaveLength(1);
    const intent = db.donationIntents[0];
    expect(intent.status).toBe("LINK_CREATED");
    expect(intent.amount_cents).toBe(2550);
    expect(intent.donor_document).toBe("10000001-9"); // stored canonically via formatDui
    // Name and email are never collected on the form: they are bound null and later
    // sourced from the webhook.
    expect(intent.donor_name).toBeNull();
    expect(intent.donor_email).toBeNull();
    expect(intent.client_ip).toBe("203.0.113.7");
    expect(intent.wompi_url_enlace).toBe(payload.urlEnlace);
    expect(intent.rate_limit_claim_id).toBe(db.securityRateLimitClaims[0].id);

    // Audit records the intent creation with amount + document type, never the number.
    const audit = db.audits.find((row) => row.action === "DONATION_INTENT_CREATED");
    expect(audit).toBeDefined();
    expect(audit?.entity_type).toBe("donation_intent");
    expect(audit?.entity_id).toBe(payload.intentId);
    const metadata = JSON.stringify(audit?.metadata_json ?? "");
    expect(metadata).not.toContain("04182769");
  });

  it("atomically admits at most five overlapping intent creations from one IP", async () => {
    const db = new InMemoryD1();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => worker.fetch(intentRequest(validIntentBody()), env(db)))
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(db.donationIntents).toHaveLength(5);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_intent")).toHaveLength(5);
    const [claim] = db.securityRateLimitClaims;
    expect(claim.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.key_hash).not.toContain("203.0.113.7");
  });

  it("counts pre-ledger intents while atomically admitting overlapping creations", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      const db = new InMemoryD1();
      for (let index = 0; index < 2; index += 1) {
        db.donationIntents.push({
          id: `legacy_intent_${index}`,
          client_ip: "203.0.113.7",
          created_at: `2026-07-04T11:5${index}:00.000Z`
        });
      }

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => worker.fetch(intentRequest(validIntentBody()), env(db)))
      );

      expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(17);
      expect(db.donationIntents).toHaveLength(5);
      expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_intent")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an oversized public intent body with 413 before any persistence", async () => {
    // A body over the 16 KiB cap is refused up front, so oversized spam never
    // reaches validation or the atomic D1 admission ledger.
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ filler: "x".repeat(17 * 1024) })),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_body_too_large",
      message: "La solicitud es demasiado grande."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("accepts a numeric amount and a type 37 free-form document without checksum rules", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ amount: 100, donorDocumentType: "37", donorDocument: "PASAPORTE-XZ-9" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].amount_cents).toBe(10000);
    expect(db.donationIntents[0].donor_document).toBe("PASAPORTE-XZ-9");
    // Domestic intents never carry a país.
    expect(db.donationIntents[0].donor_pais).toBeNull();
    // Absent giftType stays null (legacy/US paths never send it).
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("persists a chosen gift type (DIEZMO / OFRENDA) on the intent", async () => {
    const diezmoDb = new InMemoryD1();
    const diezmo = await worker.fetch(intentRequest(validIntentBody({ giftType: "DIEZMO" })), env(diezmoDb));
    expect(diezmo.status).toBe(201);
    expect(diezmoDb.donationIntents[0].gift_type).toBe("DIEZMO");

    const ofrendaDb = new InMemoryD1();
    const ofrenda = await worker.fetch(intentRequest(validIntentBody({ giftType: "OFRENDA" })), env(ofrendaDb));
    expect(ofrenda.status).toBe(201);
    expect(ofrendaDb.donationIntents[0].gift_type).toBe("OFRENDA");
  });

  it("rejects an invalid gift type without persisting the intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ giftType: "GIFT" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_gift_type",
      message: "Seleccione el tipo de aportación: diezmo u ofrenda."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("still accepts an intent with no gift type at all (legacy / US paths)", async () => {
    const db = new InMemoryD1();
    // validIntentBody carries no giftType key.
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("creates a NIT (36) intent with canonical document storage and the razón social", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "Empresa Ejemplo, S.A. de C.V." })),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    // Stored canonically as XXXX-XXXXXX-XXX-X regardless of input hyphenation.
    expect(intent.donor_document).toBe("0614-280390-112-1");
    // The razón social rides in donor_name so the correlated CDE names the empresa,
    // not the Wompi cardholder.
    expect(intent.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
  });

  it("rejects an empresa NIT without exactly 14 digits", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "0614-280390-112", donorName: "Empresa Ejemplo" })),
      env(db)
    );

    expect(response.status).toBe(400);
    // Donor-facing copy frames the 36 type as the empresa's NIT (the /donar select
    // labels it "Empresa" so legacy personal-NIT holders are not baited into it).
    await expect(response.json()).resolves.toEqual({
      error: "invalid_nit",
      message: "Ingrese el NIT de la empresa (14 dígitos)."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("requires the razón social for NIT intents and caps it at 200 characters", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_razon_social" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "x".repeat(201) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_razon_social" });
  });

  it("bounds pasaporte (03) and carnet (02) documents to 5-20 chars and stores them uppercase", async () => {
    const pasaporteDb = new InMemoryD1();
    const pasaporte = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "ab-123456" })),
      env(pasaporteDb)
    );
    expect(pasaporte.status).toBe(201);
    expect(pasaporteDb.donationIntents[0].donor_document).toBe("AB-123456");

    const carnetDb = new InMemoryD1();
    const carnet = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "cr 2026-001" })),
      env(carnetDb)
    );
    expect(carnet.status).toBe(201);
    expect(carnetDb.donationIntents[0].donor_document).toBe("CR 2026-001");

    const tooShort = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "A123" })),
      env(new InMemoryD1())
    );
    expect(tooShort.status).toBe(400);
    await expect(tooShort.json()).resolves.toMatchObject({ error: "invalid_identity_document" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "X".repeat(21) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_identity_document" });
  });

  it("rejects document types outside the five CAT-022 receptor codes", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocumentType: "99" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_document_type" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("stores the 00/00/00 geography plus the CAT-020 país for a foreign-resident intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(
        validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "US", complemento: "742 Evergreen Terrace, Springfield" })
      ),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    expect(intent.direccion_departamento).toBe("00");
    expect(intent.direccion_municipio).toBe("00");
    expect(intent.direccion_distrito).toBe("00");
    expect(intent.donor_pais).toBe("US");
  });

  it("rejects SV as the país on the foreign path", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "SV" })),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_pais_sv" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a foreign-path intent whose país is missing or outside CAT-020", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_pais" });

    const bogus = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "XX" })),
      env(new InMemoryD1())
    );
    expect(bogus.status).toBe(400);
    await expect(bogus.json()).resolves.toMatchObject({ error: "invalid_pais" });
  });

  it("rejects an amount below the one-dollar minimum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "0.99" })), env(db));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("invalid_amount");
    expect(payload.message).toMatch(/usted|monto/i);
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects an amount above the five-thousand-dollar maximum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "5000.01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_amount" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("ignores a donorName/donorEmail on non-NIT intents: they are neither validated nor persisted", async () => {
    const db = new InMemoryD1();
    // Even if a client sends name/email on a non-NIT intent, the endpoint neither
    // requires nor stores them (the razón social is bound only for NIT/36, so the
    // webhook cardholder name still wins for personal donors).
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorName: "Ignorado", donorEmail: "ignorado@example.org" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents).toHaveLength(1);
    expect(db.donationIntents[0].donor_name).toBeNull();
    expect(db.donationIntents[0].donor_email).toBeNull();
  });

  it("rejects a DUI that fails the check digit for document type 13", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocument: BAD_CHECKSUM_DUI })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_dui",
      message: "DUI inválido: revise el número y el dígito verificador."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a municipio that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 23 is a valid San Salvador (06) municipio but not valid under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "23", distrito: "01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_municipio" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a distrito that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 14 is a valid district under San Salvador (06) but not under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "13", distrito: "14" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_distrito" });
  });

  it("rejects a missing complemento", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
  });

  it("rejects a complemento longer than the MH schema's 200-char cap", async () => {
    // fe-cd-v2 caps receptor direccion.complemento at 200. Anything longer would
    // pass intent validation, take the donor's payment, and then FAIL the schema
    // at CDE build time — a paid donation stranded without a comprobante.
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "x".repeat(201) })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("blocks the sixth intent from one IP within 15 minutes with a 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      const db = new InMemoryD1();
      // Five intents already created by this IP inside the window.
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({
          id: `di_seed_${i}`,
          status: "LINK_CREATED",
          client_ip: "203.0.113.7",
          expires_at: "2026-07-04T13:00:00.000Z",
          created_at: `2026-07-04T11:5${i}:00.000Z`
        });
      }

      const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: "too_many_attempts",
        message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
      });
      // No new intent was created.
      expect(db.donationIntents).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 502 and leaves the intent PENDING when Wompi link creation fails", async () => {
    const db = new InMemoryD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      const response = await worker.fetch(
        intentRequest(validIntentBody()),
        env(db, {
          MOCK_EXTERNAL_SERVICES: "false",
          APP_ORIGIN: "https://donar.example.org",
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
          WOMPI_CLIENT_ID: "id",
          WOMPI_CLIENT_SECRET: "secret"
        })
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ error: "wompi_link_failed" });
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].status).toBe("PENDING");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the status and paid flag for a known intent id", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({ id: "di_known", status: "LINK_CREATED", donor_name: "Secreto", donor_document: "10000001-9", paid_at: null });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_known/status"), env(db));

    expect(response.status).toBe(200);
    // Backward-compatible: status unchanged, paid added. Unpaid intent → paid:false.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: false });
  });

  it("reports paid:true once paid_at is stamped (donor thanks keys on payment, not MH acceptance)", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({
      id: "di_paidflag",
      status: "LINK_CREATED",
      donor_name: "Secreto",
      donor_document: "10000001-9",
      paid_at: "2026-07-04T12:30:00.000Z"
    });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_paidflag/status"), env(db));

    expect(response.status).toBe(200);
    // Status is still LINK_CREATED (CDE not yet accepted) but the donor already paid.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: true });
  });

  it("returns 404 for an unknown intent id", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_missing/status"), env(db));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "intent_not_found" });
  });

  it("expires overdue unpaid (PENDING and LINK_CREATED) intents on the 15-minute cron sweep", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_fresh", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T13:00:00.000Z", created_at: "2026-07-04T12:00:00.000Z" },
      { id: "di_done", status: "COMPLETED", wompi_id_enlace: 999, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Mock mode (env's default): deactivatePaymentLink is a no-op, so no fetch happens.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
    } finally {
      vi.useRealTimers();
    }

    // An abandoned checkout (link minted, donor never paid) must not sit as
    // LINK_CREATED forever — it expires just like an unlinked PENDING intent.
    expect(db.donationIntents.find((row) => row.id === "di_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_fresh")?.status).toBe("PENDING");
    expect(db.donationIntents.find((row) => row.id === "di_done")?.status).toBe("COMPLETED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deactivates the Wompi link of each expired LINK_CREATED intent in real mode", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_pending_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Token, then the PUT that deactivates the one link with a wompi_id_enlace.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ idEnlace: 555, usable: false }), { status: 200 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    // Both intents expire; only the linked one triggers a token + PUT (2 calls).
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_pending_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchSpy.mock.calls[1];
    expect(putUrl).toBe("https://api.wompi.sv/EnlacePago/555");
    expect((putInit as RequestInit).method).toBe("PUT");
  });

  it("still expires intents when a Wompi deactivation PUT fails", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      // A deactivation failure must not throw out of the sweep or leave the intent unexpired.
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("caps one sweep at INTENT_EXPIRY_SWEEP_LIMIT and lets the next tick continue", async () => {
    const db = new InMemoryD1();
    // More expirable rows than a single tick can process, so attacker-created intents
    // cannot force one cron invocation to snapshot or deactivate an unbounded set.
    const overflow = 5;
    for (let i = 0; i < INTENT_EXPIRY_SWEEP_LIMIT + overflow; i += 1) {
      const suffix = String(i).padStart(4, "0");
      db.donationIntents.push({
        id: `di_exp_${suffix}`,
        status: "PENDING",
        wompi_id_enlace: null,
        amount_cents: 2550,
        expires_at: "2026-07-04T11:00:00.000Z",
        created_at: "2026-07-04T10:00:00.000Z"
      });
    }
    const expiredCount = () => db.donationIntents.filter((row) => row.status === "EXPIRED").length;

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // Exactly the cap expires this tick; the remainder stays PENDING for the next one.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT);
      expect(db.donationIntents.filter((row) => row.status === "PENDING")).toHaveLength(overflow);

      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // The next tick continues from where the first left off.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT + overflow);
      expect(db.donationIntents.some((row) => row.status === "PENDING")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Premint: draft create (amount + optional giftType only) ────────────────
  //
  // The donor wizard mints the Wompi link in the background when the SV donor
  // ENTERS Paso 2, before the fiscal data exists. That draft body carries only the
  // amount (and, on the SV path, the gift type) — no documento/dirección — yet the
  // link is minted exactly as today (identificadorEnlaceComercio = intent id).
  describe("draft create (no donor fields)", () => {
    function draftRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
      return new Request("https://example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    it("mints the Wompi link for a draft carrying only { amount, giftType } (donor data absent)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        intentId: string;
        datosToken?: string;
        urlEnlace?: string;
        urlEnlaceLargo?: string;
      };
      // Preminting remains an internal latency optimization. The payment capability
      // stays server-side until /datos atomically commits the fiscal fields.
      expect(payload.intentId).toMatch(/^di_/);
      expect(payload.datosToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(payload).not.toHaveProperty("urlEnlace");
      expect(payload).not.toHaveProperty("urlEnlaceLargo");

      expect(db.donationIntents).toHaveLength(1);
      const intent = db.donationIntents[0];
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.wompi_url_enlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
      expect(intent.wompi_url_enlace_largo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // The draft marker: donor document + address stay NULL until the datos call.
      expect(intent.donor_document).toBeNull();
      expect(intent.direccion_departamento).toBeNull();
      expect(intent.direccion_complemento).toBeNull();
      expect(intent.donor_name).toBeNull();
      expect(intent.client_ip).toBe("203.0.113.7");
      expect(String(intent.datos_token_hash)).toMatch(/^[a-f0-9]{64}$/);
      expect(intent.datos_token_hash).not.toBe(payload.datosToken);
    });

    it("rejects cross-site simple and mismatched-origin JSON before any side effect", async () => {
      const db = new InMemoryD1();
      const simpleResponse = await worker.fetch(
        new Request("https://example.org/api/donations/intent", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            Origin: "https://attacker.example",
            "Sec-Fetch-Site": "cross-site",
            "cf-connecting-ip": "203.0.113.7"
          },
          body: JSON.stringify({ amount: "25.50", giftType: "DIEZMO" })
        }),
        env(db)
      );
      const mismatchedOriginResponse = await worker.fetch(
        new Request("https://example.org/api/donations/intent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.example",
            "Sec-Fetch-Site": "same-site",
            "cf-connecting-ip": "203.0.113.7"
          },
          body: JSON.stringify({ amount: "25.50", giftType: "DIEZMO" })
        }),
        env(db)
      );

      expect(simpleResponse.status).toBe(415);
      expect(mismatchedOriginResponse.status).toBe(403);
      expect(db.securityRateLimitClaims).toHaveLength(0);
      expect(db.donationIntents).toHaveLength(0);
      expect(db.audits).toHaveLength(0);
    });

    it("accepts same-origin JSON through the public mutation admission check", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(
        draftRequest(
          { amount: "25.50", giftType: "DIEZMO" },
          { Origin: "https://example.org", "Sec-Fetch-Site": "same-origin" }
        ),
        env(db)
      );

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
    });

    it("accepts the request origin when APP_ORIGIN names a different canonical host", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(
        draftRequest(
          { amount: "25.50", giftType: "DIEZMO" },
          { Origin: "https://example.org", "Sec-Fetch-Site": "same-origin" }
        ),
        env(db, { APP_ORIGIN: "https://canonical.example.org" })
      );

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
    });

    it("mints a draft with no gift type at all (US / legacy background mint)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "10" }), env(db));

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].gift_type).toBeNull();
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("still validates the amount for a draft (same rule as the full create)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "0.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_amount",
        message: "El monto debe estar entre $1.00 y $5,000.00."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("rejects a present-but-invalid gift type on a draft (no persistence)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "GIFT" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_gift_type",
        message: "Seleccione el tipo de aportación: diezmo u ofrenda."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("applies the same per-IP throttle to draft creates", async () => {
      const db = new InMemoryD1();
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({ id: `di_seed_${i}`, client_ip: "203.0.113.7", created_at: "2026-07-04T12:00:00.000Z" });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "DIEZMO" }), env(db));
        expect(response.status).toBe(429);
        expect(db.donationIntents).toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Premint: datos completion (fast D1-only) ───────────────────────────────
  //
  // Attaches the donor's fiscal data to a minted draft with the same validation the
  // full create runs; NO Wompi call, and it must never touch amount or gift type.
  describe("datos completion", () => {
    const DATOS_TOKEN = "datos-capability-test-token";

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:30:00.000Z") });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function seedDraft(db: InMemoryD1, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const draft = {
        id: "di_draft_1",
        status: "LINK_CREATED",
        amount_cents: 2550,
        donor_name: null,
        donor_document_type: "13",
        donor_document: null,
        donor_email: null,
        donor_phone: null,
        direccion_departamento: null,
        direccion_municipio: null,
        direccion_distrito: null,
        direccion_complemento: null,
        donor_pais: null,
        gift_type: "DIEZMO",
        wompi_id_enlace: 123456,
        wompi_url_enlace: "https://mock.wompi.sv/enlace/di_draft_1",
        wompi_url_enlace_largo: "https://mock.wompi.sv/enlace-largo/di_draft_1",
        document_id: null,
        client_ip: "203.0.113.7",
        datos_token_hash: await sha256Hex(utf8Bytes(DATOS_TOKEN)),
        paid_at: null,
        created_at: "2026-07-04T12:00:00.000Z",
        updated_at: "2026-07-04T12:00:00.000Z",
        expires_at: "2026-07-04T13:00:00.000Z",
        ...overrides
      };
      db.donationIntents.push(draft);
      return draft;
    }

    function datosRequest(
      id: string,
      body: Record<string, unknown>,
      headers: Record<string, string> = { "X-Donation-Datos-Token": DATOS_TOKEN }
    ): Request {
      return new Request(`https://example.org/api/donations/intent/${id}/datos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    const validDatos = {
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador"
    };

    it("attaches donor data to a minted draft without a Wompi call or an amount/gift change", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        intentId: "di_draft_1",
        urlEnlace: "https://mock.wompi.sv/enlace/di_draft_1",
        urlEnlaceLargo: "https://mock.wompi.sv/enlace-largo/di_draft_1"
      });
      // No outbound HTTP: datos is D1-only.
      expect(fetchSpy).not.toHaveBeenCalled();

      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBe("10000001-9"); // stored canonically
      expect(intent.donor_document_type).toBe("13");
      expect(intent.donor_phone).toBe("70001122");
      expect(intent.direccion_departamento).toBe("06");
      expect(intent.direccion_complemento).toBe("Colonia Escalón, San Salvador");
      // Untouched by datos: money + tipo were locked at draft-mint time.
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // Still LINK_CREATED and pointing at the same minted link.
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.wompi_id_enlace).toBe(123456);
      expect(intent.datos_token_hash).toBeNull();
    });

    it("rejects an oversized public datos body with 413 before mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, filler: "x".repeat(17 * 1024) }),
        env(db)
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "request_body_too_large",
        message: "La solicitud es demasiado grande."
      });
      // The draft is untouched: donor data was never attached.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("mirrors the full-create validation messages (invalid DUI)", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, donorDocument: "01234567-0" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_dui",
        message: "DUI inválido: revise el número y el dígito verificador."
      });
      // Nothing persisted on a rejected datos call.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("requires the razón social for a NIT (36) datos completion", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, donorDocumentType: "36", donorDocument: "06142803901121" }),
        env(db)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_razon_social",
        message: "Ingrese la razón social (máximo 200 caracteres)."
      });
    });

    it("returns 404 for an unknown intent id", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(datosRequest("di_missing", validDatos), env(db));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_not_found" });
    });

    it("returns 409 for a COMPLETED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "COMPLETED", document_id: "dte_prev" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      // The completed intent is not mutated.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("rejects datos on an EXPIRED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "EXPIRED" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBeNull();
      expect(intent.status).toBe("EXPIRED");
    });

    it("rejects datos after expires_at even before the cron sweep marks the intent EXPIRED", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "LINK_CREATED", expires_at: "2026-07-04T12:59:59.000Z" });
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T13:00:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
        expect(db.donationIntents[0].donor_document).toBeNull();
        expect(db.donationIntents[0].datos_token_hash).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a missing or incorrect datos capability without mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const missing = await worker.fetch(datosRequest("di_draft_1", validDatos, {}), env(db));
      const incorrect = await worker.fetch(
        datosRequest("di_draft_1", validDatos, { "X-Donation-Datos-Token": "wrong-capability" }),
        env(db)
      );

      expect(missing.status).toBe(409);
      expect(incorrect.status).toBe(409);
      await expect(missing.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(incorrect.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("rejects replay after the datos capability has been consumed", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const first = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
      const replay = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Ataque de replay" }), env(db));

      expect(first.status).toBe(200);
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("allows exactly one of two concurrent datos capability requests", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const responses = await Promise.all([
        worker.fetch(datosRequest("di_draft_1", validDatos), env(db)),
        worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Segundo escritor" }), env(db))
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(db.donationIntents[0].datos_token_hash).toBeNull();
      expect(["Colonia Escalón, San Salvador", "Segundo escritor"]).toContain(db.donationIntents[0].direccion_complemento);
    });

    it("rejects datos after payment and on full-create intents without a capability", async () => {
      const paidDb = new InMemoryD1();
      await seedDraft(paidDb, { paid_at: "2026-07-04T12:30:00.000Z" });
      const paid = await worker.fetch(datosRequest("di_draft_1", validDatos), env(paidDb));

      const fullDb = new InMemoryD1();
      await seedDraft(fullDb, {
        donor_document: "10000001-9",
        direccion_complemento: "Colonia Escalón, San Salvador",
        datos_token_hash: null
      });
      const full = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Sobrescritura" }), env(fullDb));

      expect(paid.status).toBe(409);
      expect(full.status).toBe(409);
      await expect(paid.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(full.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(paidDb.donationIntents[0].donor_document).toBeNull();
      expect(fullDb.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("applies the per-IP throttle to the public datos endpoint", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const keyHash = await sha256Hex(utf8Bytes("203.0.113.7"));
      for (let i = 0; i < 5; i += 1) {
        db.securityRateLimitClaims.push({
          id: `datos_rate_${i}`,
          scope: "donation_datos",
          key_hash: keyHash,
          claimed_at: "2026-07-04T12:00:00.000Z",
          expires_at: "2026-07-04T12:15:00.000Z"
        });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
        expect(response.status).toBe(429);
        // The draft was not modified.
        expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts failed datos capability guesses even when no intent rows are created", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const statuses: number[] = [];

      for (let index = 0; index < 6; index += 1) {
        const response = await worker.fetch(
          datosRequest("di_draft_1", validDatos, { "X-Donation-Datos-Token": `wrong-${index}` }),
          env(db)
        );
        statuses.push(response.status);
      }

      expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].donor_document).toBeNull();
      expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "donation_datos")).toHaveLength(5);
      expect(db.securityRateLimitClaims.some((claim) => claim.scope === "donation_intent")).toBe(false);
    });
  });
});

function seededUserLifecycleDb(): InMemoryD1 {
  const db = new InMemoryD1();
  db.sessionUser = {
    id: "user_owner",
    email: "owner@example.org",
    name: "Owner",
    role: "OWNER"
  };
  db.users.push({
    id: "user_target",
    email: "target@example.org",
    name: "Target",
    role: "OPERATOR",
    password_hash: "target-hash",
    password_salt: "target-salt",
    disabled_at: null,
    updated_at: "2026-07-03T12:00:00.000Z"
  });
  for (let index = 0; index < 2; index += 1) {
    db.sessions.push({
      id: `session_lifecycle_${index}`,
      user_id: "user_target",
      token_hash: `lifecycle_token_${index}`,
      expires_at: "2026-07-05T12:00:00.000Z",
      created_at: `2026-07-04T11:0${index}:00.000Z`,
      revoked_at: null
    });
    db.resetTokens.push({
      id: `reset_lifecycle_${index}`,
      user_id: "user_target",
      token_hash: `reset_hash_${index}`,
      expires_at: "2026-07-05T12:00:00.000Z",
      used_at: null
    });
  }
  return db;
}

describe("password reset", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function knownUser(): Record<string, unknown> {
    return {
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: ""
    };
  }

  it("emails a reset link and stores only a hashed token for a known user", async () => {
    const db = new InMemoryD1();
    const sentMessages: Array<{ to: string; subject: string; text: string }> = [];
    db.users.push(knownUser());

    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message as { to: string; subject: string; text: string });
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.resetTokens).toHaveLength(1);
    expect(sentMessages).toHaveLength(1);
    const link = /https:\/\/example\.org\/#reset=([A-Za-z0-9_-]+)/.exec(sentMessages[0].text);
    expect(link).toBeTruthy();
    expect((sentMessages[0] as { html?: string }).html).toContain(`href="https://example.org/#reset=${link![1]}"`);
    expect(String(db.resetTokens[0].token_hash)).toBe(await sha256Hex(utf8Bytes(link![1])));
    expect(String(db.resetTokens[0].token_hash)).not.toBe(link![1]);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "PASSWORD_RESET_REQUESTED",
      entity_id: "user_operator",
      rate_limit_claim_id: db.securityRateLimitClaims[0].id
    }));
  });

  it("builds the reset link from APP_ORIGIN even when the request carries a different origin", async () => {
    const db = new InMemoryD1();
    const sentMessages: Array<{ text: string; html?: string }> = [];
    db.users.push(knownUser());

    // Host-header poisoning: the request arrives via an attacker-controlled origin,
    // but the emailed reset link must use the canonical APP_ORIGIN so the token
    // cannot be captured by pointing the link at an attacker host.
    const response = await fetchAndWaitUntil(
      new Request("https://attacker.example/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      env(db, {
        APP_ORIGIN: "https://app.example.org",
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message as { text: string; html?: string });
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("https://app.example.org/#reset=");
    expect(sentMessages[0].text).not.toContain("https://attacker.example/#reset=");
    expect(sentMessages[0].html).toContain('href="https://app.example.org/#reset=');
  });

  it("returns ok without creating tokens or sending email for unknown accounts", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];

    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nadie@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.resetTokens).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("atomically admits only three overlapping reset requests for one account", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(3);
    expect(db.resetTokens).toHaveLength(3);
    expect(db.resetTokens.filter((token) => !token.used_at)).toHaveLength(3);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(3);
    expect(db.securityRateLimitClaims[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.securityRateLimitClaims[0].key_hash).not.toContain("user_operator");
  });

  it("counts a pre-migration account audit against the account-wide reset budget", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.audits.push({
      id: "legacy_reset_audit",
      action: "PASSWORD_RESET_REQUESTED",
      entity_id: "user_operator",
      created_at: "2026-07-04T11:55:00.000Z"
    });
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(2);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(2);
  });

  it("does not let rotating sources multiply one account's reset budget", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = (callerIp: string) =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": callerIp },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => request(`198.51.100.${index + 1}`))
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(3);
    expect(db.resetTokens.filter((token) => !token.used_at)).toHaveLength(3);
    const claims = db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset");
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.key_hash)).size).toBe(3);
    expect(new Set(claims.map((claim) => claim.subject_key_hash)).size).toBe(1);
    expect(claims[0].subject_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(claims[0].subject_key_hash).not.toContain("user_operator");
  });

  it("consumes reset quota and invalidates each exact token when delivery fails", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as unknown as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(3);
    expect(db.resetTokens).toHaveLength(3);
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
  });

  it("keeps earlier unused reset tokens valid until one reset succeeds", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const runtime = env(db);
    const auth = new AuthService(runtime);

    const first = await auth.createPasswordResetToken("operator@example.org");
    const second = await auth.createPasswordResetToken("operator@example.org");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(db.resetTokens).toHaveLength(2);
    expect(db.resetTokens[0].used_at).toBeNull();
    expect(db.resetTokens[1].used_at).toBeNull();
  });

  it.each(["email-change", "disable-reenable"] as const)(
    "does not mint a reset token when %s wins after the account lookup",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      db.users.push({
        ...knownUser(),
        disabled_at: null,
        auth_generation: 0,
        created_at: "2026-07-04T11:00:00.000Z",
        updated_at: "2026-07-04T11:00:00.000Z"
      });
      db.beforeCredentialGuardedResetTokenInsert = async () => {
        const repository = new Repository(runtime.DB);
        if (mutation === "email-change") {
          await repository.updateUser("user_operator", { email: "changed@example.org" });
        } else {
          await repository.updateUser("user_operator", { disabled: true });
          await repository.updateUser("user_operator", { disabled: false });
        }
      };

      const result = await new AuthService(runtime).createPasswordResetToken("operator@example.org");

      expect(result).toBeNull();
      expect(db.resetTokens).toHaveLength(0);
      expect(db.users[0].auth_generation).toBe(mutation === "email-change" ? 1 : 2);
    }
  );

  it.each(["self-reset", "admin-reset"] as const)(
    "does not mint a reset token when a concurrent %s changes the password",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      db.users.push({
        ...knownUser(),
        disabled_at: null,
        auth_generation: 0,
        created_at: "2026-07-04T11:00:00.000Z",
        updated_at: "2026-07-04T11:00:00.000Z"
      });
      const existingTokenHash = await sha256Hex(utf8Bytes("existing-reset-token"));
      db.resetTokens.push({
        id: "reset_existing",
        user_id: "user_operator",
        token_hash: existingTokenHash,
        expires_at: "2099-07-04T23:00:00.000Z",
        used_at: null
      });
      db.beforeCredentialGuardedResetTokenInsert = async () => {
        const repository = new Repository(runtime.DB);
        if (mutation === "self-reset") {
          await repository.resetPasswordWithToken(
            "user_operator",
            existingTokenHash,
            "self-reset-hash",
            "self-reset-salt"
          );
        } else {
          await repository.setUserPassword(
            "user_operator",
            "admin-reset-hash",
            "admin-reset-salt"
          );
        }
      };

      const result = await new AuthService(runtime).createPasswordResetToken("operator@example.org");

      expect(result).toBeNull();
      expect(db.resetTokens).toHaveLength(1);
      expect(db.resetTokens[0].used_at).toEqual(expect.any(String));
      expect(db.users[0]).toMatchObject({
        password_hash: `${mutation}-hash`,
        password_salt: `${mutation}-salt`
      });
    }
  );

  it("resets the password, revokes sessions, and consumes the token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("known-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "known-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.users[0].password_hash).not.toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.resetTokens[0].used_at).toBeTruthy();
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "PASSWORD_RESET_COMPLETED", entity_id: "user_operator" }));
  });

  it("serializes reset redemption with lifecycle invalidation in both orders", async () => {
    const firstDb = seededUserLifecycleDb();
    const firstEnv = env(firstDb);
    const firstRawToken = "lifecycle-reset-first";
    firstDb.resetTokens[0].token_hash = await sha256Hex(utf8Bytes(firstRawToken));
    firstDb.beforePasswordResetBatch = async () => {
      firstDb.beforePasswordResetBatch = null;
      await new Repository(firstEnv.DB).updateUser("user_target", {
        email: "transitioned@example.org"
      });
    };

    await expect(
      new AuthService(firstEnv).confirmPasswordReset(
        firstRawToken,
        "New#Password2026"
      )
    ).rejects.toThrow(/válido|expiró/i);
    expect(firstDb.users[0].email).toBe("transitioned@example.org");
    expect(firstDb.users[0].password_hash).toBe("target-hash");
    expect(firstDb.sessions.every((row) => row.revoked_at != null)).toBe(true);
    expect(firstDb.resetTokens.every((row) => row.used_at != null)).toBe(true);

    const secondDb = seededUserLifecycleDb();
    const secondEnv = env(secondDb);
    const secondRawToken = "reset-wins-first";
    secondDb.resetTokens[0].token_hash = await sha256Hex(utf8Bytes(secondRawToken));
    await new AuthService(secondEnv).confirmPasswordReset(
      secondRawToken,
      "New#Password2026"
    );
    await new Repository(secondEnv.DB).updateUser("user_target", {
      email: "after-reset@example.org"
    });
    expect(secondDb.users[0].email).toBe("after-reset@example.org");
    expect(secondDb.users[0].password_hash).not.toBe("target-hash");
    expect(secondDb.sessions.every((row) => row.revoked_at != null)).toBe(true);
    expect(secondDb.resetTokens.every((row) => row.used_at != null)).toBe(true);
  });

  it("invalidates every sibling password reset token after one succeeds", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push(
      {
        id: "reset_1",
        user_id: "user_operator",
        token_hash: await sha256Hex(utf8Bytes("first-token")),
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      },
      {
        id: "reset_2",
        user_id: "user_operator",
        token_hash: await sha256Hex(utf8Bytes("sibling-token")),
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      }
    );

    const confirm = (token: string, password: string) =>
      worker.fetch(
        new Request("https://example.org/api/auth/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password })
        }),
        env(db, { MOCK_EXTERNAL_SERVICES: "false" })
      );

    const first = await confirm("first-token", "First#Pass2026");
    const sibling = await confirm("sibling-token", "Second#Pass2026");

    expect(first.status).toBe(200);
    expect(sibling.status).toBe(400);
    await expect(sibling.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.passwordResetBatchCount).toBe(1);
  });

  it("does not change the password when a reset token loses the atomic race", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("racing-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.beforePasswordResetBatch = () => {
      db.resetTokens[0].used_at = "2026-07-04T12:00:00.000Z";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "racing-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.passwordResetBatchCount).toBe(1);
  });

  it("allows exactly one of two concurrent confirmations to consume a reset token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("shared-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const confirm = (password: string) =>
      worker.fetch(
        new Request("https://example.org/api/auth/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "shared-token", password })
        }),
        env(db, { MOCK_EXTERNAL_SERVICES: "false" })
      );

    const responses = await Promise.all([confirm("First#Pass2026"), confirm("Second#Pass2026")]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(db.resetTokens[0].used_at).toBeTruthy();
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.passwordResetBatchCount).toBe(2);
  });

  it("rolls back password, sessions, and tokens when the reset batch fails", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("rollback-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.failPasswordResetBatchAfterStatement = 1;

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "rollback-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(500);
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.resetTokens[0].used_at).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("stale-token")),
      expires_at: "2026-07-04T00:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "stale-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.users[0].password_hash).toBe("old-hash");
  });

  it("rejects weak passwords without consuming the token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("known-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "known-token", password: "corta" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.resetTokens[0].used_at).toBeNull();
  });
});

describe("document listing", () => {
  it("returns a bounded page with a cursor for older matching documents", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_1",
        codigo_generacion: "11111111-1111-4111-8111-111111111111",
        numero_control: "DTE-15-M001P004-000000000000001",
        donor_name: "Staging Smoke",
        donor_email: "one@example.org",
        created_at: "2026-06-26T03:00:00.000Z"
      }),
      testDocument({
        id: "doc_2",
        codigo_generacion: "70000003-2222-4222-8222-700000032222",
        numero_control: "DTE-15-M001P004-000000000000002",
        donor_name: "Staging Smoke",
        donor_email: "two@example.org",
        created_at: "2026-06-26T02:00:00.000Z"
      }),
      testDocument({
        id: "doc_3",
        codigo_generacion: "33333333-3333-4333-8333-333333333333",
        numero_control: "DTE-15-M001P004-000000000000003",
        donor_name: "Staging Smoke",
        donor_email: "three@example.org",
        created_at: "2026-06-26T01:00:00.000Z"
      })
    );

    const firstResponse = await worker.fetch(
      new Request("https://example.org/api/documents?q=Smoke&limit=2", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json() as { documents: DteDocumentRecord[]; hasMore: boolean; nextCursor: string | null; limit: number };
    expect(firstPage.documents.map((document) => document.id)).toEqual(["doc_1", "doc_2"]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.limit).toBe(2);

    const secondResponse = await worker.fetch(
      new Request(`https://example.org/api/documents?q=Smoke&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      documents: [expect.objectContaining({ id: "doc_3" })],
      hasMore: false,
      nextCursor: null,
      limit: 2
    });
  });

  it("uses indexed token-prefix search instead of scanning document text columns", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_1",
        codigo_generacion: "11111111-1111-4111-8111-111111111111",
        numero_control: "DTE-15-M001P004-000000000000001",
        donor_name: "Staging Smoke",
        donor_email: "smoke@example.org",
        created_at: "2026-06-26T03:00:00.000Z"
      }),
      testDocument({
        id: "doc_2",
        codigo_generacion: "70000003-2222-4222-8222-700000032222",
        numero_control: "DTE-15-M001P004-000000000000002",
        donor_name: "Example Person",
        donor_email: "donor@example.org",
        created_at: "2026-06-26T02:00:00.000Z"
      })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?q=Stag%20Smok&limit=10", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const page = await response.json() as { documents: DteDocumentRecord[] };
    expect(page.documents.map((document) => document.id)).toEqual(["doc_1"]);
    expect(db.preparedSql.some((sql) => sql.includes("dte_document_search") && sql.includes("MATCH ?"))).toBe(true);
    expect(db.preparedSql.some((sql) => sql.includes("LIKE ? ESCAPE"))).toBe(false);
  });
});

describe("online donation intents listing", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/donations/intents"), env(db));

    expect(response.status).toBe(401);
  });

  it("returns only allowlisted intent fields, exposing the linked numero de control for COMPLETED", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_paid",
        numero_control: "DTE-15-M001P004-000000000000042",
        // The donante shown in the panel now comes from the emitted CDE's donor_name
        // (which was lifted from the webhook), not from the intent.
        donor_name: "Beto del Webhook"
      })
    );
    db.donationIntents.push(
      {
        id: "di_pending",
        status: "PENDING",
        amount_cents: 1000,
        // Name/email are no longer stored on the intent.
        donor_name: null,
        donor_document_type: "13",
        donor_document: "000000000",
        donor_email: null,
        donor_phone: null,
        direccion_departamento: "06",
        direccion_municipio: "22",
        direccion_distrito: "01",
        direccion_complemento: "San Salvador",
        donor_pais: null,
        gift_type: null,
        wompi_id_enlace: null,
        wompi_url_enlace: null,
        wompi_url_enlace_largo: null,
        document_id: null,
        client_ip: "203.0.113.9",
        created_at: "2026-07-05T10:00:00.000Z",
        updated_at: "2026-07-05T10:00:00.000Z",
        expires_at: "2026-07-05T11:00:00.000Z"
      },
      {
        id: "di_done",
        status: "COMPLETED",
        amount_cents: 2550,
        donor_name: null,
        donor_document_type: "13",
        donor_document: "000000000",
        donor_email: null,
        donor_phone: null,
        direccion_departamento: "06",
        direccion_municipio: "22",
        direccion_distrito: "01",
        direccion_complemento: "San Salvador",
        donor_pais: null,
        gift_type: "DIEZMO",
        wompi_id_enlace: 987654,
        wompi_url_enlace: "https://s.wompi.sv/987654",
        wompi_url_enlace_largo: null,
        document_id: "doc_paid",
        client_ip: "203.0.113.9",
        created_at: "2026-07-05T12:00:00.000Z",
        updated_at: "2026-07-05T12:05:00.000Z",
        expires_at: "2026-07-05T13:00:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/donations/intents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      intents: Array<Record<string, unknown> & { id: string; status: string; numero_control: string | null; document_donor_name: string | null; gift_type: string | null }>;
    };
    // Newest first: the COMPLETED intent (12:00) precedes the PENDING one (10:00).
    expect(body.intents.map((intent) => intent.id)).toEqual(["di_done", "di_pending"]);
    expect(body.intents[0].numero_control).toBe("DTE-15-M001P004-000000000000042");
    // The COMPLETED intent's donante comes from the joined document; the PENDING one has none.
    expect(body.intents[0].document_donor_name).toBe("Beto del Webhook");
    expect(body.intents[1].numero_control).toBeNull();
    expect(body.intents[1].document_donor_name).toBeNull();
    // The admin listing carries gift_type so the panel can render the Tipo column.
    expect(body.intents[0].gift_type).toBe("DIEZMO");
    expect(body.intents[1].gift_type).toBeNull();
    // Least privilege: the listing must not carry donor PII, the client IP, or the
    // payment-link metadata that donation_intents.* used to leak.
    for (const intent of body.intents) {
      expect(intent).not.toHaveProperty("donor_document");
      expect(intent).not.toHaveProperty("donor_document_type");
      expect(intent).not.toHaveProperty("donor_email");
      expect(intent).not.toHaveProperty("donor_name");
      expect(intent).not.toHaveProperty("donor_phone");
      expect(intent).not.toHaveProperty("direccion_complemento");
      expect(intent).not.toHaveProperty("client_ip");
      expect(intent).not.toHaveProperty("wompi_url_enlace");
      expect(intent).not.toHaveProperty("wompi_url_enlace_largo");
    }
  });
});

describe("document detail donor-data-verified flag", () => {
  it("marks the document as donor-data-verified when a COMPLETED intent references it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_paid" }));
    db.donationIntents.push({
      id: "di_done",
      status: "COMPLETED",
      amount_cents: 2550,
      donor_name: "Beto Completo",
      donor_document_type: "13",
      donor_document: "000000000",
      donor_email: "beto@example.org",
      donor_phone: null,
      direccion_departamento: "06",
      direccion_municipio: "22",
      direccion_distrito: "01",
      direccion_complemento: "San Salvador",
      wompi_id_enlace: 987654,
      wompi_url_enlace: null,
      wompi_url_enlace_largo: null,
      document_id: "doc_paid",
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:05:00.000Z",
      expires_at: "2026-07-05T13:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_paid", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ donorDataVerified: true });
  });

  it("does not set the flag for a document with no completed intent", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_plain" }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_plain", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ donorDataVerified: false });
  });

  it("returns the authoritative latest receipt delivery without relying on an audit row", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_email_failure" }));
    db.emailDeliveries.push({
      id: "email_failure_authority",
      document_id: "doc_email_failure",
      to_email: "donor@example.org",
      status: "FAILED",
      provider_response_json: JSON.stringify({ code: "E_HEADER_NOT_ALLOWED" }),
      sent_at: null,
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null,
      claim_attempted_at: "2026-07-17T17:00:00.000Z",
      idempotency_key: "delivery-authority",
      claim_token: "delivery-authority-claim",
      provider_dispatch_started_at: "2026-07-17T17:00:01.000Z",
      finalized_at: "2026-07-17T17:00:02.000Z",
      outcome_class: "NOT_SENT",
      failure_code: "E_HEADER_NOT_ALLOWED",
      retry_safe: 1,
      resend_request_id: null,
      attempt_no: 2,
      created_at: "2026-07-17T17:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_email_failure", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      audit: [],
      receiptEmailDelivery: {
        status: "FAILED",
        outcomeClass: "NOT_SENT",
        failureCode: "E_HEADER_NOT_ALLOWED",
        retrySafe: true,
        attemptNo: 2,
        occurredAt: "2026-07-17T17:00:02.000Z"
      }
    });
  });
});

describe("user administration", () => {
  it("stores newly created passwords in the versioned format that carries the iteration count", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fresh@example.org", name: "Fresh", role: "ADMIN", password: "Fresh#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(201);
    const created = db.users.find((row) => row.email === "fresh@example.org");
    expect(String(created?.password_hash)).toMatch(/^pbkdf2\$100000\$[0-9a-f]{64}$/);
  });

  it("verifies a legacy countless hash at the historic count and upgrades the row on login", async () => {
    const db = new InMemoryD1();
    // A pre-versioning row: raw hex derived at the historic 100k count with no marker.
    const legacy = await hashPassword("Legacy#Pass2026", "fixed-salt", { enforcePolicy: false, iterations: 100_000 });
    db.users.push({
      id: "user_legacy",
      email: "legacy@example.org",
      name: "Legacy User",
      role: "ADMIN",
      password_hash: legacy.hash,
      password_salt: legacy.salt,
      disabled_at: ""
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.org", password: "Legacy#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "legacy@example.org" } });
    // The legacy hash verified, and the successful login rehashed it into the current
    // versioned format carrying the iteration count.
    expect(legacy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(String(db.users[0].password_hash)).toMatch(/^pbkdf2\$100000\$[0-9a-f]{64}$/);
    expect(db.users[0].password_hash).not.toBe(legacy.hash);
  });

  it("does not create a session when a legacy login rehash loses a password-reset race", async () => {
    const db = new InMemoryD1();
    const legacy = await hashPassword("Legacy#Pass2026", "fixed-salt", { enforcePolicy: false, iterations: 100_000 });
    const reset = await hashPassword("Reset#Pass2026", "reset-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_legacy",
      email: "legacy@example.org",
      name: "Legacy User",
      role: "ADMIN",
      password_hash: legacy.hash,
      password_salt: legacy.salt,
      disabled_at: ""
    });
    db.beforePasswordRehashCas = () => {
      db.users[0].password_hash = reset.hash;
      db.users[0].password_salt = reset.salt;
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.org", password: "Legacy#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    expect(db.users[0].password_hash).toBe(reset.hash);
    expect(db.sessions).toHaveLength(0);
  });

  it("updates a user's profile, email, role, and disabled state", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Operations Lead",
          email: "ops@example.org",
          role: "ADMIN",
          disabled: true
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: "user_operator",
        name: "Operations Lead",
        email: "ops@example.org",
        role: "ADMIN"
      }
    });
    expect(db.users[0]).toMatchObject({
      name: "Operations Lead",
      email: "ops@example.org",
      role: "ADMIN"
    });
    expect(db.users[0].disabled_at).toBeTruthy();
    expect(db.audits.at(-1)).toMatchObject({
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator"
    });
  });

  it.each([
    ["email", { email: "changed@example.org" }, true],
    ["disable", { disabled: true }, true],
    ["re-enable", { disabled: false }, true],
    ["name", { name: "Changed Name" }, false],
    ["role", { role: "ADMIN" }, false]
  ] as const)(
    "%s updates %s existing sessions and reset tokens",
    async (_label, patch, invalidates) => {
      const db = seededUserLifecycleDb();
      if ("disabled" in patch && patch.disabled === false) {
        db.users.find((row) => row.id === "user_target")!.disabled_at =
          "2026-07-03T12:00:00.000Z";
      }

      const response = await worker.fetch(
        new Request("https://example.org/api/users/user_target", {
          method: "PATCH",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(patch)
        }),
        env(db)
      );

      expect(response.status).toBe(200);
      expect(
        db.sessions.every((row) => row.revoked_at != null)
      ).toBe(invalidates);
      expect(
        db.resetTokens.every((row) => row.used_at != null)
      ).toBe(invalidates);
    }
  );

  it("stops an ADMIN from creating or promoting a user to OWNER", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const promote = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "OWNER" })
      }),
      env(db)
    );
    expect(promote.status).toBe(403);
    await expect(promote.json()).resolves.toMatchObject({ error: "owner_role_required" });
    expect(db.users[0].role).toBe("OPERATOR");

    const create = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-owner@example.org", name: "New Owner", role: "OWNER", password: "Owner-password1!" })
      }),
      env(db)
    );
    expect(create.status).toBe(403);
    await expect(create.json()).resolves.toMatchObject({ error: "owner_role_required" });
    expect(db.users).toHaveLength(1);
  });

  it("blocks an ADMIN from modifying or resetting the password of an existing OWNER", async () => {
    // The reverse escalation vector: resetting an OWNER's password (or disabling the
    // account) hands the ADMIN that OWNER's session power. Only OWNERs touch OWNERs.
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_owner",
      email: "owner@example.org",
      name: "Owner",
      role: "OWNER",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const reset = await worker.fetch(
      new Request("https://example.org/api/users/user_owner/password", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "Atacante#2026" })
      }),
      env(db)
    );
    expect(reset.status).toBe(403);
    await expect(reset.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0].password_hash).toBe("old-hash");

    const patch = await worker.fetch(
      new Request("https://example.org/api/users/user_owner", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true })
      }),
      env(db)
    );
    expect(patch.status).toBe(403);
    await expect(patch.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0].disabled_at).toBe("");
  });

  it("rejects an ADMIN password reset when the target is promoted to OWNER before the write", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null
    });
    db.beforeGuardedUserMutation = () => {
      db.users[0].role = "OWNER";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target/password", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "Fresh#Password2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0]).toMatchObject({ role: "OWNER", password_hash: "old-hash", password_salt: "old-salt" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an ADMIN patch when the target is promoted to OWNER before the write", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null
    });
    db.beforeGuardedUserMutation = () => {
      db.users[0].role = "OWNER";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hijacked Owner" })
      }),
      env(db)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0]).toMatchObject({ role: "OWNER", name: "Target" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a stale ADMIN patch instead of undoing an overlapping disable", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.beforeGuardedUserMutation = async () => {
      await new Repository(runtime.DB).updateUser("user_target", { disabled: true });
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stale Rename" })
      }),
      runtime
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "user_update_conflict" });
    expect(db.users[0]).toMatchObject({
      name: "Target",
      email: "target@example.org",
      disabled_at: expect.any(String),
      auth_generation: 1
    });
    expect(db.audits.filter((audit) => audit.action === "USER_UPDATED")).toHaveLength(0);
  });

  it("rejects a stale OWNER rename instead of undoing an overlapping role promotion", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.beforeGuardedUserMutation = async () => {
      await new Repository(runtime.DB).updateUser("user_target", { role: "OWNER" }, true);
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stale Rename" })
      }),
      runtime
    );

    expect(response.status).toBe(409);
    expect(db.users[0]).toMatchObject({ name: "Target", role: "OWNER" });
    expect(db.audits.filter((audit) => audit.action === "USER_UPDATED")).toHaveLength(0);
  });

  it("lets an OWNER create and promote users to OWNER", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const promote = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "OWNER" })
      }),
      env(db)
    );
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({ user: { id: "user_operator", role: "OWNER" } });
    expect(db.users[0].role).toBe("OWNER");

    const create = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "second-owner@example.org", name: "Second Owner", role: "OWNER", password: "Owner-password1!" })
      }),
      env(db)
    );
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({ user: { role: "OWNER" } });
    expect(db.users).toHaveLength(2);
  });

  it("resets a user's password and revokes active sessions", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });
    db.resetTokens.push(
      {
        id: "reset_1",
        user_id: "user_operator",
        token_hash: "first-reset-hash",
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      },
      {
        id: "reset_2",
        user_id: "user_operator",
        token_hash: "second-reset-hash",
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "New-long-password1!" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.users[0].password_hash).not.toBe("old-hash");
    expect(db.users[0].password_salt).not.toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
    expect(db.passwordResetBatchCount).toBe(1);
    expect(db.audits.at(-1)).toMatchObject({
      action: "USER_PASSWORD_RESET",
      entity_type: "user",
      entity_id: "user_operator"
    });
  });

  it("rolls back an administrator password change, session revocation, and reset-token invalidation together", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: "reset-hash",
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.failPasswordResetBatchAfterStatement = 1;

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "New-long-password1!" })
      }),
      env(db)
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "internal_error" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.users[0].password_salt).toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.resetTokens[0].used_at).toBeNull();
    expect(db.audits).toHaveLength(0);
  });

  it("rejects weak password resets without changing the user or sessions", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "weakpassword" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_user_password" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.users[0].password_salt).toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.audits).toHaveLength(0);
  });
});

function emailResendDb(): InMemoryD1 {
  const db = new InMemoryD1();
  db.sessionUser = {
    id: "user_operator",
    email: "operator@example.org",
    name: "Operator",
    role: "OPERATOR"
  };
  db.documents.push(testDocument());
  return db;
}

const TEST_RESEND_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function resendDocument(
  runtime: Env,
  resendRequestId = TEST_RESEND_REQUEST_ID
): Promise<Response> {
  return worker.fetch(
    new Request("https://example.org/api/documents/doc_1/resend", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ resendRequestId })
    }),
    runtime
  );
}

describe("document email resend", () => {
  it("requires a client-generated resend request ID", async () => {
    const db = emailResendDb();

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_resend_request_id"
    });
    expect(db.emailDeliveries).toHaveLength(0);
  });

  it("suppresses a repeated HTTP request with the same deliberate resend ID", async () => {
    const db = emailResendDb();
    const send = vi.fn(async () => ({ messageId: "cf-manual-resend-once" }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    });

    const first = await resendDocument(runtime);
    const repeated = await resendDocument(runtime);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      duplicateSuppressed: false,
      attemptNo: 1
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      ok: true,
      duplicateSuppressed: true,
      attemptNo: 1
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      resend_request_id: TEST_RESEND_REQUEST_ID,
      attempt_no: 1,
      status: "SENT"
    });
    const resendAudit = db.audits.find((row) => row.action === "EMAIL_RESENT");
    expect(resendAudit).toBeTruthy();
    expect(JSON.stringify(resendAudit)).not.toContain("legacy-contact-2@example.com");
  });

  it("reports an in-progress duplicate while the first resend owns the provider call", async () => {
    const db = emailResendDb();
    let releaseProvider!: () => void;
    let providerEntered!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const send = vi.fn(async () => {
      providerEntered();
      await providerRelease;
      return { messageId: "cf-manual-resend-concurrent" };
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    });

    const firstPromise = resendDocument(runtime);
    await providerStarted;
    const repeated = await resendDocument(runtime);
    releaseProvider();
    const first = await firstPromise;

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toMatchObject({
      error: "resend_in_progress",
      attemptNo: 1
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries the same deliberate request only after a proven NOT_SENT outcome", async () => {
    const db = emailResendDb();
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(
        new Error("header rejected before provider acceptance"),
        { code: "E_HEADER_NOT_ALLOWED" }
      ))
      .mockResolvedValueOnce({ messageId: "cf-manual-resend-recovered" });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    });

    const rejected = await resendDocument(runtime);
    const recovered = await resendDocument(runtime);
    const repeated = await resendDocument(runtime);

    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toMatchObject({
      error: "email_send_failed",
      outcomeClass: "NOT_SENT",
      manualReview: false,
      attemptNo: 1
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      ok: true,
      duplicateSuppressed: false,
      attemptNo: 2
    });
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      ok: true,
      duplicateSuppressed: true,
      attemptNo: 2
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      status: "SENT",
      resend_request_id: TEST_RESEND_REQUEST_ID,
      attempt_no: 2
    });
  });

  it("blocks repeat dispatch after an ambiguous manual resend outcome", async () => {
    const db = emailResendDb();
    const send = vi.fn(async () => {
      throw Object.assign(new Error(
        "internal failure for legacy-contact-2@example.com at https://private.example/token/abc"
      ), {
        code: "E_INTERNAL_SERVER_ERROR"
      });
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    });

    const failed = await resendDocument(runtime);
    const repeated = await resendDocument(runtime);

    expect(failed.status).toBe(502);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      error: "email_send_failed",
      outcomeClass: "UNKNOWN",
      manualReview: true,
      attemptNo: 1
    });
    expect(repeated.status).toBe(409);
    await expect(repeated.json()).resolves.toMatchObject({
      error: "resend_requires_review",
      outcomeClass: "UNKNOWN",
      attemptNo: 1
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      status: "FAILED",
      outcome_class: "UNKNOWN",
      retry_safe: 0
    }));
    const persisted = JSON.stringify({
      deliveries: db.emailDeliveries,
      audits: db.audits,
      response: failedBody
    });
    expect(persisted).not.toContain("https://private.example/token/abc");
  });

  it("blocks replay of an older retry-safe request after a newer ambiguous attempt", async () => {
    const db = emailResendDb();
    const olderRequestId = "99999999-9999-4999-8999-999999999999";
    const newerRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("safe rejection"), {
        code: "E_HEADER_NOT_ALLOWED"
      }))
      .mockRejectedValueOnce(Object.assign(new Error("ambiguous provider result"), {
        code: "E_INTERNAL_SERVER_ERROR"
      }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    });

    expect((await resendDocument(runtime, olderRequestId)).status).toBe(502);
    expect((await resendDocument(runtime, newerRequestId)).status).toBe(502);
    const replay = await resendDocument(runtime, olderRequestId);

    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      error: "resend_requires_review",
      outcomeClass: "UNKNOWN",
      attemptNo: 2
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.emailDeliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resend_request_id: olderRequestId,
        status: "FAILED",
        outcome_class: "NOT_SENT",
        attempt_no: 1
      }),
      expect.objectContaining({
        resend_request_id: newerRequestId,
        status: "FAILED",
        outcome_class: "UNKNOWN",
        attempt_no: 2
      })
    ]));
  });

  it("blocks a fresh resend ID when the latest legacy receipt failure is ambiguous", async () => {
    const db = emailResendDb();
    db.emailDeliveries.push({
      id: "email_legacy_ambiguous",
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED",
      provider_response_json: "{}",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      claim_token: null,
      outcome_class: null,
      retry_safe: 0,
      attempt_no: 1,
      created_at: "2026-07-17T16:59:00.000Z"
    });
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    const response = await resendDocument(env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as SendEmail
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "resend_requires_review",
      outcomeClass: null,
      attemptNo: 1
    });
    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toHaveLength(1);
  });

  it("sends receipts through the Cloudflare Email Service binding", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      from: "legacy-contact-6@example.com",
      to: "legacy-contact-2@example.com",
      headers: {
        "X-Idempotency-Key": expect.stringMatching(/^dsv-receipt-resend-v1-[a-f0-9]{64}$/)
      },
      subject: "Comprobante de su donación",
      text: expect.stringContaining("DTE-15-M001P004-000000000000009"),
      html: expect.stringContaining("DTE-15-M001P004-000000000000009"),
      attachments: [
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }),
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.json",
          type: "application/json",
          disposition: "attachment"
        })
      ]
    });
    const sentMessage = sentMessages[0] as { attachments: Array<{ content: unknown }> };
    expect(sentMessage.attachments[0].content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((sentMessage.attachments[0].content as Uint8Array).slice(0, 4))).toBe("%PDF");
    const pdfSha256 = await sha256Hex(sentMessage.attachments[0].content as Uint8Array);
    expect(sentMessage.attachments[1].content).toBeInstanceOf(Uint8Array);
    const dteJsonBytes = sentMessage.attachments[1].content as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(sentMessage.attachments[1].content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    const providerDeliveryId = `sha256:${await sha256Hex(utf8Bytes("cf-email-1"))}`;
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      template_version: expect.stringMatching(/^dteReceipt:sha256:[a-f0-9]{64}$/),
      pdf_renderer_version: "cde-pdf:v3",
      pdf_sha256: pdfSha256,
      dte_json_sha256: await sha256Hex(dteJsonBytes),
      provider_delivery_id: providerDeliveryId,
      provider_response_json: JSON.stringify({ provider: "cloudflare-email", messageId: providerDeliveryId })
    }));
  });

  it("uses the configured receipt email template", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());
    db.settings.push({
      key: "email_templates_json",
      value: JSON.stringify({
        dteReceipt: {
          subject: "CDE {{numeroControl}} listo",
          body: "Hola {{donante}}, recibimos {{monto}} y adjuntamos {{codigoGeneracion}}."
        },
        dteInvalidation: {
          subject: "CDE invalidado {{numeroControl}}",
          body: "El CDE {{numeroControl}} fue INVALIDADO."
        }
      }),
      updated_by: "user_owner",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-template" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      subject: "CDE DTE-15-M001P004-000000000000009 listo",
      text: "Hola Example Person, recibimos $100.00 y adjuntamos 6CAE5F7E-A590-4573-8EF2-FE48B14796C4."
    });
  });

  it("attaches the signed JWS artifact when the document has a signed JWS", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const signedJws = "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature";
    db.documents.push({
      ...testDocument(),
      signed_jws: signedJws
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    const sentMessage = sentMessages[0] as { attachments: Array<{ filename: string; content: unknown }> };
    const jsonAttachment = sentMessage.attachments.find((attachment) => attachment.filename.endsWith(".json"));
    expect(jsonAttachment?.content).toBeInstanceOf(Uint8Array);
    // The legally meaningful artifact is the signed JWS, not the unsigned plain_json.
    expect(new TextDecoder().decode(jsonAttachment?.content as Uint8Array)).toBe(signedJws);
    // The recorded JSON evidence hash covers the signed artifact actually sent.
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: "doc_1",
        dte_json_sha256: await sha256Hex(new TextEncoder().encode(signedJws))
      })
    );
  });

  it("does not cross providers after an ambiguous Cloudflare email failure", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", id: "email_http_1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      })
    );
    const cloudflareSend = vi.fn(async () => {
      throw new Error("provider accepted message before response channel closed");
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_ARBITRARY_RECIPIENTS: "true",
        EMAIL_PROVIDER_URL: "https://mail.example/send",
        EMAIL_API_KEY: "email-api-key",
        EMAIL: { send: cloudflareSend } as SendEmail
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: "No se pudo confirmar el resultado del envío con el proveedor."
    });
    expect(cloudflareSend).toHaveBeenCalledTimes(1);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED",
      provider_response_json: JSON.stringify({ code: "EMAIL_DISPATCH_UNKNOWN" })
    }));
  });

  it("preselects the HTTP provider when Cloudflare arbitrary recipients are not enabled", async () => {
    const db = emailResendDb();
    const cloudflareSend = vi.fn(async () => ({ messageId: "must-not-use-cloudflare" }));
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", id: "email_http_selected" }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      })
    );

    const response = await resendDocument(
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_ARBITRARY_RECIPIENTS: "false",
        EMAIL_PROVIDER_URL: "https://mail.example/send",
        EMAIL_API_KEY: "email-api-key",
        EMAIL: { send: cloudflareSend } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    expect(cloudflareSend).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const providerDeliveryId = `sha256:${await sha256Hex(utf8Bytes("email_http_selected"))}`;
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "SENT",
      provider_response_json: JSON.stringify({
        provider: "http-email",
        messageId: providerDeliveryId
      })
    }));
  });

  it("passes a receipt claim's stable provider identity to the HTTP provider", async () => {
    const db = new InMemoryD1();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", id: "email_http_stable" }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      })
    );
    const idempotencyKey = `dsv-receipt-v1-${"a".repeat(64)}`;

    await new EmailService(env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    })).sendReceipt(testDocument(), "legacy-contact-2@example.com", idempotencyKey);

    expect(providerFetch).toHaveBeenCalledWith(
      "https://mail.example/send",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": idempotencyKey
        })
      })
    );
  });

  it.each([
    "http://mail.example/send",
    "https://user:password@mail.example/send",
    "not-a-url"
  ])("never sends credentials to unsafe email provider endpoint %s", async (providerUrl) => {
    const db = emailResendDb();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "must-not-send" }), { status: 202 })
    );
    const response = await resendDocument(
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_PROVIDER_URL: providerUrl,
        EMAIL_API_KEY: "email-api-key"
      })
    );

    expect(response.status).toBe(502);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("ignores the legacy owner-controlled EMAIL_API_URL", async () => {
    const db = emailResendDb();
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "legacy-must-not-send" }), { status: 202 })
    );
    const response = await resendDocument(
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_API_URL: "https://legacy-owner.example/send",
        EMAIL_API_KEY: "email-api-key"
      } as Partial<Env> & { EMAIL_API_URL: string })
    );

    expect(response.status).toBe(502);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("records and returns email failures when the provider is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com" })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: expect.stringContaining("Configure el servicio de correo")
    });
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED"
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_RESEND_FAILED", entity_id: "doc_1" }));
  });

  it("records a failed delivery when EMAIL_FROM is missing for a real send", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        // EMAIL_FROM intentionally omitted even though a provider binding exists.
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-should-not-send" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: "Configure el remitente de correo antes de enviar."
    });
    expect(sentMessages).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED"
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_RESEND_FAILED", entity_id: "doc_1" }));
  });

  it("alerts on a manual resend failure using the delivery claim as the incident", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(testDocument());
    const sent: Array<{ to: string; subject: string }> = [];
    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            const outbound = message as { to: string; subject: string };
            sent.push(outbound);
            if (outbound.subject === "Fallo al reenviar comprobante") {
              return { messageId: "alert-manual-resend-failed" };
            }
            throw Object.assign(new Error("header rejected"), { code: "E_HEADER_NOT_ALLOWED" });
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(502);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      to: "owner@example.org",
      subject: "Fallo al reenviar comprobante"
    });
    const delivery = db.emailDeliveries[0];
    const alertAudit = db.audits.find((audit) => audit.action === "ALERT_SENT:EMAIL_FAILED");
    expect(alertAudit).toBeTruthy();
    expect(JSON.parse(String(alertAudit?.metadata_json))).toEqual({
      incidentId: delivery.claim_token,
      channel: "email"
    });
  });
});

describe("document contact email", () => {
  it("updates the delivery email without mutating the legal DTE JSON", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/email", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: "nuevo@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(db.documents[0].donor_email).toBe("nuevo@example.org");
    expect(JSON.parse(db.documents[0].plain_json)).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_EMAIL_UPDATED", entity_id: "doc_1" }));
  });

  it("rejects a donor-email correction while accepted-document finalization owns the row", async () => {
    const db = new InMemoryD1();
    const document = testDocument({
      post_accept_finalized_at: null,
      post_accept_finalization_claim_id: "finalize_active",
      post_accept_finalization_claimed_at: "2026-07-14T15:00:00.000Z"
    });
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/email", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: "nuevo@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "document_finalization_pending" });
    expect(db.documents[0].donor_email).toBe("legacy-contact-2@example.com");
    expect(db.audits.some((audit) => audit.action === "DTE_EMAIL_UPDATED")).toBe(false);
  });
});

describe("document JSON download", () => {
  it("returns valid plain DTE JSON even when a signed JWS exists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push({
      ...testDocument(),
      signed_jws: "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/json", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
  });
});

describe("document retry", () => {
  it("rejects retry for an accepted or invalidated DTE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push({ ...testDocument(), status: "INVALIDATED" });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "document_not_retryable",
      message: expect.stringContaining("no tiene fallos")
    });
  });

  it("rejects a production DTE retry from staging before queueing or auditing", async () => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      status: "FAILED",
      environment: "01",
      signed_jws: null,
      sello_recibido: null,
      accepted_at: null
    }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { APP_ENV: "staging", ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("allows exactly one of two concurrent retries to transmit a signed CDE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      status: "SIGNED",
      signed_jws: "signed-retry-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    }));
    let documentReads = 0;
    let releaseDocumentReads!: () => void;
    const bothDocumentReads = new Promise<void>((resolve) => {
      releaseDocumentReads = resolve;
    });
    db.beforeDocumentRead = async () => {
      documentReads += 1;
      if (documentReads === 2) releaseDocumentReads();
      await bothDocumentReads;
    };
    const runtime = env(db);
    const retry = () => worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      runtime
    );

    const responses = await Promise.all([retry(), retry()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    await expect(conflict.json()).resolves.toMatchObject({ error: "document_retry_in_progress" });
    expect(db.audits.filter((audit) => audit.action === "DTE_RETRIED")).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
  });

  it("keeps the fiscal claim when a retry's MH outcome is unknown", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      status: "SIGNED",
      signed_jws: "signed-ambiguous-retry-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockRejectedValueOnce(new Error("connection reset after request write"));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });
    const retry = () => worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      runtime
    );

    const first = await retry();
    expect(first.status).toBe(500);
    expect(db.documents[0]).toMatchObject({
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/),
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const second = await retry();
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "fiscal_outcome_pending_reconciliation" });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("releases a signed retry claim when MH authentication fails before dispatch", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      status: "SIGNED",
      signed_jws: "signed-predispatch-retry-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response("auth unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });
    const retry = () => worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      runtime
    );

    expect((await retry()).status).toBe(500);
    expect(db.documents[0].fiscal_operation_claim_id).toBeNull();
    expect((await retry()).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit receptor correction for a rejected Wompi CDE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    // Real payment-link payload shape: no DocumentoIdentidad, no Direccion.
    db.wompiEvents.push({
      id: "wompi_evt_reject",
      transaction_id: "TX-REJECTED-1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 100,
      donor_email: "legacy-contact-2@example.com",
      donor_name: "Example Person",
      raw_body: JSON.stringify({
        IdTransaccion: "TX-REJECTED-1",
        ResultadoTransaccion: "ExitosaAprobada",
        Monto: "1.00",
        FechaTransaccion: "2026-07-05T10:15:19.089-06:00",
        EsProductiva: false,
        Cliente: { Nombre: "Example Person", EMail: "legacy-contact-2@example.com" }
      }),
      processed_at: "2026-07-05T16:33:40.000Z",
      created_document_id: "doc_1",
      received_at: "2026-07-05T16:33:20.000Z"
    });
    db.documents.push({
      ...testDocument(),
      status: "REJECTED",
      wompi_event_id: "wompi_evt_reject",
      signed_jws: "stale-signed-jws",
      sello_recibido: null,
      accepted_at: null,
      mh_estado: "HTTP_400"
    });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const before = structuredClone(db.documents[0]);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "document_correction_required",
      message: "Corrija los datos rechazados antes de crear un nuevo intento fiscal."
    });
    expect(db.documents[0]).toEqual(before);
    expect(transmit).not.toHaveBeenCalled();
  });
});

describe("contingency history (read-only)", () => {
  // La emisión en contingencia del CDE se eliminó: el Anexo de validaciones del
  // evento de contingencia (campo 35) no admite el tipo 15. Los periodos históricos
  // siguen visibles en solo lectura; las rutas de apertura/barrido ya no existen.
  it("no longer exposes the contingency open/sweep routes", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const open = await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "00", tipoContingencia: 2, reason: "MH TEST no disponible" })
      }),
      env(db)
    );
    expect(open.status).toBe(404);
    expect(db.contingencies).toHaveLength(0);

    const sweep = await worker.fetch(
      new Request("https://example.org/api/contingency/sweep", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(sweep.status).toBe(404);
  });

  it("still serves historical contingency state for the read-only view", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.contingencies.push({
      id: "cont_hist_1",
      environment: "00",
      status: "CLOSED",
      reason: "MH TEST no disponible (histórico)",
      tipo_contingencia: 2,
      started_at: "2026-06-20T01:00:00.000Z",
      ended_at: "2026-06-20T04:00:00.000Z",
      event_id: null,
      event_sello: null,
      transmit_deadline_at: null,
      created_at: "2026-06-20T01:00:00.000Z"
    });
    db.documents.push({
      ...testDocument(),
      id: "doc_contingency",
      status: "CONTINGENCY_PENDING",
      sello_recibido: null,
      mh_estado: "CONTINGENCY_PENDING",
      accepted_at: null,
      contingency_period_id: "cont_hist_1"
    });

    const stateResponse = await worker.fetch(
      new Request("https://example.org/api/contingency", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      contingency: {
        active: null,
        pendingDocuments: [
          {
            id: "doc_contingency",
            status: "CONTINGENCY_PENDING"
          }
        ],
        periods: [
          {
            id: "cont_hist_1",
            status: "CLOSED"
          }
        ],
        summary: {
          pending: 1,
          open: 0,
          closed: 1
        }
      }
    });
  });

  it("returns contingency lote rows and line counts for the dashboard", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.contingencies.push({
      id: "cont_1",
      environment: "00",
      status: "EVENT_ACCEPTED",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      event_id: "event_1",
      event_sello: "EVENT-SEAL",
      transmit_deadline_at: "2026-06-29T01:00:00.000Z",
      created_at: "2026-06-26T01:00:00.000Z"
    });
    db.contingencyBatches.push({
      id: "batch_1",
      contingency_period_id: "cont_1",
      environment: "00",
      id_envio: "BATCH-SEND-1",
      status: "PROCESSING",
      codigo_lote: "LOTE-TEST-1",
      request_json: "{}",
      response_json: "{}",
      last_error: null,
      line_count: 2,
      accepted_count: 1,
      rejected_count: 0,
      pending_count: 1,
      created_at: "2026-06-26T01:10:00.000Z",
      submitted_at: "2026-06-26T01:11:00.000Z",
      last_polled_at: "2026-06-26T01:12:00.000Z",
      updated_at: "2026-06-26T01:12:00.000Z"
    });
    db.contingencyBatchLines.push(
      {
        id: "line_1",
        batch_id: "batch_1",
        contingency_period_id: "cont_1",
        document_id: "doc_1",
        line_no: 1,
        status: "ACCEPTED",
        codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
        tipo_dte: "15",
        signed_jws: "signed-cde-jws-1",
        sello_recibido: "DTE-SEAL-1",
        mh_estado: "PROCESADO",
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:10:00.000Z",
        updated_at: "2026-06-26T01:12:00.000Z"
      },
      {
        id: "line_2",
        batch_id: "batch_1",
        contingency_period_id: "cont_1",
        document_id: "doc_2",
        line_no: 2,
        status: "BATCH_SENT",
        codigo_generacion: "8C2A5D5F-1111-4111-8111-1111119E416F",
        tipo_dte: "15",
        signed_jws: "signed-cde-jws-2",
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:10:00.000Z",
        updated_at: "2026-06-26T01:11:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/contingency", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contingency: {
        batches: [
          {
            id: "batch_1",
            status: "PROCESSING",
            codigo_lote: "LOTE-TEST-1",
            line_count: 2,
            accepted_count: 1,
            pending_count: 1
          }
        ],
        batchLines: [
          { id: "line_1", batch_id: "batch_1", status: "ACCEPTED", sello_recibido: "DTE-SEAL-1" },
          { id: "line_2", batch_id: "batch_1", status: "BATCH_SENT" }
        ],
        summary: {
          batches: 1,
          batchAccepted: 1,
          batchPending: 1,
          batchRejected: 0
        }
      }
    });
  });
});

describe("document invalidation", () => {
  // Pin the clock inside the legal window of testDocument()'s sello (June 2026 →
  // invalidation allowed until the tenth business day of July, 2026-07-15T05:59:59Z).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-01T15:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects production invalidation from staging before signing or transmission", async () => {
    const db = new InMemoryD1();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ environment: "01" }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "No debe transmitirse" })
      }),
      env(db, { APP_ENV: "staging", MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(db.dteEvents).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("blocks invalidation after the tenth business day of the following month", async () => {
    vi.setSystemTime(new Date("2026-07-15T06:00:00.000Z"));
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Fuera de ventana" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "outside_legal_window",
      deadline: "2026-07-15T05:59:59.000Z"
    });
    expect(document.status).toBe("ACCEPTED");
  });

  it("requires a replacement codigo de generación for tipo 1 invalidations", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 1, motivoAnulacion: "Error en datos" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "replacement_required_for_tipo_1" });
    expect(document.status).toBe("ACCEPTED");
  });

  it("rejects caller-supplied invalidation identity fields before signing", async () => {
    const db = new InMemoryD1();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tipoAnulacion: 2,
          motivoAnulacion: "Prueba",
          nombreResponsable: "Attacker",
          tipDocResponsable: "13",
          numDocResponsable: "00000000-0"
        })
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_invalidation_input" });
    expect(db.dteEvents).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows exactly one of two concurrent invalidations to create and transmit an event", async () => {
    const db = new InMemoryD1();
    const certPassword = "correct horse battery staple";
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ donor_email: null }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml(certPassword),
      MH_CERT_PASSWORD: certPassword
    });
    const invalidate = () => worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Prueba concurrente" })
      }),
      runtime
    );

    const responses = await Promise.all([invalidate(), invalidate()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    await expect(conflict.json()).resolves.toMatchObject({ error: "document_fiscal_operation_in_progress" });
    expect(db.dteEvents).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DTE_INVALIDATED")).toHaveLength(1);
    expect(db.documents[0].status).toBe("INVALIDATED");
  });

  it("does not redispatch an invalidation after an ambiguous MH 503 response", async () => {
    const db = new InMemoryD1();
    const certPassword = "correct horse battery staple";
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ donor_email: null }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(new Response("MH unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml(certPassword),
      MH_CERT_PASSWORD: certPassword,
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
    });
    const invalidate = () => worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Resultado ambiguo" })
      }),
      runtime
    );

    expect((await invalidate()).status).toBe(500);
    expect(db.documents[0]).toMatchObject({
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/),
      fiscal_operation_kind: "INVALIDATION",
      fiscal_operation_event_id: db.dteEvents[0].id
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const second = await invalidate();
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "fiscal_outcome_pending_reconciliation" });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
    expect(db.dteEvents).toHaveLength(1);
  });

  it("atomically fails the event and releases its claim when MH auth fails before dispatch", async () => {
    const db = new InMemoryD1();
    const certPassword = "correct horse battery staple";
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ donor_email: null }));
    const fetchMock = vi.fn().mockResolvedValue(new Response("auth unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml(certPassword),
      MH_CERT_PASSWORD: certPassword,
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Fallo antes del envío" })
      }),
      runtime
    );

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      fiscal_operation_claim_id: null,
      fiscal_operation_claimed_at: null,
      fiscal_operation_kind: null,
      fiscal_operation_event_id: null
    });
    expect(db.dteEvents).toHaveLength(1);
    expect(db.dteEvents[0]).toMatchObject({
      status: "FAILED",
      mh_estado: "PRE_DISPATCH_FAILED",
      accepted_at: null
    });
  });

  it("rolls back the event verdict when atomic invalidation completion fails", async () => {
    const db = new InMemoryD1();
    const certPassword = "correct horse battery staple";
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ donor_email: null }));
    db.failInvalidationCompletionBatchAfterStatement = 1;
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml(certPassword),
      MH_CERT_PASSWORD: certPassword
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Fallo transaccional" })
      }),
      runtime
    );

    expect(response.status).toBe(500);
    expect(db.dteEvents).toHaveLength(1);
    expect(db.dteEvents[0].status).toBe("SIGNED");
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/),
      fiscal_operation_kind: "INVALIDATION",
      fiscal_operation_event_id: db.dteEvents[0].id
    });
    expect(db.audits.some((audit) => audit.action === "DTE_INVALIDATED")).toBe(false);
  });

  it("blocks receipt resend while an invalidation outcome is pending reconciliation", async () => {
    const db = new InMemoryD1();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      fiscal_operation_claim_id: "fiscal_pending_invalidation",
      fiscal_operation_claimed_at: "2026-07-14T12:00:00.000Z",
      fiscal_operation_kind: "INVALIDATION",
      fiscal_operation_event_id: "event_pending_invalidation"
    }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "fiscal_outcome_pending_reconciliation" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toHaveLength(0);
  });

  it("excludes accepted-looking documents with pending invalidations from status-dependent exports", async () => {
    const db = new InMemoryD1();
    db.documents.push(
      testDocument({ id: "doc_definitive", wompi_event_id: "wompi_definitive" }),
      testDocument({
        id: "doc_pending_invalidation",
        wompi_event_id: "wompi_pending_invalidation",
        fiscal_operation_claim_id: "fiscal_pending_invalidation",
        fiscal_operation_claimed_at: "2026-07-14T12:00:00.000Z",
        fiscal_operation_kind: "INVALIDATION",
        fiscal_operation_event_id: "event_pending_invalidation"
      })
    );
    const repository = new Repository(env(db).DB);
    const range = { startIso: "2026-01-01T00:00:00.000Z", endIso: "2027-01-01T00:00:00.000Z" };

    expect((await repository.listAcceptedDteDocumentsForExport()).map((document) => document.id)).toEqual(["doc_definitive"]);
    expect((await repository.listAcceptedDocumentsInYear(range, null)).map((document) => document.id)).toEqual(["doc_definitive"]);
    expect((await repository.listAcceptedWompiContactRows("00", null)).map((row) => row.id)).toEqual(["doc_definitive"]);
    expect((await repository.listWompiLaneDocumentsForAnalytics(range, "00", null)).map((document) => document.id)).toEqual(["doc_definitive"]);
  });

  it("emails an invalidation notice when MH accepts the invalidation event", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);
    db.settings.push({
      key: "email_templates_json",
      value: JSON.stringify({
        dteReceipt: {
          subject: "CDE {{numeroControl}} listo",
          body: "Adjuntamos {{numeroControl}}."
        },
        dteInvalidation: {
          subject: "Aviso de invalidación {{numeroControl}}",
          body: "Hola {{donante}}, el CDE {{numeroControl}} quedó {{estado}} ante MH."
        }
      }),
      updated_by: "user_owner",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    const certPassword = "correct horse battery staple";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({
          estado: "PROCESADO",
          codigoMsg: "001",
          descripcionMsg: "Invalidación recibida",
          selloRecibido: "2026INVALIDACIONSEAL",
          observaciones: []
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Prueba aceptada" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-invalidated" };
          }
        } as SendEmail,
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword,
        MH_USER_TEST: "10000003520015",
        MH_PASSWORD_TEST: "test-password",
        MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
        MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      emailSent: true
    });
    expect(db.documents[0].status).toBe("INVALIDATED");
    expect(sentMessages).toHaveLength(1);
    const sentMessage = sentMessages[0] as { subject: string; text: string; attachments: Array<{ filename: string; content: unknown }> };
    expect(sentMessage.subject).toBe("Aviso de invalidación DTE-15-M001P004-000000000000009");
    expect(sentMessage.text).toBe("Hola Example Person, el CDE DTE-15-M001P004-000000000000009 quedó Invalidado ante MH.");
    expect(new TextDecoder().decode((sentMessage.attachments[0].content as Uint8Array).slice(0, 4))).toBe("%PDF");
    const invalidationPdfSha256 = await sha256Hex(sentMessage.attachments[0].content as Uint8Array);
    const invalidationJsonBytes = sentMessage.attachments[1].content as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(sentMessage.attachments[1].content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    const providerDeliveryId = `sha256:${await sha256Hex(utf8Bytes("cf-email-invalidated"))}`;
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      email_type: "dteInvalidation",
      document_status_at_send: "INVALIDATED",
      template_version: expect.stringMatching(/^dteInvalidation:sha256:[a-f0-9]{64}$/),
      pdf_renderer_version: "cde-pdf:v3",
      pdf_sha256: invalidationPdfSha256,
      dte_json_sha256: await sha256Hex(invalidationJsonBytes),
      provider_delivery_id: providerDeliveryId,
      provider_response_json: JSON.stringify({ provider: "cloudflare-email", messageId: providerDeliveryId })
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_INVALIDATION_SENT", entity_id: "doc_1" }));
    const invalidation = JSON.parse(String(db.dteEvents[0].plain_json)) as {
      motivo: Record<string, string>;
    };
    expect(invalidation.motivo).toMatchObject({
      nombreResponsable: "Example Person",
      tipDocResponsable: "13",
      numDocResponsable: "100000001",
      nombreSolicita: "Example Person",
      tipDocSolicita: "13",
      numDocSolicita: "100000001"
    });
  });

  it("returns a conflict when MH rejects the invalidation event", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);
    const certPassword = "correct horse battery staple";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            estado: "RECHAZADO",
            codigoMsg: "027",
            descripcionMsg: "[identificacion.fecEmi] DATO NO COINCIDE CON DTE",
            selloRecibido: null,
            observaciones: []
          },
          { status: 400 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Prueba rechazada" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword,
        MH_USER_TEST: "10000003520015",
        MH_PASSWORD_TEST: "test-password",
        MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
        MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalidation_rejected",
      message: expect.stringContaining("DATO NO COINCIDE")
    });
    expect(document.status).toBe("ACCEPTED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_INVALIDATION_REJECTED", entity_id: "doc_1" }));
  });
});

describe("F960 CSV export", () => {
  it("returns accepted CDEs for a date range in the real F960 semicolon format", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument(),
      {
        ...testDocument(),
        id: "doc_may",
        codigo_generacion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000008",
        issued_at: "2026-05-31T23:30:00.000Z",
        accepted_at: "2026-05-31T23:31:00.000Z",
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: { nombre: "Outside Range", correo: "outside@example.org", tipoDocumento: "13", numDocumento: "100000043" },
          resumen: { valorTotal: 50 },
          identificacion: { fecEmi: "2026-05-31", horEmi: "17:30:00", codigoGeneracion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B" }
        })
      },
      {
        ...testDocument(),
        id: "doc_failed",
        codigo_generacion: "0E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000010",
        status: "FAILED",
        sello_recibido: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-20260601-20260630.csv"');
    await expect(response.text()).resolves.toBe(
      "1;;Example Person;9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;100000001;062026\r\n"
    );
  });

  it("neutralizes spreadsheet formulas in donor-controlled CSV fields", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument({
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: {
            nombre: '=HYPERLINK("https://evil.example",A1)',
            correo: "donor@example.org",
            tipoDocumento: "13",
            numDocumento: "@PAYLOAD"
          },
          resumen: { valorTotal: 100 },
          identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
        })
      })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    // The =HYPERLINK name gets a leading apostrophe (then quoted for the embedded "),
    // the @PAYLOAD document gets one too; benign numeric/hex fields stay bare.
    await expect(response.text()).resolves.toBe(
      `1;;"'=HYPERLINK(""https://evil.example"",A1)";9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;'@PAYLOAD;062026\r\n`
    );
  });

  it("returns preview rows for the selected date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rowCount: 1,
      amountTotal: "100.00",
      rows: [
        {
          nit: "",
          nombre: "Example Person",
          codigoActividad: "9300",
          tipoDonacion: "4",
          sello: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
          codigoGeneracion: "6CAE5F7EA59045738EF2FE48B14796C4",
          monto: "100.00",
          dui: "100000001",
          periodo: "062026"
        }
      ]
    });
  });

  it("returns an Excel inspection workbook with headers for the selected rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.xlsx?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-inspeccion-20260601-20260630.xlsx"');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
    const workbookText = new TextDecoder().decode(bytes);
    expect(workbookText).toContain("Nombre donante");
    expect(workbookText).toContain("Example Person");
    expect(workbookText).toContain("Código generación");
    expect(workbookText).toContain("Aceptado");
  });

  it("requires an admin role", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("CRM contacts export", () => {
  function seedWompiDonor(
    db: InMemoryD1,
    document: Partial<DteDocumentRecord>,
    intent?: Record<string, unknown>
  ): void {
    const doc = testDocument({ wompi_event_id: `wompi_${document.id}`, ...document });
    db.documents.push(doc);
    if (intent) {
      db.donationIntents.push({
        id: `intent_${doc.id}`,
        status: "COMPLETED",
        document_id: doc.id,
        created_at: doc.issued_at,
        donor_phone: null,
        direccion_complemento: null,
        direccion_departamento: null,
        donor_pais: null,
        gift_type: null,
        ...intent
      });
    }
  }

  it("returns a BOM-prefixed CSV of unique Wompi-lane donors for the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      {
        id: "doc_ana",
        environment: "01",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 5000,
        issued_at: "2026-02-01T18:00:00.000Z"
      },
      {
        donor_phone: "70000001",
        direccion_complemento: "Calle Nueva",
        direccion_departamento: "06",
        gift_type: "DIEZMO"
      }
    );
    // Excluded: production filter (this doc is ambiente 00).
    seedWompiDonor(db, {
      id: "doc_other_env",
      environment: "00",
      donor_email: "test@example.org",
      donor_name: "Test",
      issued_at: "2026-02-02T18:00:00.000Z"
    });
    // Excluded: not a Wompi-lane document (no wompi_event_id).
    seedWompiDonor(db, {
      id: "doc_manual",
      environment: "01",
      wompi_event_id: null,
      donor_email: "manual@example.org",
      donor_name: "Manual",
      issued_at: "2026-02-03T18:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="contactos-donantes-01-1.csv"');
    // Response.text() strips a leading BOM per spec, so assert the BOM on raw bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("nombre,correo,telefono,direccion,departamento,pais,primera_donacion,ultima_donacion,total_donado_usd,numero_donaciones,tipo_preferido");
    expect(rows[1]).toBe("Ana,ana@example.org,70000001,Calle Nueva,San Salvador,El Salvador,2026-02-01,2026-02-01,50.00,1,Diezmo");
    // Only the single ambiente-01 Wompi-lane donor.
    expect(rows.filter((row) => row.length > 0)).toHaveLength(2);
  });

  it("records a CONTACTS_EXPORTED audit with the count and environment but no PII", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "CONTACTS_EXPORTED");
    expect(audit).toBeDefined();
    expect(audit!.entity_type).toBe("export");
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({ environment: "01", contacts: 1 });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("ana@example.org");
    expect(serialized).not.toContain("70000001");
    expect(serialized).not.toContain("Ana");
  });

  it("rejects a missing or invalid environment", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_export_environment" });
  });

  it("requires an admin role (viewer and operator are rejected)", async () => {
    for (const role of ["VIEWER", "OPERATOR"]) {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_x", email: "x@example.org", name: "X", role };

      const response = await worker.fetch(
        new Request("https://example.org/api/exports/contacts?environment=01", {
          headers: { Authorization: "Bearer test-token" }
        }),
        env(db)
      );

      expect(response.status).toBe(403);
    }
  });

  it("restricts the export to a from/to date window (El Salvador local, inclusive)", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Before the window (2024) and inside the window (2025-06).
    seedWompiDonor(
      db,
      { id: "doc_old", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 1000, issued_at: "2024-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_in", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2025-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-01-01&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    // Header + one donor; the 2025 donation is the only one counted (total 50.00).
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("50.00");
    expect(rows[1]).not.toContain("60.00");
  });

  it("filters counted donations by giftType and drops donors with none", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_diez", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 3000, issued_at: "2026-02-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_ofr", environment: "01", donor_email: "beto@example.org", donor_name: "Beto", amount_cents: 4000, issued_at: "2026-02-02T18:00:00.000Z" },
      { gift_type: "OFRENDA" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&giftType=DIEZMO", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Ana");
    expect(csv).not.toContain("Beto");
  });

  it("emits only the requested columns and rejects an unknown column name with 400 Spanish", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    const ok = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,correo", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(ok.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await ok.arrayBuffer())).replace(/^﻿/, "");
    expect(csv.split("\r\n")[0]).toBe("nombre,correo");

    const bad = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,inventada", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_export_columns");
    expect(body.message).toContain("inventada");
  });

  it("rejects a malformed or inverted date range with 400", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const inverted = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-12-31&to=2025-01-01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(inverted.status).toBe(400);
    await expect(inverted.json()).resolves.toMatchObject({ error: "invalid_export_range" });

    const malformed = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-1-1&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(malformed.status).toBe(400);
  });
});

describe("annual donor certificates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-05T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedYear(db: InMemoryD1): void {
    db.documents.push(
      testDocument({
        id: "cert_ana_1",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 2500,
        issued_at: "2025-02-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000101"
      }),
      testDocument({
        id: "cert_ana_2",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 7501,
        issued_at: "2025-05-10T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000102"
      }),
      testDocument({
        id: "cert_noemail",
        donor_email: null,
        donor_name: "Sin Correo",
        amount_cents: 4000,
        issued_at: "2025-06-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000103"
      }),
      // Excluded: invalidated
      testDocument({
        id: "cert_invalid",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        status: "INVALIDATED",
        amount_cents: 9999,
        issued_at: "2025-07-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000104"
      }),
      // Excluded: different year
      testDocument({
        id: "cert_prev_year",
        donor_email: "beto@example.org",
        donor_name: "Beto",
        amount_cents: 1000,
        issued_at: "2024-12-31T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000105"
      })
    );
  }

  it("previews donors with counts, totals and email presence for a completed year", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      donorCount: number;
      withEmail: number;
      withoutEmail: number;
      totalLabel: string;
      donors: Array<{ donorName: string; hasEmail: boolean; count: number; totalLabel: string }>;
    };
    expect(body.donorCount).toBe(2);
    expect(body.withEmail).toBe(1);
    expect(body.withoutEmail).toBe(1);
    expect(body.totalLabel).toBe("$140.01");
    const ana = body.donors.find((donor) => donor.donorName === "Ana");
    expect(ana).toMatchObject({ hasEmail: true, count: 2, totalLabel: "$100.01" });
    const sinCorreo = body.donors.find((donor) => donor.donorName === "Sin Correo");
    expect(sinCorreo).toMatchObject({ hasEmail: false, count: 1 });
    // Search metadata present even without a query: full-year match set, not truncated.
    expect(body).toMatchObject({ matchCount: 2, truncated: false });
  });

  it("filters the preview donors by q while keeping the full-year summary", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    // "ana" (no accent) matches the "Ana" donor via deaccented, case-insensitive compare.
    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025&q=ana", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      donorCount: number;
      withEmail: number;
      matchCount: number;
      truncated: boolean;
      donors: Array<{ donorName: string }>;
    };
    // Summary spans the whole year regardless of the filter.
    expect(body.donorCount).toBe(2);
    expect(body.withEmail).toBe(1);
    // Only the matching donor is listed.
    expect(body.matchCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.donors.map((donor) => donor.donorName)).toEqual(["Ana"]);
  });

  it("rejects future years", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2027", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_certificate_year" });
  });

  it("forbids preview for non-admin roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(403);
  });

  it("sends one certificate per donor with email, attaches the PDF, and skips donors without email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    const sent: Array<{ to: string; subject: string; attachments?: Array<{ filename: string; type: string; content: Uint8Array }> }> = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message as { to: string; subject: string });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 1, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ana@example.org");
    expect(sent[0].subject).toBe("Constancia de donaciones 2025");
    const attachments = sent[0].attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("constancia-donaciones-2025.pdf");
    expect(attachments[0].type).toBe("application/pdf");
    expect(new TextDecoder("latin1").decode(attachments[0].content.slice(0, 5))).toBe("%PDF-");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONOR_CERTIFICATE_SENT", entity_id: "2025:ana@example.org" })
    );
  });

  it("re-run skips donors already sent and only retries the rest", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    db.audits.push({
      id: "audit_prior",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "DONOR_CERTIFICATE_SENT",
      entity_type: "donor_certificate",
      entity_id: "2025:ana@example.org",
      summary: "prior send",
      created_at: "2026-07-01T00:00:00.000Z"
    });
    const sent: unknown[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message);
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    // Ana already sent (skipped), Sin Correo has no email (skipped), nothing left to send.
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 0, skipped: 2, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("forbids send for non-admin roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(403);
  });

  it("attaches a complete dossier: summary page plus every accepted DTE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    const sent: Array<{ attachments?: Array<{ content: Uint8Array }> }> = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message as { attachments?: Array<{ content: Uint8Array }> });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    const pdfBytes = sent[0]?.attachments?.[0]?.content;
    expect(pdfBytes).toBeDefined();
    // Ana has 2 accepted donations → 1 summary page + 2 DTE pages.
    const dir = mkdtempSync(join(tmpdir(), "diezmos-dossier-send-"));
    const pdfPath = join(dir, "dossier.pdf");
    writeFileSync(pdfPath, pdfBytes!);
    const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    expect(Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? 0)).toBe(3);
  });

  it("sends only the named donor when the request body identifies one, ignoring the sent-dedupe", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    // A prior send would normally dedupe Ana away — an explicit single send must resend.
    db.audits.push({
      id: "audit_prior",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "DONOR_CERTIFICATE_SENT",
      entity_type: "donor_certificate",
      entity_id: "2025:ana@example.org",
      summary: "prior send",
      created_at: "2026-07-01T00:00:00.000Z"
    });
    const sent: Array<{ to: string }> = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "ana@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message as { to: string });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 1, skipped: 0, failed: 0 });
    expect(sent.map((message) => message.to)).toEqual(["ana@example.org"]);
    // Audited as a single send.
    expect(db.audits).toContainEqual(
      expect.objectContaining({
        action: "DONOR_CERTIFICATE_SENT",
        entity_id: "2025:ana@example.org",
        metadata_json: expect.stringContaining("\"mode\":\"single\"")
      })
    );
  });

  it("returns 404 with a Spanish message when the named donor is not in the year's aggregation", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "nadie@example.org" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/no (se encontró|tiene)/i);
  });

  it("returns 400 with a Spanish message when the named donor has no email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "Sin Correo" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/correo/i);
  });
});

describe("advanced CDE generation", () => {
  it.each([
    ["production", "/api/test/dte"],
    ["production", "/api/test/dte/advanced-template"],
    ["production", "/api/test/dte/advanced"],
    ["preview", "/api/test/dte"],
    ["preview", "/api/test/dte/advanced-template"],
    ["preview", "/api/test/dte/advanced"]
  ])("blocks direct generation in %s at %s before creating or queueing a DTE", async (appEnv, path) => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request(`https://example.org${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db, { APP_ENV: appEnv, ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "test_generation_disabled_in_production" });
    expect(db.documents).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("locks emission settings to the deployment's allowed ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const request = (method: "GET" | "PUT", environment?: "00" | "01") =>
      new Request("https://example.org/api/settings/emission-environment", {
        method,
        headers: { Authorization: "Bearer test-token", ...(environment ? { "Content-Type": "application/json" } : {}) },
        body: environment ? JSON.stringify({ environment }) : undefined
      });

    const state = await worker.fetch(request("GET"), env(db, { APP_ENV: "staging" }));
    const stagingRejected = await worker.fetch(request("PUT", "01"), env(db, { APP_ENV: "staging" }));
    const productionRejected = await worker.fetch(request("PUT", "00"), env(db, { APP_ENV: "production" }));

    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toEqual({
      emissionEnvironment: {
        environment: "00",
        source: "deployment_default",
        appEnv: "staging",
        locked: true,
        allowedEnvironments: ["00"]
      }
    });
    expect(stagingRejected.status).toBe(409);
    expect(productionRejected.status).toBe(409);
    expect(db.settings.find((row) => row.key === "emission_environment")).toBeUndefined();
    expect(db.audits.find((row) => row.action === "EMISSION_ENVIRONMENT_UPDATED")).toBeUndefined();
  });

  it("creates a staging quick DTE in 00 despite a stale incompatible setting", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const settingsResponse = await worker.fetch(
      new Request("https://example.org/api/settings/emission-environment", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "01" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(settingsResponse.status).toBe(409);
    db.settings.push({ key: "emission_environment", value: "01", updated_by: "legacy", updated_at: "2026-07-01T00:00:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "1.00",
          donorName: "Example Person",
          donorDocument: "100000001",
          donorEmail: "donor@example.org",
          donorPhone: "70000005"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({ ambiente: "00", tipoDte: "15" });
    expect(generated.receptor.nombre).toBe("Example Person");
    expect(generated.otrosDocumentos[0]).toMatchObject({
      descDocumento: "Generación directa",
      detalleDocumento: "Donación offline"
    });
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 100,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("records smoke provenance only for a valid staging admin run ID", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const create = async (appEnv: string, smokeRunId: string) => {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      const response = await worker.fetch(
        new Request("https://example.org/api/test/dte", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: "1.00",
            donorName: "Staging Smoke",
            donorDocument: "100000001",
            donorEmail: "smoke@example.org",
            donorPhone: "70000005",
            smokeRunId
          })
        }),
        env(db, {
          APP_ENV: appEnv,
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
        })
      );
      return { db, response };
    };

    const staging = await create("staging", runId);
    expect(staging.response.status).toBe(202);
    expect(staging.db.audits).toContainEqual(expect.objectContaining({
      action: "STAGING_SMOKE_RUN",
      entity_type: "dte_document",
      entity_id: staging.db.documents[0].id,
      metadata_json: JSON.stringify({
        runId,
        path: "admin",
        source: "staging-smoke"
      })
    }));

    const invalid = await create("staging", "not-a-uuid");
    expect(invalid.response.status).toBe(202);
    expect(invalid.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);

    const local = await create("local", runId);
    expect(local.response.status).toBe(202);
    expect(local.db.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);
  });

  it("accepts a quick DTE donor document type outside DUI and NIT", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "offline@example.org"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.receptor).toMatchObject({
      tipoDocumento: "37",
      numDocumento: "RECIBO-123",
      nombre: "Donante Offline"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("rejects malformed donor email on quick DTE creation", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "correo-invalido"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_donor_email", message: "Ingrese un correo válido" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toEqual([]);
  });

  it("opens the advanced template with a default amount when quick amount is blank", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "Example Person", donorDocumentType: "03", donorDocument: "A1234567" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string }; resumen: { valorTotal: number } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "03", numDocumento: "A1234567" });
    expect(body.draft.resumen.valorTotal).toBe(1);
  });

  it("opens the advanced template with empty donor fields so the wizard can collect them", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string; nombre: string } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "13", numDocumento: "", nombre: "" });
  });

  it("stores a schema-valid advanced CDE draft and queues it for transmission", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: advancedCdeDraft() })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000001",
      tipoOperacion: 1,
      tipoMoneda: "USD"
    });
    expect(generated.identificacion.codigoGeneracion).toMatch(/^[A-F0-9-]{36}$/);
    expect(generated.receptor.nombre).toBe("Example Person Advanced");
    expect(generated.cuerpoDocumento[0].descripcion).toBe("Diezmo avanzado");
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "advanced@example.org",
      donor_name: "Example Person Advanced",
      amount_cents: 12345,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_CREATED", entity_type: "dte_document" }));
  });

  it("rejects an advanced CDE draft that does not match the CDE schema", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: { receptor: { nombre: "Sin estructura" } } })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects final generation of a template draft whose receptor was left empty", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const baseEnv = {
      APP_ENV: "staging",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
    };

    const templateResponse = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, baseEnv)
    );
    expect(templateResponse.status).toBe(200);
    const { draft: emptyReceptorDraft } = (await templateResponse.json()) as { draft: Record<string, unknown> };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: emptyReceptorDraft })
      }),
      env(db, baseEnv)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects an advanced CDE draft with an invalid DUI check digit", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const draft = advancedCdeDraft();
    (draft.receptor as Record<string, unknown>).tipoDocumento = "13";
    (draft.receptor as Record<string, unknown>).numDocumento = "00000000-9";

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_advanced_cde",
      message: expect.stringContaining("DUI")
    });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("Wompi webhook integration", () => {
  it("accepts a signed official Wompi webhook and queues approved payments", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_doc_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      },
      enlacePago: {
        IdentificadorEnlaceComercio: "DONACION-123"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, inserted: true, queued: true });
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0]).toMatchObject({
      transaction_id: "wompi_doc_tx_1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donor@example.org",
      donor_name: "Example Person"
    });
    expect(queued).toEqual([{
      wompiEventId: db.wompiEvents[0].id,
      issuanceAttemptId: expect.any(String)
    }]);
  });

  it("stores but quarantines a signed webhook whose ambiente is incompatible with the deployment", async () => {
    const db = new InMemoryD1();
    // Owner has the app set to PRODUCTION emission, but a TEST-mode payment arrives.
    db.settings.push({ key: "emission_environment", value: "01" });
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_mismatch",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        APP_ENV: "production",
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.clone().json()).resolves.toMatchObject({ queued: false });
    expect(db.wompiEvents[0]).toMatchObject({ transaction_id: "wompi_env_tx_mismatch", environment: "00" });
    const mismatch = db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH");
    expect(mismatch).toMatchObject({ entity_type: "wompi_event", entity_id: db.wompiEvents[0].id });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { payloadEnvironment: string; activeEnvironment: string };
    expect(metadata).toMatchObject({ payloadEnvironment: "00", activeEnvironment: "01" });
    expect(queued).toEqual([]);
  });

  it("rejects a manually injected incompatible Wompi queue event before any issuance side effect", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push({
      id: "wompi_injected_prod",
      transaction_id: "wompi_injected_prod_tx",
      environment: "01",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify({
        IdCuenta: "acct_1",
        FechaTransaccion: "2026-07-09T12:00:00-06:00",
        Monto: "25.00",
        IdTransaccion: "wompi_injected_prod_tx",
        ResultadoTransaccion: "ExitosaAprobada",
        EsProductiva: true
      }),
      headers_json: "{}",
      received_at: "2026-07-09T18:00:00.000Z",
      processed_at: null,
      created_document_id: null
    });

    const error = await new IssuancePipeline(env(db, { APP_ENV: "staging" }))
      .processWompiEvent("wompi_injected_prod")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentNotAllowedError);
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.wompiEvents[0].processed_at).toBeNull();
  });

  it("does not audit a mismatch when the signed payload agrees with the active emission setting", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "emission_environment", value: "00" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_agree",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents[0]).toMatchObject({ environment: "00" });
    expect(db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH")).toBeUndefined();
  });

  it("normalizes the stored raw Wompi body before generating the queued CDE", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_pipeline_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const body = await response.json() as { wompiEventId: string };
    const certificateXml = await generatedCertificateXml("cert-password");

    const record = await new IssuancePipeline(env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify({ ...emisorConfig(), defaultDonationType: 1 }),
      MH_CERT_XML: certificateXml,
      MH_CERT_PASSWORD: "cert-password"
    })).processWompiEvent(body.wompiEventId);

    expect(record).toMatchObject({
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 2500,
      status: "ACCEPTED"
    });
    const cde = JSON.parse(record!.plain_json) as { receptor: { nombre: string; correo: string; telefono: string } };
    expect(cde.receptor).toMatchObject({
      nombre: "Example Person",
      correo: "donor@example.org",
      telefono: "70000005"
    });
  });

  it("returns a clear 400 for signed webhook payloads Wompi cannot map to a transaction", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "25.00",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_wompi_payload",
      message: expect.stringContaining("IdTransaccion")
    });
    expect(db.wompiEvents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("does not mark paid_at from an IdExterno-only app identifier", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_paidmark",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_paid_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_paidmark"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.paid_at ?? null).toBeNull();
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.status).toBe("LINK_CREATED");
  });

  it("marks paid_at only from an exact canonical commerce id and numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_enlacepaid",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_enlace_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_enlacepaid" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_enlacepaid")?.paid_at).toBeTruthy();
  });

  it("does not mark paid_at when the canonical commerce id lacks the numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_missing_link",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_missing_link_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "di_missing_link" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents[0].paid_at ?? null).toBeNull();
  });

  it("does not change paid_at on a replayed webhook for an already-paid intent", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_replay",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: "2026-07-04T12:30:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_replay_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_replay",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_replay" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    // markIntentPaid is idempotent (WHERE paid_at IS NULL): the first stamp stands.
    expect(db.donationIntents.find((row) => row.id === "di_replay")?.paid_at).toBe("2026-07-04T12:30:00.000Z");
  });

  it("leaves non-intent (legacy static-link) webhooks unaffected — no intent, no error", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_legacy_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "DONACION-123" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    // Still processed and queued; nothing to mark paid, no crash.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true, queued: true });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("never lets a paid-marker failure (unknown di_ intent) break webhook processing", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    // A di_ id that has no matching intent row — the marker must no-op, not 500.
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_orphan_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_does_not_exist"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true });
    expect(db.wompiEvents).toHaveLength(1);
  });

  it("does not mark paid_at for a declined di_ webhook", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_declined",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_declined_tx_1",
      ResultadoTransaccion: "Rechazada",
      EsProductiva: false,
      IdExterno: "di_declined"
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_declined")?.paid_at ?? null).toBeNull();
  });
});

describe("donation intent correlation", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_corr_1",
      status: "LINK_CREATED",
      amount_cents: 2500,
      // Name/email are no longer captured on the form; the intent stores null and the
      // correlated CDE lifts nombre/correo from the webhook.
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: INTENT_ADDRESS.departamento,
      direccion_municipio: INTENT_ADDRESS.municipio,
      direccion_distrito: INTENT_ADDRESS.distrito,
      direccion_complemento: INTENT_ADDRESS.complemento,
      donor_pais: null,
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-06-26T01:00:00.000Z",
      updated_at: "2026-06-26T01:00:00.000Z",
      expires_at: "2026-06-26T02:00:00.000Z",
      ...overrides
    };
    db.donationIntents.push(intent);
    return intent;
  }

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_corr_evt"): string {
    db.wompiEvents.push({
      id,
      transaction_id: String(webhook.IdTransaccion),
      environment: "00",
      result: String(webhook.ResultadoTransaccion),
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify(webhook),
      headers_json: "{}",
      received_at: "2026-06-26T01:46:47.015Z",
      processed_at: null,
      created_document_id: null
    });
    return id;
  }

  function correlationWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_corr_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_corr_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" },
      // Fallback donor data that MUST be overridden by the intent when correlated.
      // Non-DUI document so the uncorrelated fallback CDE still validates.
      cliente: {
        DocumentoIdentidad: "P-A123456",
        Nombre: "Fallback",
        Apellidos: "Cliente",
        EMail: "fallback@example.org",
        Celular: "70000003",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  async function pipelineEnv(db: InMemoryD1): Promise<Env> {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password"
    });
  }

  async function expectQuarantined(
    db: InMemoryD1,
    eventId: string,
    runtime: Env,
    reason: string
  ): Promise<void> {
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;
    const result = await new IssuancePipeline(runtime).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeTruthy();
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      issuance_status: "FAILED",
      issuance_attempt_count: 1,
      issuance_error_code: "WOMPI_INTENT_QUARANTINED",
      issuance_error_message: expect.stringContaining("intención")
    });
    const audits = db.audits.filter(
      (row) =>
        row.action === "DONATION_INTENT_BINDING_REJECTED" &&
        row.entity_id === eventId
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0].metadata_json))).toMatchObject({ reason });

    await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(1);
    expect(db.documents).toHaveLength(0);
  }

  it("records one webhook smoke provenance marker only for a valid signed staging identity", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const staging = new InMemoryD1();
    seedIntentRow(staging);
    const stagingEventId = seedWompiEvent(
      staging,
      correlationWebhook({ IdTransaccion: `SMOKE-WEBHOOK-${runId}` })
    );
    const stagingRuntime = { ...(await pipelineEnv(staging)), APP_ENV: "staging" };

    const document = await new IssuancePipeline(stagingRuntime).processWompiEvent(stagingEventId);
    await new IssuancePipeline(stagingRuntime).processWompiEvent(stagingEventId);

    expect(document).not.toBeNull();
    expect(staging.audits.filter((audit) => audit.action === "STAGING_SMOKE_RUN")).toEqual([
      expect.objectContaining({
        entity_type: "dte_document",
        entity_id: document!.id,
        metadata_json: JSON.stringify({
          runId,
          path: "webhook",
          source: "staging-smoke"
        })
      })
    ]);

    const invalid = new InMemoryD1();
    seedIntentRow(invalid);
    const invalidEventId = seedWompiEvent(
      invalid,
      correlationWebhook({ IdTransaccion: "SMOKE-WEBHOOK-not-a-uuid" })
    );
    await new IssuancePipeline({ ...(await pipelineEnv(invalid)), APP_ENV: "staging" })
      .processWompiEvent(invalidEventId);
    expect(invalid.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);

    const local = new InMemoryD1();
    seedIntentRow(local);
    const localEventId = seedWompiEvent(
      local,
      correlationWebhook({ IdTransaccion: `SMOKE-WEBHOOK-${runId}` })
    );
    await new IssuancePipeline(await pipelineEnv(local)).processWompiEvent(localEventId);
    expect(local.audits.some((audit) => audit.action === "STAGING_SMOKE_RUN")).toBe(false);
  });

  it("marks a non-approved Wompi event as ignored", async () => {
    const db = new InMemoryD1();
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_not_approved_tx",
      ResultadoTransaccion: "Fallida"
    });
    const eventId = seedWompiEvent(db, webhook, "wompi_not_approved");

    const result = await new IssuancePipeline(env(db)).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      issuance_status: "IGNORED",
      issuance_attempt_count: 0,
      processed_at: expect.any(String)
    });
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
  });

  it("correlates a LINK_CREATED intent: identity + address from the intent, nombre/correo from the webhook", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // Merge: tipoDocumento/numDocumento/direccion from the intent (canonical DUI +
    // catalog-coded address), nombre/correo from the webhook (the donor typed them on
    // Wompi's sheet — the intent no longer carries them), telefono from the intent phone.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nombre: "Fallback Cliente",
      correo: "fallback@example.org",
      telefono: "70001111",
      direccion: INTENT_ADDRESS
    });
    // Natural-person flow unchanged: donor_name/donor_email track the emitted receptor,
    // which for a person is the webhook cardholder name and correo.
    expect(record?.donor_name).toBe("Fallback Cliente");
    expect(record?.donor_email).toBe("fallback@example.org");
    // The intent is closed and points at the CDE that fulfilled it.
    const intent = db.donationIntents.find((row) => row.id === "di_corr_1");
    expect(intent?.status).toBe("COMPLETED");
    expect(intent?.document_id).toBe(record!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_corr_1" })
    );
  });

  it("lets only one concurrent delivery issue a successful Wompi event", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook({ IdTransaccion: "wompi_concurrent_success" }));
    let claimAttempts = 0;
    let releaseClaims!: () => void;
    const bothClaimsReached = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    db.beforeWompiIssuanceClaim = async () => {
      claimAttempts += 1;
      if (claimAttempts === 2) releaseClaims();
      await bothClaimsReached;
    };
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte");
    const runtime = await pipelineEnv(db);
    const sequenceBefore = db.nextSequence;

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("retries accepted Wompi bookkeeping and finalizes it without retransmitting", async () => {
    const db = new InMemoryD1();
    const intent = seedIntentRow(db);
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_post_acceptance_retry_tx"
    });
    const eventId = seedWompiEvent(db, webhook, "wompi_post_acceptance_retry");
    const codigoGeneracion = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const numeroControl = "DTE-15-M001P004-000000000000031";
    const plainDocument = buildCdeDocument(webhook as unknown as WompiWebhook, emisorConfig(), {
      sequence: 31,
      codigoGeneracion,
      environment: "00",
      issuedAt: new Date("2026-07-13T11:00:00-06:00")
    });
    db.documents.push(testDocument({
      id: "dte_post_acceptance_retry",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: numeroControl,
      status: "SIGNED",
      plain_json: JSON.stringify(plainDocument),
      signed_jws: "stored-signed-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null,
      donor_email: "fallback@example.org",
      post_accept_finalized_at: null
    }));
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-POST-ACCEPTANCE",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const realPrepare = db.prepare.bind(db);
    let failAcceptedAudit = true;
    let failIntentLookup = true;
    let intentCompletedBeforeReceipt = false;
    db.prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (sql.includes("INSERT INTO audit_logs") && failAcceptedAudit) {
        failAcceptedAudit = false;
        statement.run = async () => {
          throw new Error("transient accepted-audit failure");
        };
      }
      if (sql.includes("SELECT * FROM donation_intents WHERE id = ?")) {
        const first = statement.first.bind(statement);
        statement.first = async <T>() => {
          if (failIntentLookup) {
            failIntentLookup = false;
            throw new Error("transient intent-correlation failure");
          }
          return first<T>();
        };
      }
      if (sql.includes("INSERT INTO email_deliveries")) {
        const run = statement.run.bind(statement);
        const first = statement.first.bind(statement);
        statement.run = async () => {
          intentCompletedBeforeReceipt = intent.status === "COMPLETED";
          return run();
        };
        statement.first = async <T>() => {
          intentCompletedBeforeReceipt = intent.status === "COMPLETED";
          return first<T>();
        };
      }
      return statement;
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = await pipelineEnv(db);
    const queueBatch = () => {
      const ack = vi.fn();
      const retry = vi.fn();
      const batch = {
        queue: "diezmossv-staging-issuance-example",
        messages: [{
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body: { wompiEventId: eventId },
          attempts: 1,
          ack,
          retry
        }],
        ackAll: vi.fn(),
        retryAll: vi.fn()
      } as unknown as MessageBatch<IssuanceMessage>;
      return { batch, ack, retry };
    };

    const first = queueBatch();
    await worker.queue(first.batch, runtime);

    expect(first.ack).not.toHaveBeenCalled();
    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-POST-ACCEPTANCE"
    });
    expect(intent.status).toBe("LINK_CREATED");
    expect(db.emailDeliveries).toHaveLength(0);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(0);
    expect(transmit).toHaveBeenCalledTimes(1);

    const second = queueBatch();
    await worker.queue(second.batch, runtime);

    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
    expect(intent).toMatchObject({
      status: "COMPLETED",
      document_id: "dte_post_acceptance_retry"
    });
    expect(intentCompletedBeforeReceipt).toBe(true);
    expect(db.emailDeliveries.filter((row) => row.status === "SENT")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);

    const third = queueBatch();
    await worker.queue(third.batch, runtime);

    expect(third.ack).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries.filter((row) => row.status === "SENT")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it("finalizes concurrent deliveries of one accepted Wompi CDE exactly once", async () => {
    const db = new InMemoryD1();
    const intent = seedIntentRow(db);
    const webhook = correlationWebhook({
      IdTransaccion: "wompi_concurrent_finalization_tx"
    });
    const eventId = seedWompiEvent(
      db,
      webhook,
      "wompi_concurrent_finalization"
    );
    const codigoGeneracion = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const plainDocument = buildCdeDocument(
      webhook as unknown as WompiWebhook,
      emisorConfig(),
      {
        sequence: 32,
        codigoGeneracion,
        environment: "00",
        issuedAt: new Date("2026-07-13T11:30:00-06:00")
      }
    );
    db.documents.push(testDocument({
      id: "dte_concurrent_finalization",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000032",
      status: "ACCEPTED",
      plain_json: JSON.stringify(plainDocument),
      signed_jws: "stored-concurrent-signed-jws",
      sello_recibido: "SELLO-CONCURRENT-FINALIZATION",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T17:30:05.000Z",
      donor_email: "fallback@example.org",
      post_accept_finalized_at: null
    }));

    const pairBarrier = () => {
      let arrivals = 0;
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      return async () => {
        arrivals += 1;
        if (arrivals === 2) {
          release();
        }
        await bothArrived;
      };
    };
    const acceptedAuditCount = pairBarrier();
    const completedAuditCount = pairBarrier();
    db.beforeAuditCount = async (action, entityId) => {
      if (action === "DTE_ACCEPTED" && entityId === "dte_concurrent_finalization") {
        await acceptedAuditCount();
      }
      if (action === "DONATION_INTENT_COMPLETED" && entityId === "di_corr_1") {
        await completedAuditCount();
      }
    };

    const sent: unknown[] = [];
    const intentCompletedAtSend: boolean[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          intentCompletedAtSend.push(intent.status === "COMPLETED");
          sent.push(message);
          return { messageId: `concurrent-receipt-${sent.length}` };
        }
      } as SendEmail
    });
    const transmit = vi
      .spyOn(MhClient.prototype, "transmitDte")
      .mockRejectedValue(new Error("an accepted CDE must not be retransmitted"));

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results.map((record) => record?.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(transmit).not.toHaveBeenCalled();
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-FINALIZATION"
    });
    expect(intent).toMatchObject({
      status: "COMPLETED",
      document_id: "dte_concurrent_finalization"
    });
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED")).toHaveLength(1);
    expect(
      db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")
    ).toHaveLength(1);
    expect(
      db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")
    ).toHaveLength(1);
    expect(intentCompletedAtSend).toEqual([true]);
    expect(sent).toHaveLength(1);
    expect(db.emailDeliveries).toHaveLength(1);
    const providerDeliveryId = `sha256:${await sha256Hex(utf8Bytes("concurrent-receipt-1"))}`;
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "dte_concurrent_finalization",
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      provider_delivery_id: providerDeliveryId
    });
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("SELECT COUNT(*) AS count FROM audit_logs")
      )
    ).toBe(false);
    expect(
      db.preparedSql.some(
        (sql) =>
          sql.includes("INSERT INTO email_deliveries") &&
          sql.includes("WHERE NOT EXISTS")
      )
    ).toBe(true);
  });

  it("keeps the payload-derived codPais/codDomiciliado for a domestic intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // No donor_pais on the intent → the existing payload-based behavior is untouched.
    expect(cde.receptor).toMatchObject({ codPais: "SV", codDomiciliado: 1 });
  });

  it("threads the intent gift type into the CDE apéndice on normal issuance (descripcion stays DONACIÓN)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as {
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
  });

  it("omits the TipoAportacion apéndice for an intent with no gift type", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // gift_type undefined → treated as null
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { apendice: Array<Record<string, unknown>> };
    expect(cde.apendice.find((entry) => entry.campo === "TipoAportacion")).toBeUndefined();
  });

  it("uses the intent razón social as the receptor nombre for a NIT intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      donor_document_type: "36",
      donor_document: "0614-280390-112-1",
      donor_name: "Empresa Ejemplo, S.A. de C.V."
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // The comprobante must carry the empresa's razón social, not the cardholder
    // name from the Wompi webhook. Correo still comes from the webhook.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "36",
      numDocumento: "0614-280390-112-1",
      nombre: "Empresa Ejemplo, S.A. de C.V.",
      correo: "fallback@example.org"
    });
    // Persisted metadata must match the signed document: donor_name is the razón social
    // (the emitted receptor nombre), NOT the Wompi cardholder name, and donor_email is
    // the emitted receptor correo.
    expect(record?.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
    expect(record?.donor_email).toBe("fallback@example.org");
  });

  it("marks a foreign intent's receptor non-domiciled with the intent país and a null direccion", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      direccion_departamento: "00",
      direccion_municipio: "00",
      direccion_distrito: "00",
      direccion_complemento: "742 Evergreen Terrace, Springfield",
      donor_pais: "US"
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // MH rejects ANY direccion object for a non-domiciled receptor (00/00/00 AND a
    // valid SV geography both fail codigoMsg 096, verified live): direccion is null,
    // the país rides in codPais, and the foreign address stays on the intent record.
    expect(cde.receptor).toMatchObject({ codPais: "US", codDomiciliado: 2, direccion: null });
  });

  it("falls back to the webhook Celular when the intent has no phone", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { donor_phone: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // telefono = intent.donor_phone ?? webhook Celular; identity/address stay from the intent.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", telefono: "70000003", direccion: INTENT_ADDRESS });
  });

  it("correlates an EXPIRED intent (donor paid in the link's last minute)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "EXPIRED" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // numDocumento/direccion still come from the intent; nombre/correo from the webhook.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", nombre: "Fallback Cliente", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
  });

  it("quarantines a COMPLETED application intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "COMPLETED", document_id: "dte_prev" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    await expectQuarantined(db, eventId, await pipelineEnv(db), "ineligible_status");

    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.document_id).toBe("dte_prev");
  });

  it("audits an amount mismatch and uses the webhook amount, still correlating", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { amount_cents: 2500 });
    // Webhook amount ($30) differs from the intent amount ($25): money truth is Wompi.
    const eventId = seedWompiEvent(db, correlationWebhook({ Monto: "30.00" }));

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.amount_cents).toBe(3000);
    const cde = JSON.parse(record!.plain_json) as { resumen: { valorTotal: number }; receptor: Record<string, unknown> };
    expect(cde.resumen.valorTotal).toBe(30);
    // Still correlated to the intent despite the mismatch: numDocumento/direccion prove it.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    const mismatch = db.audits.find((row) => row.action === "DONATION_INTENT_AMOUNT_MISMATCH");
    expect(mismatch).toBeTruthy();
    expect(mismatch).toMatchObject({ entity_type: "donation_intent", entity_id: "di_corr_1" });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { intentAmountCents: number; eventAmountCents: number };
    expect(metadata).toMatchObject({ intentAmountCents: 2500, eventAmountCents: 3000 });
  });

  it("leaves legacy payloads (no intent id) unchanged: fallback receptor, no intent lookup", async () => {
    const db = new InMemoryD1();
    // A static-link payload whose IdentificadorEnlaceComercio is not a "di_" intent id.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      enlacePago: { Id: 123, IdentificadorEnlaceComercio: "DONACION-legacy" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("quarantines when the webhook link id does not match the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // wompi_id_enlace: 987654
    // A donor-influenced IdExterno points at di_corr_1, but the payment was made on a
    // DIFFERENT Wompi link than the one minted for that intent.
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 111111, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    await expectQuarantined(db, eventId, await pipelineEnv(db), "link_id_mismatch");

    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("creates one binding-rejected audit when two pipelines quarantine the same event concurrently", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    let countArrivals = 0;
    let releaseCounts!: () => void;
    const bothCountsReached = new Promise<void>((resolve) => {
      releaseCounts = resolve;
    });
    db.beforeBindingAuditCount = async () => {
      countArrivals += 1;
      if (countArrivals === 2) {
        releaseCounts();
      }
      await bothCountsReached;
    };
    const runtime = await pipelineEnv(db);
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    const results = await Promise.all([
      new IssuancePipeline(runtime).processWompiEvent(eventId),
      new IssuancePipeline(runtime).processWompiEvent(eventId)
    ]);

    expect(results).toEqual([null, null]);
    const audits = db.audits.filter(
      (row) =>
        row.action === "DONATION_INTENT_BINDING_REJECTED" &&
        row.entity_id === eventId
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0].metadata_json))).toMatchObject({
      intentId: "di_corr_1",
      reason: "link_id_mismatch",
      expectedLinkId: 987654,
      payloadLinkId: 111111
    });
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeTruthy();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("SELECT COUNT(*) AS count FROM audit_logs")
      )
    ).toBe(false);
    expect(
      db.preparedSql.some((sql) =>
        sql.includes("UPDATE dte_documents SET signed_jws")
      )
    ).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("does not add a binding-rejected audit to an already processed application event", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    const event = db.wompiEvents.find((row) => row.id === eventId)!;
    event.processed_at = "2026-07-13T10:00:00.000Z";
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    await expect(
      new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId)
    ).resolves.toBeNull();

    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(0);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBe("2026-07-13T10:00:00.000Z");
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rolls back the binding audit when the quarantine batch fails before processed marking", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    db.failBindingQuarantineBatchAfterStatement = 1;
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    await expect(
      new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId)
    ).rejects.toThrow("injected binding-quarantine batch failure");

    expect(
      db.audits.filter(
        (row) =>
          row.action === "DONATION_INTENT_BINDING_REJECTED" &&
          row.entity_id === eventId
      )
    ).toHaveLength(0);
    expect(
      db.wompiEvents.find((row) => row.id === eventId)?.processed_at
    ).toBeNull();
    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(0);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("correlates when the webhook link id matches the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
    expect(db.audits.find((row) => row.action === "DONATION_INTENT_BINDING_REJECTED")).toBeUndefined();
  });

  it("quarantines a draft intent whose donor document is missing", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { donor_document: null, direccion_departamento: null, direccion_municipio: null, direccion_distrito: null, direccion_complemento: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    await expectQuarantined(db, eventId, await pipelineEnv(db), "incomplete_donor_data");

    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
  });

  it("blocks a rejected-document rebuild when its app binding is quarantined", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({
        EnlacePago: {
          Id: 111111,
          IdentificadorEnlaceComercio: "di_corr_1"
        }
      })
    );
    db.documents.push({
      ...testDocument({
        id: "dte_quarantine_rebuild",
        wompi_event_id: eventId,
        status: "REJECTED",
        signed_jws: null
      })
    });
    const record = db.documents[0];
    const before = { ...record };
    const outbound = vi.spyOn(globalThis, "fetch");
    const sequenceBefore = db.nextSequence;

    await expect(
      new IssuancePipeline(await pipelineEnv(db))
        .rebuildRejectedWompiDocument(record)
    ).rejects.toBeInstanceOf(WompiIntentQuarantinedError);

    expect(db.nextSequence).toBe(sequenceBefore);
    expect(db.documents[0].plain_json).toBe(before.plain_json);
    expect(db.documents[0].signed_jws).toBe(before.signed_jws);
    expect(outbound).not.toHaveBeenCalled();

    db.sessionUser = {
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR"
    };
    const response = await worker.fetch(
      new Request(
        "https://example.org/api/documents/dte_quarantine_rebuild/retry",
        {
          method: "POST",
          headers: { Authorization: "Bearer test-token" }
        }
      ),
      await pipelineEnv(db)
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "document_correction_required"
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("keeps the intent receptor when an operator rebuilds a REJECTED intent-backed CDE", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    // A REJECTED document already exists for this Wompi event (fallback receptor).
    db.documents.push({
      id: "dte_rejected",
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: "11111111-1111-4111-8111-111111111111",
      numero_control: "DTE-15-M001P004-000000000000009",
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      transmission_claim_id: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const record = db.documents.find((row) => row.id === "dte_rejected") as unknown as DteDocumentRecord;
    const result = await new IssuancePipeline(await pipelineEnv(db)).rebuildRejectedWompiDocument(record);

    expect(result.accepted).toBe(true);
    const rebuilt = db.documents.find((row) => row.id === "dte_rejected");
    const cde = JSON.parse(String(rebuilt!.plain_json)) as { receptor: Record<string, unknown> };
    // The rebuild must re-apply the intent's identity + address (not downgrade to the
    // emisor-geography fallback). nombre/correo come from the webhook either way, so
    // numDocumento/direccion are what prove the intent correlation survived the rebuild.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.document_id).toBe("dte_rejected");
  });

  it("threads the gift type into the CDE apéndice when a gift-type intent is rebuilt on the rejected path", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "OFRENDA" });
    const eventId = seedWompiEvent(db, correlationWebhook());
    db.documents.push({
      id: "dte_rejected_gift",
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: "70000003-2222-4222-8222-700000032222",
      numero_control: "DTE-15-M001P004-000000000000019",
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      transmission_claim_id: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const record = db.documents.find((row) => row.id === "dte_rejected_gift") as unknown as DteDocumentRecord;
    await new IssuancePipeline(await pipelineEnv(db)).rebuildRejectedWompiDocument(record);

    const rebuilt = db.documents.find((row) => row.id === "dte_rejected_gift");
    const cde = JSON.parse(String(rebuilt!.plain_json)) as {
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Ofrenda" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
  });

  function seedRejectedDoc(db: InMemoryD1, eventId: string, id: string): DteDocumentRecord {
    const doc = {
      id,
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: `3333${id}-3333-4333-8333-333333333333`.slice(0, 36),
      numero_control: `DTE-15-M001P004-0000000000000${id.length}9`,
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    };
    db.documents.push(doc as unknown as DteDocumentRecord);
    return doc as unknown as DteDocumentRecord;
  }

  it("refuses a concurrent rebuild of an already-claimed REJECTED CDE and transmits only one DTE", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    seedRejectedDoc(db, eventId, "dte_rejected_cas");
    // Both operator retries capture the same REJECTED snapshot and reach the claim
    // together. The loser must stop before allocating a fiscal control sequence.
    const staleSnapshot = { ...db.documents.find((row) => row.id === "dte_rejected_cas") } as unknown as DteDocumentRecord;
    let claims = 0;
    let releaseClaims!: () => void;
    const bothClaimsReached = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    db.beforeRejectedWompiClaim = async () => {
      claims += 1;
      if (claims === 2) releaseClaims();
      await bothClaimsReached;
    };
    const runtime = await pipelineEnv(db);
    const sequenceBefore = db.nextSequence;
    const results = await Promise.allSettled([
      new IssuancePipeline(runtime).rebuildRejectedWompiDocument(staleSnapshot),
      new IssuancePipeline(runtime).rebuildRejectedWompiDocument(staleSnapshot)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.any(RejectedWompiRetryConflictError) })
    ]);
    expect(db.documents.find((row) => row.id === "dte_rejected_cas")?.status).toBe("ACCEPTED");
    expect(db.nextSequence).toBe(sequenceBefore + 1);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED" && row.entity_id === "dte_rejected_cas")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
  });

  it("leaves a REJECTED CDE retryable when the rebuild fails before it can be claimed", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    const record = seedRejectedDoc(db, eventId, "dte_rejected_signfail");
    // Signing throws (no MH_CERT_XML configured) BEFORE the claim UPDATE runs.
    const brokenEnv = env(db, { MOCK_EXTERNAL_SERVICES: "true", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) });

    await expect(new IssuancePipeline(brokenEnv).rebuildRejectedWompiDocument(record)).rejects.toThrow();

    // Not a claim conflict, and the row is untouched: still REJECTED, still carrying its
    // original MH verdict, so the operator can retry once the cause is fixed.
    const doc = db.documents.find((row) => row.id === "dte_rejected_signfail");
    expect(doc?.status).toBe("REJECTED");
    expect(doc?.mh_estado).toBe("RECHAZADO");
  });

  it("treats an invalid donor DUI as terminal: no control sequence, no document, audited", async () => {
    const db = new InMemoryD1();
    // A raw legacy webhook (no intent) whose DocumentoIdentidad looks like a DUI (9
    // digits) but fails the check digit. buildCdeDocument would declare it type 13 and
    // throw AFTER the control sequence is allocated, so a queue retry would burn a
    // control number on every attempt — the guard must reject it BEFORE allocation.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_bad_dui_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const result = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.documents).toHaveLength(0);
    // The sequence counter never advanced — no fiscal gap across queue retries.
    expect(db.nextSequence).toBe(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_INVALID_DONOR_DUI", entity_type: "wompi_event", entity_id: eventId })
    );
    const invalidDuiAudit = db.audits.find(
      (audit) => audit.action === "WOMPI_INVALID_DONOR_DUI" && audit.entity_id === eventId
    );
    expect(invalidDuiAudit?.summary).toBe("Los datos del donante contienen un DUI inválido.");
    expect(invalidDuiAudit?.summary).not.toContain("12345678-9");
    expect(db.wompiEvents.find((event) => event.id === eventId)).toMatchObject({
      processed_at: expect.any(String),
      issuance_status: "FAILED",
      issuance_attempt_count: 1,
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: expect.stringContaining("DUI")
    });
    expect(db.wompiEvents.find((event) => event.id === eventId)?.issuance_error_message)
      .not.toContain("12345678-9");
  });

  it("rejects deterministic CDE schema failures before allocating a control sequence", async () => {
    const db = new InMemoryD1();
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_oversized_email_tx",
      cliente: {
        DocumentoIdentidad: "",
        Nombre: "Correo",
        Apellidos: "Extenso",
        EMail: `${"a".repeat(90)}@example.org`,
        CodigoPais: "SV"
      }
    });
    const eventId = seedWompiEvent(db, webhook);

    const first = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);
    const second = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.audits.filter((audit) => audit.action === "WOMPI_INVALID_CDE_INPUT")).toHaveLength(1);
    expect(db.wompiEvents.find((event) => event.id === eventId)?.processed_at).toEqual(expect.any(String));
  });

  it("does not requeue an invalid-DUI Wompi event after terminal processing", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      IdTransaccion: "wompi_bad_dui_sweep_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);
    const pipeline = new IssuancePipeline({
      ...(await pipelineEnv(db)),
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await pipeline.processWompiEvent(eventId);
    await pipeline.sweepStalledWompiEvents();

    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId)).toBe(false);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId)).toBe(false);
  });

  it("recovers intent and receipt finalization after post-acceptance auditing fails", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook({ IdTransaccion: "wompi_post_accept_audit_failure" }));
    db.failNextAuditAction = "DTE_ACCEPTED";
    const runtime = await pipelineEnv(db);

    await expect(new IssuancePipeline(runtime).processWompiEvent(eventId)).rejects.toThrow("injected DTE_ACCEPTED audit failure");

    expect(db.documents).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.documents[0].sello_recibido).toBeTruthy();
    expect(db.documents[0].post_accept_finalized_at ?? null).toBeNull();
    expect(db.donationIntents[0]).toMatchObject({ status: "COMPLETED", document_id: db.documents[0].id });
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.some((audit) => audit.action === "DTE_FAILED")).toBe(false);
    expect(await new Repository(runtime.DB).claimDocumentInvalidation(db.documents[0].id, "must_not_claim_before_finalization")).toBe(false);

    const recovery = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(recovery).toEqual({ finalized: 1, failed: 0 });
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "DTE_ACCEPTED")).toHaveLength(1);
  });

  it("lets only one concurrent post-accept finalizer send the definitive receipt", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    let claimAttempts = 0;
    let releaseClaims!: () => void;
    const bothClaimed = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    db.beforePostAcceptFinalizationClaim = async () => {
      claimAttempts += 1;
      if (claimAttempts === 2) releaseClaims();
      await bothClaimed;
    };
    const runtime = await pipelineEnv(db);

    const results = await Promise.all([
      new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations(),
      new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations()
    ]);

    expect(results.reduce((total, result) => total + result.finalized, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.emailDeliveries.filter((delivery) => delivery.status === "SENT" && delivery.email_type === "dteReceipt")).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
  });

  it("reloads a donor-email correction that commits immediately before finalization ownership", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({
      wompi_event_id: null,
      donor_email: "anterior@example.org",
      post_accept_finalized_at: null
    }));
    db.beforePostAcceptFinalizationClaim = () => {
      db.documents[0].donor_email = "corregido@example.org";
    };
    const runtime = await pipelineEnv(db);

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "corregido@example.org",
      status: "SENT",
      email_type: "dteReceipt"
    }));
  });

  it("sends the definitive accepted receipt even after a manual rejected-document resend", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      wompi_event_id: null,
      status: "REJECTED",
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      accepted_at: null,
      post_accept_finalized_at: null
    }));

    const resend = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ resendRequestId: TEST_RESEND_REQUEST_ID })
      }),
      env(db)
    );
    expect(resend.status).toBe(200);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      email_type: "dteReceipt",
      document_status_at_send: "REJECTED",
      status: "SENT"
    }));

    Object.assign(db.documents[0], {
      status: "ACCEPTED",
      sello_recibido: "ACCEPTED-AFTER-RETRY",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-14T15:00:00.000Z"
    });

    const finalization = await new IssuancePipeline(await pipelineEnv(db)).retryPendingPostAcceptFinalizations();

    expect(finalization).toEqual({ finalized: 1, failed: 0 });
    expect(db.emailDeliveries.filter((delivery) => delivery.email_type === "dteReceipt")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document_status_at_send: "REJECTED", status: "SENT" }),
        expect.objectContaining({ document_status_at_send: "ACCEPTED", status: "SENT" })
      ])
    );
  });

  it("stops before the email provider when finalization ownership is lost at dispatch", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    db.beforePostAcceptEmailDispatchMark = () => {
      db.documents[0].post_accept_finalization_claim_id = "stolen_owner";
    };
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toEqual([
      expect.objectContaining({
        document_id: "doc_1",
        status: "PENDING",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    ]);
    expect(db.documents[0]).toMatchObject({
      post_accept_finalized_at: null,
      post_accept_finalization_claim_id: "stolen_owner"
    });
    expect(db.documents[0].post_accept_email_dispatch_started_at ?? null).toBeNull();
  });

  it("records a retry-safe NOT_SENT outcome when Cloudflare rejects receipt headers before acceptance", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const providerError = Object.assign(
      new Error("custom header 'Idempotency-Key' is not allowed"),
      { code: "E_HEADER_NOT_ALLOWED" }
    );
    const send = vi.fn(async () => {
      throw providerError;
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      provider_dispatch_started_at: expect.any(String),
      outcome_class: "NOT_SENT",
      failure_code: "E_HEADER_NOT_ALLOWED",
      retry_safe: 1
    }));
  });

  it("records an UNKNOWN manual-review outcome for an internal provider error after dispatch starts", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const providerError = Object.assign(
      new Error("internal provider failure"),
      { code: "E_INTERNAL_SERVER_ERROR" }
    );
    const send = vi.fn(async () => {
      throw providerError;
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      provider_dispatch_started_at: expect.any(String),
      outcome_class: "UNKNOWN",
      failure_code: "E_INTERNAL_SERVER_ERROR",
      retry_safe: 0
    }));
  });

  it("sends an operational alert when an accepted receipt delivery fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    const sent: Array<{ to: string; subject: string; text?: string; headers?: Record<string, string> }> = [];
    const send = vi.fn(async (message: unknown) => {
      const outbound = message as (typeof sent)[number];
      sent.push(outbound);
      if (outbound.subject === "Fallo al enviar comprobante") {
        return { messageId: "alert-email-failed" };
      }
      throw new Error("custom header rejected by provider");
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const result = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(result).toEqual({ finalized: 1, failed: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      to: "owner@example.org",
      subject: "Fallo al enviar comprobante",
      text: expect.stringContaining(
        "No se pudo confirmar el resultado del envío con el proveedor."
      )
    });
    expect(sent[1].headers).toBeUndefined();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "EMAIL_FAILED", entity_type: "dte_document", entity_id: "doc_1" })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:EMAIL_FAILED", entity_type: "dte_document", entity_id: "doc_1" })
    );
    const delivery = db.emailDeliveries.find((row) => row.document_id === "doc_1");
    const alertAudit = db.audits.find((row) => row.action === "ALERT_SENT:EMAIL_FAILED");
    expect(JSON.parse(String(alertAudit?.metadata_json))).toEqual({
      incidentId: delivery?.claim_token,
      channel: "email"
    });
  });

  it("recovers finalization after a recorded email failure without redispatching it", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ wompi_event_id: null, post_accept_finalized_at: null }));
    db.failNextAuditAction = "ADVANCED_CDE_ACCEPTED";
    const send = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send } as SendEmail
    });

    const first = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(first).toEqual({ finalized: 0, failed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      status: "FAILED",
      email_type: "dteReceipt"
    }));
    expect(db.documents[0].post_accept_finalization_claim_id ?? null).toBeNull();

    const recovery = await new IssuancePipeline(runtime).retryPendingPostAcceptFinalizations();

    expect(recovery).toEqual({ finalized: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.documents[0].post_accept_finalized_at).toEqual(expect.any(String));
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
  });

});

// Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
// admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
// está EXCLUIDO, así que un CDE nunca se emite en contingencia. Cuando MH no está
// disponible, la emisión queda diferida (status SIGNED + transmission_deferred_at —
// D1 no permite reconstruir tablas padre de FK para ampliar el CHECK de status):
// el donante recibe de inmediato
// el comprobante TRANSITORIO y el cron de 15 minutos reintenta la transmisión.
describe("deferred transmission when MH is unavailable", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_defer_1",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: INTENT_ADDRESS.departamento,
      direccion_municipio: INTENT_ADDRESS.municipio,
      direccion_distrito: INTENT_ADDRESS.distrito,
      direccion_complemento: INTENT_ADDRESS.complemento,
      donor_pais: null,
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      created_at: "2026-06-26T01:00:00.000Z",
      updated_at: "2026-06-26T01:00:00.000Z",
      expires_at: "2026-06-26T02:00:00.000Z",
      ...overrides
    };
    db.donationIntents.push(intent);
    return intent;
  }

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_defer_evt"): string {
    db.wompiEvents.push({
      id,
      transaction_id: String(webhook.IdTransaccion),
      environment: "00",
      result: String(webhook.ResultadoTransaccion),
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify(webhook),
      headers_json: "{}",
      received_at: "2026-06-26T01:46:47.015Z",
      processed_at: null,
      created_document_id: null
    });
    return id;
  }

  function deferWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_defer_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_defer_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_defer_1" },
      cliente: {
        DocumentoIdentidad: "P-A123456",
        Nombre: "Fallback",
        Apellidos: "Cliente",
        EMail: "fallback@example.org",
        Celular: "70000003",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  // URL-routing fetch stub: MH auth always succeeds; recepciondte behaves per test.
  function stubMhFetch(recepcion: () => Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" });
      }
      if (url.includes("recepciondte")) {
        return recepcion();
      }
      throw new Error(`Fetch inesperado en prueba de transmisión diferida: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // Authentication happens before the legal fiscal POST. This is the only outage
  // class that is safe to defer and retry automatically.
  function stubMhAuthUnavailable(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return new Response("MH no disponible", { status: 503 });
      }
      throw new Error(`El endpoint fiscal no debía alcanzarse: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function deferredEnv(db: InMemoryD1, sent: Array<{ subject: string; to: string; text: string }>): Promise<Env> {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { subject: string; to: string; text: string });
          return { messageId: `email-${sent.length}` };
        }
      } as SendEmail
    });
  }

  it("defers a Wompi CDE: SIGNED + deferred marker, normal shape, transitorio email, intent untouched", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processWompiEvent(eventId);

    // Deferred state = SIGNED + transmission_deferred_at (no new status value: D1
    // cannot rebuild dte_documents to widen its CHECK constraint).
    expect(record?.status).toBe("SIGNED");
    expect(record?.transmission_deferred_at).toBeTruthy();
    expect(record?.signed_jws).toBeTruthy();
    // NO contingency: no period row, no attachment — the CDE keeps its NORMAL shape.
    expect(db.contingencies).toHaveLength(0);
    expect(record?.contingency_period_id).toBeNull();
    const cde = JSON.parse(String(record!.plain_json)) as {
      identificacion: Record<string, unknown>;
      receptor: Record<string, unknown>;
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.identificacion.tipoModelo).toBe(1);
    // The intent override and gift type survive the deferral unchanged.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_type: "dte_document", entity_id: record!.id })
    );
    // Immediate transitorio email with distinguishing evidence type.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(sent[0].text).toContain("Sello de Recepción");
    // ...but never claims the deferred CDE already carries an MH reception seal.
    expect(sent[0].text).not.toContain("con sello de recepción del Ministerio de Hacienda");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: record!.id,
        status: "SENT",
        email_type: "dteReceiptTransitorio",
        document_status_at_send: "SIGNED"
      })
    );
    // The intent completes only on REAL MH acceptance — never at deferral.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("defers a quick/advanced queue CDE instead of marking it FAILED", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_quick_defer"));
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_defer");

    expect(record.status).toBe("SIGNED");
    expect(record.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_id: "doc_quick_defer" })
    );
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
  });

  it("does not resend the transitorio email when a queue redelivery re-defers the same document", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_quick_dedupe"), status: "SIGNED", transmission_deferred_at: "2026-06-26T01:49:00.000Z", signed_jws: "already-signed-jws" });
    // The first delivery attempt already sent the transitorio before the crash/redelivery.
    db.emailDeliveries.push({
      id: "email_prev",
      document_id: "doc_quick_dedupe",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: "{}",
      sent_at: "2026-06-26T01:50:00.000Z",
      email_type: "dteReceiptTransitorio",
      document_status_at_send: "SIGNED",
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_dedupe");

    expect(sent).toHaveLength(0);
    expect(db.emailDeliveries.filter((row) => row.document_id === "doc_quick_dedupe")).toHaveLength(1);
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.transmission_deferred_at).toBeTruthy();
  });

  it("rejects deferred issuer drift before an unsigned recovery can sign or call MH", async () => {
    const db = new InMemoryD1();
    const document = advancedCdeDraft();
    (document.emisor as Record<string, unknown>).numDocumento = "06142803901122";
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_issuer_drift",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(document),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      transmission_deferred_at: new Date().toISOString()
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    const mhFetch = stubMhFetch(() => new Response("MH no disponible", { status: 503 }));
    const signSpy = vi.spyOn(crypto.subtle, "sign");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    expect(result).toEqual({ transmitted: 0, rejected: 0, pending: 1 });
    expect(signSpy).not.toHaveBeenCalled();
    expect(mhFetch).not.toHaveBeenCalled();
    expect(db.documents.find((row) => row.id === "doc_deferred_issuer_drift")).toMatchObject({
      status: "SIGNED",
      signed_jws: null
    });
    expect(errorLog).toHaveBeenCalledWith({
      event: "deferred_transmission_retry_failed",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });

  it("defers an operator rejected-doc rebuild when MH is unavailable", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    db.documents.push({
      ...testDocument(),
      id: "doc_rejected_defer",
      wompi_event_id: eventId,
      status: "REJECTED",
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      accepted_at: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhAuthUnavailable();

    const record = db.documents.find((row) => row.id === "doc_rejected_defer") as unknown as DteDocumentRecord;
    const result = await new IssuancePipeline(await deferredEnv(db, sent)).rebuildRejectedWompiDocument(record);

    expect(result.accepted).toBe(false);
    const rebuilt = db.documents.find((row) => row.id === "doc_rejected_defer");
    expect(rebuilt?.status).toBe("SIGNED");
    expect(rebuilt?.transmission_deferred_at).toBeTruthy();
    const cde = JSON.parse(String(rebuilt!.plain_json)) as { identificacion: Record<string, unknown>; receptor: Record<string, unknown> };
    expect(cde.identificacion.tipoModelo).toBe(1);
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).not.toBe("COMPLETED");
  });

  it("retries a deferred CDE on the sweep: acceptance completes the intent and sends the definitive email", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(deferred?.transmission_deferred_at).toBeTruthy();
    expect(sent).toHaveLength(1);

    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-DEFINITIVO", observaciones: [] }));
    const result = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    expect(result).toMatchObject({ transmitted: 1 });
    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("ACCEPTED");
    expect(doc?.sello_recibido).toBe("SELLO-DEFINITIVO");
    // The marker stays as historical "was deferred at" evidence; leaving SIGNED is
    // what removes the doc from the retry sweep.
    expect(doc?.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // Definitive email: normal receipt copy, PDF now carries the real sello.
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).not.toContain("(en trámite)");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: deferred!.id,
        status: "SENT",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    );
    // REAL acceptance completes the correlated intent.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("COMPLETED");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.document_id).toBe(deferred!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_defer_1" })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED_FINALIZED", entity_type: "dte_document", entity_id: deferred!.id })
    );
  });

  it("records a deferred post-accept email timeout once without a second provider or MH send", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook({
      IdTransaccion: "wompi_deferred_finalization_recovery_tx"
    }), "wompi_deferred_finalization_recovery");
    const sent: Array<{
      subject: string;
      to: string;
      text: string;
      headers?: Record<string, string>;
    }> = [];
    const runtime = await deferredEnv(db, sent);
    let definitiveAttempts = 0;
    runtime.EMAIL = {
      send: async (message: unknown) => {
        const outbound = message as (typeof sent)[number];
        sent.push(outbound);
        if (!outbound.subject.includes("(en trámite)")) {
          definitiveAttempts += 1;
          if (definitiveAttempts === 1) {
            throw new Error("provider timeout after accepting the message");
          }
        }
        return { messageId: `deferred-finalization-${sent.length}` };
      }
    } as SendEmail;

    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(runtime).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(sent).toHaveLength(1);

    const mhRecoveryFetch = stubMhFetch(() => jsonResponse({
      estado: "PROCESADO",
      selloRecibido: "SELLO-DEFERRED-FINALIZATION",
      observaciones: []
    }));
    await new IssuancePipeline(runtime).retryDeferredTransmissions();

    expect(db.documents.find((row) => row.id === deferred!.id)?.status).toBe("ACCEPTED");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("COMPLETED");
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    const failedDelivery = db.emailDeliveries.find(
      (row) => row.document_id === deferred!.id && row.email_type === "dteReceipt"
    );
    expect(failedDelivery).toMatchObject({
      status: "FAILED",
      idempotency_key: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/),
      claim_attempted_at: expect.any(String)
    });
    expect(sent[1].headers).toMatchObject({
      "X-Idempotency-Key": failedDelivery!.idempotency_key
    });
    expect(sent[1].headers).not.toHaveProperty("Message-ID");

    const result = await new IssuancePipeline(runtime).retryAcceptedWompiFinalizations();

    expect(result).toEqual({ finalized: 0, pending: 0 });
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED_FINALIZED")).toHaveLength(1);
    expect(db.emailDeliveries.filter(
      (row) => row.document_id === deferred!.id && row.email_type === "dteReceipt"
    )).toHaveLength(1);
    expect(failedDelivery).toMatchObject({
      status: "FAILED",
      idempotency_key: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/),
      provider_delivery_id: null
    });
    expect(sent).toHaveLength(2);
    expect(
      mhRecoveryFetch.mock.calls.filter(([input]) => String(input).includes("recepciondte"))
    ).toHaveLength(1);
  });

  it("does not redispatch a deferred CDE after an ambiguous transport failure", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_ambiguous",
      status: "SIGNED",
      signed_jws: "signed-deferred-ambiguous-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      transmission_deferred_at: "2026-07-14T12:00:00.000Z",
      donor_email: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    const fetchMock = stubMhFetch(() => {
      throw new Error("connection reset after request write");
    });

    const first = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(first).toEqual({ transmitted: 0, rejected: 0, pending: 1 });
    expect(db.documents[0].fiscal_operation_claim_id).toMatch(/^fiscal_/);
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const second = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(second).toEqual({ transmitted: 0, rejected: 0, pending: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("keeps the CDE pending without email or audit spam while MH stays down, alerting once after an hour", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(sent).toHaveLength(1); // transitorio
    // Age the DEFERRAL beyond the one-hour alert threshold (the alert is measured
    // from transmission_deferred_at, not from document creation).
    const doc = db.documents.find((row) => row.id === deferred!.id)!;
    doc.transmission_deferred_at = "2026-06-26T00:00:00.000Z";

    const first = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(first).toMatchObject({ transmitted: 0, pending: 1 });
    expect(db.documents.find((row) => row.id === deferred!.id)?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === deferred!.id)?.transmission_deferred_at).toBeTruthy();
    // One backlog alert (transitorio + alert = 2 sends), deduped on the next tick.
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);

    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);
    // No per-tick audit noise: the deferral audit stays singular, no accepted/rejected audits.
    expect(db.audits.filter((row) => row.action === "DTE_TRANSMISSION_DEFERRED")).toHaveLength(1);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_ACCEPTED" }));
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_REJECTED" }));
  });

  it("marks a deferred CDE REJECTED through the normal rejected path when MH rejects it on retry", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhAuthUnavailable();
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);

    stubMhFetch(() => jsonResponse({ estado: "RECHAZADO", observaciones: ["Firma inválida"] }));
    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("REJECTED");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_REJECTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // No definitive email on rejection; the intent stays open for the operator rebuild.
    expect(sent).toHaveLength(1);
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).not.toBe("COMPLETED");
  });

  it("runs the deferred-transmission retry on the 15-minute cron tick", async () => {
    const db = new InMemoryD1();
    const codigoGeneracion = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const document = buildCdeDocument(
      wompiSample as unknown as WompiWebhook,
      emisorConfig(),
      { sequence: 73, codigoGeneracion, environment: "00" }
    );
    db.documents.push({
      ...testDocument(),
      id: "doc_sched_defer",
      wompi_event_id: null,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000073",
      plain_json: JSON.stringify(document),
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      donor_email: null
    });

    // Mock mode: MH accepts without network. The cron must pick the pending doc up.
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));

    expect(db.documents.find((row) => row.id === "doc_sched_defer")?.status).toBe("ACCEPTED");
  });

  it("finalizes an accepted Wompi CDE missing its completion marker on the 15-minute cron without retransmitting", async () => {
    const db = new InMemoryD1();
    const eventId = seedWompiEvent(db, deferWebhook({
      IdTransaccion: "wompi_scheduled_finalization_tx",
      IdExterno: undefined,
      EnlacePago: undefined
    }), "wompi_scheduled_finalization");
    db.documents.push({
      ...testDocument(),
      id: "doc_scheduled_finalization",
      wompi_event_id: eventId,
      status: "ACCEPTED",
      sello_recibido: "SELLO-SCHEDULED-FINALIZATION",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T18:00:00.000Z",
      donor_email: null,
      post_accept_finalized_at: null
    });
    const transmit = vi
      .spyOn(MhClient.prototype, "transmitDte")
      .mockRejectedValue(new Error("accepted finalization sweep must not call MH"));

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env(db)
    );

    expect(transmit).not.toHaveBeenCalled();
    expect(db.audits.filter(
      (row) => row.action === "DTE_ACCEPTED_FINALIZED" && row.entity_id === "doc_scheduled_finalization"
    )).toHaveLength(1);
    expect(db.audits.filter(
      (row) => row.action === "EMAIL_SKIPPED" && row.entity_id === "doc_scheduled_finalization"
    )).toHaveLength(1);
  });

  it("lists FAILED and REJECTED under the combined Fallos filter while a deferred SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      {
        ...testDocument(),
        id: "doc_failed_list",
        codigo_generacion: "CCCCCCC3-CCCC-4CCC-8CCC-CCCCCCCCCCC3",
        numero_control: "DTE-15-M001P004-000000000000803",
        status: "FAILED",
        created_at: "2026-06-26T01:50:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_rejected_list",
        codigo_generacion: "DDDDDDD4-DDDD-4DDD-8DDD-DDDDDDDDDDD4",
        numero_control: "DTE-15-M001P004-000000000000804",
        status: "REJECTED",
        created_at: "2026-06-26T01:51:00.000Z"
      },
      // A deferred SIGNED doc (En trámite) must NOT leak into Fallos — that exclusion
      // is a deliberate product decision (it is awaiting transmission, not failed).
      {
        ...testDocument(),
        id: "doc_deferred_excluded",
        codigo_generacion: "FFFFFFF6-FFFF-4FFF-8FFF-FFFFFFFFFFF6",
        numero_control: "DTE-15-M001P004-000000000000806",
        status: "SIGNED",
        transmission_deferred_at: "2026-06-26T01:52:00.000Z",
        created_at: "2026-06-26T01:52:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=FAILED,REJECTED", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_rejected_list", "doc_failed_list"]);
  });

  it("lists accepted receipt failures under the server-side attention filter until a later send succeeds", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      {
        ...testDocument(),
        id: "doc_fiscal_failed_attention",
        codigo_generacion: "AAAAAAA1-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
        numero_control: "DTE-15-M001P004-000000000000811",
        status: "FAILED",
        created_at: "2026-07-17T11:01:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_fiscal_rejected_attention",
        codigo_generacion: "BBBBBBB2-BBBB-4BBB-8BBB-BBBBBBBBBBB2",
        numero_control: "DTE-15-M001P004-000000000000812",
        status: "REJECTED",
        created_at: "2026-07-17T11:02:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_failed_attention",
        codigo_generacion: "CCCCCCC3-CCCC-4CCC-8CCC-CCCCCCCCCCC3",
        numero_control: "DTE-15-M001P004-000000000000813",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:03:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_recovered_attention",
        codigo_generacion: "DDDDDDD4-DDDD-4DDD-8DDD-DDDDDDDDDDD4",
        numero_control: "DTE-15-M001P004-000000000000814",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:04:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_receipt_pending_attention",
        codigo_generacion: "EEEEEEE5-EEEE-4EEE-8EEE-EEEEEEEEEEE5",
        numero_control: "DTE-15-M001P004-000000000000815",
        status: "ACCEPTED",
        created_at: "2026-07-17T11:05:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_deferred_attention",
        codigo_generacion: "FFFFFFF6-FFFF-4FFF-8FFF-FFFFFFFFFFF6",
        numero_control: "DTE-15-M001P004-000000000000816",
        status: "SIGNED",
        transmission_deferred_at: "2026-07-17T11:06:00.000Z",
        created_at: "2026-07-17T11:06:00.000Z"
      }
    );
    db.emailDeliveries.push(
      {
        id: "delivery_failed_latest",
        document_id: "doc_receipt_failed_attention",
        email_type: "dteReceipt",
        status: "FAILED",
        outcome_class: "UNKNOWN",
        failure_code: "E_INTERNAL_SERVER_ERROR",
        retry_safe: 0,
        provider_response_json: JSON.stringify({ error: "provider rejected" }),
        created_at: "2026-07-17T11:06:00.000Z"
      },
      {
        id: "delivery_recovered_old_failure",
        document_id: "doc_receipt_recovered_attention",
        email_type: "dteReceipt",
        status: "FAILED",
        provider_response_json: JSON.stringify({ error: "provider rejected" }),
        created_at: "2026-07-17T11:06:00.000Z"
      },
      {
        id: "delivery_recovered_latest_success",
        document_id: "doc_receipt_recovered_attention",
        email_type: "dteReceipt",
        status: "SENT",
        provider_response_json: JSON.stringify({ provider: "cloudflare-email" }),
        created_at: "2026-07-17T11:07:00.000Z"
      },
      {
        id: "delivery_pending_post_dispatch",
        document_id: "doc_receipt_pending_attention",
        email_type: "dteReceipt",
        status: "PENDING",
        provider_dispatch_started_at: "2026-07-17T11:08:00.000Z",
        provider_response_json: "{}",
        created_at: "2026-07-17T11:08:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?attention=failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      documents: Array<{
        id: string;
        status: string;
        receipt_email_status?: string | null;
        receipt_email_outcome_class?: string | null;
        receipt_email_failure_code?: string | null;
        receipt_email_requires_review?: number | null;
      }>;
    };
    expect(body.documents.map((document) => document.id)).toEqual([
      "doc_receipt_pending_attention",
      "doc_receipt_failed_attention",
      "doc_fiscal_rejected_attention",
      "doc_fiscal_failed_attention"
    ]);
    expect(body.documents.find((document) => document.id === "doc_receipt_failed_attention")).toMatchObject({
      status: "ACCEPTED",
      receipt_email_status: "FAILED",
      receipt_email_outcome_class: "UNKNOWN",
      receipt_email_failure_code: "E_INTERNAL_SERVER_ERROR"
    });
    expect(body.documents.find((document) => document.id === "doc_receipt_pending_attention")).toMatchObject({
      status: "ACCEPTED",
      receipt_email_status: "PENDING",
      receipt_email_requires_review: 1
    });
  });

  it("surfaces deferred docs as En trámite (virtual filter) while a plain SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Deferred: SIGNED + marker → listed under the virtual TRANSMISSION_PENDING filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_list",
      codigo_generacion: "AAAAAAA1-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
      numero_control: "DTE-15-M001P004-000000000000801",
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null
    });
    // Plain SIGNED (mid-pipeline transient, NOT deferred) → excluded from the filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_plain_signed",
      codigo_generacion: "BBBBBBB2-BBBB-4BBB-8BBB-BBBBBBBBBBB2",
      numero_control: "DTE-15-M001P004-000000000000802",
      status: "SIGNED",
      transmission_deferred_at: null,
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=TRANSMISSION_PENDING", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_deferred_list"]);
  });
});

describe("audit pagination", () => {
  it("pages the audit list by keyset cursor with a stable order", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    for (let i = 0; i < 7; i++) {
      db.audits.push({
        id: `audit_${String(i).padStart(3, "0")}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "DTE_ACCEPTED",
        entity_type: "dte_document",
        entity_id: `doc_${i}`,
        summary: `fila ${i}`,
        metadata_json: "{}",
        actor_ip: null,
        actor_context: null,
        created_at: `2026-07-0${(i % 7) + 1}T10:00:00.000Z`
      });
    }

    const first = await worker.fetch(
      new Request("https://example.org/api/audit?limit=3", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { audit: Array<{ id: string; created_at: string }>; nextCursor: string | null };
    expect(page1.audit).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first.
    expect(page1.audit[0].created_at >= page1.audit[1].created_at).toBe(true);

    const second = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page2 = (await second.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.audit).toHaveLength(3);
    // No overlap between pages.
    const ids1 = new Set(page1.audit.map((row) => row.id));
    expect(page2.audit.every((row) => !ids1.has(row.id))).toBe(true);

    const third = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page2.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page3 = (await third.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page3.audit).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("pipeline failure alerts", () => {
  it("sends an operational alert when a Wompi-triggered DTE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_alert_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const webhookResponse = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const { wompiEventId } = (await webhookResponse.json()) as { wompiEventId: string };

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-dte-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails before reaching MH,
      // deterministically driving the DTE into the FAILED path.
    });

    await expect(new IssuancePipeline(pipelineEnv).processWompiEvent(wompiEventId)).rejects.toThrow();

    const failedDocument = db.documents.find((document) => document.wompi_event_id === wompiEventId);
    expect(failedDocument?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_FAILED", entity_id: failedDocument!.id }));
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:DTE_FAILED", entity_type: "dte_document", entity_id: failedDocument!.id })
    );
  });

  it("sends an operational alert when an advanced CDE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail"));

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-advanced-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails deterministically.
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail")).rejects.toThrow();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail" }));
    expect(sentAlerts).toHaveLength(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail" })
    );
  });

  it("does not fail the pipeline when the alert email provider throws", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_alert_error"));

    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async () => {
          throw new Error("destination address is not a verified address");
        }
      } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_alert_error")).rejects.toThrow();

    const document = db.documents.find((doc) => doc.id === "doc_advanced_fail_alert_error");
    expect(document?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail_alert_error" }));
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail_alert_error" })
    );
  });

  it("does not send a duplicate alert for a document that fails twice", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_twice"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_twice",
        "advanced_attempt_twice"
      )
    ).rejects.toThrow();
    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_twice",
        "advanced_attempt_twice"
      )
    ).rejects.toThrow();

    expect(sentAlerts).toHaveLength(1);
  });

  it("sends another alert when a later advanced issuance attempt fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_later"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_later",
        "advanced_attempt_first"
      )
    ).rejects.toThrow();
    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument(
        "doc_advanced_fail_later",
        "advanced_attempt_second"
      )
    ).rejects.toThrow();

    expect(sentAlerts).toHaveLength(2);
  });

  it("does not send an alert when alert_email is unset", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_advanced_fail_no_alert_email"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_no_alert_email")).rejects.toThrow();

    expect(sentAlerts).toHaveLength(0);
  });
});

describe("advanced DTE queue idempotency", () => {
  it("does not let a late signer reopen and retransmit an already accepted CDE", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_sign_race",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    let reads = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    db.beforeDocumentRead = async () => {
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
    };
    let signedUpdates = 0;
    let releaseLateSigner!: () => void;
    const firstPipelineCompleted = new Promise<void>((resolve) => {
      releaseLateSigner = resolve;
    });
    db.beforeDocumentSignedUpdate = async () => {
      signedUpdates += 1;
      if (signedUpdates === 2) await firstPipelineCompleted;
    };
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password"
    });
    const first = new IssuancePipeline(runtime).processDteDocument("doc_advanced_sign_race");
    const second = new IssuancePipeline(runtime).processDteDocument("doc_advanced_sign_race");

    await Promise.race([first, second]);
    releaseLateSigner();
    const results = await Promise.all([first, second]);

    expect(results.every((record) => record.status === "ACCEPTED")).toBe(true);
    expect(db.audits.filter((audit) => audit.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(1);
    expect(db.documents[0].status).toBe("ACCEPTED");
    expect(db.documents[0].sello_recibido).toBeTruthy();
  });

  it.each([408, 429, 500, 503, 521])("does not redispatch a queue CDE after an ambiguous MH %i response", async (status) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_ambiguous",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(new Response("MH unavailable", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_ambiguous")
    ).rejects.toThrow(`Ministerio de Hacienda no disponible: ${status}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const redelivery = await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_ambiguous");
    expect(redelivery.status).toBe("SIGNED");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("does not redispatch a queue CDE after an empty HTTP 200 without a terminal MH verdict", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_empty_200",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-empty-200-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_empty_200")
    ).rejects.toThrow("resultado no definitivo");
    expect(db.documents[0].fiscal_operation_claim_id).toEqual(expect.stringMatching(/^fiscal_/));
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    const redelivery = await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_empty_200");
    expect(redelivery.fiscal_operation_claim_id).toBe(db.documents[0].fiscal_operation_claim_id);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it.each([
    [{ estado: "NO PROCESADO", selloRecibido: "CONTRADICTORY-SEAL" }, "NO PROCESADO"],
    [{ estado: "RECHAZADO", selloRecibido: "CONTRADICTORY-SEAL" }, "RECHAZADO"],
    [{ estado: "PROCESADO", selloRecibido: null }, "PROCESADO"]
  ])("retains the fiscal claim for contradictory MH HTTP 200 verdict %s", async (mhBody, expectedState) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_contradictory_200",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-contradictory-200-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse(mhBody));
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_contradictory_200")
    ).rejects.toThrow(`resultado no definitivo: ${expectedState}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_contradictory_200");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it.each([
    [302, null, "RECIBIDO"],
    [400, { estado: "PROCESADO", selloRecibido: "CONTRADICTORY-SEAL" }, "PROCESADO"],
    [400, { estado: "RECHAZADO", selloRecibido: "CONTRADICTORY-SEAL" }, "RECHAZADO"],
    [422, "not-json", "RECIBIDO"]
  ])("retains the fiscal claim for non-definitive MH HTTP %i response", async (status, mhBody, expectedState) => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_nondefinitive_http",
      wompi_event_id: null,
      status: "SIGNED",
      plain_json: JSON.stringify(advancedCdeDraft()),
      signed_jws: "signed-nondefinitive-http-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const mhResponse = typeof mhBody === "string"
      ? new Response(mhBody, { status })
      : mhBody === null
        ? new Response("", { status })
        : jsonResponse(mhBody, { status });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(mhResponse);
    vi.stubGlobal("fetch", fetchMock);
    const pipelineEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      MH_USER_TEST: "mh-user",
      MH_PASSWORD_TEST: "mh-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_nondefinitive_http")
    ).rejects.toThrow(`resultado no definitivo: ${expectedState}`);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      fiscal_operation_claim_id: expect.stringMatching(/^fiscal_/)
    });
    const callsAfterAmbiguousResult = fetchMock.mock.calls.length;

    await new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_nondefinitive_http");
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterAmbiguousResult);
  });

  it("rejects persisted issuer drift before signing an advanced CDE", async () => {
    const db = new InMemoryD1();
    const document = advancedCdeDraft();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_issuer_drift",
      wompi_event_id: null,
      status: "PENDING",
      plain_json: JSON.stringify(document),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });
    const persisted = JSON.parse(db.documents[0].plain_json) as Record<string, any>;
    persisted.emisor.numDocumento = "06142803901122";
    db.documents[0].plain_json = JSON.stringify(persisted);
    const mhFetch = vi.fn(async () => new Response("MH must not be called", { status: 500 }));
    vi.stubGlobal("fetch", mhFetch);

    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    });

    await expect(
      new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_issuer_drift")
    ).rejects.toThrow(/emisor/i);

    expect(db.documents[0].signed_jws).toBeNull();
    expect(mhFetch).not.toHaveBeenCalled();
    expect(db.audits).toContainEqual(
      expect.objectContaining({
        action: "ADVANCED_CDE_FAILED",
        entity_type: "dte_document",
        entity_id: "doc_advanced_issuer_drift"
      })
    );
  });

  it("does not re-transmit an already ACCEPTED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_accepted",
      wompi_event_id: null,
      status: "ACCEPTED",
      signed_jws: "signed-jws",
      sello_recibido: "SELLO-EXISTING",
      accepted_at: "2026-06-26T01:46:48.000Z"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_accepted");

    // Terminal document returned untouched: no re-sign, no re-transmit, verdict preserved.
    expect(record.status).toBe("ACCEPTED");
    expect(record.sello_recibido).toBe("SELLO-EXISTING");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(0);
    expect(db.audits.filter((row) => row.action === "EMAIL_SENT")).toHaveLength(0);
  });

  it("does not re-process an INVALIDATED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_invalidated",
      wompi_event_id: null,
      status: "INVALIDATED",
      signed_jws: "signed-jws"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_invalidated");

    expect(record.status).toBe("INVALIDATED");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED" || row.action === "ADVANCED_CDE_REJECTED")).toHaveLength(0);
  });

  it("does not flip an accepted advanced CDE to FAILED when post-acceptance bookkeeping throws", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_advanced_postfail"), signed_jws: "signed-jws" });
    // Make the ADVANCED_CDE_ACCEPTED audit write throw once, AFTER MH has accepted and
    // the row has already been marked ACCEPTED, forcing the catch path.
    const realPrepare = db.prepare.bind(db);
    let failNextAudit = true;
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes("INSERT INTO audit_logs") && failNextAudit) {
        failNextAudit = false;
        stmt.run = async () => {
          throw new Error("audit write failed");
        };
      }
      return stmt;
    };

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_postfail");

    // The MH acceptance seal survives: never overwritten with FAILED.
    expect(record.status).toBe("ACCEPTED");
    expect(db.documents.find((row) => row.id === "doc_advanced_postfail")?.status).toBe("ACCEPTED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
  });
});

describe("DTE transmission claim", () => {
  it("lets only one of two nonterminal deliveries call MH", async () => {
    const db = new InMemoryD1();
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const document = buildCdeDocument(
      wompiSample as unknown as WompiWebhook,
      emisorConfig(),
      { sequence: 71, codigoGeneracion, environment: "00" }
    );
    db.documents.push(testDocument({
      id: "dte_concurrent_transmission",
      wompi_event_id: null,
      codigo_generacion: codigoGeneracion,
      numero_control: "DTE-15-M001P004-000000000000071",
      plain_json: JSON.stringify(document),
      status: "SIGNED",
      signed_jws: "stable-signed-jws",
      sello_recibido: null,
      accepted_at: null
    }));
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockImplementation(async () => {
      await providerGate;
      return {
        accepted: true,
        estado: "PROCESADO",
        selloRecibido: "SELLO-CONCURRENT-CLAIM",
        observaciones: [],
        raw: { estado: "PROCESADO" }
      };
    });
    const runtime = env(db, { MOCK_EXTERNAL_SERVICES: "true" });

    const processing = Promise.all([
      new IssuancePipeline(runtime).processDteDocument("dte_concurrent_transmission"),
      new IssuancePipeline(runtime).processDteDocument("dte_concurrent_transmission")
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const callsBeforeRelease = transmit.mock.calls.length;
    release();
    await processing;

    expect(callsBeforeRelease).toBe(1);
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-CONCURRENT-CLAIM"
    });
  });

  it("does not let a late divergent result replace a terminal verdict or seal", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({
      id: "dte_terminal_result_guard",
      status: "SIGNED",
      signed_jws: "stable-signed-jws",
      sello_recibido: null,
      accepted_at: null
    }));
    const repo = new Repository(db as unknown as D1Database);

    const claimId = "fiscal-terminal-winner";
    await expect(repo.claimDocumentTransmission(
      "dte_terminal_result_guard",
      "SIGNED",
      "stable-signed-jws",
      claimId
    )).resolves.toBe(true);
    await expect(repo.completeDocumentTransmission("dte_terminal_result_guard", claimId, {
      status: "ACCEPTED",
      sello: "SELLO-WINNER",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:05:00.000Z"
    })).resolves.toBe(true);
    await expect(repo.completeDocumentTransmission("dte_terminal_result_guard", claimId, {
      status: "REJECTED",
      sello: null,
      mhEstado: "RECHAZADO",
      observaciones: ["late loser"],
      acceptedAt: null
    })).resolves.toBe(false);

    expect(db.documents[0]).toMatchObject({
      status: "ACCEPTED",
      sello_recibido: "SELLO-WINNER",
      mh_estado: "PROCESADO",
      accepted_at: "2026-07-13T20:05:00.000Z"
    });
  });

  it("does not auto-transmit a rebuilt Wompi row whose fiscal outcome needs reconciliation", async () => {
    const db = new InMemoryD1();
    const wompiEventId = "wompi_rebuild_crash_gap";
    const codigoGeneracion = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
    const rebuilt = buildCdeDocument(
      wompiSample as unknown as WompiWebhook,
      emisorConfig(),
      { sequence: 73, codigoGeneracion, environment: "00" }
    );
    db.wompiEvents.push(wompiEventForReservation({
      id: wompiEventId,
      transaction_id: "transaction_rebuild_crash_gap",
      raw_body: JSON.stringify(wompiSample)
    }));
    db.documents.push(testDocument({
      id: "dte_rebuild_crash_gap",
      wompi_event_id: wompiEventId,
      status: "REJECTED",
      signed_jws: null,
      sello_recibido: null,
      accepted_at: null,
      donor_email: null
    }));
    const repo = new Repository(db as unknown as D1Database);
    const claimId = "fiscal-rebuild-crash";

    await expect(repo.claimRejectedWompiRetry(
      "dte_rebuild_crash_gap",
      wompiEventId,
      claimId
    )).resolves.toBe(true);
    await expect(repo.prepareClaimedRejectedWompiRebuild(
      "dte_rebuild_crash_gap",
      wompiEventId,
      claimId,
      {
        codigoGeneracion,
        numeroControl: "DTE-15-M001P004-000000000000073",
        plainJson: rebuilt,
        signedJws: "rebuilt-signed-jws"
      }
    )).resolves.toBe(true);
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      transmission_deferred_at: null
    });

    const transmit = vi.spyOn(MhClient.prototype, "transmitDte").mockResolvedValue({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SELLO-REBUILT-SWEEP",
      observaciones: [],
      raw: { estado: "PROCESADO" }
    });
    const result = await new IssuancePipeline(env(db, {
      MOCK_EXTERNAL_SERVICES: "true"
    })).retryDeferredTransmissions();

    expect(result).toEqual({ transmitted: 0, rejected: 0, pending: 0 });
    expect(transmit).not.toHaveBeenCalled();
    expect(db.documents[0]).toMatchObject({
      status: "SIGNED",
      sello_recibido: null,
      fiscal_operation_claim_id: claimId
    });
  });
});

describe("issuance dead-letter and stalled-event sweep", () => {
  function deadLetterBatch(body: IssuanceMessage, queueName: string) {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: queueName,
      messages: [{ id: "msg_1", timestamp: new Date(), body, attempts: 3, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>;
    return { batch, ack, retry };
  }

  function stalledWompiEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "wompi_stalled",
      transaction_id: "TX-STALLED-1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donante@example.org",
      donor_name: "Donante",
      raw_body: "{}",
      processed_at: null,
      created_document_id: null,
      received_at: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  it("persists four pre-CDE failures before dead-lettering the reserved identifiers", async () => {
    const db = new InMemoryD1();
    db.nextSequence = 31;
    const eventId = "wompi_bad_country";
    const webhook = {
      ...wompiSample,
      IdTransaccion: "wompi_bad_country_tx",
      Cliente: {
        ...wompiSample.Cliente,
        CodigoPais: "ZZ"
      }
    };
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: webhook.IdTransaccion,
      raw_body: JSON.stringify(webhook)
    }));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const { batch, ack, retry } = deadLetterBatch(
        { wompiEventId: eventId },
        "diezmossv-staging-issuance-example"
      );

      await worker.queue(batch, runtime);

      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(1);
    }

    const { batch: deadLetter, ack } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example-dlq"
    );
    await worker.queue(deadLetter, runtime);

    const event = db.wompiEvents.find((row) => row.id === eventId);
    expect(event).toMatchObject({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_count: 4,
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: expect.stringContaining("CAT-020 País")
    });
    expect(event?.control_sequence).toBeNull();
    expect(db.nextSequence).toBe(31);
    expect(db.audits.filter((row) => row.action === "WOMPI_ISSUANCE_FAILED" && row.entity_id === eventId)).toHaveLength(4);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("never persists or exposes arbitrary secret-bearing queue errors", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const eventId = "wompi_unsafe_failure";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_unsafe_failure_tx"
    }));
    const unsafe = new Error(
      "Bearer sk-live-secret private-victim@example.net $123.45 " +
      "https://internal.example/retry\n    at retryIssuance (worker.ts:1:1)"
    );
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent").mockRejectedValue(unsafe);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, retry } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(retry).toHaveBeenCalledTimes(1);
    const event = db.wompiEvents.find((row) => row.id === eventId);
    expect(event).toMatchObject({
      issuance_status: "FAILED",
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "Fallo de emisión sin detalle"
    });
    const audit = db.audits.find(
      (row) => row.action === "WOMPI_ISSUANCE_FAILED" && row.entity_id === eventId
    );
    expect(audit).toMatchObject({
      summary: "Fallo de emisión sin detalle",
      metadata_json: JSON.stringify({ code: "ISSUANCE_ERROR" })
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain("sk-live-secret");
    expect(responseText).not.toContain("private-victim@example.net");
    expect(responseText).not.toContain("$123.45");
    expect(responseText).not.toContain("https://internal.example");
    expect(responseText).not.toContain("retryIssuance");
    expect(responseText).toContain("Fallo de emisión sin detalle");
  });

  it("resumes a stored nonterminal Wompi document without changing its identifiers or JSON", async () => {
    const db = new InMemoryD1();
    db.nextSequence = 32;
    const eventId = "wompi_resume_stored";
    const codigoGeneracion = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const numeroControl = "DTE-15-M001P004-000000000000031";
    const webhook = {
      ...wompiSample,
      IdTransaccion: "wompi_resume_stored_tx",
      IdExterno: undefined,
      EnlacePago: undefined
    } as WompiWebhook;
    const plainDocument = buildCdeDocument(webhook, emisorConfig(), {
      sequence: 31,
      codigoGeneracion,
      environment: "00",
      issuedAt: new Date("2026-07-13T10:00:00-06:00")
    });
    const plainJson = JSON.stringify(plainDocument);
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: webhook.IdTransaccion,
      raw_body: JSON.stringify(webhook),
      issuance_status: "FAILED",
      control_prefix: "M001P004",
      control_sequence: 31,
      reserved_numero_control: numeroControl,
      reserved_codigo_generacion: codigoGeneracion
    }));
    db.documents.push(testDocument({
      id: "dte_resume_stored",
      wompi_event_id: eventId,
      codigo_generacion: codigoGeneracion,
      numero_control: numeroControl,
      status: "SIGNED",
      plain_json: plainJson,
      signed_jws: "stored-jws",
      sello_recibido: null,
      mh_estado: null,
      donor_email: null,
      accepted_at: null
    }));

    const record = await new IssuancePipeline(env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
    })).processWompiEvent(eventId);

    expect(record).toMatchObject({
      id: "dte_resume_stored",
      status: "ACCEPTED",
      numero_control: numeroControl,
      codigo_generacion: codigoGeneracion,
      plain_json: plainJson
    });
    expect(db.documents).toHaveLength(1);
    expect(db.nextSequence).toBe(32);
    expect(db.wompiEvents.find((row) => row.id === eventId)).toMatchObject({
      created_document_id: "dte_resume_stored",
      issuance_status: "DOCUMENT_CREATED"
    });
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED", entity_id: "dte_resume_stored" })
    );
    expect(db.audits).not.toContainEqual(
      expect.objectContaining({ action: "ADVANCED_CDE_ACCEPTED", entity_id: "dte_resume_stored" })
    );
  });

  it("audits and acks dead-lettered issuance messages", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_dead",
      transaction_id: "wompi_dead_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    const { batch, ack, retry } = deadLetterBatch({ wompiEventId: "wompi_dead" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead" })
    );
  });

  it("ignores a delayed DLQ from an older attempt without overwriting the current retry", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_stale_dlq";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_stale_dlq_tx",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_last_attempt_at: "2026-07-13T22:10:00.000Z",
      issuance_failed_at: "2026-07-13T22:00:00.000Z"
    }));
    const { batch, ack } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-old" } as IssuanceMessage,
      "diezmossv-staging-issuance-example-dlq"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_dead_lettered_at: null
    });
    expect(db.audits).not.toContainEqual(expect.objectContaining({
      action: "ISSUANCE_DEAD_LETTERED",
      entity_id: eventId
    }));
  });

  it("records bounded fallback evidence when the current attempt hard-terminates without an error", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const eventId = "wompi_hard_termination";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_hard_termination_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: null,
      issuance_error_message: null,
      issuance_last_attempt_at: "2026-07-13T22:10:00.000Z"
    }));
    const { batch, ack } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-current" } as IssuanceMessage,
      "diezmossv-staging-issuance-example-dlq"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "ISSUANCE_RETRIES_EXHAUSTED",
      issuance_error_message: "El mensaje de emisión agotó sus reintentos antes de crear el CDE."
    });
    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const body = await response.json() as { failures: Array<Record<string, unknown>> };
    expect(body.failures).toContainEqual(expect.objectContaining({
      id: eventId,
      issuance_status: "DEAD_LETTERED",
      issuance_error_code: "ISSUANCE_RETRIES_EXHAUSTED"
    }));
  });

  it("claims tokenless legacy deliveries into one deterministic legacy attempt", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_legacy_message";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_legacy_message_tx",
      issuance_status: null,
      issuance_attempt_id: null
    }));
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent")
      .mockRejectedValue(new Error("legacy failure"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, retry } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "FAILED",
      issuance_attempt_id: `legacy:${eventId}`,
      issuance_error_code: "ISSUANCE_ERROR"
    });
  });

  it("acks a failure from an attempt that became stale while processing", async () => {
    const db = new InMemoryD1();
    const eventId = "wompi_stale_failure";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_stale_failure_tx",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-old",
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "Error anterior"
    }));
    vi.spyOn(IssuancePipeline.prototype, "processWompiEvent").mockImplementation(async () => {
      db.wompiEvents[0].issuance_status = "RETRY_QUEUED";
      db.wompiEvents[0].issuance_attempt_id = "attempt-new";
      throw new Error("late old failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { batch, ack, retry } = deadLetterBatch(
      { wompiEventId: eventId, issuanceAttemptId: "attempt-old" },
      "diezmossv-staging-issuance-example"
    );

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-new",
      issuance_error_message: "Error anterior"
    });
    expect(db.audits).not.toContainEqual(expect.objectContaining({
      action: "WOMPI_ISSUANCE_FAILED",
      entity_id: eventId
    }));
  });

  it("emits dead-letter audit and alert only for the winning current transition", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const eventId = "wompi_current_dlq_once";
    db.wompiEvents.push(wompiEventForReservation({
      id: eventId,
      transaction_id: "wompi_current_dlq_once_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current"
    }));
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-current-dlq" };
        }
      } as SendEmail
    });

    for (let delivery = 0; delivery < 2; delivery += 1) {
      const { batch, ack } = deadLetterBatch(
        { wompiEventId: eventId, issuanceAttemptId: "attempt-current" },
        "diezmossv-staging-issuance-example-dlq"
      );
      await worker.queue(batch, runtime);
      expect(ack).toHaveBeenCalledTimes(1);
    }

    expect(db.audits.filter(
      (row) => row.action === "ISSUANCE_DEAD_LETTERED" && row.entity_id === eventId
    )).toHaveLength(1);
    expect(db.audits.filter(
      (row) => row.action === "ALERT_SENT:ISSUANCE_DEAD_LETTERED" && row.entity_id === eventId
    )).toHaveLength(1);
    expect(sentAlerts).toHaveLength(1);
  });

  it("sends an operational alert for a dead-lettered issuance message", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_dead_alert",
      transaction_id: "wompi_dead_alert_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const { batch } = deadLetterBatch({ wompiEventId: "wompi_dead_alert" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(
      batch,
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message as { to: string; subject: string });
            return { messageId: "alert-dead-letter" };
          }
        } as SendEmail
      })
    );

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead_alert" })
    );
  });

  it("re-enqueues an approved wompi event stuck without a document for over an hour", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toEqual([{
      wompiEventId: "wompi_stalled",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_EVENT_REQUEUED", entity_id: "wompi_stalled" })
    );
  });

  it("does not touch recent or already-processed events", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_fresh", received_at: new Date().toISOString() }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_done", created_document_id: "dte_1" }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_declined", result: "Rechazada" }));

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(0);
  });

  it("recovers stale queued or processing retries using the last-attempt cutoff", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_retry_stale",
      processed_at: "2026-01-01T00:05:00.000Z",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-retry-stale",
      issuance_last_attempt_at: "2026-01-01T00:04:00.000Z"
    }));
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_processing_stale",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-processing-stale",
      issuance_last_attempt_at: "2026-01-01T00:04:00.000Z"
    }));
    db.wompiEvents.push(stalledWompiEvent({
      id: "wompi_retry_fresh",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-retry-fresh",
      issuance_last_attempt_at: new Date().toISOString()
    }));

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(2);
    expect(queued).toEqual(expect.arrayContaining([
      { wompiEventId: "wompi_retry_stale", issuanceAttemptId: expect.any(String) },
      { wompiEventId: "wompi_processing_stale", issuanceAttemptId: expect.any(String) }
    ]));
    expect(queued).not.toContainEqual({ wompiEventId: "wompi_retry_fresh" });
  });

  it("ignores historical requeue audits from before the current retry epoch", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const eventId = "wompi_retry_new_epoch";
    db.wompiEvents.push(stalledWompiEvent({
      id: eventId,
      processed_at: "2026-06-01T00:00:00.000Z",
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-new-epoch",
      issuance_last_attempt_at: "2026-06-01T00:00:00.000Z"
    }));
    for (let index = 0; index < 3; index += 1) {
      db.audits.push({
        id: `audit_historical_${index}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: eventId,
        summary: "",
        metadata_json: "{}",
        created_at: `2026-05-0${index + 1}T00:00:00.000Z`
      });
    }

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toEqual([{
      wompiEventId: eventId,
      issuanceAttemptId: expect.any(String)
    }]);
    expect(db.audits.filter(
      (audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId
    )).toHaveLength(4);
  });

  it("caps three requeues from the current retry epoch and raises the stalled alert", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const eventId = "wompi_retry_current_epoch";
    db.wompiEvents.push(stalledWompiEvent({
      id: eventId,
      processed_at: "2026-06-01T00:00:00.000Z",
      issuance_status: "PROCESSING",
      issuance_attempt_id: "attempt-current-epoch",
      issuance_last_attempt_at: "2026-06-01T00:00:00.000Z"
    }));
    for (let index = 0; index < 3; index += 1) {
      db.audits.push({
        id: `audit_current_${index}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: eventId,
        summary: "",
        metadata_json: "{}",
        created_at: `2026-06-0${index + 1}T00:00:00.000Z`
      });
    }

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(0);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "WOMPI_EVENT_STALLED",
      entity_id: eventId
    }));
  });

  it("gives up after three requeues and flags the event exactly once", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(queued).toHaveLength(0);
    const stalledAudits = db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === "wompi_stalled");
    expect(stalledAudits).toHaveLength(1);
  });

  it("sends a single operational alert even across repeated 15-minute cron runs", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled" };
        }
      } as SendEmail
    });

    // Simulate three consecutive 15-minute cron ticks after the event is already flagged stalled.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
  });

  it("retries the operational alert on a later tick after the first send attempt fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    let attempt = 0;
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          attempt += 1;
          if (attempt === 1) {
            throw Object.assign(new Error("recipient rejected before acceptance"), {
              code: "E_RECIPIENT_NOT_ALLOWED"
            });
          }
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled-retry" };
        }
      } as SendEmail
    });

    // Tick 1: the provider proves rejection before acceptance, so the same incident
    // remains safe to retry on a later tick.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
    expect(db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED")).toHaveLength(1);

    // Tick 2: email provider succeeds — the alert must be retried (not permanently
    // suppressed by the WOMPI_EVENT_STALLED audit from tick 1) and now sends.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );

    // Tick 3: alert already sent — sendOperationalAlert's own dedupe prevents a resend.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
  });
});

function queuedNoop(_message: IssuanceMessage): void {
  // Sweep should not requeue once an event has already been flagged stalled.
}

describe("scheduled cron dispatch", () => {
  it("routes the monthly retention cron to the retention export, not the 15-minute sweeps", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    // Retention export ran (audited), and the 15-minute sweep logic (which
    // would have requeued the stalled Wompi event) did not run.
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(true);
    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED")).toBe(false);
  });

  it("routes the 15-minute cron to the existing sweeps, not the retention export", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    expect(queued).toEqual([{
      wompiEventId: "wompi_stalled",
      issuanceAttemptId: expect.any(String)
    }]);
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(false);
  });

  it("isolates a retention export failure so it never throws out of scheduled()", async () => {
    const db = new InMemoryD1();
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));
    const scheduledEnv = env(db, { ARCHIVE: archive as unknown as R2Bucket });

    await expect(
      worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_FAILED" }));
  });
});

describe("certificate expiry alerts (15-minute cron)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the expiry date in Spanish and counts days remaining in the alert copy", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 2026-07-11
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expiring-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("vence el 11/07/2026");
      expect(alert.text).toContain("Quedan 10 día(s)");
      expect(alert.text).not.toContain(expiresAt.toISOString());
    }
  });

  it("words an already-expired certificate as 'venció hace N días' instead of a negative countdown", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // already expired 5 days ago
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expired-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("venció hace 5 días");
      expect(alert.text).not.toContain("Quedan -5");
    }
  });

  it("sends a CERT_EXPIRING alert once per threshold crossed and never duplicates on repeated ticks", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 10 days out: crosses 30 and 14 thresholds, not 3
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-cert-expiring" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(2);
    expect(sentAlerts.every((alert) => alert.to === "owner@example.org")).toBe(true);
    const expiryIso = expiresAt.toISOString();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:30` })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:14` })
    );
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(2);
  });

  it("does not alert when more than 30 days remain before expiry", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const expiresAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });

  it("re-arms alerts for a renewed certificate because the dedupe key includes the expiry date", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
    const oldExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    db.audits.push({
      id: "audit_prior_alert",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ALERT_SENT:CERT_EXPIRING",
      entity_type: "credentials",
      entity_id: `${oldExpiresAt.toISOString()}:14`,
      summary: "",
      metadata_json: "{}",
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const renewedExpiresAt = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(renewedExpiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    // Renewed cert is >30 days out, so no new alert fires — but the important
    // assertion is that the stale dedupe audit for the old expiry date does
    // not suppress a future alert against the new expiry date.
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(1);
  });

  it("never throws when the certificate secret is absent, and sends no alert", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const scheduledEnv = env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "alerts@example.org" });

    await expect(
      worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });
});

function certXmlWithExpiry(expiresAt: Date): string {
  const epochSecond = Math.floor(expiresAt.getTime() / 1000);
  return `<CertificadoMH><activo>true</activo><certificado><basicEstructure><validity><notAfter><epochSecond>${epochSecond}</epochSecond></notAfter></validity></basicEstructure></certificado></CertificadoMH>`;
}

function stalledWompiEventFixture(): Record<string, unknown> {
  return {
    id: "wompi_stalled",
    transaction_id: "TX-STALLED-1",
    environment: "00",
    result: "ExitosaAprobada",
    amount_cents: 2500,
    donor_email: "donante@example.org",
    donor_name: "Donante",
    raw_body: "{}",
    processed_at: null,
    created_document_id: null,
    received_at: "2026-01-01T00:00:00.000Z"
  };
}

describe("credential administration", () => {
  it("returns safe credential status to owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        MH_USER_TEST: "0614",
        MH_PASSWORD_TEST: "test-password",
        MH_CERT_XML_PART_1: "<CertificadoMH>",
        MH_CERT_XML_PART_2: "</CertificadoMH>",
        MH_CERT_PASSWORD: "cert-password",
        WOMPI_API_SECRET: "wompi-secret"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      credentials: {
        target: {
          appEnv: "staging",
          scriptName: "diezmossv-staging-resource-example",
          writerConfigured: false,
          writerMissing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
        },
        groups: {
          mhTest: { ready: true },
          signer: { ready: true },
          wompi: {
            label: "Webhook entrante de Wompi",
            ready: true,
            items: [
              {
                name: "WOMPI_API_SECRET",
                label: "Firma del webhook entrante",
                configured: true
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("test-password");
    expect(JSON.stringify(data)).not.toContain("cert-password");
    expect(JSON.stringify(data)).not.toContain("wompi-secret");
  });

  it.each([
    ["staging", "production"],
    ["production", "test"]
  ] as const)("rejects %s credential writes for the %s-incompatible environment", async (appEnv, environment) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment, mhUser: "replacement-user" })
      }),
      env(db, {
        APP_ENV: appEnv,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "writer-token",
        CLOUDFLARE_SCRIPT_NAME: `example-worker-${appEnv}`
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits.find((row) => row.action === "CREDENTIALS_UPDATED")).toBeUndefined();
  });

  it("returns a clear error when credential update is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "test", mhUser: "0614", mhPassword: "test-password" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "credential_writer_not_configured"
    });
    expect(db.audits).toHaveLength(0);
  });

  it("lets owners bootstrap the Cloudflare writer token without echoing it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials/writer-token", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ token: "cf-writer-token" })
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        CLOUDFLARE_API_BASE_URL: "https://cf.test"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      updated: ["CLOUDFLARE_API_TOKEN"],
      credentials: {
        target: {
          writerConfigured: true,
          writerMissing: []
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("cf-writer-token");
    expect(JSON.stringify(db.audits)).not.toContain("cf-writer-token");
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "CLOUDFLARE_WRITER_ENABLED",
      entity_id: "diezmossv-staging-resource-example"
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-resource-example/secrets-bulk");
    expect(init.headers).toMatchObject({ Authorization: "Bearer cf-writer-token" });
  });
});

describe("email template settings", () => {
  it("lets owners edit subject and body templates for each email type", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          templates: {
            dteReceipt: {
              subject: "CDE {{numeroControl}} emitido",
              body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
            },
            dteInvalidation: {
              subject: "CDE {{numeroControl}} invalidado",
              body: "El CDE {{numeroControl}} quedó {{estado}}."
            }
          }
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailTemplates: {
        definitions: [
          expect.objectContaining({ type: "dteReceipt", label: "Envío de comprobante" }),
          expect.objectContaining({ type: "dteInvalidation", label: "Invalidación de comprobante" })
        ],
        placeholders: expect.arrayContaining(["{{numeroControl}}", "{{donante}}", "{{monto}}"]),
        templates: {
          dteReceipt: {
            subject: "CDE {{numeroControl}} emitido",
            body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
          },
          dteInvalidation: {
            subject: "CDE {{numeroControl}} invalidado",
            body: "El CDE {{numeroControl}} quedó {{estado}}."
          }
        }
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_templates_json",
      updated_by: "user_owner"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_TEMPLATES_UPDATED",
      entity_type: "app_setting",
      entity_id: "email_templates_json"
    }));

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      emailTemplates: {
        templates: {
          dteReceipt: { subject: "CDE {{numeroControl}} emitido" },
          dteInvalidation: { subject: "CDE {{numeroControl}} invalidado" }
        }
      }
    });
  });
});

describe("alert email setting", () => {
  it("lets owners configure and read back the operational alert recipient", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org" })
      }),
      env(db)
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" }));
    // The audit records THAT the recipient changed, but never the address itself — the
    // audit trail is readable by lower roles, so the OWNER-only value must not ride in.
    const audit = db.audits.find((row) => row.action === "ALERT_EMAIL_UPDATED");
    expect(audit).toMatchObject({
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado",
      metadata_json: JSON.stringify({ enabled: true })
    });

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ alertEmail: "owner@example.org" });
  });

  it("lets owners configure multiple operational alert recipients separated by commas", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, admin@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org, admin@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org, admin@example.org", updated_by: "user_owner" }));
  });

  it("rejects malformed operational alert recipient lists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("redacts a legacy alert-email address from the audit trail for lower roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // A row written before the redaction shipped still carries the address in both the
    // summary and metadata; the read path must scrub it for everyone.
    db.audits.push({
      id: "audit_alert_legacy",
      actor_type: "USER",
      actor_id: "user_owner",
      action: "ALERT_EMAIL_UPDATED",
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado a owner@example.org",
      metadata_json: JSON.stringify({ alertEmail: "owner@example.org" }),
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const scopedResponse = await worker.fetch(
      new Request("https://example.org/api/audit?entityType=app_setting&entityId=alert_email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(scopedResponse.status).toBe(200);
    const scopedBody = (await scopedResponse.json()) as { audit: Array<{ summary?: string; metadata_json?: string }> };
    expect(JSON.stringify(scopedBody.audit)).not.toContain("owner@example.org");
    expect(scopedBody.audit[0]).toMatchObject({
      summary: "Correo de alertas actualizado",
      metadata_json: "{}"
    });

    // The general (keyset-paginated) audit trail is the primary VIEWER surface and must
    // scrub the legacy address too.
    const generalResponse = await worker.fetch(
      new Request("https://example.org/api/audit", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(generalResponse.status).toBe(200);
    const generalBody = (await generalResponse.json()) as { audit: Array<Record<string, unknown>> };
    expect(JSON.stringify(generalBody.audit)).not.toContain("owner@example.org");
  });

  it("allows clearing the alert email to disable alerting", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "" });
  });

  it("rejects a malformed alert email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("manual retention export endpoint", () => {
  it("lets an owner trigger the retention export for an explicit month and audits the request", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "completed", month: "2026-03" });
    expect(archive.objects.has("retention/2026/2026-03/manifest.json")).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_EXPORT_REQUESTED", entity_type: "retention_export", entity_id: "2026-03" })
    );
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_COMPLETED" }));
  });

  it("rejects a malformed month parameter", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=not-a-month", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
  });

  it("rejects an export request for the current (still-open) month and writes nothing to the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const archive = new FakeArchiveBucket();
    // The month currently open in El Salvador local time — same helper the
    // handler itself will use to compute "the previous closed month" — so
    // this test targets "now"'s own month regardless of when it runs.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

    const response = await worker.fetch(
      new Request(`https://example.org/api/admin/retention-export?month=${currentMonth}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns HTTP 500 when the export itself fails, instead of 200 with ok:false", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "failed", month: "2026-03" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("admin backups panel", () => {
  function seedManifest(archive: FakeArchiveBucket, month: string, tables: Record<string, { rowCount: number; body: string }>): Promise<void> {
    return (async () => {
      const prefix = `retention/${month.slice(0, 4)}/${month}`;
      const manifestTables: Record<string, { rowCount: number; sha256: string }> = {};
      for (const [table, { rowCount, body }] of Object.entries(tables)) {
        const bytes = utf8Bytes(body);
        await archive.put(`${prefix}/${table}.ndjson`, bytes);
        manifestTables[table] = { rowCount, sha256: await sha256Hex(bytes) };
      }
      const manifest = { month, generatedAt: `${month}-28T09:00:00.000Z`, tables: manifestTables };
      await archive.put(`${prefix}/manifest.json`, utf8Bytes(JSON.stringify(manifest)));
    })();
  }

  it("lists archived, missing, and in-progress months newest-first with parsed manifest data", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Earliest document is April 2026, so the expected range spans April..(last closed month).
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-04-10T12:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    // April archived, May missing (no manifest).
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 3, body: "a\nb\nc\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { months: Array<{ month: string; status: string; totalRows?: number; exportedAt?: string }> };
    const byMonth = new Map(payload.months.map((entry) => [entry.month, entry]));

    // Newest first.
    expect(payload.months[0].month > payload.months[payload.months.length - 1].month).toBe(true);
    expect(byMonth.get("2026-04")).toMatchObject({ status: "archivado", totalRows: 3 });
    expect(byMonth.get("2026-04")?.exportedAt).toBe("2026-04-28T09:00:00.000Z");
    expect(byMonth.get("2026-05")).toMatchObject({ status: "faltante" });
    // The current (still-open) El Salvador month appears only as en_curso.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
    expect(byMonth.get(currentMonth)?.status).toBe("en_curso");
  });

  it("returns an empty list when there are no documents and no manifests", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ months: [] });
  });

  it("rejects a VIEWER with 403 and an unauthenticated caller with 401", async () => {
    const dbViewer = new InMemoryD1();
    dbViewer.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const viewerResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(dbViewer)
    );
    expect(viewerResponse.status).toBe(403);

    const anonResponse = await worker.fetch(new Request("https://example.org/api/admin/backups"), env(new InMemoryD1()));
    expect(anonResponse.status).toBe(401);
  });

  it("verifies a month against its manifest and audits RETENTION_VERIFIED on a full match", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "row\n" },
      audit_logs: { rowCount: 0, body: "" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean }> };
    expect(payload.ok).toBe(true);
    expect(payload.files.every((file) => file.ok)).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFIED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("reports a mismatch, audits RETENTION_VERIFY_FAILED, and sends an operational alert when an object is corrupted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "row\n" } });
    // Corrupt the stored object's bytes so its SHA-256 no longer matches the manifest.
    await archive.put("retention/2026/2026-04/dte_documents.ndjson", utf8Bytes("tampered\n"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        ARCHIVE: archive as unknown as R2Bucket,
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message);
            return { messageId: "alert-verify" };
          }
        } as unknown as Env["EMAIL"]
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean; expected: string; actual: string }> };
    expect(payload.ok).toBe(false);
    const corrupted = payload.files.find((file) => file.table === "dte_documents");
    expect(corrupted?.ok).toBe(false);
    expect(corrupted?.expected).not.toBe(corrupted?.actual);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFY_FAILED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    expect(sent).toHaveLength(1);
  });

  it("streams a table object as an attachment and audits RETENTION_DOWNLOADED", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 2, body: "line1\nline2\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("2026-04");
    await expect(response.text()).resolves.toBe("line1\nline2\n");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("returns 404 when downloading an object that is not in the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a full-month ZIP whose objects exceed the memory budget with a Spanish 413", async () => {
    // The ZIP is buffered in worker memory; enforcement fires DURING collection (before
    // reading each object) so an oversized month can never balloon memory first.
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    // One object claims a size beyond the 32 MiB budget; its body is tiny so the test
    // itself stays cheap — the guard must trust the R2-reported size, not read first.
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });
    archive.sizeOverrides.set("retention/2026/2026-04/dte_documents.ndjson", 32 * 1024 * 1024 + 1);

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    // No PII-download audit for a refused archive.
    expect(db.audits.filter((row) => row.action === "RETENTION_DOWNLOADED")).toHaveLength(0);
  });

  it("streams a full-month ZIP of every archived object plus the manifest and audits the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="respaldo-2026-04.zip"');

    // Round-trip the streamed ZIP through the system unzip binary (same pattern as
    // pdf.test.ts shelling out to poppler) to prove listing + exact content.
    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const dir = mkdtempSync(join(tmpdir(), "diezmos-backup-zip-"));
    const zipPath = join(dir, "respaldo.zip");
    writeFileSync(zipPath, zipBytes);
    const listing = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("dte_documents.ndjson");
    expect(listing).toContain("audit_logs.ndjson");
    expect(listing).toContain("No errors detected");
    expect(execFileSync("unzip", ["-p", zipPath, "dte_documents.ndjson"], { encoding: "utf8" })).toBe("line1\nline2\n");
    expect(execFileSync("unzip", ["-p", zipPath, "audit_logs.ndjson"], { encoding: "utf8" })).toBe("audit\n");

    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    const audit = db.audits.find((row) => row.action === "RETENTION_DOWNLOADED");
    expect(JSON.parse(String(audit!.metadata_json))).toMatchObject({ month: "2026-04", table: "__all__" });
  });

  it("rejects an oversized full-month ZIP before auditing the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "x".repeat(33 * 1024 * 1024) }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "RETENTION_DOWNLOADED" }));
  });

  it("returns 404 for a full-month download of a month without an archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a VIEWER full-month download with 403", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("audit actor context", () => {
  // Cloudflare only sets request.cf in the Workers runtime, so tests attach it
  // manually; the worker reads it defensively via (request as any).cf.
  function withCf(request: Request, cf: Record<string, unknown>): Request {
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    return request;
  }

  const SV_CF = {
    country: "SV",
    city: "San Salvador",
    region: "San Salvador",
    timezone: "America/El_Salvador",
    asn: 27773,
    asOrganization: "Claro El Salvador",
    colo: "SJO",
    httpProtocol: "HTTP/2",
    tlsVersion: "TLSv1.3"
  };

  it("records the client IP and cf context on a failed login audit", async () => {
    const db = new InMemoryD1();

    const request = withCf(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "190.86.1.2",
          "user-agent": "Mozilla/5.0 Test"
        },
        body: JSON.stringify({ email: "nobody@example.org", password: "whatever" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(401);
    const failure = db.audits.find((audit) => audit.action === "LOGIN_FAILED");
    expect(failure).toBeTruthy();
    expect(failure?.actor_ip).toBe("190.86.1.2");
    expect(JSON.parse(String(failure?.actor_context))).toMatchObject({
      country: "SV",
      city: "San Salvador",
      asOrganization: "Claro El Salvador",
      userAgent: "Mozilla/5.0 Test"
    });
  });

  it("bounds oversized actor fields on a failed login audit", async () => {
    const db = new InMemoryD1();
    const request = withCf(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "2".repeat(200),
          "user-agent": "Browser".repeat(200)
        },
        body: JSON.stringify({ email: "nobody@example.org", password: "whatever" })
      }),
      {
        ...SV_CF,
        country: "S".repeat(20),
        city: "á".repeat(1_000),
        asOrganization: "Org".repeat(1_000),
        ignored: "x".repeat(100_000)
      }
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(401);
    const failure = db.audits.find((audit) => audit.action === "LOGIN_FAILED");
    expect(failure).toBeTruthy();
    expect(utf8Bytes(String(failure?.actor_ip)).byteLength).toBeLessThanOrEqual(64);
    const actorContext = String(failure?.actor_context);
    expect(utf8Bytes(actorContext).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(actorContext)).toMatchObject({
      _truncated: expect.arrayContaining(["country", "city", "asOrganization", "userAgent"])
    });
    expect(JSON.parse(actorContext)).not.toHaveProperty("ignored");
  });

  it("bounds actor fields when createAudit is called directly", async () => {
    const db = new InMemoryD1();
    const repo = new Repository(env(db).DB);

    await repo.createAudit({
      action: "DIRECT_AUDIT_TEST",
      entityType: "test",
      entityId: "direct",
      summary: "Direct audit boundary",
      actorIp: "🧪".repeat(100),
      actorContext: {
        city: "á".repeat(1_000),
        userAgent: "🧪".repeat(10_000),
        asn: 27773,
        ignored: "x".repeat(100_000)
      }
    });

    const audit = db.audits.find((row) => row.action === "DIRECT_AUDIT_TEST");
    expect(audit).toBeTruthy();
    expect(utf8Bytes(String(audit?.actor_ip)).byteLength).toBeLessThanOrEqual(64);
    expect(String(audit?.actor_ip)).not.toContain("�");
    const actorContext = String(audit?.actor_context);
    expect(utf8Bytes(actorContext).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(actorContext)).toMatchObject({
      asn: 27773,
      _truncated: expect.arrayContaining(["city", "userAgent"])
    });
    expect(JSON.parse(actorContext)).not.toHaveProperty("ignored");
  });

  it("records the client IP and cf context on an admin user update audit", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const request = withCf(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "cf-connecting-ip": "201.203.9.9",
          "user-agent": "AdminBrowser/1.0"
        },
        body: JSON.stringify({ role: "ADMIN" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(200);
    const audit = db.audits.find((row) => row.action === "USER_UPDATED");
    expect(audit?.actor_ip).toBe("201.203.9.9");
    expect(JSON.parse(String(audit?.actor_context))).toMatchObject({
      asOrganization: "Claro El Salvador",
      userAgent: "AdminBrowser/1.0"
    });
  });

  it("leaves cron/queue (SYSTEM) audits without actor IP or context", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(wompiEventForReservation({
      id: "wompi_1",
      transaction_id: "wompi_1_tx",
      issuance_status: "PROCESSING",
      issuance_attempt_id: null
    }));
    // A dead-letter batch runs in the queue handler with no incoming Request.
    await worker.queue(
      {
        queue: "issuance-dlq",
        messages: [
          {
            body: { wompiEventId: "wompi_1" } as IssuanceMessage,
            ack: () => undefined,
            retry: () => undefined
          }
        ]
      } as unknown as MessageBatch<IssuanceMessage>,
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "ISSUANCE_DEAD_LETTERED");
    expect(audit).toBeTruthy();
    expect(audit?.actor_ip ?? null).toBeNull();
    expect(audit?.actor_context ?? null).toBeNull();
  });

  it.each(["VIEWER", "OPERATOR"] as const)("projects account audit rows safely for %s users", async (role) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: `user_${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.org`, name: role, role };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_system_1",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ISSUANCE_DEAD_LETTERED",
      entity_type: "wompi_event",
      entity_id: "wompi_1",
      summary: "seeded",
      metadata_json: "{}",
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:46.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    const userRow = body.audit.find((row) => row.id === "audit_user_1");
    const systemRow = body.audit.find((row) => row.id === "audit_system_1");

    // Account rows hide both the actor and target identity from lower audit audiences.
    expect(userRow?.actor_id ?? null).toBeNull();
    expect(userRow?.actor_name ?? null).toBeNull();
    expect(userRow?.actor_email ?? null).toBeNull();
    expect(userRow?.actor_ip ?? null).toBeNull();
    expect(userRow?.actor_context ?? null).toBeNull();
    expect(userRow?.entity_id ?? null).toBeNull();
    expect(userRow?.summary).toBe("Usuario actualizado");
    expect(userRow?.metadata_json).toBe("{}");
    // SYSTEM rows have no resolvable user and no captured context.
    expect(systemRow?.actor_name ?? null).toBeNull();
    expect(systemRow?.actor_ip ?? null).toBeNull();
  });

  it("applies the lower-role audit projection on scoped, document-detail, and contingency responses", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.documents.push(testDocument({ id: "doc_projection" }));
    db.contingencies.push({
      id: "cont_projection",
      environment: "00",
      status: "OPEN",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      created_at: "2026-06-26T01:00:00.000Z"
    });
    const sensitiveContext = JSON.stringify({ city: "San Salvador", country: "SV" });
    db.audits.push(
      {
        id: "audit_scoped_user",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "USER_UPDATED",
        entity_type: "user",
        entity_id: "user_operator",
        summary: "operator@example.org ascendido",
        metadata_json: JSON.stringify({ email: "operator@example.org" }),
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:49.015Z"
      },
      {
        id: "audit_document_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "DTE_RETRIED",
        entity_type: "dte_document",
        entity_id: "doc_projection",
        summary: "Documento reintentado",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:48.015Z"
      },
      {
        id: "audit_contingency_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "CONTINGENCY_OPENED",
        entity_type: "contingency_period",
        entity_id: "cont_projection",
        summary: "Contingencia abierta",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:47.015Z"
      }
    );

    const headers = { Authorization: "Bearer test-token" };
    const [scopedResponse, documentResponse, contingencyResponse] = await Promise.all([
      worker.fetch(
        new Request("https://example.org/api/audit?entityType=user&entityId=user_operator", { headers }),
        env(db)
      ),
      worker.fetch(new Request("https://example.org/api/documents/doc_projection", { headers }), env(db)),
      worker.fetch(new Request("https://example.org/api/contingency", { headers }), env(db))
    ]);

    expect(scopedResponse.status).toBe(200);
    expect(documentResponse.status).toBe(200);
    expect(contingencyResponse.status).toBe(200);
    const scoped = (await scopedResponse.json()) as { audit: Array<Record<string, unknown>> };
    const document = (await documentResponse.json()) as { audit: Array<Record<string, unknown>> };
    const contingency = (await contingencyResponse.json()) as { contingency: { audit: Array<Record<string, unknown>> } };

    expect(scoped.audit[0]).toMatchObject({
      actor_id: null,
      actor_name: null,
      actor_email: null,
      actor_ip: null,
      actor_context: null,
      entity_id: null,
      summary: "Usuario actualizado",
      metadata_json: "{}"
    });
    for (const row of [document.audit[0], contingency.contingency.audit[0]]) {
      expect(row).toMatchObject({ actor_email: null, actor_ip: null, actor_context: null });
    }
  });

  it("returns sensitive audit actor fields for ADMIN users", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin_session", email: "admin-session@example.org", name: "Admin Session", role: "ADMIN" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    expect(body.audit[0]).toMatchObject({
      actor_name: "Ada Admin",
      actor_email: "admin@example.org",
      actor_ip: "190.86.1.2"
    });
    expect(JSON.parse(String(body.audit[0]?.actor_context))).toMatchObject({ city: "San Salvador" });
  });
});

describe("branding", () => {
  function ownerDb(): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    return db;
  }

  function authed(role: string): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = { id: `user_${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.org`, name: role, role };
    return db;
  }

  it("returns the defaults for the public branding endpoint before anything is set", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: "ExamplePerson1",
      accentColor: "#0f766e",
      supportEmail: "legacy-contact-1@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("reflects a saved name and color on the public branding endpoint", async () => {
    const db = ownerDb();
    const put = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "  Iglesia Central  ", accentColor: "#123ABC", supportEmail: "  legacy-email-119@example.com " })
      }),
      env(db)
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      ok: true,
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com"
    });
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_UPDATED", entity_type: "app_setting" });

    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));
    await expect(response.json()).resolves.toMatchObject({
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("carries the support email in the branding audit metadata", async () => {
    const db = ownerDb();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia Central", accentColor: "#123abc", supportEmail: "legacy-email-119@example.com" })
      }),
      env(db)
    );
    const audit = db.audits.at(-1) as { action: string; metadata_json?: string };
    expect(audit.action).toBe("BRANDING_UPDATED");
    expect(String(audit.metadata_json)).toContain("legacy-email-119@example.com");
  });

  it("rejects a malformed support email with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e", supportEmail: "no-arroba" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("correo");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a bad hex color with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#zzz" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("color");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an empty name with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "   ", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("rejects an 81-character name", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "a".repeat(81), accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("forbids a VIEWER from writing branding", async () => {
    const db = authed("VIEWER");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("forbids an OPERATOR from writing branding", async () => {
    const db = authed("OPERATOR");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("requires a session to write branding", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(401);
  });

  const logoCases: Array<{ contentType: string; ext: string }> = [
    { contentType: "image/svg+xml", ext: "svg" },
    { contentType: "image/png", ext: "png" },
    { contentType: "image/jpeg", ext: "jpg" }
  ];

  for (const { contentType } of logoCases) {
    it(`stores a ${contentType} logo and serves it with hardening headers`, async () => {
      const db = ownerDb();
      const archive = new FakeArchiveBucket();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);

      const put = await worker.fetch(
        new Request("https://example.org/api/settings/branding/logo", {
          method: "PUT",
          headers: { Authorization: "Bearer test-token", "Content-Type": contentType },
          body: bytes
        }),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { ok: boolean; logoVersion: string };
      expect(putBody.ok).toBe(true);
      expect(putBody.logoVersion).toBeTruthy();
      expect(archive.putCalls.at(-1)?.key).toBe("branding/logo");
      expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_UPDATED" });

      const publicBranding = await worker.fetch(
        new Request("https://example.org/api/branding"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: putBody.logoVersion });

      const logo = await worker.fetch(
        new Request("https://example.org/api/branding/logo"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(logo.status).toBe(200);
      expect(logo.headers.get("Content-Type")).toBe(contentType);
      expect(logo.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(logo.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(logo.headers.get("Content-Security-Policy")).toBe("script-src 'none'; default-src 'none'; style-src 'unsafe-inline'");
      await expect(logo.arrayBuffer()).resolves.toEqual(bytes.buffer);
    });
  }

  it("stores and serves the donor logo separately from the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const adminBytes = new Uint8Array([1, 2, 3]);
    const donorBytes = new Uint8Array([7, 8, 9]);

    const adminPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: adminBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const adminBody = (await adminPut.json()) as { logoVersion: string };

    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: donorBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorPut.status).toBe(200);
    const donorBody = (await donorPut.json()) as { ok: boolean; donorLogoVersion: string };
    expect(donorBody.ok).toBe(true);
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/logo");
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/donor-logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_UPDATED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({
      logoVersion: adminBody.logoVersion,
      donorLogoVersion: donorBody.donorLogoVersion
    });

    const donorLogo = await worker.fetch(
      new Request("https://example.org/api/branding/donor-logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorLogo.status).toBe(200);
    expect(donorLogo.headers.get("Content-Type")).toBe("image/png");
    await expect(donorLogo.arrayBuffer()).resolves.toEqual(donorBytes.buffer);

    const adminLogo = await worker.fetch(
      new Request("https://example.org/api/branding/logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(adminLogo.arrayBuffer()).resolves.toEqual(adminBytes.buffer);
  });

  it("rejects a logo upload with an unsupported content type", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/gif" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding_logo" });
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a logo upload larger than 512 KB", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const bytes = new Uint8Array(512 * 1024 + 1);
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: bytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns 404 for the logo stream when none is stored", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding/logo"), env(db));
    expect(response.status).toBe(404);
  });

  it("removes a stored logo and records an audit", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([9, 9, 9])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true });
    expect(archive.deleteCalls).toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: null });
  });

  it("removes a stored donor logo without removing the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 1, 1])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([2, 2, 2])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorBody = (await donorPut.json()) as { donorLogoVersion: string };

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true, donorLogoVersion: null });
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.deleteCalls).toContain("branding/donor-logo");
    expect(archive.deleteCalls).not.toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: expect.any(String), donorLogoVersion: null });
  });

  it("forbids a non-owner from uploading a logo", async () => {
    const db = authed("ADMIN");
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(403);
    expect(archive.putCalls).toHaveLength(0);
  });
});

const ANALYTICS_MAX_BYTES = 8 * 1024 * 1024;
const ANALYTICS_CAPACITY_RESPONSE = {
  error: "analytics_range_too_large",
  message: "El rango solicitado contiene demasiados datos. Reduzca las fechas."
};

describe("analytics endpoint (Wompi lane)", () => {
  it("requires a session (401 without a token)", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/analytics"), env(db));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-13-40&to=2026-01-01", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("rejects analytics ranges wider than one year", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=1900-01-01&to=9998-12-31", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("aggregates the Wompi lane and excludes manually issued CDEs by design", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Wompi-lane accepted doc (environment 00).
    db.documents.push(
      testDocument({
        id: "doc_wompi",
        wompi_event_id: "wompi_lane",
        environment: "00",
        status: "ACCEPTED",
        donor_email: "lane@example.org",
        donor_name: "Lane Donor",
        amount_cents: 5000,
        issued_at: "2026-06-10T18:00:00.000Z",
        accepted_at: "2026-06-10T18:00:20.000Z"
      }),
      // Manually issued CDE (no wompi_event_id) — must NOT appear in any total.
      testDocument({
        id: "doc_manual",
        wompi_event_id: null,
        environment: "00",
        status: "ACCEPTED",
        donor_email: "manual@example.org",
        amount_cents: 999999,
        issued_at: "2026-06-11T18:00:00.000Z"
      })
    );
    db.donationIntents.push({
      id: "di_lane",
      status: "COMPLETED",
      document_id: "doc_wompi",
      donor_document: "DUI-1",
      gift_type: "DIEZMO",
      direccion_departamento: "06",
      donor_pais: null,
      created_at: "2026-06-10T17:50:00.000Z",
      paid_at: "2026-06-10T17:55:00.000Z"
    });
    db.emailDeliveries.push({ id: "em_1", document_id: "doc_wompi", status: "SENT", created_at: "2026-06-10T18:01:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { analytics: Record<string, any> };
    const analytics = body.analytics;
    expect(analytics.environment).toBe("00");
    expect(analytics.hasData).toBe(true);
    // Only the Wompi-lane doc counts (the 999999 manual CDE is excluded).
    const june = analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    expect(june).toMatchObject({ totalCents: 5000, count: 1 });
    // Gift split routes it to Diezmo via the correlated intent.
    expect(analytics.giving.giftSplit.find((point: any) => point.key === "2026-06")?.diezmoCents).toBe(5000);
    // Geography buckets it under department 06.
    expect(analytics.geography.departments.find((row: any) => row.code === "06")?.count).toBe(1);
    // Funnel + email pick up the lane intent and delivery.
    expect(analytics.funnel).toMatchObject({ created: 1, datos: 1, paid: 1, completed: 1 });
    expect(analytics.email.weekly.reduce((sum: number, point: any) => sum + point.sent, 0)).toBe(1);
    // Top donors never leak numero de control.
    expect(JSON.stringify(analytics.giving.topDonors)).not.toContain("numero_control");
  });

  it("returns 422 before materializing more than ten thousand analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 10_001; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(false);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("returns 422 when serialized analytics rows exceed eight MiB", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    db.documents.push(
      testDocument({
        id: "doc_byte_budget",
        wompi_event_id: "wompi_byte_budget",
        environment: "00",
        donor_name: "🧪".repeat(2_100_000),
        issued_at: "2026-06-10T18:00:00.000Z"
      })
    );

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
  });

  it("shares remaining row capacity across document and intent readers", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 9_999; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_shared_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_shared_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }
    db.donationIntents.push(
      testAnalyticsIntent({ id: "di_shared_budget_1" }),
      testAnalyticsIntent({ id: "di_shared_budget_2" })
    );

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.analyticsQueryLimits.find((query) => query.reader === "intents")?.limit
    ).toBe(2);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("accepts exactly ten thousand analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    for (let index = 0; index < 10_000; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_exact_budget_${String(index).padStart(5, "0")}`,
          wompi_event_id: `wompi_exact_budget_${index}`,
          environment: "00",
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { analytics: { giving: { monthly: Array<{ count: number }> } } };
    expect(body.analytics.giving.monthly[0]?.count).toBe(10_000);
    expect(
      db.analyticsQueryLimits.find((query) => query.reader === "intents")?.limit
    ).toBe(1);
  });

  it("bounds document query pages for realistically amended donor emails", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const amendedEmail = `${"a".repeat(262_000)}@x.co`;
    expect(
      utf8Bytes(JSON.stringify({ email: amendedEmail })).byteLength
    ).toBeLessThanOrEqual(256 * 1024);
    for (let index = 0; index < 32; index += 1) {
      db.documents.push(
        testDocument({
          id: `doc_amended_email_${String(index).padStart(2, "0")}`,
          wompi_event_id: `wompi_amended_email_${index}`,
          environment: "00",
          donor_email: amendedEmail,
          issued_at: "2026-06-10T18:00:00.000Z"
        })
      );
    }
    const serializedRowBytes =
      utf8Bytes(
        JSON.stringify(analyticsDocumentRow(db.documents[0], []))
      ).byteLength + 1;
    expect(serializedRowBytes * 31).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(serializedRowBytes * 32).toBeGreaterThan(ANALYTICS_MAX_BYTES);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    const documentQueryLimits = db.analyticsQueryLimits
      .filter((query) => query.reader === "documents")
      .map((query) => query.limit);
    expect(documentQueryLimits[0]).toBe(31);
    expect(documentQueryLimits.every((limit) => limit <= 31)).toBe(true);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(false);
  });

  it("shares serialized UTF-8 capacity across document and intent readers", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const document = testDocument({
      id: "doc_combined_bytes",
      wompi_event_id: "wompi_combined_bytes",
      environment: "00",
      donor_name: "🧪".repeat(1_050_000),
      issued_at: "2026-06-10T18:00:00.000Z"
    });
    const intent = testAnalyticsIntent({
      id: "di_combined_bytes",
      donor_document: "🧪".repeat(1_050_000)
    });
    db.documents.push(document);
    db.donationIntents.push(intent);

    const documentBytes = utf8Bytes(
      JSON.stringify(analyticsDocumentRow(document, db.donationIntents))
    ).byteLength + 1;
    const intentBytes = utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1;
    expect(documentBytes).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(intentBytes).toBeLessThan(ANALYTICS_MAX_BYTES);
    expect(documentBytes + intentBytes).toBeGreaterThan(ANALYTICS_MAX_BYTES);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM donation_intents i"))
    ).toBe(true);
    expect(
      db.preparedSql.some((sql) => sql.includes("FROM email_deliveries e"))
    ).toBe(false);
  });

  it("accepts exactly eight MiB of serialized analytics rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const intent = analyticsIntentWithSerializedBytes(ANALYTICS_MAX_BYTES);
    expect(
      utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1
    ).toBe(ANALYTICS_MAX_BYTES);
    db.donationIntents.push(intent);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(200);
  });

  it("rejects one byte beyond eight MiB with the exact capacity response", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    const intent = analyticsIntentWithSerializedBytes(ANALYTICS_MAX_BYTES + 1);
    expect(
      utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1
    ).toBe(ANALYTICS_MAX_BYTES + 1);
    db.donationIntents.push(intent);

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(ANALYTICS_CAPACITY_RESPONSE);
  });

  it("scopes every metric to the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({ id: "doc_00", wompi_event_id: "w00", environment: "00", amount_cents: 1000, issued_at: "2026-06-10T18:00:00.000Z" }),
      testDocument({ id: "doc_01", wompi_event_id: "w01", environment: "01", amount_cents: 8000, issued_at: "2026-06-10T18:00:00.000Z" })
    );
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const body = (await response.json()) as { analytics: Record<string, any> };
    const june = body.analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    // Only the 01 doc is counted; the 00 doc is invisible in this ambiente.
    expect(june).toMatchObject({ totalCents: 8000, count: 1 });
  });
});

function bootstrapRequest(options: { token?: string } = {}, clientIp?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) {
    headers.set("X-Bootstrap-Owner-Token", options.token);
  }
  if (clientIp) {
    headers.set("CF-Connecting-IP", clientIp);
  }
  return new Request("https://example.org/api/auth/bootstrap-owner", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "legacy-contact-3@example.com",
      name: "Example Person",
      password: "Long-enough1!"
    })
  });
}

function executionContextCapturing(tasks: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

async function fetchAndWaitUntil(request: Request, runtime: Env): Promise<Response> {
  const tasks: Promise<unknown>[] = [];
  const response = await worker.fetch(request, runtime, executionContextCapturing(tasks));
  await Promise.all(tasks);
  return response;
}

function env(db: InMemoryD1, values: Partial<Env> = {}): Env {
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
class FakeArchiveBucket {
  readonly objects = new Map<string, Uint8Array>();
  // Reported-size overrides so tests can simulate oversized R2 objects without
  // allocating them (the backup ZIP guard trusts object.size before reading).
  readonly sizeOverrides = new Map<string, number>();
  readonly contentTypes = new Map<string, string>();
  readonly putCalls: Array<{ key: string; bytes: Uint8Array }> = [];
  readonly headCalls: string[] = [];
  readonly deleteCalls: string[] = [];

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object> {
    const bytes =
      value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : value instanceof Uint8Array
          ? value
          : utf8Bytes(String(value));
    this.objects.set(key, bytes);
    if (options?.httpMetadata?.contentType) {
      this.contentTypes.set(key, options.httpMetadata.contentType);
    }
    this.putCalls.push({ key, bytes });
    return { key } as R2Object;
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

interface LoginRateLimitRow {
  window_started_at: string;
  attempt_count: number;
  expires_at: string;
}

interface SecurityRateLimitClaimRow {
  id: string;
  scope: string;
  key_hash: string;
  subject_key_hash?: string | null;
  claimed_at: string;
  expires_at: string;
}

function wompiEventForReservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wompi_1",
    transaction_id: "transaction_1",
    environment: "00",
    result: "ExitosaAprobada",
    amount_cents: 1000,
    donor_email: "donor@example.org",
    donor_name: "Donante",
    raw_body: "{}",
    headers_json: "{}",
    received_at: "2026-07-13T12:00:00.000Z",
    processed_at: null,
    created_document_id: null,
    issuance_status: null,
    control_prefix: null,
    control_sequence: null,
    reserved_numero_control: null,
    reserved_codigo_generacion: null,
    issuance_attempt_count: 0,
    issuance_error_code: null,
    issuance_error_message: null,
    issuance_last_attempt_at: null,
    issuance_failed_at: null,
    issuance_dead_lettered_at: null,
    ...overrides
  };
}

function withWompiIssuanceDefaults(
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

const WOMPI_ISSUANCE_FAILURE_FIELDS = [
  "id",
  "environment",
  "amount_cents",
  "donor_name",
  "donor_email",
  "received_at",
  "issuance_status",
  "issuance_attempt_count",
  "issuance_error_code",
  "issuance_error_message",
  "issuance_last_attempt_at",
  "issuance_failed_at",
  "issuance_dead_lettered_at",
  "reserved_numero_control"
] as const;

function wompiIssuanceFailureProjection(event: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    WOMPI_ISSUANCE_FAILURE_FIELDS.map((field) => [field, event[field] ?? null])
  );
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let boundValues: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          boundValues = values;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          const sqliteValues = boundValues.map((value) => {
            if (typeof value === "string" || typeof value === "number") return value;
            throw new TypeError("SQLite D1 test adapter only supports string and number binds");
          });
          return (database.prepare(query).get(...sqliteValues) ?? null) as T | null;
        }
      };
      return statement;
    }
  } as unknown as D1Database;
}

class InMemoryD1 {
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
  documentLookupCount = 0;
  wompiIssuanceFailureLookupCount = 0;
  wompiIssuanceRetryClaimCount = 0;
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
  beforeRejectedWompiClaim: (() => void | Promise<void>) | null = null;
  beforeWompiIssuanceClaim: (() => void | Promise<void>) | null = null;
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
    if (guardedUserMutation && this.beforeGuardedUserMutation) {
      const beforeMutation = this.beforeGuardedUserMutation;
      this.beforeGuardedUserMutation = null;
      await beforeMutation();
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

interface StatementRunResult {
  success: true;
  meta: { changes: number };
  results: never[];
}

class Statement {
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
      this.sql.includes("SET issuance_status = 'RETRY_QUEUED'") &&
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
          (row.issuance_status === "FAILED" || row.issuance_status === "DEAD_LETTERED")
      );
      if (!event) {
        return null;
      }
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
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("SET fiscal_operation_claim_id = ?") &&
      this.sql.includes("status = 'REJECTED'") &&
      this.sql.includes("fiscal_operation_claim_id IS NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      if (this.db.beforeRejectedWompiClaim) {
        await this.db.beforeRejectedWompiClaim();
      }
      const [claimId, claimedAt, updatedAt, documentId, wompiEventId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.wompi_event_id === wompiEventId &&
          row.status === "REJECTED" &&
          (row.fiscal_operation_claim_id ?? null) === null
      );
      if (!document) {
        return null;
      }
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
      this.sql.includes("SET codigo_generacion = ?") &&
      this.sql.includes("status = 'REJECTED'") &&
      this.sql.includes("fiscal_operation_claim_id = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [codigoGeneracion, numeroControl, plainJson, signedJws, updatedAt, documentId, wompiEventId, claimId] = this.args;
      const document = this.db.documents.find(
        (row) =>
          row.id === documentId &&
          row.wompi_event_id === wompiEventId &&
          row.status === "REJECTED" &&
          row.fiscal_operation_claim_id === claimId
      );
      if (!document) {
        return null;
      }
      document.codigo_generacion = String(codigoGeneracion);
      document.numero_control = String(numeroControl);
      document.plain_json = String(plainJson);
      document.signed_jws = signedJws === null ? null : String(signedJws);
      document.status = "SIGNED";
      document.sello_recibido = null;
      document.mh_estado = null;
      document.mh_observaciones_json = "[]";
      document.post_accept_finalized_at = null;
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
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs") && this.sql.includes("created_at >= ?")) {
      const [action, entityId, sinceIso] = this.args.map(String);
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
      intent.direccion_complemento = String(direccionComplemento);
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
      return (event ? wompiIssuanceFailureProjection(event) : null) as T | null;
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
    if (this.sql.includes("FROM donation_intents") && this.sql.includes("status IN ('PENDING','LINK_CREATED')") && this.sql.includes("expires_at < ?")) {
      // listIntentsExpiringBefore: same predicate as the EXPIRED update, projecting
      // the fields the deactivation sweep needs, capped oldest-first by the bound limit.
      const nowIso = String(this.args[0]);
      const limit = Number(this.args[1] ?? Number.POSITIVE_INFINITY);
      const rows = this.db.donationIntents
        .filter((intent) => (intent.status === "PENDING" || intent.status === "LINK_CREATED") && String(intent.expires_at) < nowIso)
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
      const [id, userId, tokenHash, expiresAt] = this.args.map(String);
      this.db.resetTokens.push({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
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
        const [usedAt, userId, markerUserId, expectedValue, expectedState, expectedVersion] = this.args;
        const marker = !this.sql.includes("EXISTS (")
          ? true
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
          created_at: "2026-06-26T01:46:47.015Z"
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
        created_at: "2026-06-26T01:46:47.015Z"
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
    if (this.sql.includes("INSERT INTO wompi_events")) {
      const [id, transactionId, environment, result, amountCents, donorEmail, donorName, rawBody, headersJson] = this.args;
      this.db.wompiEvents.push({
        id,
        transaction_id: transactionId,
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
      const [paidAt, updatedAt, id, expectedLinkId] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (
        intent &&
        intent.wompi_id_enlace === expectedLinkId &&
        (intent.status === "LINK_CREATED" || intent.status === "EXPIRED") &&
        (intent.paid_at == null || intent.paid_at === "")
      ) {
        intent.paid_at = paidAt == null ? null : String(paidAt);
        intent.updated_at = String(updatedAt);
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
      this.sql.includes("SET issuance_status = 'RETRY_QUEUED'") &&
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
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = String(attemptId);
        event.issuance_last_attempt_at = String(queuedAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_status = 'RETRY_QUEUED'") &&
      this.sql.includes("issuance_status IN ('FAILED', 'DEAD_LETTERED')")
    ) {
      const [attemptId, queuedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find(
        (row) =>
          row.id === wompiEventId &&
          row.created_document_id == null &&
          (row.issuance_status === "FAILED" || row.issuance_status === "DEAD_LETTERED")
      );
      if (event) {
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = String(attemptId);
        event.issuance_last_attempt_at = String(queuedAt);
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE wompi_events") &&
      this.sql.includes("SET issuance_status = 'RETRY_QUEUED'") &&
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
        (guardsExistingAttempt || event.processed_at == null) &&
        statusEligible &&
        String(event.issuance_last_attempt_at ?? event.received_at) < staleBefore
      ) {
        event.issuance_status = "RETRY_QUEUED";
        event.issuance_attempt_id = attemptId;
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

// Maps a retention-export SELECT's table name to its backing in-memory array,
// so the generic "ORDER BY created_at ASC, id ASC LIMIT ?" branch above can
// serve every table the retention service reads without one bespoke branch per table.
function retentionTableFor(db: InMemoryD1, sql: string): Array<Record<string, unknown>> | null {
  if (sql.includes("FROM dte_documents")) return db.documents as unknown as Array<Record<string, unknown>>;
  if (sql.includes("FROM donation_intents")) return db.donationIntents;
  if (sql.includes("FROM dte_events")) return db.dteEvents;
  if (sql.includes("FROM email_deliveries")) return db.emailDeliveries;
  if (sql.includes("FROM wompi_events")) return db.wompiEvents;
  if (sql.includes("FROM audit_logs")) return db.audits;
  if (sql.includes("FROM contingency_periods")) return db.contingencies;
  if (sql.includes("FROM contingency_batch_lines")) return db.contingencyBatchLines;
  if (sql.includes("FROM contingency_batches")) return db.contingencyBatches;
  return null;
}

function documentMatchesFtsQuery(document: DteDocumentRecord, query: string): boolean {
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

function advancedFailingDocument(id: string): DteDocumentRecord {
  return {
    ...testDocument(),
    id,
    wompi_event_id: null,
    status: "PENDING",
    signed_jws: null,
    sello_recibido: null,
    accepted_at: null,
    plain_json: JSON.stringify({
      emisor: advancedCdeDraft().emisor,
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: {
        fecEmi: "2026-06-26",
        horEmi: "19:50:00",
        ambiente: "00",
        codigoGeneracion: "11111111-1111-4111-8111-111111111111",
        numeroControl: "DTE-15-M001P004-000000000000999"
      }
    })
  };
}

function testAnalyticsIntent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "di_analytics",
    status: "COMPLETED",
    document_id: null,
    donor_document: "10000000-1",
    gift_type: "DIEZMO",
    created_at: "2026-06-10T17:50:00.000Z",
    paid_at: "2026-06-10T17:55:00.000Z",
    direccion_departamento: "06",
    donor_pais: null,
    ...overrides
  };
}

function analyticsDocumentRow(
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

function analyticsIntentRow(intent: Record<string, unknown>): Record<string, unknown> {
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

function analyticsIntentWithSerializedBytes(
  serializedBytes: number
): Record<string, unknown> {
  const intent = testAnalyticsIntent({
    id: "di_exact_byte_budget",
    donor_document: ""
  });
  const baseBytes =
    utf8Bytes(JSON.stringify(analyticsIntentRow(intent))).byteLength + 1;
  if (serializedBytes < baseBytes) {
    throw new Error("El presupuesto de prueba no alcanza para la fila base");
  }
  return {
    ...intent,
    donor_document: "a".repeat(serializedBytes - baseBytes)
  };
}

function testDocument(overrides: Partial<DteDocumentRecord> = {}): DteDocumentRecord {
  return {
    id: "doc_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: JSON.stringify({
      emisor: { nombre: "ExamplePerson1" },
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
    }),
    signed_jws: null,
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "legacy-contact-2@example.com",
    donor_name: "Example Person",
    amount_cents: 10000,
    issued_at: "2026-06-26T01:46:47.015Z",
    accepted_at: "2026-06-26T01:46:48.000Z",
    contingency_period_id: null,
    transmission_deferred_at: null,
    post_accept_finalized_at: "2026-06-26T01:46:49.000Z",
    transmission_claim_id: null,
    created_at: "2026-06-26T01:46:47.015Z",
    updated_at: "2026-06-26T01:46:48.000Z",
    ...overrides
  };
}

function advancedCdeDraft(): Record<string, unknown> {
  return {
    identificacion: {
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000999",
      codigoGeneracion: "11111111-1111-4111-8111-111111111111",
      tipoModelo: 1,
      tipoOperacion: 1,
      fecEmi: "2026-06-26",
      horEmi: "09:00:00",
      tipoMoneda: "USD"
    },
    emisor: {
      tipoDocumento: "36",
      numDocumento: "10000003520015",
      nrc: "2400001",
      nombre: "MISION EXAMPLEORGANIZATION",
      codActividad: "94910",
      descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
      nombreComercial: "MISION EXAMPLEORGANIZATION",
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
      },
      telefono: "70000002",
      correo: "legacy-contact-4@example.com",
      codEstable: "0002",
      codPuntoVenta: "0002"
    },
    receptor: {
      tipoDocumento: "13",
      numDocumento: "100000001",
      nrc: null,
      nombre: "Example Person Advanced",
      codActividad: null,
      descActividad: null,
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "SAN SALVADOR"
      },
      telefono: "70000001",
      correo: "advanced@example.org",
      codDomiciliado: 1,
      codPais: "SV"
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Referencia avanzada",
        detalleDocumento: "ADVANCED-TEST"
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: 1,
        cantidad: 1,
        codigo: "DIEZMO",
        uniMedida: 99,
        descripcion: "Diezmo avanzado",
        tipoDepreciacion: 0,
        valorUni: 123.45,
        valor: 123.45
      }
    ],
    resumen: {
      valorTotal: 123.45,
      totalLetras: null,
      pagos: [
        {
          codigo: "01",
          montoPago: 123.45,
          referencia: "ADVANCED"
        }
      ]
    },
    apendice: [
      { campo: "Origen", etiqueta: "Origen", valor: "DTE avanzado" }
    ]
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function signWompiBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)));
  return hexFromBytes(digest);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function generatedCertificateXml(password: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const passwordHash = hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-512", utf8Bytes(password))));
  return `<CertificadoMH><nit>12345678901234</nit><publicKey><encodied>${bytesToBase64(spki)}</encodied></publicKey><privateKey><encodied>${bytesToBase64(pkcs8)}</encodied><clave>${passwordHash}</clave></privateKey><activo>true</activo></CertificadoMH>`;
}

function emisorConfig() {
  return {
    tipoDocumento: "36",
    numDocumento: "10000003520015",
    nrc: "2400001",
    nombre: "MISION EXAMPLEORGANIZATION",
    codActividad: "94910",
    descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
    nombreComercial: "MISION EXAMPLEORGANIZATION",
    direccion: {
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
    },
    telefono: "70000002",
    correo: "legacy-contact-4@example.com",
    codEstable: "0002",
    codEstableMH: "M001",
    codPuntoVenta: "0002",
    codPuntoVentaMH: "P004",
    controlPrefix: "M001P004",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: 1,
    defaultUnidadMedida: 99,
    paymentMethodCode: "01",
    responsable: {
      nombre: "Example Person",
      tipoDocumento: "13",
      numeroDocumento: "100000001",
      tipoEstablecimiento: "02"
    }
  };
}
