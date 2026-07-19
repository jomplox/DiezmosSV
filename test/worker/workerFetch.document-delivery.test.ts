import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { EmailService } from "../../src/worker/services/email";
import { MhClient } from "../../src/worker/services/mhClient";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env } from "../../src/worker/types";
import { makeDocument as testDocument } from "./fixtures";
import {
  emailResendDb,
  resendDocument,
  TEST_RESEND_REQUEST_ID
} from "./support/documentDeliveryFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

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
      subject: "Comprobante de su donación DTE-15-M001P004-000000000000009",
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


function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
