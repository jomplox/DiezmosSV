#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID } from "node:crypto";

const help = `
DiezmosSV Cloudflare staging smoke test

Required env:
  STAGING_URL              Deployed Worker URL, for example https://diezmossv-staging-resource-example.<account>.workers.dev
  STAGING_EMAIL            Admin/operator login email
  STAGING_PASSWORD         Admin/operator login password
  WOMPI_API_SECRET         Staging Wompi webhook secret
  SMOKE_DONOR_DOCUMENT     Donor document to place on the TEST CDE

Optional env:
  STAGING_BOOTSTRAP=1      Bootstrap owner before login if login fails and D1 is empty
  STAGING_BOOTSTRAP_TOKEN  Required when STAGING_BOOTSTRAP=1; sent as X-Bootstrap-Owner-Token
  STAGING_NAME             Bootstrap owner name, default "Staging Owner"
  SMOKE_AMOUNT             Donation amount, default "1.00"
  SMOKE_DONOR_NAME         Donor name, default "Staging Smoke"
  SMOKE_DONOR_EMAIL        Donor email, default unique smoke address
  SMOKE_DONOR_PHONE        Donor phone, default "00000000"
  SMOKE_PATHS              Comma list: webhook,admin. Default "webhook,admin"
  SMOKE_TIMEOUT_MS         Poll timeout, default 120000
  SMOKE_POLL_MS            Poll interval, default 5000
  SMOKE_CREATE_USER=1      Create a disposable VIEWER user
  SMOKE_INVALIDATE=1       Invalidate the accepted TEST DTE after downloads/resend
  SMOKE_RETRY_DOCUMENT_ID  Existing failed/rejected document id to retry
  SMOKE_ALLOW_EMAIL_FAILURE=1  Report resend failure as warning instead of failing

Usage:
  npm run smoke:staging
  npm run smoke:staging -- --dry-run
`;

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  process.stdout.write(help);
  process.exit(0);
}

const dryRun = args.has("--dry-run");
const required = ["STAGING_URL", "STAGING_EMAIL", "STAGING_PASSWORD", "WOMPI_API_SECRET", "SMOKE_DONOR_DOCUMENT"];
if (process.env.STAGING_BOOTSTRAP === "1") {
  required.push("STAGING_BOOTSTRAP_TOKEN");
}
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  fail(`Missing required env: ${missing.join(", ")}\n${help}`);
}

const config = {
  baseUrl: normalizeBaseUrl(requiredEnv("STAGING_URL")),
  email: requiredEnv("STAGING_EMAIL"),
  password: requiredEnv("STAGING_PASSWORD"),
  bootstrap: process.env.STAGING_BOOTSTRAP === "1",
  bootstrapToken: process.env.STAGING_BOOTSTRAP_TOKEN ?? "",
  name: process.env.STAGING_NAME ?? "Staging Owner",
  wompiSecret: requiredEnv("WOMPI_API_SECRET"),
  amount: process.env.SMOKE_AMOUNT ?? "1.00",
  donorName: process.env.SMOKE_DONOR_NAME ?? "Staging Smoke",
  donorEmail: process.env.SMOKE_DONOR_EMAIL ?? `smoke+${Date.now()}@example.org`,
  donorDocument: requiredEnv("SMOKE_DONOR_DOCUMENT"),
  donorPhone: process.env.SMOKE_DONOR_PHONE ?? "00000000",
  paths: parsePaths(process.env.SMOKE_PATHS ?? "webhook,admin"),
  timeoutMs: parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 120_000),
  pollMs: parsePositiveInt(process.env.SMOKE_POLL_MS, 5_000),
  createUser: process.env.SMOKE_CREATE_USER === "1",
  invalidate: process.env.SMOKE_INVALIDATE === "1",
  retryDocumentId: process.env.SMOKE_RETRY_DOCUMENT_ID,
  allowEmailFailure: process.env.SMOKE_ALLOW_EMAIL_FAILURE === "1"
};

if (dryRun) {
  const payload = buildWompiPayload(config, "DRY-RUN");
  log("dry-run", {
    baseUrl: config.baseUrl,
    paths: config.paths,
    donorEmail: config.donorEmail,
    donorDocument: redact(config.donorDocument),
    amount: config.amount,
    signedWebhookShape: Boolean(signWompiPayload(JSON.stringify(payload), config.wompiSecret)),
    willCreateUser: config.createUser,
    willBootstrap: config.bootstrap,
    willInvalidate: config.invalidate,
    retryDocumentId: config.retryDocumentId ?? null
  });
  process.exit(0);
}

await main();

async function main() {
  const startedAt = Date.now();
  const results = [];
  logStep("Checking ASSETS/admin UI shell");
  const shell = await textRequest("/", { token: null });
  assert(shell.includes("ExamplePerson1") || shell.includes("root"), "Admin UI shell did not look like the built app");
  results.push({ check: "admin_ui_shell", ok: true });

  logStep("Checking /api/health");
  const health = await jsonRequest("/api/health", { token: null });
  results.push({ check: "health", ok: true, appEnv: health.appEnv });

  logStep("Authenticating");
  const auth = await authenticate();
  results.push({ check: "auth", ok: true, role: auth.user.role });

  if (config.createUser) {
    logStep("Creating disposable VIEWER user");
    const suffix = Date.now();
    // Crypto-random and never logged: the timestamp stays in the (non-secret) name/email
    // for traceability, but the password must not be derivable from smoke output. The
    // "Smoke-...!1" wrapper guarantees the password policy (upper/lower/number/symbol).
    const password = `Smoke-${randomBytes(18).toString("base64url")}!1`;
    const created = await jsonRequest("/api/users", {
      method: "POST",
      token: auth.token,
      body: {
        name: `Smoke Viewer ${suffix}`,
        email: `smoke-viewer+${suffix}@example.org`,
        role: "VIEWER",
        password
      }
    });
    results.push({ check: "user_create", ok: true, user: created.user.email });
  }

  const acceptedDocs = [];
  for (const path of config.paths) {
    if (path === "webhook") {
      const doc = await runWebhookPath(auth.token, startedAt);
      acceptedDocs.push(doc);
      results.push({ check: "webhook_to_accepted_dte", ok: true, documentId: doc.id, sello: doc.sello_recibido });
    }
    if (path === "admin") {
      const doc = await runAdminPath(auth.token, startedAt);
      acceptedDocs.push(doc);
      results.push({ check: "admin_test_to_accepted_dte", ok: true, documentId: doc.id, sello: doc.sello_recibido });
    }
  }

  const targetDoc = acceptedDocs[0];
  if (!targetDoc) {
    fail("No accepted document was produced by selected smoke paths");
  }

  logStep("Downloading PDF and signed JSON");
  const pdf = await binaryRequest(`/api/documents/${targetDoc.id}/pdf`, { token: auth.token });
  assert(pdf.contentType.includes("application/pdf"), `Unexpected PDF content type: ${pdf.contentType}`);
  assert(pdf.bytes.byteLength > 500, "PDF download was unexpectedly small");
  const json = await binaryRequest(`/api/documents/${targetDoc.id}/json`, { token: auth.token });
  assert(json.bytes.byteLength > 100, "JSON/JWS download was unexpectedly small");
  results.push({ check: "downloads", ok: true, pdfBytes: pdf.bytes.byteLength, jsonBytes: json.bytes.byteLength });

  logStep("Resending email receipt");
  try {
    await jsonRequest(`/api/documents/${targetDoc.id}/resend`, { method: "POST", token: auth.token, body: {} });
    results.push({ check: "email_resend", ok: true });
  } catch (error) {
    if (!config.allowEmailFailure) throw error;
    results.push({ check: "email_resend", ok: false, warning: error.message });
  }

  if (config.retryDocumentId) {
    logStep("Retrying supplied failed/rejected document");
    await jsonRequest(`/api/documents/${config.retryDocumentId}/retry`, { method: "POST", token: auth.token, body: {} });
    results.push({ check: "retry_supplied_document", ok: true, documentId: config.retryDocumentId });
  } else {
    results.push({ check: "retry_supplied_document", ok: null, skipped: "Set SMOKE_RETRY_DOCUMENT_ID for a failed/rejected document" });
  }

  logStep("Running contingency sweep");
  const sweep = await jsonRequest("/api/contingency/sweep", { method: "POST", token: auth.token, body: {} });
  results.push({ check: "contingency_sweep", ok: true, transmitted: sweep.transmitted, periodId: sweep.periodId });

  if (config.invalidate) {
    logStep("Invalidating accepted TEST DTE");
    const invalidation = await jsonRequest(`/api/documents/${targetDoc.id}/invalidate`, {
      method: "POST",
      token: auth.token,
      body: { tipoAnulacion: 2, motivoAnulacion: "Invalidacion smoke test staging" }
    });
    assert(Boolean(invalidation.accepted), `Invalidation was not accepted: ${JSON.stringify(invalidation)}`);
    results.push({ check: "invalidation", ok: true, eventId: invalidation.eventId });
  } else {
    results.push({ check: "invalidation", ok: null, skipped: "Set SMOKE_INVALIDATE=1 to consume an accepted TEST DTE" });
  }

  logStep("Checking audit log");
  const audit = await jsonRequest("/api/audit", { token: auth.token });
  assert(Array.isArray(audit.audit) && audit.audit.length > 0, "Audit log was empty");
  results.push({ check: "audit_log", ok: true, rows: audit.audit.length });

  log("summary", { ok: true, results });
}

async function authenticate() {
  try {
    return await login();
  } catch (error) {
    if (!config.bootstrap) throw error;
    logStep("Login failed, attempting owner bootstrap because STAGING_BOOTSTRAP=1");
    await jsonRequest("/api/auth/bootstrap-owner", {
      method: "POST",
      token: null,
      headers: { "X-Bootstrap-Owner-Token": config.bootstrapToken },
      body: { email: config.email, name: config.name, password: config.password }
    });
    return login();
  }
}

async function login() {
  return jsonRequest("/api/auth/login", {
    method: "POST",
    token: null,
    body: { email: config.email, password: config.password }
  });
}

async function runWebhookPath(token, startedAt) {
  logStep("Posting signed Wompi TEST webhook");
  const payload = buildWompiPayload(config, `SMOKE-WEBHOOK-${Date.now()}`);
  const rawBody = JSON.stringify(payload);
  const response = await jsonRequest("/webhooks/wompi", {
    method: "POST",
    token: null,
    rawBody,
    headers: {
      "Content-Type": "application/json",
      wompi_hash: signWompiPayload(rawBody, config.wompiSecret)
    }
  });
  assert(response.queued === true, `Webhook was not queued: ${JSON.stringify(response)}`);
  return pollAcceptedDocument(token, payload.Cliente.EMail, startedAt);
}

async function runAdminPath(token, startedAt) {
  logStep("Posting admin-generated TEST DTE");
  const email = withTag(config.donorEmail, "admin");
  const response = await jsonRequest("/api/test/dte", {
    method: "POST",
    token,
    body: {
      amount: config.amount,
      donorName: config.donorName,
      donorEmail: email,
      donorDocument: config.donorDocument,
      donorPhone: config.donorPhone
    }
  });
  assert(response.queued === true, `Admin TEST DTE was not queued: ${JSON.stringify(response)}`);
  return pollAcceptedDocument(token, email, startedAt);
}

async function pollAcceptedDocument(token, donorEmail, startedAt) {
  const deadline = Date.now() + config.timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const params = new URLSearchParams({ q: donorEmail, limit: "100" });
    const response = await jsonRequest(`/api/documents?${params}`, { token });
    const docs = response.documents ?? [];
    const match = docs.find((doc) => doc.donor_email === donorEmail && Date.parse(doc.created_at) >= startedAt - 5_000);
    if (match) {
      lastSeen = {
        id: match.id,
        status: match.status,
        ambiente: match.environment,
        sello: match.sello_recibido,
        mhEstado: match.mh_estado,
        observaciones: match.mh_observaciones_json
      };
      if (match.status === "ACCEPTED" && match.sello_recibido && match.environment === "00") {
        return match;
      }
      if (match.status === "REJECTED" || match.status === "FAILED") {
        fail(`Document reached ${match.status}: ${JSON.stringify(lastSeen)}`);
      }
    }
    await sleep(config.pollMs);
  }
  fail(`Timed out waiting for accepted ambiente 00 DTE for ${donorEmail}. Last seen: ${JSON.stringify(lastSeen)}`);
}

function buildWompiPayload(input, transactionId) {
  const fullName = input.donorName.trim() || "Staging Smoke";
  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = parts.length <= 1 ? fullName : parts.slice(0, -1).join(" ");
  const lastName = parts.length <= 1 ? "Smoke" : parts.at(-1);
  return {
    IdCuenta: "diezmossv-staging-resource-example",
    FechaTransaccion: new Date().toISOString(),
    Monto: input.amount,
    IdTransaccion: `${transactionId}-${randomUUID()}`,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: "STAGING",
    IdIntentoPago: randomUUID(),
    Cantidad: 1,
    EsProductiva: false,
    Aplicativo: {
      Nombre: "DiezmosSV Staging",
      Url: input.baseUrl,
      Id: "diezmossv-staging-resource-example"
    },
    EnlacePago: {
      Id: 1,
      IdentificadorEnlaceComercio: "DTE Test",
      NombreProducto: "Donacion de prueba",
      DescripcionProducto: "Prueba controlada de integracion DTE"
    },
    Cliente: {
      DocumentoIdentidad: input.donorDocument,
      Nombre: firstName,
      Apellidos: lastName,
      Direccion: "Direccion de prueba",
      EMail: withTag(input.donorEmail, "webhook"),
      Celular: input.donorPhone,
      NombreRegion: "San Salvador",
      NombrePais: "El Salvador",
      CodigoPais: "SV",
      CodigoRegion: "SV-SS"
    },
    EsInternacional: false,
    IdExterno: "DTE-TEST"
  };
}

function signWompiPayload(rawBody, secret) {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

async function jsonRequest(path, options) {
  const response = await request(path, options);
  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function textRequest(path, options) {
  const response = await request(path, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text}`);
  }
  return text;
}

async function binaryRequest(path, options) {
  const response = await request(path, options);
  const bytes = await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${new TextDecoder().decode(bytes)}`);
  }
  return { bytes, contentType: response.headers.get("content-type") ?? "" };
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body = undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
}

function parsePaths(value) {
  const paths = value.split(",").map((item) => item.trim()).filter(Boolean);
  const valid = new Set(["webhook", "admin"]);
  for (const path of paths) {
    if (!valid.has(path)) fail(`Invalid SMOKE_PATHS entry: ${path}`);
  }
  if (paths.length === 0) fail("SMOKE_PATHS must include webhook, admin, or both");
  return paths;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`Expected positive integer, got ${value}`);
  return parsed;
}

function withTag(email, tag) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  const cleanLocal = local.replace(/\+.*$/, "");
  return `${cleanLocal}+${tag}-${Date.now()}@${domain}`;
}

function requiredEnv(key) {
  return process.env[key];
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function redact(value) {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message) {
  console.log(`-> ${message}`);
}

function log(label, data) {
  console.log(JSON.stringify({ label, ...data }, null, 2));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
