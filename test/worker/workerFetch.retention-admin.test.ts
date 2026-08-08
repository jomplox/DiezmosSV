import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { elSalvadorMonth } from "../../src/worker/services/retention";
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
  function seedManifest(archive: FakeArchiveBucket, month: string, tables: Record<string, { rowCount: number; body: string }>): Promise<void> {
    return (async () => {
      const prefix = `retention/${month.slice(0, 4)}/${month}`;
      const manifestTables: Record<string, { rowCount: number; sha256: string }> = {};
      for (const [table, { rowCount, body }] of Object.entries(tables)) {
        const bytes = utf8Bytes(body);
        await archive.put(`${prefix}/${table}.ndjson`, bytes);
        manifestTables[table] = { rowCount, sha256: await sha256Hex(bytes) };
      }
      const manifest = { month, generatedAt: `${month}-28T09:00:00.000Z`, tables: manifestTables };
      await archive.put(`${prefix}/manifest.json`, utf8Bytes(JSON.stringify(manifest)));
    })();
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
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "row\n" },
      audit_logs: { rowCount: 0, body: "" }
    });

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
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFIED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("reports a mismatch, audits RETENTION_VERIFY_FAILED, and sends an operational alert when an object is corrupted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "row\n" } });
    // Corrupt the stored object's bytes so its SHA-256 no longer matches the manifest.
    await archive.put("retention/2026/2026-04/dte_documents.ndjson", utf8Bytes("tampered\n"));

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
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });
    archive.sizeOverrides.set("retention/2026/2026-04/dte_documents.ndjson", 32 * 1024 * 1024 + 1);

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
