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
  repositoryRoot = process.cwd()
} = {}) {
  const sourceConfig = assertPrivateWranglerConfig(configPath, {
    repositoryRoot
  });
  const resolvedRepository = realpathSync(repositoryRoot);
  let contents = readFileSync(sourceConfig, "utf8");
  contents = rewriteRelativeTomlPath(contents, "main", resolvedRepository);
  contents = rewriteRelativeTomlPath(contents, "migrations_dir", resolvedRepository);
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
