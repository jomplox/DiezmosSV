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

const namedEmailBindings = [
  "[[send_email]]",
  'name = "EMAIL"',
  "[[env.staging.send_email]]",
  'name = "EMAIL"',
  "[[env.production.send_email]]",
  'name = "EMAIL"'
].join("\n");

const inlineEmailBindings = [
  'send_email = [{ name = "EMAIL" }]',
  "[env.staging]",
  'send_email = [{ name = "EMAIL" }]',
  "[env.production]",
  'send_email = [{ name = "EMAIL" }]'
].join("\n");

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
        'migrations_dir = "migrations"',
        namedEmailBindings
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
      [
        'name = "example"',
        'migrations_dir = "migrations"',
        namedEmailBindings
      ].join("\n"),
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
    writeFileSync(
      configPath,
      ['migrations_dir = "migrations"', namedEmailBindings].join("\n"),
      { mode: 0o600 }
    );

    expect(() =>
      preparePrivateWranglerConfig(configPath, {
        repositoryRoot,
        migrationsDirOverride
      })
    ).toThrow(/owner-only permissions/i);
  });

  it.each([
    ["named tables", namedEmailBindings],
    ["inline arrays", inlineEmailBindings]
  ])("accepts one unrestricted EMAIL binding per scope using %s", (_form, bindings) => {
    const { repositoryRoot, configPath } = privateConfig(
      ['name = "example"', 'main = "src/worker/index.ts"', bindings].join("\n")
    );

    const prepared = preparePrivateWranglerConfig(configPath, { repositoryRoot });
    prepared.cleanup();
    expect(existsSync(prepared.configPath)).toBe(false);
  });

  it.each([
    ["root", withSenderAllowlist(namedEmailBindings, "root")],
    ["staging", withSenderAllowlist(namedEmailBindings, "staging")],
    ["production", withSenderAllowlist(namedEmailBindings, "production")]
  ])("rejects an allowed sender restriction in %s", (_scope, bindings) => {
    const { repositoryRoot, configPath } = privateConfig(bindings);

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/must not restrict.*EMAIL_FROM sender/i);
  });

  it("rejects an allowed sender restriction in any additional environment", () => {
    const { repositoryRoot, configPath } = privateConfig([
      namedEmailBindings,
      "[[env.preview.send_email]]",
      'name = "PREVIEW_EMAIL"',
      'allowed_sender_addresses = ["sender@example.invalid"]'
    ].join("\n"));

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/must not restrict.*EMAIL_FROM sender/i);
  });

  it("rejects an inline allowed sender restriction", () => {
    const { repositoryRoot, configPath } = privateConfig(
      inlineEmailBindings.replace(
        'send_email = [{ name = "EMAIL" }]',
        'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["sender@example.invalid"] }]'
      )
    );

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/must not restrict.*EMAIL_FROM sender/i);
  });

  it.each([
    [
      "root",
      namedEmailBindings.replace('[[send_email]]\nname = "EMAIL"\n', "")
    ],
    [
      "staging",
      namedEmailBindings.replace(
        '[[env.staging.send_email]]\nname = "EMAIL"\n',
        ""
      )
    ],
    [
      "production",
      namedEmailBindings.replace(
        '[[env.production.send_email]]\nname = "EMAIL"',
        ""
      )
    ]
  ])("rejects a missing EMAIL binding in %s", (_scope, bindings) => {
    const { repositoryRoot, configPath } = privateConfig(bindings);

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/exactly one EMAIL binding.*root, staging, and production/i);
  });

  it.each([
    ["root", `${namedEmailBindings}\n[[send_email]]\nname = "EMAIL"`],
    ["staging", `${namedEmailBindings}\n[[env.staging.send_email]]\nname = "EMAIL"`],
    ["production", `${namedEmailBindings}\n[[env.production.send_email]]\nname = "EMAIL"`]
  ])("rejects duplicate EMAIL bindings in %s", (_scope, bindings) => {
    const { repositoryRoot, configPath } = privateConfig(bindings);

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/exactly one EMAIL binding.*root, staging, and production/i);
  });

  it("rejects a binding with the wrong name", () => {
    const { repositoryRoot, configPath } = privateConfig(
      namedEmailBindings.replace('name = "EMAIL"', 'name = "OTHER"')
    );

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/named EMAIL/i);
  });

  it("rejects a non-array send_email shape", () => {
    const { repositoryRoot, configPath } = privateConfig([
      'send_email = { name = "EMAIL" }',
      '[env.staging]',
      'send_email = [{ name = "EMAIL" }]',
      '[env.production]',
      'send_email = [{ name = "EMAIL" }]'
    ].join("\n"));

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow(/exactly one EMAIL binding.*root, staging, and production/i);
  });

  it("rejects malformed TOML before preparing a copy", () => {
    const { repositoryRoot, configPath } = privateConfig(
      'send_email = [{ name = "EMAIL" }'
    );

    expect(() =>
      preparePrivateWranglerConfig(configPath, { repositoryRoot })
    ).toThrow();
  });
});

function privateConfig(contents: string): {
  repositoryRoot: string;
  configPath: string;
} {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-repository-"));
  const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-private-"));
  const configPath = join(privateRoot, "wrangler.toml");
  writeFileSync(configPath, contents, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { repositoryRoot, configPath };
}

function withSenderAllowlist(
  bindings: string,
  scope: "root" | "staging" | "production"
): string {
  const header =
    scope === "root" ? "[[send_email]]" : `[[env.${scope}.send_email]]`;
  return bindings.replace(
    `${header}\nname = "EMAIL"`,
    `${header}\nname = "EMAIL"\nallowed_sender_addresses = ["sender@example.invalid"]`
  );
}
