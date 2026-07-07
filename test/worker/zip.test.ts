import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipStored } from "../../src/worker/utils/zip";

// The ZIP is round-tripped through the system `unzip` binary (present on macOS and
// ubuntu CI, same pattern as pdf.test.ts shelling out to poppler): `unzip -t` proves
// the archive listing + CRC integrity, `unzip -p` proves exact byte content.
describe("zipStored", () => {
  function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  it("produces an archive whose listing and per-file content round-trip through unzip", () => {
    const entries = [
      { name: "manifest.json", data: encode('{"month":"2026-04"}\n') },
      { name: "dte_documents.ndjson", data: encode("line1\nline2\n") },
      { name: "audit_logs.ndjson", data: encode("") }
    ];
    const zip = zipStored(entries);

    const dir = mkdtempSync(join(tmpdir(), "diezmos-zip-"));
    const zipPath = join(dir, "respaldo.zip");
    writeFileSync(zipPath, zip);

    // -t verifies every entry's stored CRC against its data and lists each name.
    const listing = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("dte_documents.ndjson");
    expect(listing).toContain("audit_logs.ndjson");
    expect(listing).toContain("No errors detected");

    // -p streams a single entry's raw bytes to stdout: exact content round-trip.
    const manifest = execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" });
    expect(manifest).toBe('{"month":"2026-04"}\n');
    const ndjson = execFileSync("unzip", ["-p", zipPath, "dte_documents.ndjson"], { encoding: "utf8" });
    expect(ndjson).toBe("line1\nline2\n");
    const empty = execFileSync("unzip", ["-p", zipPath, "audit_logs.ndjson"], { encoding: "utf8" });
    expect(empty).toBe("");
  });

  it("preserves binary (non-UTF-8) bytes exactly", () => {
    const binary = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x80, 0x7f, 0x0a, 0x0d]);
    const zip = zipStored([{ name: "blob.bin", data: binary }]);

    const dir = mkdtempSync(join(tmpdir(), "diezmos-zip-bin-"));
    const zipPath = join(dir, "b.zip");
    writeFileSync(zipPath, zip);
    execFileSync("unzip", ["-o", zipPath, "-d", dir]);
    // unzip restores the entry under its archived name.
    const roundTripped = new Uint8Array(readFileSync(join(dir, "blob.bin")));
    expect([...roundTripped]).toEqual([...binary]);
  });

  it("returns a well-formed empty archive (EOCD only) for zero entries", () => {
    const zip = zipStored([]);
    // An empty archive is exactly the 22-byte end-of-central-directory record with a
    // zero record count. (macOS `unzip -l` treats this as an error, so assert the
    // structure directly rather than shelling out.)
    expect(zip.length).toBe(22);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x06054b50); // EOCD signature
    expect(view.getUint16(10, true)).toBe(0); // total central directory records
  });
});
