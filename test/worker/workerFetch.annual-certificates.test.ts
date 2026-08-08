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

  it("previews one bounded donor-summary page with truthful continuation fields", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      year: number;
      donors: Array<{ donorName: string; hasEmail: boolean; count: number; totalLabel: string; dossierTooLarge: boolean }>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(body).toMatchObject({ year: 2025, hasMore: false, nextCursor: null });
    const ana = body.donors.find((donor) => donor.donorName === "Ana");
    expect(ana).toMatchObject({ hasEmail: true, count: 2, totalLabel: "$100.01", dossierTooLarge: false });
    const sinCorreo = body.donors.find((donor) => donor.donorName === "Sin Correo");
    expect(sinCorreo).toMatchObject({ hasEmail: false, count: 1 });
    expect(body).not.toHaveProperty("donorCount");
    expect(body).not.toHaveProperty("totalLabel");
  });

  it("filters recipient keys with accent-insensitive search while keeping the match's complete-year aggregate", async () => {
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
      donors: Array<{ donorName: string; count: number; totalLabel: string }>;
      hasMore: boolean;
    };
    expect(body.donors).toEqual([
      expect.objectContaining({ donorName: "Ana", count: 2, totalLabel: "$100.01" })
    ]);
    expect(body.hasMore).toBe(false);
  });

  it("returns 50 donors and resumes after its keyset cursor without a duplicate", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    for (let index = 0; index < 51; index += 1) {
      const sequence = String(index).padStart(3, "0");
      db.documents.push(testDocument({
        id: `preview_${sequence}`,
        donor_email: `preview${sequence}@example.org`,
        donor_name: `Preview ${sequence}`,
        issued_at: "2025-04-01T16:00:00.000Z",
        numero_control: `DTE-15-M001P004-${sequence.padStart(15, "0")}`
      }));
    }

    const firstResponse = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );
    const first = (await firstResponse.json()) as { donors: Array<{ groupKey: string }>; hasMore: boolean; nextCursor: string | null };
    expect(first.donors).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("preview049@example.org");

    const secondResponse = await worker.fetch(
      new Request(`https://example.org/api/certificates/annual?year=2025&after=${encodeURIComponent(first.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );
    const second = (await secondResponse.json()) as { donors: Array<{ groupKey: string }>; hasMore: boolean; nextCursor: string | null };
    expect(second.donors.map((donor) => donor.groupKey)).toEqual(["preview050@example.org"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(second.donors.map((donor) => donor.groupKey)).not.toContain(first.nextCursor);
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

  it("sends one certificate per eligible email target and excludes no-email rows before processing", async () => {
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
    await expect(response.json()).resolves.toEqual({
      year: 2025,
      mode: "bulk",
      processed: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
      hasMore: false,
      nextCursor: null
    });
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
    // Already-sent and no-email recipients are excluded before the bounded target read.
    await expect(response.json()).resolves.toEqual({
      year: 2025,
      mode: "bulk",
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      hasMore: false,
      nextCursor: null
    });
    expect(sent).toHaveLength(0);
  });

  it("processes 10+1 eligible targets over two batches, then replay sends no duplicate", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    for (let index = 0; index < 11; index += 1) {
      const sequence = String(index).padStart(3, "0");
      db.documents.push(testDocument({
        id: `bulk_${sequence}`,
        donor_email: `bulk${sequence}@example.org`,
        donor_name: `Bulk ${sequence}`,
        issued_at: `2025-03-${String(index + 1).padStart(2, "0")}T16:00:00.000Z`,
        numero_control: `DTE-15-M001P004-${sequence.padStart(15, "0")}`
      }));
    }
    const sent: string[] = [];
    const workerEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL: {
        send: async (message: unknown) => {
          sent.push((message as { to: string }).to);
          return { messageId: `cf-cert-${sent.length}` };
        }
      } as SendEmail
    });

    const firstResponse = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({})
      }),
      workerEnv
    );
    const first = (await firstResponse.json()) as {
      processed: number;
      sent: number;
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(first).toMatchObject({ processed: 10, sent: 10, hasMore: true, nextCursor: "bulk009@example.org" });
    expect(sent).toHaveLength(10);

    const secondResponse = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ after: first.nextCursor })
      }),
      workerEnv
    );
    await expect(secondResponse.json()).resolves.toEqual({
      year: 2025,
      mode: "bulk",
      processed: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
      hasMore: false,
      nextCursor: null
    });
    expect(sent).toHaveLength(11);
    expect(new Set(sent).size).toBe(11);

    const replayResponse = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ after: first.nextCursor })
      }),
      workerEnv
    );
    await expect(replayResponse.json()).resolves.toMatchObject({ processed: 0, sent: 0, hasMore: false, nextCursor: null });
    expect(sent).toHaveLength(11);

    const runAudits = db.audits.filter((audit) => audit.action === "DONOR_CERTIFICATES_RUN");
    expect(runAudits).toHaveLength(3);
    for (const audit of runAudits) {
      const metadata = JSON.parse(String(audit.metadata_json ?? "{}")) as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual([
        "failed",
        "hasMore",
        "mode",
        "processed",
        "sent",
        "skipped"
      ]);
      expect(metadata).not.toHaveProperty("after");
      expect(metadata).not.toHaveProperty("nextCursor");
      expect(metadata).not.toHaveProperty("groupKey");
      expect(metadata).not.toHaveProperty("donorGroupKey");
      expect(audit.summary).not.toContain("bulk009@example.org");
    }
  });

  it("performs a final sent-audit recheck and skips a target that races after selection", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument({
      id: "race_target",
      donor_email: "race@example.org",
      donor_name: "Race",
      issued_at: "2025-03-01T16:00:00.000Z"
    }));
    let injected = false;
    db.beforeAuditCount = async (action, entityId) => {
      if (!injected && action === "DONOR_CERTIFICATE_SENT" && entityId === "2025:race@example.org") {
        injected = true;
        db.audits.push({
          id: "race_winner",
          actor_type: "SYSTEM",
          actor_id: null,
          action,
          entity_type: "donor_certificate",
          entity_id: entityId,
          summary: "concurrent send",
          created_at: "2026-07-05T11:59:59.000Z"
        });
      }
    };
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
        EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "unexpected" }; } } as SendEmail
      })
    );

    await expect(response.json()).resolves.toMatchObject({ processed: 1, sent: 0, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("fails an oversized bulk dossier before PDF/email, audits it, and continues later targets", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    for (let index = 0; index < 26; index += 1) {
      db.documents.push(testDocument({
        id: `oversized_${index}`,
        donor_email: "a-oversized@example.org",
        donor_name: "Oversized",
        issued_at: `2025-01-${String(index + 1).padStart(2, "0")}T16:00:00.000Z`,
        numero_control: `DTE-15-M001P004-${String(index).padStart(15, "0")}`,
        plain_json: "not-json-so-rendering-would-fail"
      }));
    }
    db.documents.push(testDocument({
      id: "oversized_next",
      donor_email: "b-next@example.org",
      donor_name: "Next",
      issued_at: "2025-12-01T16:00:00.000Z",
      numero_control: "DTE-15-M001P004-999999999999999"
    }));
    const sent: string[] = [];

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
            sent.push((message as { to: string }).to);
            return { messageId: "cf-cert-next" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 2, sent: 1, skipped: 0, failed: 1 });
    expect(sent).toEqual(["b-next@example.org"]);
    expect(db.preparedSql.filter((sql) => sql.includes("annual_certificate_documents"))).toHaveLength(1);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DONOR_CERTIFICATE_FAILED",
      entity_id: "2025:a-oversized@example.org",
      summary: expect.stringMatching(/límite de 25 comprobantes/i)
    }));
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
    await expect(response.json()).resolves.toEqual({
      year: 2025,
      mode: "single",
      processed: 1,
      sent: 1,
      skipped: 0,
      failed: 0,
      hasMore: false,
      nextCursor: null
    });
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

  it("returns the exact 422 before PDF/email for an oversized explicit dossier", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    for (let index = 0; index < 26; index += 1) {
      db.documents.push(testDocument({
        id: `single_oversized_${index}`,
        donor_email: "single-oversized@example.org",
        donor_name: "Single Oversized",
        issued_at: `2025-02-${String(index + 1).padStart(2, "0")}T16:00:00.000Z`,
        numero_control: `DTE-15-M001P004-${String(index + 100).padStart(15, "0")}`,
        plain_json: "not-json-so-rendering-would-fail"
      }));
    }
    const sent: unknown[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "single-oversized@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: { send: async (message: unknown) => { sent.push(message); return { messageId: "unexpected" }; } } as SendEmail
      })
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "certificate_dossier_too_large",
      message: expect.stringMatching(/límite de 25 comprobantes/i)
    });
    expect(sent).toHaveLength(0);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "DONOR_CERTIFICATE_FAILED",
      entity_id: "2025:single-oversized@example.org"
    }));
  });

  it.each([
    { label: "both donor and after", body: { donor: "ana@example.org", after: "cursor@example.org" } },
    { label: "non-string donor", body: { donor: 42 } },
    { label: "unknown field", body: { cursor: "ana@example.org" } }
  ])("rejects an invalid send body: $label", async ({ body }) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_certificate_send_request" });
  });

  it("rejects malformed JSON instead of treating it as an empty bulk request", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: "{not-json"
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json_body" });
  });
});
