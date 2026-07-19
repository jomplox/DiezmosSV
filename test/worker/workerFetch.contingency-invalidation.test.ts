import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { Repository } from "../../src/worker/storage/repository";
import { utf8Bytes } from "../../src/worker/utils/encoding";
import { makeDocument as testDocument } from "./fixtures";
import { emisorConfig, generatedCertificateXml } from "./support/dteFixtures";
import { TEST_RESEND_REQUEST_ID } from "./support/documentDeliveryFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { jsonResponse, sha256Hex } from "./support/workerFetchHelpers";

installWorkerFetchGlobals();

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
