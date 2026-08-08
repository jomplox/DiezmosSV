import { describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import worker from "../../src/worker/index";
import { Repository } from "../../src/worker/storage/repository";
import type { IssuanceMessage } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();

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
      processed_at: "2026-07-13T22:06:52.000Z",
      issuance_status: status,
      issuance_attempt_count: 4,
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "La validación del esquema CDE falló",
      issuance_last_attempt_at: "2026-07-13T22:06:49.000Z",
      issuance_failed_at: "2026-07-13T22:06:49.000Z",
      issuance_dead_lettered_at: "2026-07-13T22:06:52.000Z",
      reserved_numero_control: "DTE-15-M001P004-000000000000031",
      correction_available: null,
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

  it("atomically rotates the stalled epoch when an OPERATOR retry claim succeeds", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      db.wompiEvents.push(failedWompiEvent({
        issuance_status: "FAILED",
        processed_at: null,
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      }));

      const response = await worker.fetch(
        new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
          method: "POST",
          headers: authorization
        }),
        env(db)
      );

      expect(response.status).toBe(202);
      expect(db.wompiEvents[0]).toMatchObject({
        issuance_status: "RETRY_QUEUED",
        issuance_last_attempt_at: "2026-07-14T10:00:00.000Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints a new monotonic stalled epoch for repeated OPERATOR retries in the same millisecond", async () => {
    vi.useFakeTimers();
    try {
      const boundary = "2026-07-14T10:00:00.000Z";
      vi.setSystemTime(new Date(boundary));
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      db.wompiEvents.push(failedWompiEvent({
        issuance_status: "FAILED",
        processed_at: null,
        issuance_last_attempt_at: boundary,
        stalled_requeue_epoch_at: boundary
      }));
      const queued: IssuanceMessage[] = [];
      const workerEnv = env(db, {
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>
      });
      const retry = () => worker.fetch(
        new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
          method: "POST",
          headers: authorization
        }),
        workerEnv
      );

      expect((await retry()).status).toBe(202);
      expect(db.wompiEvents[0]).toMatchObject({
        issuance_last_attempt_at: "2026-07-14T10:00:00.001Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.001Z"
      });

      Object.assign(db.wompiEvents[0], {
        issuance_status: "FAILED",
        issuance_error_code: "ISSUANCE_ERROR",
        issuance_error_message: "Fallo transitorio",
        processed_at: null
      });
      expect((await retry()).status).toBe(202);
      expect(db.wompiEvents[0]).toMatchObject({
        issuance_last_attempt_at: "2026-07-14T10:00:00.002Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.002Z"
      });
      expect(queued).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rotate the stalled epoch when the OPERATOR retry CAS loses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
      db.wompiEvents.push(failedWompiEvent({
        issuance_status: "FAILED",
        processed_at: null,
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      }));
      db.beforeWompiIssuanceRetryClaim = () => {
        db.wompiEvents[0].issuance_error_message = "Otro proceso cambió el fallo";
      };
      const queued: IssuanceMessage[] = [];

      const response = await worker.fetch(
        new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
          method: "POST",
          headers: authorization
        }),
        env(db, {
          ISSUANCE_QUEUE: {
            send: async (message: IssuanceMessage) => queued.push(message)
          } as unknown as Queue<IssuanceMessage>
        })
      );

      expect(response.status).toBe(409);
      expect(db.wompiEvents[0]).toMatchObject({
        issuance_last_attempt_at: "2026-07-13T22:06:49.000Z",
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      });
      expect(queued).toHaveLength(0);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_ISSUANCE_RETRY_QUEUED"
      )).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns correction_required when the failure becomes correctable between read and retry claim", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({
      issuance_status: "FAILED",
      processed_at: null,
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "El proveedor no respondió."
    }));
    db.beforeWompiIssuanceRetryClaim = () => {
      db.wompiEvents[0].issuance_error_code = "WOMPI_INVALID_DONOR_DUI";
      db.wompiEvents[0].issuance_error_message =
        "Los datos del donante contienen un DUI inválido.";
    };
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
        method: "POST",
        headers: authorization
      }),
      env(db, {
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "correction_required",
      message: "Corrija los datos del donante antes de reintentar la creación del CDE."
    });
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "FAILED",
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI"
    });
    expect(queued).toHaveLength(0);
  });

  it("projects correction availability without resolving bindings for transient failures", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const legacyPayload = {
      ...wompiSample,
      IdTransaccion: "list_legacy",
      Cliente: {
        ...wompiSample.Cliente,
        DocumentoIdentidad: "12345678-9"
      }
    };
    const boundPayload = {
      ...legacyPayload,
      IdTransaccion: "list_bound",
      IdExterno: "di_list_bound",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_list_bound"
      }
    };
    const unboundPayload = {
      ...legacyPayload,
      IdTransaccion: "list_unbound",
      IdExterno: "di_list_missing",
      EnlacePago: {
        Id: 987654,
        IdentificadorEnlaceComercio: "di_list_missing"
      }
    };
    db.donationIntents.push({
      id: "di_list_bound",
      status: "LINK_CREATED",
      wompi_id_enlace: 987654
    });
    db.wompiEvents.push(
      failedWompiEvent({
        id: "wompi_list_legacy",
        raw_body: JSON.stringify(legacyPayload),
        issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
        issuance_error_message: "Los datos del donante contienen un DUI inválido."
      }),
      failedWompiEvent({
        id: "wompi_list_bound",
        raw_body: JSON.stringify(boundPayload),
        issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
        issuance_error_message: "Los datos del donante contienen un DUI inválido."
      }),
      failedWompiEvent({
        id: "wompi_list_unbound",
        raw_body: JSON.stringify(unboundPayload),
        issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
        issuance_error_message: "Los datos del donante contienen un DUI inválido."
      }),
      failedWompiEvent({
        id: "wompi_list_transient",
        issuance_error_code: "ISSUANCE_ERROR",
        issuance_error_message: "El proveedor no respondió."
      })
    );
    const intentLookups = vi.spyOn(Repository.prototype, "getDonationIntent");

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/issuance-failures", {
        headers: authorization
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      failures: Array<{ id: string; correction_available: boolean | null }>;
    };
    expect(Object.fromEntries(
      body.failures.map((failure) => [failure.id, failure.correction_available])
    )).toEqual({
      wompi_list_bound: true,
      wompi_list_legacy: true,
      wompi_list_transient: null,
      wompi_list_unbound: false
    });
    expect(intentLookups).toHaveBeenCalledTimes(2);
    expect(intentLookups).toHaveBeenCalledWith("di_list_bound");
    expect(intentLookups).toHaveBeenCalledWith("di_list_missing");
  });

  it("queues a generic retry for a non-correctable legacy terminal row stuck in PROCESSING", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-13T22:06:52.000Z",
      issuance_attempt_id: "legacy-stuck-attempt",
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "El proveedor no respondió."
    }));
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
        method: "POST",
        headers: authorization
      }),
      env(db, {
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
    expect(db.wompiEvents[0]).toMatchObject({
      issuance_status: "RETRY_QUEUED",
      processed_at: null,
      issuance_attempt_id: expect.not.stringMatching(/^legacy-/)
    });
    expect(queued).toEqual([{
      wompiEventId: "wompi_failed",
      issuanceAttemptId: db.wompiEvents[0].issuance_attempt_id
    }]);
  });

  it.each([
    {
      label: "ordinary failed row",
      overrides: {
        issuance_status: "FAILED",
        processed_at: null
      }
    },
    {
      label: "legacy terminal row stuck in PROCESSING",
      overrides: {
        issuance_status: "PROCESSING",
        processed_at: "2026-07-13T22:06:52.000Z",
        issuance_attempt_id: "legacy-stuck-attempt"
      }
    }
  ])("requires guarded correction instead of generic retry for a correctable $label", async ({ overrides }) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.wompiEvents.push(failedWompiEvent({
      ...overrides,
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "Los datos del donante contienen un DUI inválido."
    }));
    const queued: IssuanceMessage[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/wompi-events/wompi_failed/retry", {
        method: "POST",
        headers: authorization
      }),
      env(db, {
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "correction_required",
      message: "Corrija los datos del donante antes de reintentar la creación del CDE."
    });
    expect(db.wompiIssuanceRetryClaimCount).toBe(0);
    expect(queued).toHaveLength(0);
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
        processed_at: null,
        issuance_last_attempt_at: db.wompiEvents[0].issuance_last_attempt_at
      })
    });
  });

  it("hides created events and unknown ids from the failure retry endpoint", async () => {
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

    expect(created.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(queued).toHaveLength(0);
    const createdBody = JSON.stringify(await created.json());
    expect(createdBody).not.toContain("donor_name");
    expect(createdBody).not.toContain("donor_email");
    expect(createdBody).not.toContain("amount_cents");
    expect(createdBody).not.toContain("reserved_numero_control");
    expect(createdBody).not.toContain("raw_body");
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
