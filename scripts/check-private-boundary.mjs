import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const violations = new Set();
const allowedDevVarPaths = new Set([".dev.vars.ci", ".dev.vars.example"]);
const skippedDevVarDirectories = new Set([".git", "node_modules"]);

collectDevVars(root);

collectTree("DTE/Credentials");
collectExact("WompiWebhookSample.json");
collectExact("node_modules/.cache/wrangler/wrangler-account.json");
collectExact("node_modules/.mf/cf.json");

collectMatchingTree("DTE", (name) => /\.(?:csv|xlsx|pdf)$/i.test(name) || /_OCR\.md$/i.test(name) || /_by_PaddleOCR.*\.md$/i.test(name));
collectMatchingTree("examples", (name) => /^DTE-.*\.(?:json|pdf)$/i.test(name));
collectTrackedImplementationDetails();

if (violations.size > 0) {
  console.error("Private artifacts must be moved outside the repository:");
  for (const path of [...violations].sort()) {
    console.error(`- ${path}`);
  }
  process.exitCode = 1;
} else {
  console.log("Private artifact boundary: clean");
}

function collectExact(path) {
  const absolute = join(root, path);
  try {
    lstatSync(absolute);
    violations.add(normalize(path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function collectTree(path) {
  const absolute = join(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    violations.add(normalize(path));
    return;
  }
  const entries = safeReadDir(absolute);
  if (entries.length === 0) {
    violations.add(normalize(path));
    return;
  }
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    const childPath = normalize(relative(root, child));
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectTree(childPath);
    } else {
      violations.add(childPath);
    }
  }
}

function collectMatchingTree(path, matches) {
  const absolute = join(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    if (matches(path.split("/").at(-1) ?? "")) violations.add(normalize(path));
    return;
  }
  for (const entry of safeReadDir(absolute)) {
    const child = join(absolute, entry.name);
    const childPath = normalize(relative(root, child));
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectMatchingTree(childPath, matches);
    } else if (matches(entry.name)) {
      violations.add(childPath);
    }
  }
}

function collectDevVars(directory) {
  for (const entry of safeReadDir(directory)) {
    const absolute = join(directory, entry.name);
    const path = normalize(relative(root, absolute));
    if (entry.name.startsWith(".dev.vars") && !allowedDevVarPaths.has(path)) {
      violations.add(path);
    }
    if (entry.isDirectory() && !entry.isSymbolicLink() && !skippedDevVarDirectories.has(entry.name)) {
      collectDevVars(absolute);
    }
  }
}

function collectTrackedImplementationDetails() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) return;

  for (const path of result.stdout.split("\0").filter(Boolean)) {
    let contents;
    try {
      const buffer = readFileSync(join(root, path));
      if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) continue;
      contents = buffer.toString("utf8");
    } catch {
      continue;
    }

    if (containsImplementationEndpoint(contents)) {
      violations.add(normalize(path));
      continue;
    }
    if (path === "wrangler.toml" && containsLiveWranglerIdentifier(contents)) {
      violations.add(normalize(path));
    }
  }
}

function containsImplementationEndpoint(contents) {
  if (
    /(^|[^@A-Za-z0-9_-])(?:[A-Za-z0-9-]+\.)+workers\.dev\b/i.test(contents) ||
    /(^|[^@A-Za-z0-9_-])(?:[A-Za-z0-9-]+\.)*elim\.[A-Za-z0-9.-]+\b/i.test(contents) ||
    /\bexample-worker-(?:staging|production)\b/i.test(contents)
  ) {
    return true;
  }
  for (const match of contents.matchAll(/https?:\/\/[^\s"'`<>)}\]]+/gi)) {
    const authority = match[0]
      .replace(/^https?:\/\//i, "")
      .split("/", 1)[0]
      .toLowerCase();
    if (
      authority.includes(".workers.dev") ||
      /(^|[.-])elim[.-]/i.test(authority)
    ) {
      return true;
    }
  }
  return /https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}(?:\/|$)/i.test(
    contents
  );
}

function containsLiveWranglerIdentifier(contents) {
  const resourceAssignments =
    /^\s*(?:database_name|bucket_name|queue|dead_letter_queue|CLOUDFLARE_SCRIPT_NAME)\s*=\s*"([^"]+)"\s*$/gim;
  for (const match of contents.matchAll(resourceAssignments)) {
    if (!match[1].toLowerCase().includes("example")) return true;
  }

  for (const match of contents.matchAll(
    /^\s*database_id\s*=\s*"([0-9a-f-]+)"\s*$/gim
  )) {
    if (match[1] !== "00000000-0000-0000-0000-000000000000") return true;
  }
  return false;
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

function normalize(path) {
  return path.split(sep).join("/");
}
