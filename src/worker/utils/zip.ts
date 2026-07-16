// Minimal ZIP writer (STORED method, no compression) for streaming a month's R2
// backup objects as a single archive. Deliberately dependency-free: a full DEFLATE
// implementation is unwarranted here (the NDJSON snapshots are already small and the
// download is occasional), and adding an npm dependency to a Cloudflare Worker for a
// once-in-a-while download is not worth the bundle/audit surface.
//
// Emits a standard PKZIP layout: for each entry a local file header + raw data, then
// one central-directory record per entry, then the end-of-central-directory record.
// STORED (method 0) means data is copied verbatim, so compressed size == uncompressed
// size and the CRC-32 is computed over the raw bytes. Only ASCII entry names are used
// by callers (retention table names + "manifest.json"); we still encode names as UTF-8
// and set the language-encoding flag so a non-ASCII name would round-trip correctly.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// Standard CRC-32 (IEEE 802.3, polynomial 0xEDB88320), table-driven. Built once at
// module load; ZIP local + central records store this over each entry's raw data.
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Builds the complete ZIP archive as one contiguous byte array. Pure: given the same
// entries it always returns identical bytes (no timestamps beyond the fixed DOS
// date/time constant below, so output is deterministic).
export function zipStored(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  // Fixed DOS date/time so the archive is reproducible. 0x0021 = 1980-01-01, the
  // minimum representable DOS date; time 0. Content integrity, not timestamps, is
  // what matters for a backup archive.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    localHeaderOffset: number;
  }

  const localChunks: Uint8Array[] = [];
  const prepared: Prepared[] = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeZipEntryName(entry.name);
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header signature
    view.setUint16(4, 20, true); // version needed to extract (2.0)
    view.setUint16(6, 0x0800, true); // general purpose flag: bit 11 = UTF-8 names
    view.setUint16(8, 0, true); // compression method: 0 = STORED
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true); // compressed size (== uncompressed for STORED)
    view.setUint32(22, data.length, true); // uncompressed size
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);

    prepared.push({ nameBytes, data, crc, localHeaderOffset: offset });
    localChunks.push(header, data);
    offset += header.length + data.length;
  }

  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const item of prepared) {
    const record = new Uint8Array(46 + item.nameBytes.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02014b50, true); // central directory header signature
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed to extract
    view.setUint16(8, 0x0800, true); // general purpose flag: UTF-8 names
    view.setUint16(10, 0, true); // compression method: STORED
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, item.crc, true);
    view.setUint32(20, item.data.length, true); // compressed size
    view.setUint32(24, item.data.length, true); // uncompressed size
    view.setUint16(28, item.nameBytes.length, true);
    view.setUint16(30, 0, true); // extra field length
    view.setUint16(32, 0, true); // file comment length
    view.setUint16(34, 0, true); // disk number start
    view.setUint16(36, 0, true); // internal file attributes
    view.setUint32(38, 0, true); // external file attributes
    view.setUint32(42, item.localHeaderOffset, true); // relative offset of local header
    record.set(item.nameBytes, 46);
    centralChunks.push(record);
    centralSize += record.length;
  }

  const centralOffset = offset;
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // end of central directory signature
  eocdView.setUint16(4, 0, true); // number of this disk
  eocdView.setUint16(6, 0, true); // disk with the start of the central directory
  eocdView.setUint16(8, prepared.length, true); // central dir records on this disk
  eocdView.setUint16(10, prepared.length, true); // total central dir records
  eocdView.setUint32(12, centralSize, true); // size of the central directory
  eocdView.setUint32(16, centralOffset, true); // offset of central directory
  eocdView.setUint16(20, 0, true); // ZIP file comment length

  return concat([...localChunks, ...centralChunks, eocd]);
}

function assertSafeZipEntryName(name: string): void {
  const segments = name.split("/");
  const unsafe = name.length === 0
    || name.includes("\0")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) {
    throw new Error(`ZIP entry name must be a safe relative path: ${JSON.stringify(name)}`);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    merged.set(chunk, position);
    position += chunk.length;
  }
  return merged;
}
