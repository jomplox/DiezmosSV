import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { Repository } from "../../src/worker/storage/repository";
import type { DteDocumentRecord } from "../../src/worker/types";
import { makeDocument as testDocument } from "./fixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("document listing", () => {
  it("lists invalidated documents when that status is selected", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({ id: "doc_invalidated", status: "INVALIDATED" }),
      testDocument({ id: "doc_accepted", status: "ACCEPTED" })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=INVALIDATED", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const page = await response.json() as { documents: DteDocumentRecord[] };
    expect(page.documents.map((document) => document.id)).toEqual(["doc_invalidated"]);
  });

  it("rejects unbounded or unknown document status filters", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const request = (status: string) => worker.fetch(
      new Request(`https://example.org/api/documents?status=${status}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    for (const status of ["UNKNOWN", Array.from({ length: 150 }, () => "FAILED").join(",")]) {
      const response = await request(status);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_document_status" });
    }
  });

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

  it("returns bounded reconciliation guidance for a document owned by a failed Wompi correction", async () => {
    const db = new InMemoryD1();
    db.sessionUser = {
      id: "user_viewer",
      email: "viewer@example.org",
      name: "Viewer",
      role: "VIEWER"
    };
    db.documents.push(testDocument({
      id: "doc_failed_correction_detail",
      wompi_event_id: "wompi_failed_correction_detail",
      status: "PENDING",
      fiscal_operation_claim_id:
        "fiscal_correction_fiscal_correction_failed_detail",
      fiscal_operation_claimed_at: "2026-07-18T12:05:00.000Z",
      fiscal_operation_kind: "TRANSMISSION",
      fiscal_operation_event_id: null
    }));
    const lookup = vi
      .spyOn(Repository.prototype, "getFailedWompiFiscalCorrectionForDocument")
      .mockResolvedValue({
        id: "fiscal_correction_failed_detail",
        status: "FAILED",
        failureCode: "FISCAL_CORRECTION_EXISTING_DOCUMENT_MISMATCH",
        failureMessage:
          "El CDE preexistente no coincide con la corrección fiscal vigente o con la intención Wompi enlazada. Requiere reconciliación manual; no se transmitió a MH."
      });

    const response = await worker.fetch(
      new Request(
        "https://example.org/api/documents/doc_failed_correction_detail",
        { headers: { Authorization: "Bearer test-token" } }
      ),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(lookup).toHaveBeenCalledWith("doc_failed_correction_detail");
    await expect(response.json()).resolves.toMatchObject({
      fiscalReconciliation: {
        id: "fiscal_correction_failed_detail",
        status: "FAILED",
        failureCode: "FISCAL_CORRECTION_EXISTING_DOCUMENT_MISMATCH",
        failureMessage:
          "El CDE preexistente no coincide con la corrección fiscal vigente o con la intención Wompi enlazada. Requiere reconciliación manual; no se transmitió a MH."
      }
    });
  });
});
