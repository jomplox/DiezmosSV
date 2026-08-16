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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPrivateWranglerConfig,
  assertPrivateWranglerEmailBindings,
  assertPrivateWranglerTargetManifest,
  preparePrivateWranglerConfig,
  resolvePrivateWranglerConfig
} from "../../scripts/private-wrangler-config.mjs";

const privateWranglerConfigModule = resolve(
  import.meta.dirname,
  "../../scripts/private-wrangler-config.mjs"
);

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
  it("accepts only the exact selected target resource manifest", () => {
    const rawConfig = targetRawConfig();
    const manifest = targetManifest();

    expect(() =>
      assertPrivateWranglerTargetManifest(rawConfig, "staging", manifest)
    ).not.toThrow();

    rawConfig.env.staging.d1_databases[0].database_id =
      "22222222-2222-2222-2222-222222222222";
    expect(() =>
      assertPrivateWranglerTargetManifest(rawConfig, "staging", manifest)
    ).toThrow(/resource manifest/i);
  });

  it.each([
    ["Worker", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.name = "other-worker"; }],
    ["APP_ENV", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.vars.APP_ENV = "production"; }],
    ["origin", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.vars.APP_ORIGIN = "https://other.example.invalid"; }],
    ["R2", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.r2_buckets[0].bucket_name = "other-archive"; }],
    ["queue", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.queues.producers[0].queue = "other-queue"; }],
    ["workers_dev", (config: ReturnType<typeof targetRawConfig>) => { config.env.staging.workers_dev = false; }]
  ] as const)("rejects a mismatched %s target value", (_name, mutate) => {
    const rawConfig = targetRawConfig();
    mutate(rawConfig);
    expect(() =>
      assertPrivateWranglerTargetManifest(rawConfig, "staging", targetManifest())
    ).toThrow(/resource manifest/i);
  });

  it.each([
    ["D1", (config: ReturnType<typeof targetRawConfig>) => {
      config.env.staging.d1_databases.push({
        binding: "EXTRA_DB",
        database_name: "unexpected-db",
        database_id: "33333333-3333-3333-3333-333333333333"
      });
    }],
    ["R2", (config: ReturnType<typeof targetRawConfig>) => {
      config.env.staging.r2_buckets.push({
        binding: "EXTRA_ARCHIVE",
        bucket_name: "unexpected-archive"
      });
    }],
    ["queue producer", (config: ReturnType<typeof targetRawConfig>) => {
      config.env.staging.queues.producers.push({
        binding: "EXTRA_QUEUE",
        queue: "unexpected-queue"
      });
    }],
    ["queue consumer", (config: ReturnType<typeof targetRawConfig>) => {
      config.env.staging.queues.consumers.push({ queue: "unexpected-queue" });
    }]
  ] as const)("rejects an extra %s outside the exact target manifest", (_name, mutate) => {
    const rawConfig = targetRawConfig();
    mutate(rawConfig);
    expect(() =>
      assertPrivateWranglerTargetManifest(rawConfig, "staging", targetManifest())
    ).toThrow(/resource manifest/i);
  });
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

  it("rejects inherited send_email for missing required bindings", () => {
    expect(
      isolatedPrototypeValidation(
        ["[env.staging]", "[env.production]"].join("\n"),
        "send_email"
      )
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("rejects inherited name for empty binding objects", () => {
    expect(
      isolatedPrototypeValidation([
        "send_email = [{}]",
        "[env.staging]",
        "send_email = [{}]",
        "[env.production]",
        "send_email = [{}]"
      ].join("\n"), "name")
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("rejects inherited env for missing named environments", () => {
    expect(
      isolatedPrototypeValidation(
        ["[[send_email]]", 'name = "EMAIL"'].join("\n"),
        "env"
      )
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("rejects inherited staging for a missing own staging environment", () => {
    expect(
      isolatedPrototypeValidation([
        "[[send_email]]",
        'name = "EMAIL"',
        "[[env.production.send_email]]",
        'name = "EMAIL"'
      ].join("\n"), "staging")
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("rejects inherited production for a missing own production environment", () => {
    expect(
      isolatedPrototypeValidation([
        "[[send_email]]",
        'name = "EMAIL"',
        "[[env.staging.send_email]]",
        'name = "EMAIL"'
      ].join("\n"), "production")
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("ignores inherited send_email values while scanning sender allowlists", () => {
    expect(
      isolatedPrototypeValidation(
        [namedEmailBindings, "[env.preview]"].join("\n"),
        "send_email_allowlist"
      )
    ).toEqual({ accepted: true, preparedCreated: true });
  });

  it("ignores inherited allowed_sender_addresses on own bindings", () => {
    expect(
      isolatedPrototypeValidation(
        namedEmailBindings,
        "allowed_sender_addresses"
      )
    ).toEqual({ accepted: true, preparedCreated: true });
  });

  it("rejects an own allowlist in a __proto__ named environment", () => {
    expect(
      isolatedPrototypeValidation([
        namedEmailBindings,
        "[[env.__proto__.send_email]]",
        'name = "EXTRA_EMAIL"',
        "allowed_sender_addresses = []"
      ].join("\n"), "none")
    ).toEqual({ accepted: false, preparedCreated: false });
  });

  it("accepts valid null-prototype config objects", () => {
    const root = Object.create(null) as Record<string, unknown>;
    const environments = Object.create(null) as Record<string, unknown>;
    root.env = environments;
    root.send_email = [nullPrototypeEmailBinding()];
    environments.staging = nullPrototypeEmailScope();
    environments.production = nullPrototypeEmailScope();

    expect(() => assertPrivateWranglerEmailBindings(root)).not.toThrow();
  });
});

function targetManifest() {
  return {
    workerName: "diezmos-sv-staging",
    origin: "https://staging.example.invalid",
    resourceManifest: {
      accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      appEnv: "staging" as const,
      d1DatabaseName: "diezmos-sv-staging-db",
      d1DatabaseId: "11111111-1111-1111-1111-111111111111",
      r2BucketName: "diezmos-sv-staging-archive",
      queueName: "diezmos-sv-staging-issuance",
      queueDlqName: "diezmos-sv-staging-issuance-dlq",
      workersDev: true
    }
  };
}

function targetRawConfig() {
  return {
    account_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    env: {
      staging: {
        name: "diezmos-sv-staging",
        workers_dev: true,
        vars: {
          APP_ENV: "staging",
          APP_ORIGIN: "https://staging.example.invalid",
          CLOUDFLARE_SCRIPT_NAME: "diezmos-sv-staging"
        },
        d1_databases: [{
          binding: "DB",
          database_name: "diezmos-sv-staging-db",
          database_id: "11111111-1111-1111-1111-111111111111"
        }],
        r2_buckets: [{ binding: "ARCHIVE", bucket_name: "diezmos-sv-staging-archive" }],
        queues: {
          producers: [{ binding: "ISSUANCE_QUEUE", queue: "diezmos-sv-staging-issuance" }],
          consumers: [
            {
              queue: "diezmos-sv-staging-issuance",
              dead_letter_queue: "diezmos-sv-staging-issuance-dlq"
            },
            { queue: "diezmos-sv-staging-issuance-dlq" }
          ]
        }
      }
    }
  };
}

const isolatedValidationProgram = String.raw`
  import { existsSync, readdirSync } from "node:fs";
  import { pathToFileURL } from "node:url";

  const [modulePath, configPath, repositoryRoot, pollution] = process.argv.slice(1);
  const emailBinding = () => ({ name: "EMAIL" });
  const emailScope = () => ({ send_email: [emailBinding()] });
  const definePollution = (key, value) => {
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      writable: true,
      value
    });
  };

  if (pollution === "send_email") {
    definePollution("send_email", [emailBinding()]);
  } else if (pollution === "send_email_allowlist") {
    definePollution("send_email", [{
      name: "INHERITED_EMAIL",
      allowed_sender_addresses: []
    }]);
  } else if (pollution === "name") {
    definePollution("name", "EMAIL");
  } else if (pollution === "env") {
    definePollution("env", {
      staging: emailScope(),
      production: emailScope()
    });
  } else if (pollution === "staging") {
    definePollution("staging", emailScope());
  } else if (pollution === "production") {
    definePollution("production", emailScope());
  } else if (pollution === "allowed_sender_addresses") {
    definePollution("allowed_sender_addresses", []);
  }

  const { preparePrivateWranglerConfig } = await import(pathToFileURL(modulePath).href);
  let prepared;
  let accepted = false;
  let preparedCreated = false;
  try {
    prepared = preparePrivateWranglerConfig(configPath, { repositoryRoot });
    accepted = true;
    preparedCreated = existsSync(prepared.configPath);
  } catch (error) {
    accepted = false;
    preparedCreated = readdirSync(process.env.TMPDIR).some((name) =>
      name.startsWith("diezmos-wrangler-config-")
    );
    const message = error instanceof Error ? error.message : "";
    const sanitized =
      message === "The selected private Wrangler config must declare exactly one EMAIL binding in root, staging, and production" ||
      message === "The selected private Wrangler config must not restrict the OWNER-configurable EMAIL_FROM sender" ||
      /^The selected private Wrangler config Email Service binding in (?:root|staging|production) must be named EMAIL$/.test(message);
    if (!sanitized) process.exitCode = 2;
  } finally {
    prepared?.cleanup();
  }
  console.log(JSON.stringify({ accepted, preparedCreated }));
`;

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

function isolatedPrototypeValidation(
  contents: string,
  pollution:
    | "none"
    | "send_email"
    | "send_email_allowlist"
    | "allowed_sender_addresses"
    | "name"
    | "env"
    | "staging"
    | "production"
): { accepted: boolean; preparedCreated: boolean } {
  const caseRoot = mkdtempSync(join(tmpdir(), "diezmos-prototype-config-"));
  const repositoryRoot = join(caseRoot, "repository");
  const privateRoot = join(caseRoot, "private");
  const childTmp = join(caseRoot, "tmp");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(childTmp, { mode: 0o700 });
  const configPath = join(privateRoot, "wrangler.toml");
  writeFileSync(configPath, contents, { mode: 0o600 });
  chmodSync(configPath, 0o600);

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      isolatedValidationProgram,
      privateWranglerConfigModule,
      configPath,
      repositoryRoot,
      pollution
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: childTmp }
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    accepted: boolean;
    preparedCreated: boolean;
  };
}

function nullPrototypeEmailBinding(): Record<string, unknown> {
  const binding = Object.create(null) as Record<string, unknown>;
  binding.name = "EMAIL";
  return binding;
}

function nullPrototypeEmailScope(): Record<string, unknown> {
  const scope = Object.create(null) as Record<string, unknown>;
  scope.send_email = [nullPrototypeEmailBinding()];
  return scope;
}
