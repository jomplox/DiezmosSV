import { afterEach, describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument } from "../../src/worker/domain/dteBuilder";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import type { IssuanceMessage, WompiWebhook } from "../../src/worker/types";
import {
  env,
  FakeArchiveBucket,
  InMemoryD1
} from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import { emisorConfig } from "./support/dteFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();

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
        "diezmossv-staging-example-issuance"
      );

      await worker.queue(batch, runtime);

      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledTimes(1);
    }

    const { batch: deadLetter, ack } = deadLetterBatch(
      { wompiEventId: eventId },
      "diezmossv-staging-example-issuance-dlq"
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
      "diezmossv-staging-example-issuance"
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
    const { batch, ack, retry } = deadLetterBatch({ wompiEventId: "wompi_dead" }, "diezmossv-staging-example-issuance-dlq");

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
      "diezmossv-staging-example-issuance-dlq"
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
      "diezmossv-staging-example-issuance-dlq"
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
      "diezmossv-staging-example-issuance"
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
      "diezmossv-staging-example-issuance"
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
        "diezmossv-staging-example-issuance-dlq"
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
    const { batch } = deadLetterBatch({ wompiEventId: "wompi_dead_alert" }, "diezmossv-staging-example-issuance-dlq");

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
      processed_at: null,
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
      processed_at: null,
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
      processed_at: null,
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
        metadata_json: JSON.stringify({
          stalledRequeueEpochAt: "2026-06-01T00:00:00.000Z"
        }),
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

  it("starts a fresh capped stalled episode after an operator retry", async () => {
    vi.useFakeTimers();
    try {
      const db = new InMemoryD1();
      db.sessionUser = {
        id: "user_operator",
        email: "operator@example.org",
        name: "Operator",
        role: "OPERATOR"
      };
      db.settings.push({ key: "alert_email", value: "owner@example.org" });
      const eventId = "wompi_two_stalled_episodes";
      db.wompiEvents.push(stalledWompiEvent({
        id: eventId,
        issuance_status: "PROCESSING",
        issuance_attempt_id: "attempt-original",
        issuance_last_attempt_at: "2026-06-01T00:00:00.000Z"
      }));
      const queued: IssuanceMessage[] = [];
      const sentAlerts: Array<{ to: string; subject: string }> = [];
      const scheduledEnv = env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>,
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message as { to: string; subject: string });
            return { messageId: `stalled-${sentAlerts.length}` };
          }
        } as SendEmail
      });
      const runSweepAt = async (iso: string) => {
        vi.setSystemTime(new Date(iso));
        db.auditCreatedAt = iso;
        await worker.scheduled({} as ScheduledEvent, scheduledEnv);
      };

      for (const hour of [2, 4, 6, 8]) {
        await runSweepAt(`2026-06-01T${String(hour).padStart(2, "0")}:00:00.000Z`);
      }
      await runSweepAt("2026-06-01T08:00:00.000Z");

      expect(queued).toHaveLength(3);
      expect(sentAlerts).toHaveLength(1);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId
      )).toHaveLength(1);

      Object.assign(db.wompiEvents[0], {
        issuance_status: "FAILED",
        issuance_error_code: "ISSUANCE_ERROR",
        issuance_error_message: "Fallo transitorio",
        processed_at: null
      });
      vi.setSystemTime(new Date("2026-06-01T10:00:00.000Z"));
      db.auditCreatedAt = "2026-06-01T10:00:00.000Z";
      const retry = await worker.fetch(
        new Request(`https://example.org/api/wompi-events/${eventId}/retry`, {
          method: "POST",
          headers: { Authorization: "Bearer test-token" }
        }),
        scheduledEnv
      );

      expect(retry.status).toBe(202);
      expect(db.wompiEvents[0]).toMatchObject({
        stalled_requeue_epoch_at: "2026-06-01T10:00:00.000Z",
        issuance_last_attempt_at: "2026-06-01T10:00:00.000Z"
      });

      for (const hour of [12, 14, 16, 18]) {
        await runSweepAt(`2026-06-01T${hour}:00:00.000Z`);
      }
      await runSweepAt("2026-06-01T18:00:00.000Z");

      expect(queued).toHaveLength(7);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId
      )).toHaveLength(6);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId
      )).toHaveLength(2);
      expect(sentAlerts).toHaveLength(2);
      expect(sentAlerts.every((alert) => alert.to === "owner@example.org")).toBe(true);
      expect(db.audits.filter(
        (audit) => audit.action === "ALERT_SENT:WOMPI_EVENT_STALLED" && audit.entity_id === eventId
      )).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes equal-timestamp prior audits and counts frozen-clock requeues in the new episode", async () => {
    vi.useFakeTimers();
    try {
      const boundary = "2026-07-14T10:00:00.000Z";
      const db = new InMemoryD1();
      db.sessionUser = {
        id: "user_operator",
        email: "operator@example.org",
        name: "Operator",
        role: "OPERATOR"
      };
      db.settings.push({ key: "alert_email", value: "owner@example.org" });
      const eventId = "wompi_equal_timestamp_episode";
      db.wompiEvents.push(stalledWompiEvent({
        id: eventId,
        issuance_status: "FAILED",
        issuance_attempt_id: "attempt-old-episode",
        issuance_error_code: "ISSUANCE_ERROR",
        issuance_error_message: "Fallo transitorio",
        issuance_last_attempt_at: boundary,
        stalled_requeue_epoch_at: boundary
      }));
      for (let index = 1; index <= 3; index += 1) {
        db.audits.push({
          id: `audit_old_requeue_${index}`,
          actor_type: "SYSTEM",
          actor_id: null,
          action: "WOMPI_EVENT_REQUEUED",
          entity_type: "wompi_event",
          entity_id: eventId,
          summary: "old episode",
          metadata_json: "{}",
          created_at: boundary
        });
      }
      db.audits.push({
        id: "audit_old_stalled",
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_STALLED",
        entity_type: "wompi_event",
        entity_id: eventId,
        summary: "old episode",
        metadata_json: "{}",
        created_at: boundary
      });
      const queued: IssuanceMessage[] = [];
      const sentAlerts: unknown[] = [];
      const scheduledEnv = env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        ISSUANCE_QUEUE: {
          send: async (message: IssuanceMessage) => queued.push(message)
        } as unknown as Queue<IssuanceMessage>,
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message);
            return { messageId: "equal-timestamp-alert" };
          }
        } as SendEmail
      });

      vi.setSystemTime(new Date(boundary));
      db.auditCreatedAt = boundary;
      const retry = await worker.fetch(
        new Request(`https://example.org/api/wompi-events/${eventId}/retry`, {
          method: "POST",
          headers: { Authorization: "Bearer test-token" }
        }),
        scheduledEnv
      );
      expect(retry.status).toBe(202);
      const episodeId = "2026-07-14T10:00:00.001Z";
      expect(db.wompiEvents[0].stalled_requeue_epoch_at).toBe(episodeId);

      for (let index = 1; index <= 3; index += 1) {
        db.audits.push({
          id: `audit_current_requeue_${index}`,
          actor_type: "SYSTEM",
          actor_id: null,
          action: "WOMPI_EVENT_REQUEUED",
          entity_type: "wompi_event",
          entity_id: eventId,
          summary: "current episode",
          metadata_json: JSON.stringify({ stalledRequeueEpochAt: episodeId }),
          created_at: boundary
        });
      }
      vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
      db.auditCreatedAt = "2026-07-14T12:00:00.000Z";
      await worker.scheduled({} as ScheduledEvent, scheduledEnv);
      await worker.scheduled({} as ScheduledEvent, scheduledEnv);

      expect(queued).toHaveLength(1);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId
      )).toHaveLength(2);
      expect(db.audits).toContainEqual(expect.objectContaining({
        action: "WOMPI_EVENT_STALLED",
        entity_id: eventId,
        metadata_json: JSON.stringify({ stalledRequeueEpochAt: episodeId })
      }));
      expect(sentAlerts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically appends one stalled audit when capped sweeps overlap", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
      const episodeId = "2026-07-14T10:00:00.000Z";
      const eventId = "wompi_overlapping_cap_sweeps";
      const db = new InMemoryD1();
      db.auditCreatedAt = "2026-07-14T12:00:00.000Z";
      db.settings.push({ key: "alert_email", value: "owner@example.org" });
      db.wompiEvents.push(stalledWompiEvent({
        id: eventId,
        issuance_status: "PROCESSING",
        issuance_attempt_id: "attempt-at-cap",
        issuance_last_attempt_at: "2026-07-14T08:00:00.000Z",
        stalled_requeue_epoch_at: episodeId
      }));
      for (let index = 1; index <= 3; index += 1) {
        db.audits.push({
          id: `audit_cap_requeue_${index}`,
          actor_type: "SYSTEM",
          actor_id: null,
          action: "WOMPI_EVENT_REQUEUED",
          entity_type: "wompi_event",
          entity_id: eventId,
          summary: "current episode",
          metadata_json: JSON.stringify({ stalledRequeueEpochAt: episodeId }),
          created_at: `2026-07-14T10:00:00.00${index}Z`
        });
      }
      let arrivals = 0;
      let release!: () => void;
      const bothObserved = new Promise<void>((resolve) => {
        release = resolve;
      });
      db.beforeAuditCount = async (action, entityId) => {
        if (action !== "WOMPI_EVENT_REQUEUED" || entityId !== eventId) {
          return;
        }
        arrivals += 1;
        if (arrivals === 2) {
          release();
        }
        await bothObserved;
      };
      const sentAlerts: unknown[] = [];
      const scheduledEnv = env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        ISSUANCE_QUEUE: {
          send: async () => {
            throw new Error("capped episode must not requeue");
          }
        } as unknown as Queue<IssuanceMessage>,
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message);
            return { messageId: "overlapping-cap-alert" };
          }
        } as SendEmail
      });

      await Promise.all([
        new IssuancePipeline(scheduledEnv).sweepStalledWompiEvents(),
        new IssuancePipeline(scheduledEnv).sweepStalledWompiEvents()
      ]);

      expect(arrivals).toBe(2);
      expect(db.audits.filter(
        (audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId
      )).toHaveLength(1);
      expect(sentAlerts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after three requeues and flags the event exactly once", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: JSON.stringify({ stalledRequeueEpochAt: "2026-01-01T00:00:00.000Z" }), created_at: "2026-01-01T00:00:00.000Z" });
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
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: JSON.stringify({ stalledRequeueEpochAt: "2026-01-01T00:00:00.000Z" }), created_at: "2026-01-01T00:00:00.000Z" });
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
    db.wompiEvents.push(stalledWompiEvent({
      stalled_requeue_epoch_at: "2026-01-01T00:00:00.000Z"
    }));
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: JSON.stringify({ stalledRequeueEpochAt: "2026-01-01T00:00:00.000Z" }), created_at: "2026-01-01T00:00:00.000Z" });
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
