import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(import.meta.dirname, "../../README.md"), "utf8");
const stagingRunbook = readFileSync(
  resolve(import.meta.dirname, "../../docs/cloudflare-staging-uat.md"),
  "utf8"
);
const deploymentGuide = readme.slice(
  readme.indexOf("## 📦 Deploy to Cloudflare"),
  readme.indexOf("## ⚙️ Configuration reference")
);

describe("remote provisioning documentation", () => {
  it.each([
    ["README deployment guide", deploymentGuide],
    ["staging UAT runbook", stagingRunbook]
  ])(
    "requires the selected owner-only external config in the %s",
    (_name, document) => {
      expect(document).toContain("DIEZMOSSV_WRANGLER_CONFIG");
      expect(document).toMatch(/absolute/i);
      expect(document).toMatch(/outside (?:the|this) repositor/i);
      expect(document).toMatch(/owner-only/i);
      expect(document).toContain("0600");
    }
  );

  it.each([
    ["README deployment guide", deploymentGuide],
    ["staging UAT runbook", stagingRunbook]
  ])(
    "routes every documented remote Wrangler command through the private wrapper in the %s",
    (_name, document) => {
      const directRemoteCommands = document
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^(?:npx )?wrangler\b/.test(line));

      expect(directRemoteCommands).toEqual([]);
      expect(document).toContain("scripts/run-private-wrangler.mjs");
    }
  );

  it("keeps live resource identifiers and routing data out of the public config workflow", () => {
    const documents = `${deploymentGuide}\n${stagingRunbook}`;

    expect(documents).not.toMatch(/copy the returned D1 id into\s+wrangler\.toml/i);
    expect(documents).not.toMatch(/ids are already committed in wrangler\.toml/i);
    expect(documents).not.toMatch(
      /\b(?!00000000-0000-0000-0000-000000000000\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
    );
  });
});
