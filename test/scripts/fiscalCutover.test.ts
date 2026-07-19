import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/assert-fiscal-cutover.mjs";

describe("assert-fiscal-cutover", () => {
  it("blocks standard remote commands until the maintenance window is acknowledged", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, FISCAL_CUTOVER_QUIESCED: "" }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FISCAL_CUTOVER_QUIESCED=1");
  });

  it("allows commands when the quiesced cutover is acknowledged", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, FISCAL_CUTOVER_QUIESCED: "1" }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
