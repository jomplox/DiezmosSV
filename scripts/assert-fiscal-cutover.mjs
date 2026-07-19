import { pathToFileURL } from "node:url";

export function assertFiscalCutoverQuiesced({ environment = process.env } = {}) {
  if (environment.FISCAL_CUTOVER_QUIESCED === "1") return;
  throw new Error(
    [
      "Fiscal claim cutover blocked: migrations 0020/0021 and the claim-aware Worker must be deployed in one quiesced maintenance window.",
      "Drain old Worker requests, pause queues/cron and mutating traffic, then acknowledge with FISCAL_CUTOVER_QUIESCED=1."
    ].join(" ")
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertFiscalCutoverQuiesced();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
