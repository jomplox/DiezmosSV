import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const wranglerToml = readFileSync(resolve(import.meta.dirname, "../../wrangler.toml"), "utf8");

describe("retention export infrastructure configuration", () => {
  const archiveBuckets: Array<{ block: string; bucketName: string }> = [
    { block: "top-level", bucketName: "diezmossv-local-archive-example" },
    { block: "env.staging", bucketName: "diezmossv-staging-archive-example" },
    { block: "env.production", bucketName: "diezmossv-production-archive-example" }
  ];

  it("binds an ARCHIVE R2 bucket per environment", () => {
    for (const { bucketName } of archiveBuckets) {
      const block = r2BucketBlock(bucketName);
      expect(block, `r2_buckets block for ${bucketName}`).toBeTruthy();
      expect(block).toContain('binding = "ARCHIVE"');
    }
  });

  it("adds the monthly retention cron alongside the 15-minute sweep in every env", () => {
    const triggerBlocks = wranglerToml
      .split(/\n(?=\[)/)
      .filter((block) => block.startsWith("[triggers]") || block.startsWith("[env.staging.triggers]") || block.startsWith("[env.production.triggers]"));
    expect(triggerBlocks).toHaveLength(3);
    for (const block of triggerBlocks) {
      expect(block).toContain('"*/15 * * * *"');
      expect(block).toContain('"0 9 1 * *"');
    }
  });
});

function r2BucketBlock(bucketName: string): string | null {
  const blocks = wranglerToml.split(/(?=\[\[)/);
  return blocks.find((block) => block.startsWith("[[") && block.includes("r2_buckets") && block.includes(`bucket_name = "${bucketName}"`)) ?? null;
}
