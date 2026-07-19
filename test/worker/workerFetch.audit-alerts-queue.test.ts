import { describe, expect, it, vi } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument } from "../../src/worker/domain/dteBuilder";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { MhClient } from "../../src/worker/services/mhClient";
import { Repository } from "../../src/worker/storage/repository";
import type { WompiWebhook } from "../../src/worker/types";
import { makeDocument as testDocument } from "./fixtures";
import {
  advancedCdeDraft,
  advancedFailingDocument,
  emisorConfig,
  generatedCertificateXml
} from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { jsonResponse, signWompiBody } from "./support/workerFetchHelpers";

installWorkerFetchGlobals();

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

  it("does not auto-transmit a claimed SIGNED row whose fiscal outcome needs reconciliation", async () => {
    const db = new InMemoryD1();
    // A worker crash between claiming the transmission and recording MH's verdict
    // leaves the row SIGNED with the fiscal claim still attached. The sweep must
    // leave it for reconciliation instead of risking a duplicate fiscal POST.
    db.documents.push(testDocument({
      id: "dte_claimed_crash_gap",
      wompi_event_id: null,
      status: "SIGNED",
      signed_jws: "claimed-signed-jws",
      sello_recibido: null,
      accepted_at: null,
      donor_email: null,
      transmission_deferred_at: "2026-07-13T20:00:00.000Z",
      fiscal_operation_claim_id: "fiscal-claim-crash",
      fiscal_operation_claimed_at: "2026-07-13T20:01:00.000Z",
      fiscal_operation_kind: "TRANSMISSION"
    }));

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
      fiscal_operation_claim_id: "fiscal-claim-crash"
    });
  });
});
