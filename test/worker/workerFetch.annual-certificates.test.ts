import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { makeDocument as testDocument } from "./fixtures";
import { emisorConfig } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

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
    db.settings.push({ key: "email_reply_to", value: "legacy-contact-7@example.com" });
    seedYear(db);
    const sent: Array<{ to: string; subject: string; replyTo?: string; attachments?: Array<{ filename: string; type: string; content: Uint8Array }> }> = [];

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
    expect(sent[0].replyTo).toBe("legacy-contact-7@example.com");
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
