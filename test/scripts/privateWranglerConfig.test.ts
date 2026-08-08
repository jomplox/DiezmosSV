import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPrivateWranglerConfig,
  preparePrivateWranglerConfig,
  resolvePrivateWranglerConfig
} from "../../scripts/private-wrangler-config.mjs";

describe("private Wrangler configuration", () => {
  it("rejects a config stored inside the repository", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const configPath = join(repositoryRoot, "wrangler.private.toml");
    writeFileSync(configPath, "name = \"example\"\n", { mode: 0o600 });

    expect(() =>
      assertPrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/outside the DiezmosSV repository/i);
  });

  it("rejects a config readable by group or other users", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(configPath, "name = \"example\"\n", { mode: 0o644 });
    chmodSync(configPath, 0o644);

    expect(() =>
      assertPrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/owner-only permissions/i);
  });

  it("accepts an owner-only config outside the repository", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(configPath, "name = \"example\"\n", { mode: 0o600 });
    chmodSync(configPath, 0o600);

    expect(
      assertPrivateWranglerConfig(configPath, { repositoryRoot })
    ).toBe(realpathSync(configPath));
  });

  it("resolves an explicit absolute config path", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(configPath, "name = \"example\"\n", { mode: 0o600 });
    chmodSync(configPath, 0o600);

    expect(
      resolvePrivateWranglerConfig({
        repositoryRoot,
        env: { DIEZMOSSV_WRANGLER_CONFIG: configPath }
      })
    ).toBe(realpathSync(configPath));
  });

  it("rejects a relative explicit config path", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    mkdirSync(join(repositoryRoot, "private"), { recursive: true });

    expect(() =>
      resolvePrivateWranglerConfig({
        repositoryRoot,
        env: { DIEZMOSSV_WRANGLER_CONFIG: "private/wrangler.toml" }
      })
    ).toThrow(/absolute path/i);
  });

  it("materializes repository-relative paths in an owner-only temporary config", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'main = "src/worker/index.ts"',
        'assets = { directory = "./dist/client", binding = "ASSETS" }',
        'migrations_dir = "migrations"'
      ].join("\n"),
      { mode: 0o600 }
    );
    chmodSync(configPath, 0o600);

    const prepared = preparePrivateWranglerConfig(configPath, {
      repositoryRoot
    });
    try {
      const contents = readFileSync(prepared.configPath, "utf8");
      expect(contents).toContain(join(repositoryRoot, "src/worker/index.ts"));
      expect(contents).toContain(join(repositoryRoot, "dist/client"));
      expect(contents).toContain(join(repositoryRoot, "migrations"));
      expect(statSync(prepared.configPath).mode & 0o077).toBe(0);
    } finally {
      prepared.cleanup();
    }

    expect(existsSync(prepared.configPath)).toBe(false);
  });

  it("uses a validated owner-only migrations override in the temporary config", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const migrationsDirOverride = mkdtempSync(
      join(tmpdir(), "diezmos-migrations-")
    );
    chmodSync(migrationsDirOverride, 0o700);
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(
      configPath,
      ['name = "example"', 'migrations_dir = "migrations"'].join("\n"),
      { mode: 0o600 }
    );

    const prepared = preparePrivateWranglerConfig(configPath, {
      repositoryRoot,
      migrationsDirOverride
    });
    try {
      expect(readFileSync(prepared.configPath, "utf8")).toContain(
        `migrations_dir = ${JSON.stringify(realpathSync(migrationsDirOverride))}`
      );
      expect(statSync(prepared.configPath).mode & 0o077).toBe(0);
    } finally {
      prepared.cleanup();
    }
  });

  it("rejects a migrations override that is accessible to other users", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
    const migrationsDirOverride = mkdtempSync(
      join(tmpdir(), "diezmos-migrations-")
    );
    chmodSync(migrationsDirOverride, 0o755);
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(configPath, 'migrations_dir = "migrations"\n', {
      mode: 0o600
    });

    expect(() =>
      preparePrivateWranglerConfig(configPath, {
        repositoryRoot,
        migrationsDirOverride
      })
    ).toThrow(/owner-only permissions/i);
  });
});
