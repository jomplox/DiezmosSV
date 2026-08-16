import { describe, expect, it, vi } from "vitest";
import { assertReleaseProvenance } from "../../scripts/assert-release-provenance.mjs";

const approvedSha = "a".repeat(40);

describe("release provenance", () => {
  it("accepts a clean exact SHA with completed successful checks and exact resources", () => {
    const run = commandFixture();

    expect(assertReleaseProvenance({
      target: "staging",
      env: { DIEZMOSSV_APPROVED_SHA: approvedSha },
      repositoryRoot: "/repository",
      selectedConfig: deployConfig("staging"),
      otherConfig: deployConfig("production"),
      rawWranglerConfig: rawConfig(),
      execFileSyncImpl: run
    })).toEqual({ sha: approvedSha });
    expect(run).toHaveBeenCalledWith(
      "gh",
      ["api", `repos/jomplox/DiezmosSV/commits/${approvedSha}/check-runs?per_page=100`],
      expect.objectContaining({ cwd: "/repository", encoding: "utf8" })
    );
  });

  it.each([
    ["missing", undefined, approvedSha],
    ["mismatched", "b".repeat(40), approvedSha]
  ])("rejects a %s approved SHA", (_name, configuredSha, headSha) => {
    expect(() => assertReleaseProvenance({
      target: "staging",
      env: configuredSha ? { DIEZMOSSV_APPROVED_SHA: configuredSha } : {},
      repositoryRoot: "/repository",
      selectedConfig: deployConfig("staging"),
      otherConfig: deployConfig("production"),
      rawWranglerConfig: rawConfig(),
      execFileSyncImpl: commandFixture({ headSha })
    })).toThrow(/approved SHA/i);
  });

  it("rejects tracked worktree changes", () => {
    expect(() => provenance({ dirty: " M src/worker/index.ts\n" })).toThrow(/tracked worktree/i);
  });

  it.each([
    ["missing", { total_count: 0, check_runs: [] }],
    ["pending", { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] }],
    ["failed", { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] }]
  ])("rejects %s GitHub checks", (_name, checks) => {
    expect(() => provenance({ checks })).toThrow(/GitHub checks/i);
  });

  it("rejects an effective Wrangler resource that differs from the manifest", () => {
    const raw = rawConfig();
    raw.env.staging.r2_buckets[0].bucket_name = "wrong-archive";
    expect(() => provenance({ raw })).toThrow(/resource manifest/i);
  });

  it("rejects staging and production reuse of any persistent resource", () => {
    const production = deployConfig("production");
    production.resourceManifest.queueName = deployConfig("staging").resourceManifest.queueName;
    expect(() => provenance({ production })).toThrow(/must not reuse/i);
  });
});

function provenance(options: {
  dirty?: string;
  checks?: unknown;
  raw?: ReturnType<typeof rawConfig>;
  production?: ReturnType<typeof deployConfig>;
} = {}) {
  return assertReleaseProvenance({
    target: "staging",
    env: { DIEZMOSSV_APPROVED_SHA: approvedSha },
    repositoryRoot: "/repository",
    selectedConfig: deployConfig("staging"),
    otherConfig: options.production ?? deployConfig("production"),
    rawWranglerConfig: options.raw ?? rawConfig(),
    execFileSyncImpl: commandFixture({ dirty: options.dirty, checks: options.checks })
  });
}

function commandFixture(options: {
  headSha?: string;
  dirty?: string;
  checks?: unknown;
} = {}) {
  return vi.fn((command: string, args: string[]) => {
    if (command === "git" && args[0] === "rev-parse") return `${options.headSha ?? approvedSha}\n`;
    if (command === "git" && args[0] === "status") return options.dirty ?? "";
    if (command === "gh" && args[0] === "api") {
      return JSON.stringify(options.checks ?? {
        total_count: 2,
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "neutral" }
        ]
      });
    }
    throw new Error("unexpected command");
  });
}

function deployConfig(target: "staging" | "production") {
  const production = target === "production";
  return {
    target,
    workerName: `diezmos-sv-${target}`,
    githubRepository: "jomplox/DiezmosSV",
    campaign: "campaign-fixture",
    givebutterFunds: null,
    origin: `https://${target}.example.invalid`,
    resourceManifest: {
      accountId: "a".repeat(32),
      appEnv: target,
      d1DatabaseName: `diezmos-sv-${target}-db`,
      d1DatabaseId: production
        ? "22222222-2222-2222-2222-222222222222"
        : "11111111-1111-1111-1111-111111111111",
      r2BucketName: `diezmos-sv-${target}-archive`,
      queueName: `diezmos-sv-${target}-issuance`,
      queueDlqName: `diezmos-sv-${target}-issuance-dlq`,
      workersDev: true
    },
    donorLogo: {
      path: "/private/logo.png",
      bytes: Buffer.from([1]),
      contentType: "image/png" as const,
      sha256: "f".repeat(64)
    }
  };
}

function rawConfig() {
  const staging = deployConfig("staging");
  return {
    account_id: staging.resourceManifest.accountId,
    env: {
      staging: {
        name: staging.workerName,
        workers_dev: staging.resourceManifest.workersDev,
        vars: {
          APP_ENV: staging.target,
          APP_ORIGIN: staging.origin,
          CLOUDFLARE_SCRIPT_NAME: staging.workerName
        },
        d1_databases: [{
          binding: "DB",
          database_name: staging.resourceManifest.d1DatabaseName,
          database_id: staging.resourceManifest.d1DatabaseId
        }],
        r2_buckets: [{ binding: "ARCHIVE", bucket_name: staging.resourceManifest.r2BucketName }],
        queues: {
          producers: [{ binding: "ISSUANCE_QUEUE", queue: staging.resourceManifest.queueName }],
          consumers: [
            { queue: staging.resourceManifest.queueName, dead_letter_queue: staging.resourceManifest.queueDlqName },
            { queue: staging.resourceManifest.queueDlqName }
          ]
        }
      }
    }
  };
}
