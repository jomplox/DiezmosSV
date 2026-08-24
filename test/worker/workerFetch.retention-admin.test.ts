import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import {
  RETENTION_CANONICAL_TABLES,
  elSalvadorMonth,
  type RetentionManifest
} from "../../src/worker/services/retention";
import { utf8Bytes } from "../../src/worker/utils/encoding";
import type { Env } from "../../src/worker/types";
import { env, FakeArchiveBucket, InMemoryD1 } from "./support/inMemoryD1";
import { makeDocument as testDocument } from "./fixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { sha256Hex } from "./support/workerFetchHelpers";

installWorkerFetchGlobals();

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
    // handler itself uses — so this test targets "now"'s own month regardless
    // of when it runs.
    const currentMonth = elSalvadorMonth(new Date());

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
  function seedManifest(
    archive: FakeArchiveBucket,
    month: string,
    tables: Record<string, { rowCount: number; body: string }> = {}
  ): Promise<RetentionManifest> {
    return (async () => {
      const prefix = `retention/${month.slice(0, 4)}/${month}`;
      const runId = "11111111-1111-4111-8111-111111111111";
      const manifestTables: RetentionManifest["tables"] = {};
      for (const table of RETENTION_CANONICAL_TABLES) {
        const { rowCount, body } = tables[table] ?? { rowCount: 0, body: "" };
        const bytes = utf8Bytes(body);
        const key = `${prefix}/runs/${runId}/${table}.ndjson`;
        await archive.put(key, bytes);
        manifestTables[table] = { key, rowCount, sha256: await sha256Hex(bytes) };
      }
      const manifest: RetentionManifest = {
        version: 2,
        runId,
        month,
        generatedAt: `${month}-28T09:00:00.000Z`,
        tables: manifestTables
      };
      await archive.put(`${prefix}/manifest.json`, utf8Bytes(JSON.stringify(manifest)));
      return manifest;
    })();
  }

  async function seedCompletionAnchor(
    db: InMemoryD1,
    manifest: RetentionManifest,
    kind: "new" | "legacy" = "new"
  ): Promise<void> {
    const totalRows = Object.values(manifest.tables).reduce((sum, entry) => sum + entry.rowCount, 0);
    const metadata = kind === "new"
      ? {
          month: manifest.month,
          runId: manifest.runId,
          generatedAt: manifest.generatedAt,
          totalRows,
          tables: manifest.tables,
          manifestSha256: await sha256Hex(utf8Bytes(JSON.stringify(manifest)))
        }
      : { month: manifest.month, totalRows, tables: manifest.tables };
    db.audits.push({
      id: `audit_anchor_${kind}`,
      action: "RETENTION_EXPORT_COMPLETED",
      entity_type: "retention_export",
      entity_id: manifest.month,
      metadata_json: JSON.stringify(metadata),
      created_at: "2026-07-01T09:00:04.000Z"
    });
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
    const currentMonth = elSalvadorMonth(new Date());
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

  it("does not list, resolve a table from, or ZIP a present-invalid manifest", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument({ id: "doc_invalid_manifest", created_at: "2026-04-10T12:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "must not escape\n" } });
    await archive.put("retention/2026/2026-04/manifest.json", utf8Bytes(JSON.stringify({
      version: 2,
      runId: "11111111-1111-4111-8111-111111111111",
      month: "2026-04",
      generatedAt: "2026-05-01T09:00:00.000Z",
      tables: {}
    })));
    const workerEnv = env(db, { ARCHIVE: archive as unknown as R2Bucket });
    const headers = { Authorization: "Bearer test-token" };

    const listResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers }),
      workerEnv
    );
    const listPayload = (await listResponse.json()) as { months: Array<{ month: string; status: string }> };
    expect(listPayload.months.find((entry) => entry.month === "2026-04")).toMatchObject({ status: "faltante" });

    const tableResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", { headers }),
      workerEnv
    );
    expect(tableResponse.status).toBe(404);

    const zipResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", { headers }),
      workerEnv
    );
    expect(zipResponse.status).toBe(404);
    expect(db.audits.filter((row) => row.action === "RETENTION_DOWNLOADED")).toHaveLength(0);
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
    const manifest = await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "row\n" },
      audit_logs: { rowCount: 0, body: "" }
    });
    await seedCompletionAnchor(db, manifest);

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
    expect(payload.files.map((file) => file.table)).toEqual(RETENTION_CANONICAL_TABLES);
    expect(archive.getCalls).toEqual([
      "retention/2026/2026-04/manifest.json",
      ...RETENTION_CANONICAL_TABLES.map((table) => manifest.tables[table].key)
    ]);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFIED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("verifies a strict manifest against an exact legacy completion anchor", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    const manifest = await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "legacy anchored row\n" }
    });
    await seedCompletionAnchor(db, manifest, "legacy");

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.audits.filter((row) => row.action === "RETENTION_VERIFIED")).toHaveLength(1);
  });

  it.each([
    ["present invalid manifest", async (_db: InMemoryD1, archive: FakeArchiveBucket) => {
      await seedManifest(archive, "2026-04");
      await archive.put("retention/2026/2026-04/manifest.json", utf8Bytes(JSON.stringify({
        version: 2,
        runId: "11111111-1111-4111-8111-111111111111",
        month: "2026-04",
        generatedAt: "2026-05-01T09:00:00.000Z",
        tables: {}
      })));
    }, "manifest_invalid"],
    ["missing D1 anchor", async (_db: InMemoryD1, archive: FakeArchiveBucket) => {
      await seedManifest(archive, "2026-04");
    }, "anchor_missing"],
    ["malformed latest D1 anchor", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      db.audits.push({
        id: "audit_anchor_malformed_latest",
        action: "RETENTION_EXPORT_COMPLETED",
        entity_type: "retention_export",
        entity_id: "2026-04",
        metadata_json: "{",
        created_at: "2026-07-01T09:00:05.000Z"
      });
    }, "anchor_invalid"],
    ["malformed new D1 anchor", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      const anchor = db.audits.at(-1)!;
      const metadata = JSON.parse(String(anchor.metadata_json)) as Record<string, unknown>;
      delete metadata.generatedAt;
      anchor.metadata_json = JSON.stringify(metadata);
    }, "anchor_invalid"],
    ["malformed legacy D1 anchor", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest, "legacy");
      const anchor = db.audits.at(-1)!;
      const metadata = JSON.parse(String(anchor.metadata_json)) as { tables: RetentionManifest["tables"] };
      delete metadata.tables.audit_logs;
      anchor.metadata_json = JSON.stringify(metadata);
    }, "anchor_invalid"],
    ["anchor run mismatch", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      const anchor = db.audits.at(-1)!;
      const metadata = JSON.parse(String(anchor.metadata_json)) as { runId: string };
      metadata.runId = "22222222-2222-4222-8222-222222222222";
      anchor.metadata_json = JSON.stringify(metadata);
    }, "anchor_mismatch"],
    ["anchor table mismatch", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      const anchor = db.audits.at(-1)!;
      const metadata = JSON.parse(String(anchor.metadata_json)) as { tables: RetentionManifest["tables"] };
      metadata.tables.audit_logs.rowCount = 1;
      anchor.metadata_json = JSON.stringify(metadata);
    }, "anchor_mismatch"],
    ["anchor digest mismatch", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      const anchor = db.audits.at(-1)!;
      const metadata = JSON.parse(String(anchor.metadata_json)) as { manifestSha256: string };
      metadata.manifestSha256 = "b".repeat(64);
      anchor.metadata_json = JSON.stringify(metadata);
    }, "anchor_mismatch"],
    ["forged manifest and matching forged body", async (db: InMemoryD1, archive: FakeArchiveBucket) => {
      const manifest = await seedManifest(archive, "2026-04");
      await seedCompletionAnchor(db, manifest);
      const forgedBody = utf8Bytes("forged but internally consistent\n");
      manifest.tables.audit_logs.rowCount = 1;
      manifest.tables.audit_logs.sha256 = await sha256Hex(forgedBody);
      await archive.put(manifest.tables.audit_logs.key, forgedBody);
      await archive.put("retention/2026/2026-04/manifest.json", utf8Bytes(JSON.stringify(manifest)));
    }, "anchor_mismatch"]
  ])("fails closed before table-body reads for %s", async (_name, arrange, reason) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const archive = new FakeArchiveBucket();
    await arrange(db, archive);
    const sent: unknown[] = [];

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
            return { messageId: "alert-anchor" };
          }
        } as unknown as Env["EMAIL"]
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false, reason, files: [] });
    expect(archive.getCalls).toEqual(["retention/2026/2026-04/manifest.json"]);
    expect(db.audits.filter((row) => row.action === "RETENTION_VERIFY_FAILED")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "RETENTION_VERIFIED")).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const failed = db.audits.find((row) => row.action === "RETENTION_VERIFY_FAILED")!;
    expect(JSON.parse(String(failed.metadata_json))).toMatchObject({ month: "2026-04", reason });
  });

  it("reports a mismatch, audits RETENTION_VERIFY_FAILED, and sends an operational alert when an object is corrupted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const archive = new FakeArchiveBucket();
    const manifest = await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "row\n" } });
    await seedCompletionAnchor(db, manifest);
    // Corrupt the stored object's bytes so its SHA-256 no longer matches the manifest.
    await archive.put(manifest.tables.dte_documents.key, utf8Bytes("tampered\n"));

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

  it.each(["fiscal_corrections_latest", "document_sequences"])(
    "downloads the manifested restore-critical table %s",
    async (table) => {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
      const archive = new FakeArchiveBucket();
      await seedManifest(archive, "2026-04", { [table]: { rowCount: 1, body: "restore row\n" } });

      const response = await worker.fetch(
        new Request(`https://example.org/api/admin/backups/2026-04/download?table=${table}`, {
          headers: { Authorization: "Bearer test-token" }
        }),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("restore row\n");
      expect(db.audits).toContainEqual(
        expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
      );
    }
  );

  it("does not download an archive object omitted from the month manifest", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "manifested\n" } });
    await archive.put("retention/2026/2026-04/debug_dump.ndjson", "sensitive unmanifested data\n");

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=debug_dump", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "RETENTION_DOWNLOADED" }));
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
    const manifest = await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });
    archive.sizeOverrides.set(manifest.tables.dte_documents.key, 32 * 1024 * 1024 + 1);

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
