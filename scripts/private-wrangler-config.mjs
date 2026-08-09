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
  const environments = isObject(rawConfig?.env) ? rawConfig.env : {};
  for (const config of [rawConfig, ...Object.values(environments)]) {
    if (!isObject(config)) continue;
    const bindings = Array.isArray(config.send_email)
      ? config.send_email
      : [config.send_email];
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
    ["staging", environments.staging],
    ["production", environments.production]
  ];

  for (const [scope, config] of scopes) {
    const bindings = isObject(config) ? config.send_email : undefined;
    if (!Array.isArray(bindings) || bindings.length !== 1 || !isObject(bindings[0])) {
      throw new Error(
        "The selected private Wrangler config must declare exactly one EMAIL binding in root, staging, and production"
      );
    }

    const binding = bindings[0];
    if (binding.name !== "EMAIL") {
      throw new Error(
        `The selected private Wrangler config Email Service binding in ${scope} must be named EMAIL`
      );
    }
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
