import { lstatSync, readdirSync } from "node:fs";
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

for (const entry of safeReadDir(join(root, "DTE"))) {
  if (!entry.isFile() && !entry.isSymbolicLink()) continue;
  if (/\.(?:csv|xlsx|pdf)$/i.test(entry.name) || /_OCR\.md$/i.test(entry.name) || /_by_PaddleOCR.*\.md$/i.test(entry.name)) {
    violations.add(`DTE/${entry.name}`);
  }
}

for (const entry of safeReadDir(join(root, "examples"))) {
  if ((!entry.isFile() && !entry.isSymbolicLink()) || !/^DTE-.*\.(?:json|pdf)$/i.test(entry.name)) continue;
  violations.add(`examples/${entry.name}`);
}

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
