import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { parseEnv } from "node:util";
import { assertDonationLaneConfigured } from "./assert-donation-lane-config.mjs";

const TARGETS = new Set(["staging", "production"]);
const GIVEBUTTER_TITHE_FUND_KEY = "VITE_GIVEBUTTER_TITHE_FUND_ID";
const GIVEBUTTER_OFFERING_FUND_KEY = "VITE_GIVEBUTTER_OFFERING_FUND_ID";
const GIVEBUTTER_FUND_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const GIVEBUTTER_PLACEHOLDER_FUND_IDS = new Set([
  "1",
  "123",
  "1234",
  "12345",
  "123456",
  "1234567",
  "12345678",
  "123456789"
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function loadPrivateDeployConfig({
  target,
  env = process.env,
  repositoryRoot = process.cwd()
}) {
  assertTarget(target);
  const override = env.DIEZMOSSV_DEPLOY_CONFIG?.trim();
  if (override && !isAbsolute(override)) {
    throw sanitizedError("The private deploy config override must be absolute");
  }
  const configPath = override || defaultDeployConfigPath(target);
  const resolvedConfig = assertPrivateFile(configPath, repositoryRoot, "deploy config");

  let parsed;
  try {
    parsed = parseEnv(readFileSync(resolvedConfig, "utf8"));
  } catch {
    throw sanitizedError("The private deploy config is invalid");
  }

  const configuredTarget = requiredValue(parsed, "DIEZMOSSV_DEPLOY_TARGET", "deploy config");
  if (!TARGETS.has(configuredTarget) || configuredTarget !== target) {
    throw sanitizedError("The private deploy config does not match the selected target");
  }
  const workerName = requiredValue(parsed, "DIEZMOSSV_WORKER_NAME", "deploy config");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workerName)) {
    throw sanitizedError("The private deploy config contains an invalid Worker name");
  }
  const githubRepository = requiredValue(
    parsed,
    "DIEZMOSSV_GITHUB_REPOSITORY",
    "deploy config"
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw sanitizedError("The private deploy config contains an invalid GitHub repository");
  }
  const resourceManifest = readResourceManifest(parsed, target);

  const campaign = requiredValue(parsed, "VITE_GIVEBUTTER_CAMPAIGN", "deploy config");
  assertDonationLaneConfigured({
    environment: { VITE_GIVEBUTTER_CAMPAIGN: campaign }
  });
  const givebutterFunds = optionalGivebutterFunds(parsed);

  const originValue = requiredValue(parsed, "DIEZMOSSV_APP_ORIGIN", "deploy config");
  const origin = validatedOrigin(originValue);
  const logoPath = requiredValue(parsed, "DIEZMOSSV_DONOR_LOGO_FILE", "deploy config");
  if (!isAbsolute(logoPath)) {
    throw sanitizedError("The private donor logo path must be absolute");
  }
  const resolvedLogo = assertPrivateFile(logoPath, repositoryRoot, "donor logo");
  let bytes;
  try {
    bytes = readFileSync(resolvedLogo);
  } catch {
    throw sanitizedError("The private donor logo is inaccessible");
  }
  const contentType = sniffRaster(bytes);
  const extension = extname(resolvedLogo).toLowerCase();
  if (
    !contentType ||
    (contentType === "image/png" && extension !== ".png") ||
    (contentType === "image/jpeg" && extension !== ".jpg" && extension !== ".jpeg")
  ) {
    throw sanitizedError("The private donor logo must be a valid extension-matched PNG or JPEG");
  }

  return {
    target,
    workerName,
    githubRepository,
    resourceManifest,
    campaign,
    givebutterFunds,
    origin,
    donorLogo: {
      path: resolvedLogo,
      bytes,
      contentType,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}

export function assertDistinctDeploymentResources(staging, production) {
  const stagingValues = reusableResourceValues(staging);
  const productionValues = reusableResourceValues(production);
  if (stagingValues.some((value) => productionValues.includes(value))) {
    throw sanitizedError("Staging and production must not reuse a deployment resource");
  }
}

function readResourceManifest(parsed, target) {
  const appEnv = requiredValue(parsed, "DIEZMOSSV_APP_ENV", "deploy config");
  if (appEnv !== target) {
    throw sanitizedError("The private deploy config APP_ENV does not match the selected target");
  }
  const accountId = requiredValue(
    parsed,
    "DIEZMOSSV_CLOUDFLARE_ACCOUNT_ID",
    "deploy config"
  );
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw sanitizedError("The private deploy config contains an invalid Cloudflare account identifier");
  }
  const d1DatabaseId = requiredValue(parsed, "DIEZMOSSV_D1_DATABASE_ID", "deploy config");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d1DatabaseId)) {
    throw sanitizedError("The private deploy config contains an invalid D1 database identifier");
  }
  const d1DatabaseName = deploymentResourceName(parsed, "DIEZMOSSV_D1_DATABASE_NAME");
  const r2BucketName = deploymentResourceName(parsed, "DIEZMOSSV_R2_BUCKET_NAME");
  const queueName = deploymentResourceName(parsed, "DIEZMOSSV_QUEUE_NAME");
  const queueDlqName = deploymentResourceName(parsed, "DIEZMOSSV_QUEUE_DLQ_NAME");
  if (queueName === queueDlqName) {
    throw sanitizedError("The private deploy config queue and dead-letter queue must be distinct");
  }
  const workersDevValue = requiredValue(parsed, "DIEZMOSSV_WORKERS_DEV", "deploy config");
  if (workersDevValue !== "true" && workersDevValue !== "false") {
    throw sanitizedError("The private deploy config workers_dev policy must be true or false");
  }
  return {
    accountId,
    appEnv,
    d1DatabaseName,
    d1DatabaseId,
    r2BucketName,
    queueName,
    queueDlqName,
    workersDev: workersDevValue === "true"
  };
}

function deploymentResourceName(parsed, key) {
  const value = requiredValue(parsed, key, "deploy config");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw sanitizedError(`The private deploy config contains an invalid resource name for ${key}`);
  }
  return value;
}

function reusableResourceValues(config) {
  return [
    config.workerName,
    config.origin,
    config.resourceManifest.d1DatabaseName,
    config.resourceManifest.d1DatabaseId,
    config.resourceManifest.r2BucketName,
    config.resourceManifest.queueName,
    config.resourceManifest.queueDlqName
  ];
}

function optionalGivebutterFunds(parsed) {
  const hasTithe = Object.hasOwn(parsed, GIVEBUTTER_TITHE_FUND_KEY);
  const hasOffering = Object.hasOwn(parsed, GIVEBUTTER_OFFERING_FUND_KEY);
  if (!hasTithe && !hasOffering) {
    return null;
  }
  if (!hasTithe || !hasOffering) {
    throw sanitizedError(
      `The private deploy config must set ${GIVEBUTTER_TITHE_FUND_KEY} and ${GIVEBUTTER_OFFERING_FUND_KEY} together as paired Givebutter fund settings`
    );
  }

  const tithe = parsed[GIVEBUTTER_TITHE_FUND_KEY]?.trim() ?? "";
  const offering = parsed[GIVEBUTTER_OFFERING_FUND_KEY]?.trim() ?? "";
  if (!GIVEBUTTER_FUND_ID_PATTERN.test(tithe) || !GIVEBUTTER_FUND_ID_PATTERN.test(offering)) {
    throw sanitizedError(
      `The private deploy config settings ${GIVEBUTTER_TITHE_FUND_KEY} and ${GIVEBUTTER_OFFERING_FUND_KEY} must contain nonblank numeric Givebutter fund identifiers`
    );
  }
  if (GIVEBUTTER_PLACEHOLDER_FUND_IDS.has(tithe) || GIVEBUTTER_PLACEHOLDER_FUND_IDS.has(offering)) {
    throw sanitizedError(
      `The private deploy config settings ${GIVEBUTTER_TITHE_FUND_KEY} and ${GIVEBUTTER_OFFERING_FUND_KEY} contain a placeholder-like Givebutter fund identifier`
    );
  }
  if (tithe === offering) {
    throw sanitizedError(
      `The private deploy config settings ${GIVEBUTTER_TITHE_FUND_KEY} and ${GIVEBUTTER_OFFERING_FUND_KEY} must contain distinct Givebutter fund identifiers`
    );
  }
  return { tithe, offering };
}

export function loadOperatorCredentials({
  target,
  env = process.env,
  repositoryRoot = process.cwd()
}) {
  assertTarget(target);
  const override = env.DIEZMOSSV_OPERATOR_ENV_FILE?.trim();
  if (override && !isAbsolute(override)) {
    throw sanitizedError("The private operator env override must be absolute");
  }
  const credentialsPath = override || defaultOperatorEnvPath(target);
  const resolvedCredentials = assertPrivateFile(
    credentialsPath,
    repositoryRoot,
    "operator env"
  );

  let parsed;
  try {
    parsed = parseEnv(readFileSync(resolvedCredentials, "utf8"));
  } catch {
    throw sanitizedError("The private operator env is invalid");
  }
  const prefix = target.toUpperCase();
  const email = parsed[`${prefix}_EMAIL`]?.trim() || parsed.DIEZMOSSV_OPERATOR_EMAIL?.trim();
  const password = parsed[`${prefix}_PASSWORD`]?.trim() || parsed.DIEZMOSSV_OPERATOR_PASSWORD?.trim();
  if (!email || !password) {
    throw sanitizedError("The private operator env is missing required credentials");
  }
  return { email, password };
}

function defaultDeployConfigPath(target) {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "DiezmosSV",
    "private",
    "deploy",
    `${target}.env`
  );
}

function defaultOperatorEnvPath(target) {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "DiezmosSV",
    "private",
    "env",
    target === "staging" ? "staging-smoke.env" : "production-operator.env"
  );
}

function assertPrivateFile(path, repositoryRoot, label) {
  if (!isAbsolute(path)) {
    throw sanitizedError(`The private ${label} path must be absolute`);
  }
  let entry;
  let resolvedPath;
  let resolvedRepository;
  let stat;
  try {
    entry = lstatSync(path);
    resolvedPath = realpathSync(path);
    resolvedRepository = realpathSync(repositoryRoot);
    stat = statSync(resolvedPath);
  } catch {
    throw sanitizedError(`The private ${label} is missing or inaccessible`);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw sanitizedError(`The private ${label} must be a regular file`);
  }
  if (isInside(resolvedRepository, resolvedPath)) {
    throw sanitizedError(`The private ${label} must stay outside the repository`);
  }
  // Owner-only data: no group or other bits, and never executable. Both 0600 and the
  // stricter read-only 0400 qualify.
  if ((stat.mode & 0o177) !== 0) {
    throw sanitizedError(`The private ${label} must have owner-only permissions (0600 or 0400)`);
  }
  if ((stat.mode & 0o400) === 0) {
    throw sanitizedError(`The private ${label} must be readable by its owner`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw sanitizedError(`The private ${label} must be owned by the current user`);
  }
  return resolvedPath;
}

// The key names are already public — the README documents every one of them — so naming
// the missing key is safe and makes the failure actionable. The value never appears.
function requiredValue(parsed, key, label) {
  const value = parsed[key]?.trim();
  if (!value) {
    throw sanitizedError(`The private ${label} is missing a required setting: ${key}`);
  }
  return value;
}

function validatedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw sanitizedError("The deployment origin is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw sanitizedError("The deployment origin must use HTTPS unless it is loopback");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw sanitizedError("The deployment origin must contain only scheme, host, and port");
  }
  return url.origin;
}

function sniffRaster(bytes) {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  return null;
}

function assertTarget(target) {
  if (!TARGETS.has(target)) {
    throw sanitizedError("Deployment target must be staging or production");
  }
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sanitizedError(message) {
  return new Error(message);
}
