import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { Repository } from "../../src/worker/storage/repository";
import { utf8Bytes } from "../../src/worker/utils/encoding";
import type { IssuanceMessage } from "../../src/worker/types";
import {
  analyticsDocumentRow,
  analyticsIntentRow,
  authedDb,
  env,
  FakeArchiveBucket,
  InMemoryD1
} from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { wompiEventForReservation } from "./support/wompiEventFixtures";

installWorkerFetchGlobals();

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
    const db = authedDb(role, new InMemoryD1());
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

  function authed(role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER"): InMemoryD1 {
    return authedDb(role, new InMemoryD1());
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
