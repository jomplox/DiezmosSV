import { homedir, tmpdir } from "node:os";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { experimental_readRawConfig } from "wrangler";

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "DiezmosSV",
  "private",
  "wrangler",
  "wrangler.toml"
);

export function resolvePrivateWranglerConfig({
  env = process.env,
  repositoryRoot = process.cwd()
} = {}) {
  const configured = env.DIEZMOSSV_WRANGLER_CONFIG?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error("DIEZMOSSV_WRANGLER_CONFIG must be an absolute path");
  }
  return assertPrivateWranglerConfig(configured || DEFAULT_CONFIG_PATH, {
    repositoryRoot
  });
}

export function assertPrivateWranglerConfig(configPath, {
  repositoryRoot = process.cwd()
} = {}) {
  if (!isAbsolute(configPath)) {
    throw new Error("The private Wrangler config must use an absolute path");
  }

  let configLstat;
  let resolvedConfig;
  let resolvedRepository;
  try {
    configLstat = lstatSync(configPath);
    resolvedConfig = realpathSync(configPath);
    resolvedRepository = realpathSync(repositoryRoot);
  } catch {
    throw new Error("The private Wrangler config is missing or inaccessible");
  }

  if (!configLstat.isFile() || configLstat.isSymbolicLink()) {
    throw new Error("The private Wrangler config must be a regular file");
  }
  if (isInside(resolvedRepository, resolvedConfig)) {
    throw new Error("The private Wrangler config must stay outside the DiezmosSV repository");
  }

  const stat = statSync(resolvedConfig);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("The private Wrangler config must have owner-only permissions (0600)");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("The private Wrangler config must be owned by the current user");
  }
  return resolvedConfig;
}

export function preparePrivateWranglerConfig(configPath, {
  repositoryRoot = process.cwd(),
  migrationsDirOverride
} = {}) {
  const sourceConfig = assertPrivateWranglerConfig(configPath, {
    repositoryRoot
  });
  const resolvedRepository = realpathSync(repositoryRoot);
  const { rawConfig } = experimental_readRawConfig({ config: sourceConfig });
  assertPrivateWranglerEmailBindings(rawConfig);
  let contents = readFileSync(sourceConfig, "utf8");
  contents = rewriteRelativeTomlPath(contents, "main", resolvedRepository);
  if (migrationsDirOverride === undefined) {
    contents = rewriteRelativeTomlPath(
      contents,
      "migrations_dir",
      resolvedRepository
    );
  } else {
    contents = rewriteMigrationsDirOverride(
      contents,
      assertOwnerOnlyDirectory(migrationsDirOverride)
    );
  }
  contents = contents.replace(
    /(\bdirectory\s*=\s*)"([^"]+)"/g,
    (match, prefix, value) =>
      isAbsolute(value)
        ? match
        : `${prefix}${JSON.stringify(resolve(resolvedRepository, value))}`
  );

  const directory = mkdtempSync(join(tmpdir(), "diezmos-wrangler-config-"));
  chmodSync(directory, 0o700);
  const preparedConfig = join(directory, "wrangler.toml");
  writeFileSync(preparedConfig, contents, { mode: 0o600 });
  chmodSync(preparedConfig, 0o600);

  let cleaned = false;
  return {
    configPath: preparedConfig,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function assertPrivateWranglerEmailBindings(rawConfig) {
  const rawEnvironments = ownValue(rawConfig, "env");
  const environments = isObject(rawEnvironments) ? rawEnvironments : undefined;
  const namedEnvironments = environments ? Object.values(environments) : [];
  for (const config of [rawConfig, ...namedEnvironments]) {
    if (!isObject(config)) continue;
    const rawBindings = ownValue(config, "send_email");
    const bindings = Array.isArray(rawBindings) ? rawBindings : [rawBindings];
    if (
      bindings.some(
        (binding) =>
          isObject(binding) && Object.hasOwn(binding, "allowed_sender_addresses")
      )
    ) {
      throw new Error(
        "The selected private Wrangler config must not restrict the OWNER-configurable EMAIL_FROM sender"
      );
    }
  }

  const scopes = [
    ["root", rawConfig],
    ["staging", ownValue(environments, "staging")],
    ["production", ownValue(environments, "production")]
  ];

  for (const [scope, config] of scopes) {
    const bindings = ownValue(config, "send_email");
    if (!Array.isArray(bindings) || bindings.length !== 1 || !isObject(bindings[0])) {
      throw new Error(
        "The selected private Wrangler config must declare exactly one EMAIL binding in root, staging, and production"
      );
    }

    const binding = bindings[0];
    if (ownValue(binding, "name") !== "EMAIL") {
      throw new Error(
        `The selected private Wrangler config Email Service binding in ${scope} must be named EMAIL`
      );
    }
  }
}

export function assertPrivateWranglerTargetManifest(rawConfig, target, manifest) {
  const environments = ownValue(rawConfig, "env");
  const selected = ownValue(environments, target);
  if (!isObject(selected)) {
    throw new Error("The selected private Wrangler config does not match the target resource manifest");
  }
  const vars = ownValue(selected, "vars");
  const d1 = exactBinding(ownValue(selected, "d1_databases"), "binding", "DB", 1);
  const r2 = exactBinding(ownValue(selected, "r2_buckets"), "binding", "ARCHIVE", 1);
  const queues = ownValue(selected, "queues");
  const producer = exactBinding(
    ownValue(queues, "producers"),
    "binding",
    "ISSUANCE_QUEUE",
    1
  );
  const consumers = ownValue(queues, "consumers");
  const mainConsumer = exactBinding(
    consumers,
    "queue",
    manifest.resourceManifest.queueName,
    2
  );
  const dlqConsumer = exactBinding(
    consumers,
    "queue",
    manifest.resourceManifest.queueDlqName,
    2
  );
  const workersDev = ownValue(selected, "workers_dev") ?? ownValue(rawConfig, "workers_dev") ?? true;
  const accountId = ownValue(selected, "account_id") ?? ownValue(rawConfig, "account_id");
  const matches =
    ownValue(selected, "name") === manifest.workerName &&
    accountId === manifest.resourceManifest.accountId &&
    ownValue(vars, "APP_ENV") === manifest.resourceManifest.appEnv &&
    ownValue(vars, "APP_ORIGIN") === manifest.origin &&
    ownValue(vars, "CLOUDFLARE_SCRIPT_NAME") === manifest.workerName &&
    ownValue(d1, "database_name") === manifest.resourceManifest.d1DatabaseName &&
    ownValue(d1, "database_id") === manifest.resourceManifest.d1DatabaseId &&
    ownValue(r2, "bucket_name") === manifest.resourceManifest.r2BucketName &&
    ownValue(producer, "queue") === manifest.resourceManifest.queueName &&
    ownValue(mainConsumer, "dead_letter_queue") === manifest.resourceManifest.queueDlqName &&
    Boolean(dlqConsumer) &&
    workersDev === manifest.resourceManifest.workersDev &&
    (target !== "production" || ownValue(vars, "MOCK_EXTERNAL_SERVICES") === "false");
  if (!matches) {
    throw new Error("The selected private Wrangler config does not match the target resource manifest");
  }
}

function exactBinding(value, key, expected, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) return undefined;
  const matches = value.filter(
    (entry) => isObject(entry) && ownValue(entry, key) === expected
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownValue(value, key) {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function assertOwnerOnlyDirectory(directory) {
  if (!isAbsolute(directory)) {
    throw new Error("The migrations override must use an absolute path");
  }

  let entry;
  let resolved;
  try {
    entry = lstatSync(directory);
    resolved = realpathSync(directory);
  } catch {
    throw new Error("The migrations override is missing or inaccessible");
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("The migrations override must be a regular directory");
  }

  const stat = statSync(resolved);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("The migrations override must have owner-only permissions (0700)");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("The migrations override must be owned by the current user");
  }
  return resolved;
}

function rewriteMigrationsDirOverride(contents, migrationsDirOverride) {
  const assignment = /^(\s*migrations_dir\s*=\s*)"[^"]+"/gm;
  let replacements = 0;
  const rewritten = contents.replace(assignment, (_match, prefix) => {
    replacements += 1;
    return `${prefix}${JSON.stringify(migrationsDirOverride)}`;
  });
  if (replacements === 0) {
    throw new Error("The private Wrangler config must declare migrations_dir");
  }
  return rewritten;
}

function rewriteRelativeTomlPath(contents, key, repositoryRoot) {
  const assignment = new RegExp(`^(\\s*${key}\\s*=\\s*)"([^"]+)"`, "gm");
  return contents.replace(assignment, (match, prefix, value) =>
    isAbsolute(value)
      ? match
      : `${prefix}${JSON.stringify(resolve(repositoryRoot, value))}`
  );
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
