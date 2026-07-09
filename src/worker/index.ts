import { getEmisorConfig, getMhCertificateXml, requireSecret } from "./config";
import { buildAdvancedCdeDocument, buildDirectCdeDocument, buildInvalidacionEvent, cdeDocumentSummary, type DirectCdeInput, type InvalidationInput } from "./domain/dteBuilder";
import { certificateExpiry, signMhDocument } from "./domain/signer";
import { ambienteFromWompi, isApprovedDonation, normalizeWompiWebhook, verifyWompiHash, WompiPayloadError, wompiHashHeader } from "./domain/wompi";
import { ALERT_EMAIL_SETTING_KEY, normalizeAlertRecipients, sendOperationalAlert } from "./services/alerts";
import { AuthError, AuthService, PASSWORD_RESET_TTL_MINUTES, PasswordResetError, requireRole, type AuthUser, type Role } from "./services/auth";
import { bootstrapCloudflareWriterToken, buildCredentialSecretPatch, CredentialWriterConfigError, credentialStatus, patchCloudflareWorkerSecrets, type CredentialUpdateInput } from "./services/credentials";
import {
  applyIntentDatos,
  clientIpFrom,
  createDonationIntent,
  createDraftDonationIntent,
  IntentDatosError,
  IntentLinkError,
  intentThrottleSinceIso,
  IntentValidationError,
  INTENT_THROTTLE_LIMIT,
  isDraftIntentBody,
  validateDatosInput,
  validateDraftIntentInput,
  validateIntentInput
} from "./services/donations";
import { EmailService } from "./services/email";
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATES_SETTING_KEY, EmailTemplateValidationError, emailTemplateResponse, normalizeEmailTemplateSettings, parseEmailTemplates } from "./services/emailTemplates";
import {
  BRANDING_ACCENT_COLOR_SETTING_KEY,
  BRANDING_DONOR_LOGO_OBJECT_KEY,
  BRANDING_DONOR_LOGO_SETTING_KEY,
  BRANDING_DISPLAY_NAME_SETTING_KEY,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_LOGO_OBJECT_KEY,
  BRANDING_LOGO_SETTING_KEY,
  BRANDING_SUPPORT_EMAIL_SETTING_KEY,
  BrandingValidationError,
  loadEmailBranding,
  normalizeBrandingAccentColor,
  normalizeBrandingDisplayName,
  normalizeBrandingLogoContentType,
  normalizeBrandingSupportEmail,
  parseBrandingLogoMeta,
  parseBrandingSettings
} from "./services/branding";
import { buildAnnualCertificatePreview, certificateYearError, sendAnnualCertificates, SingleDonorSendError } from "./services/certificate";
import { computeAnalytics, elSalvadorRangeWindow, type AnalyticsRange } from "./services/analytics";
import { CAT012_DEPARTMENTS, CAT020_COUNTRIES, findCatalogOption } from "../shared/catalogs";
import { aggregateDonorContacts, buildContactsCsv, resolveContactColumns, contactsCsvFilename } from "./services/contacts";
import { buildF960Csv, buildF960Selection, buildF960Xlsx, XLSX_MIME, type F960Selection } from "./services/f960";
import { MhClient } from "./services/mhClient";
import { IssuancePipeline, RejectedWompiRetryConflictError } from "./services/pipeline";
import { renderDtePdf } from "./services/pdf";
import { auditContextFrom } from "./services/requestContext";
import { BackupArchiveTooLargeError, BACKUP_MONTH_DOWNLOAD_MAX_BYTES, collectBackupMonthObjects, listBackupMonths, verifyBackupMonth } from "./services/backups";
import { zipStored } from "./utils/zip";
import { previousElSalvadorMonth, retentionManifestKey, retentionTableKey, runRetentionExport } from "./services/retention";
import { WompiApiService } from "./services/wompiApi";
import { formatElSalvadorDate } from "../shared/legalWindows";
import { Repository } from "./storage/repository";
import type { DteDocumentRecord, Env, IssuanceMessage, MhResponse, WompiWebhook } from "./types";
import { addHours, cdeInvalidationDeadline, isWithinDeadline, nowIso } from "./utils/dates";
import { timingSafeEqual } from "./utils/encoding";
import { jsonResponse, methodNotAllowed, notFound } from "./utils/http";

const BOOTSTRAP_OWNER_TOKEN_HEADER = "X-Bootstrap-Owner-Token";
const EMISSION_ENVIRONMENT_SETTING = "emission_environment";
const RETENTION_EXPORT_CRON = "0 9 1 * *";
const CERT_EXPIRY_ALERT_THRESHOLD_DAYS = [30, 14, 3];
// Audit-based auth throttling. Failed logins and password-reset requests are
// counted over a rolling window; crossing the threshold short-circuits the endpoint
// before any credential work runs, so there is no timing oracle to distinguish
// throttled from rejected. Login failures are keyed on (email, caller IP) so a third
// party cannot lock out a victim's email by spamming failures from another address,
// while real brute-force from a single IP is still capped.
const AUTH_THROTTLE_WINDOW_MINUTES = 15;
const LOGIN_FAILED_LIMIT = 5;
const PASSWORD_RESET_LIMIT = 3;

// The public donation endpoints parse untrusted JSON before any validation or
// persistence, and the per-IP throttle counts only PERSISTED intents — so oversized
// invalid bodies would otherwise be free to spam. Cap the body at 16 KiB (these
// payloads are a few hundred bytes) so an oversized request is rejected up front.
const PUBLIC_DONATION_JSON_BODY_LIMIT_BYTES = 16 * 1024;

type BrandingLogoSlot = {
  settingKey: string;
  objectKey: string;
  versionField: "logoVersion" | "donorLogoVersion";
  updatedAction: "BRANDING_LOGO_UPDATED" | "BRANDING_DONOR_LOGO_UPDATED";
  removedAction: "BRANDING_LOGO_REMOVED" | "BRANDING_DONOR_LOGO_REMOVED";
  updatedSummary: string;
  removedSummary: string;
};

const ADMIN_EMAIL_LOGO_SLOT: BrandingLogoSlot = {
  settingKey: BRANDING_LOGO_SETTING_KEY,
  objectKey: BRANDING_LOGO_OBJECT_KEY,
  versionField: "logoVersion",
  updatedAction: "BRANDING_LOGO_UPDATED",
  removedAction: "BRANDING_LOGO_REMOVED",
  updatedSummary: "Logo de marca actualizado",
  removedSummary: "Logo de marca eliminado"
};

const DONOR_LOGO_SLOT: BrandingLogoSlot = {
  settingKey: BRANDING_DONOR_LOGO_SETTING_KEY,
  objectKey: BRANDING_DONOR_LOGO_OBJECT_KEY,
  versionField: "donorLogoVersion",
  updatedAction: "BRANDING_DONOR_LOGO_UPDATED",
  removedAction: "BRANDING_DONOR_LOGO_REMOVED",
  updatedSummary: "Logo de donantes actualizado",
  removedSummary: "Logo de donantes eliminado"
};

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

// Reads a JSON body while enforcing a byte cap: a declared Content-Length over the
// limit is rejected immediately, and a chunked/undeclared body is bounded as it
// streams so a lying (or absent) length header cannot bypass the cap. Malformed JSON
// resolves to {} to preserve the endpoints' prior tolerant parsing.
async function readJsonBodyWithLimit(request: Request, limitBytes: number): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > limitBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  const body = request.body;
  if (!body) {
    return {};
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > limitBytes) {
          throw new RequestBodyTooLargeError();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(concatBytes(chunks, total)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function donationBodyTooLargeResponse(): Response {
  return jsonResponse({ error: "request_body_too_large", message: "La solicitud es demasiado grande." }, { status: 413 });
}

function backupArchiveTooLargeResponse(): Response {
  return jsonResponse(
    {
      error: "backup_archive_too_large",
      message: "El respaldo mensual es demasiado grande para descargarlo como ZIP. Descarga las tablas individualmente.",
      limitBytes: BACKUP_MONTH_DOWNLOAD_MAX_BYTES
    },
    { status: 413 }
  );
}

function authThrottleSinceIso(): string {
  return new Date(Date.now() - AUTH_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
}

// Operator telemetry captured on audit rows: the client IP, the Cloudflare request
// context (geo/ISP), and the acting user's email. The OWNER wants this visible in
// Auditoría, but only to ADMIN+; VIEWERs receive these columns nulled server-side so
// the values never leave the worker. The client renders the nulls as an em-dash and
// hides the expandable context row.
const SENSITIVE_AUDIT_FIELDS = ["actor_ip", "actor_context", "actor_email"] as const;

function canViewSensitiveAudit(user: AuthUser): boolean {
  return user.role === "ADMIN" || user.role === "OWNER";
}

function redactAuditForUser(rows: Array<Record<string, unknown>>, user: AuthUser): Array<Record<string, unknown>> {
  if (canViewSensitiveAudit(user)) {
    return rows;
  }
  return rows.map((row) => {
    const redacted = { ...row };
    for (const field of SENSITIVE_AUDIT_FIELDS) {
      redacted[field] = null;
    }
    return redacted;
  });
}

async function listAuditForUser(
  repo: Repository,
  user: AuthUser,
  entityType?: string,
  entityId?: string
): Promise<Array<Record<string, unknown>>> {
  return redactAuditForUser(await repo.listAudit(entityType, entityId), user);
}

// Canonical public origin for links emailed to users (password reset). Built from the
// configured APP_ORIGIN so a poisoned Host header cannot redirect reset tokens to an
// attacker; falls back to the request origin only when APP_ORIGIN is unset (local dev).
function resolveAppOrigin(env: Env, url: URL): string {
  const configured = env.APP_ORIGIN?.trim();
  if (configured) {
    return new URL(configured).origin;
  }
  return url.origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      if (url.pathname === "/webhooks/wompi") {
        return await handleWompiWebhook(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof AuthError) {
        return jsonResponse({ error: "auth_error", message: error.message }, { status: error.status });
      }
      return jsonResponse({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
    if (batch.queue.endsWith("-dlq")) {
      await handleDeadLetterBatch(batch, env);
      return;
    }
    const pipeline = new IssuancePipeline(env);
    for (const message of batch.messages) {
      try {
        if (message.body.advancedDocumentId) {
          await pipeline.processDteDocument(message.body.advancedDocumentId);
        } else if (message.body.wompiEventId) {
          await pipeline.processWompiEvent(message.body.wompiEventId);
        } else {
          throw new Error("Issuance message did not include a target id");
        }
        message.ack();
      } catch (error) {
        console.error("Issuance message failed", error);
        message.retry();
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === RETENTION_EXPORT_CRON) {
      try {
        await runRetentionExport(env, new Date(event.scheduledTime));
      } catch (error) {
        console.error("Retention export failed", error);
      }
      return;
    }
    const pipeline = new IssuancePipeline(env);
    try {
      await pipeline.retryDeferredTransmissions();
    } catch (error) {
      console.error("Deferred transmission retry failed", error);
    }
    try {
      await pipeline.sweepStalledWompiEvents();
    } catch (error) {
      console.error("Stalled Wompi event sweep failed", error);
    }
    try {
      const repo = new Repository(env.DB);
      const now = nowIso();
      // Process a bounded page per tick: snapshot the capped set of expiring intents,
      // then expire exactly that page by id, so public intent creation cannot force one
      // cron invocation to snapshot or deactivate an unbounded row set. The remainder
      // is picked up by the next tick.
      const expiring = await repo.listIntentsExpiringBefore(now);
      await repo.expireDonationIntentsByIds(expiring.map((intent) => intent.id), now);
      const wompi = new WompiApiService(env);
      for (const intent of expiring) {
        if (intent.wompi_id_enlace == null) {
          continue;
        }
        // Each deactivation is isolated: one Wompi failure must not abort the sweep
        // or the other deactivations. The intent is already EXPIRED regardless.
        try {
          await wompi.deactivatePaymentLink(intent);
        } catch (error) {
          console.error("Wompi link deactivation failed", intent.id, error);
        }
      }
    } catch (error) {
      console.error("Donation intent expiry sweep failed", error);
    }
    try {
      // Drive the expiry math from the scheduled tick's time, the same reference the
      // retention export above uses, so the countdown never depends on the wall clock.
      await checkCertificateExpiry(env, new Repository(env.DB), event.scheduledTime ?? Date.now());
    } catch (error) {
      console.error("Certificate expiry check failed", error);
    }
  }
};

async function handleDeadLetterBatch(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
  const repo = new Repository(env.DB);
  for (const message of batch.messages) {
    const documentId = message.body.advancedDocumentId;
    const wompiEventId = message.body.wompiEventId;
    const entityType = documentId ? "dte_document" : "wompi_event";
    const entityId = documentId ?? wompiEventId ?? "desconocido";
    const summary = "Mensaje de emisión agotó sus reintentos en cola; conservado para revisión";
    await repo.createAudit({
      action: "ISSUANCE_DEAD_LETTERED",
      entityType,
      entityId,
      summary
    });
    await sendOperationalAlert(env, repo, {
      kind: "ISSUANCE_DEAD_LETTERED",
      title: "Mensaje de emisión agotó reintentos",
      detail: summary,
      entityType,
      entityId
    });
    message.ack();
  }
}

// Runs on every 15-minute cron tick. certificateExpiry never throws (an
// unreadable/absent MH_CERT_XML yields expiresAt: null), so this simply
// no-ops when there is nothing to check. Sends at most one alert per
// threshold crossed (30/14/3 days), deduped by sendOperationalAlert's
// audit-based mechanism keyed on `${expiresAt}:${threshold}` so a renewed
// certificate (new expiresAt) re-arms every threshold. nowMs is the scheduled
// tick's time, threaded from worker.scheduled so the countdown in both the
// threshold check and the alert copy reads one clock instead of the wall clock.
async function checkCertificateExpiry(env: Env, repo: Repository, nowMs: number): Promise<void> {
  let certXml: string;
  try {
    certXml = getMhCertificateXml(env);
  } catch {
    return;
  }
  const { expiresAt } = certificateExpiry(certXml);
  if (!expiresAt) {
    return;
  }
  const remainingDays = Math.floor((new Date(expiresAt).getTime() - nowMs) / (24 * 60 * 60 * 1000));
  const remainingLabel = remainingDays < 0 ? `venció hace ${Math.abs(remainingDays)} días` : `Quedan ${remainingDays} día(s)`;
  for (const threshold of CERT_EXPIRY_ALERT_THRESHOLD_DAYS) {
    if (remainingDays > threshold) {
      continue;
    }
    await sendOperationalAlert(env, repo, {
      kind: "CERT_EXPIRING",
      title: "Certificado del firmador MH por vencer",
      detail: `El certificado del firmador del Ministerio de Hacienda vence el ${formatElSalvadorDate(expiresAt)}. ${remainingLabel}.`,
      entityType: "credentials",
      entityId: `${expiresAt}:${threshold}`
    });
  }
}

async function handleWompiWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const rawBody = await request.text();
  const valid = await verifyWompiHash(rawBody, wompiHashHeader(request), requireSecret(env, "WOMPI_API_SECRET"));
  if (!valid) {
    return jsonResponse({ error: "invalid_wompi_hash" }, { status: 401 });
  }
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "invalid_wompi_payload", message: "El webhook Wompi no contiene JSON válido" }, { status: 400 });
  }
  let payload: WompiWebhook;
  try {
    payload = normalizeWompiWebhook(parsedPayload);
  } catch (error) {
    if (error instanceof WompiPayloadError) {
      return jsonResponse({ error: "invalid_wompi_payload", message: error.message }, { status: 400 });
    }
    throw error;
  }
  // The webhook is an inbound Cloudflare request too — capture Wompi's IP/context so
  // WOMPI_RECEIVED/WOMPI_DUPLICATE audits carry the same actor context as UI actions.
  const repo = new Repository(env.DB, auditContextFrom(request));
  // The environment is the signed payload's own EsProductiva flag — never the
  // owner-controlled active emission setting. A test-mode payment (EsProductiva=false)
  // must never be emitted as a PRODUCTION DTE just because the deployment defaults to
  // 01; the signed flag is the fiscal source of truth. When the two disagree we still
  // honor the payload but audit the disagreement so operators can see it.
  const environment = ambienteFromWompi(payload);
  const activeEnvironment = await activeEmissionEnvironment(repo, env);
  const headers = Object.fromEntries([...request.headers.entries()].filter(([key]) => key.toLowerCase() !== "authorization"));
  const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, headers, environment);
  await repo.createAudit({
    action: inserted ? "WOMPI_RECEIVED" : "WOMPI_DUPLICATE",
    entityType: "wompi_event",
    entityId: record.id,
    summary: `${payload.IdTransaccion} ${payload.ResultadoTransaccion}`
  });
  if (inserted && environment !== activeEnvironment) {
    await repo.createAudit({
      action: "WOMPI_ENVIRONMENT_MISMATCH",
      entityType: "wompi_event",
      entityId: record.id,
      summary: `El webhook declara ambiente ${environment} pero la emisión activa es ${activeEnvironment}; se honra el del webhook`,
      metadata: { payloadEnvironment: environment, activeEnvironment }
    });
  }
  // Stamp the donor's payment marker synchronously, BEFORE the queue enqueue and
  // regardless of it. The donor-facing "thanks" keys on paid_at (the PAYMENT), not on
  // COMPLETED (the CDE's MH acceptance, which the async pipeline sets and can lag).
  // Runs on replays too (markIntentPaid is idempotent). Wrapped defensively — a
  // bad/unknown intent id must never break webhook processing.
  await markIntentPaidFromWebhook(repo, payload);
  if (inserted && isApprovedDonation(payload)) {
    await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id });
  }
  return jsonResponse({ ok: true, wompiEventId: record.id, inserted, queued: inserted && isApprovedDonation(payload) }, { status: inserted ? 202 : 200 });
}

// Marks the donation intent this approved webhook fulfills as paid, keyed on the same
// intent-id correlation the pipeline uses (payload.IdExterno, falling back to the raw
// enlace identifier). Only "di_"-prefixed ids of approved donations touch the DB, so
// legacy static-link payloads skip it entirely. Never throws: any failure is swallowed
// so a bad intent id can never 500 the webhook — the paid marker is a UI convenience,
// not a correctness gate (the pipeline still owns COMPLETED and the comprobante).
async function markIntentPaidFromWebhook(repo: Repository, payload: WompiWebhook): Promise<void> {
  try {
    if (!isApprovedDonation(payload)) {
      return;
    }
    const intentId = payload.IdExterno ?? payload.EnlacePago?.IdentificadorEnlaceComercio;
    if (!intentId || !intentId.startsWith("di_")) {
      return;
    }
    await repo.markIntentPaid(intentId);
  } catch (error) {
    console.error("No se pudo marcar la intención como pagada", error);
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // Build the actor context ONCE per request and inject it into the Repository, so
  // every downstream repo.createAudit (route handlers reuse this same instance)
  // records the caller's IP and Cloudflare request context without per-call-site wiring.
  const repo = new Repository(env.DB, auditContextFrom(request));
  const auth = new AuthService(env);
  const user = await auth.authenticate(request);

  if (url.pathname === "/api/health") {
    return jsonResponse({ ok: true, appEnv: env.APP_ENV ?? "unknown", now: nowIso() });
  }

  if (url.pathname === "/api/auth/bootstrap-status" && request.method === "GET") {
    return jsonResponse({ bootstrapAvailable: (await repo.countUsers()) === 0 });
  }

  // Public branding read: the login screen needs the display name, accent color, and
  // logo version BEFORE any session exists, so these two routes are unauthenticated.
  if (url.pathname === "/api/branding" && request.method === "GET") {
    return handlePublicBrandingRoute(repo);
  }

  if (url.pathname === "/api/branding/logo" && request.method === "GET") {
    return handleBrandingLogoStream(env, repo, ADMIN_EMAIL_LOGO_SLOT);
  }

  if (url.pathname === "/api/branding/donor-logo" && request.method === "GET") {
    return handleBrandingLogoStream(env, repo, DONOR_LOGO_SLOT);
  }

  // Public donor checkout: unauthenticated, runs before any role check. A body with
  // only { amount, giftType } is a DRAFT create (the wizard mints the Wompi link in the
  // background on Paso 1→2); a body carrying donor data is a full create (the fallback
  // when no usable premint draft exists). Both mint the link identically.
  if (url.pathname === "/api/donations/intent" && request.method === "POST") {
    const clientIp = clientIpFrom(request);
    const recentIntents = await repo.countRecentIntentsByIp(clientIp, intentThrottleSinceIso());
    if (recentIntents >= INTENT_THROTTLE_LIMIT) {
      // Short-circuit before any validation/persistence so a throttled attempt is cheap.
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBodyWithLimit(request, PUBLIC_DONATION_JSON_BODY_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return donationBodyTooLargeResponse();
      }
      throw error;
    }
    const draft = isDraftIntentBody(body);
    let input;
    try {
      input = draft ? validateDraftIntentInput(body) : validateIntentInput(body);
    } catch (error) {
      if (error instanceof IntentValidationError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }
    try {
      const created = draft
        ? await createDraftDonationIntent(env, repo, input as ReturnType<typeof validateDraftIntentInput>, clientIp)
        : await createDonationIntent(env, repo, input as ReturnType<typeof validateIntentInput>, clientIp);
      return jsonResponse(created, { status: 201 });
    } catch (error) {
      if (error instanceof IntentLinkError) {
        // Intent stays PENDING and expires harmlessly on the cron sweep.
        return jsonResponse({ error: "wompi_link_failed", message: "No se pudo generar el enlace de pago. Intente de nuevo en unos minutos." }, { status: 502 });
      }
      throw error;
    }
  }

  // Public datos completion: attaches the donor's fiscal data to a minted draft with a
  // fast D1-only call (no Wompi). Same per-IP throttle as create (cheap but public).
  const intentDatosMatch = url.pathname.match(/^\/api\/donations\/intent\/([^/]+)\/datos$/);
  if (intentDatosMatch && request.method === "POST") {
    const clientIp = clientIpFrom(request);
    const recentIntents = await repo.countRecentIntentsByIp(clientIp, intentThrottleSinceIso());
    if (recentIntents >= INTENT_THROTTLE_LIMIT) {
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    let data;
    try {
      const body = await readJsonBodyWithLimit(request, PUBLIC_DONATION_JSON_BODY_LIMIT_BYTES);
      data = validateDatosInput(body);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return donationBodyTooLargeResponse();
      }
      if (error instanceof IntentValidationError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }
    try {
      await applyIntentDatos(repo, intentDatosMatch[1], data);
      return jsonResponse({ ok: true });
    } catch (error) {
      if (error instanceof IntentDatosError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: error.httpStatus });
      }
      throw error;
    }
  }

  const intentStatusMatch = url.pathname.match(/^\/api\/donations\/intent\/([^/]+)\/status$/);
  if (intentStatusMatch && request.method === "GET") {
    const intent = await repo.getDonationIntent(intentStatusMatch[1]);
    if (!intent) {
      // Enumeration-safe: unknown ids get the same shape a foreign id would.
      return jsonResponse({ error: "intent_not_found" }, { status: 404 });
    }
    // status stays for backward compatibility (COMPLETED = CDE accepted by MH). paid
    // reflects the payment marker (paid_at), so the donor's wizard can show "thanks" the
    // moment Wompi confirms the payment, without waiting on MH acceptance.
    return jsonResponse({ status: intent.status, paid: intent.paid_at != null });
  }

  if (url.pathname === "/api/auth/bootstrap-owner" && request.method === "POST") {
    if (!hasValidBootstrapOwnerToken(request, env)) {
      return jsonResponse({ error: "bootstrap_token_required" }, { status: 403 });
    }
    const body = (await request.json()) as { email: string; name: string; password: string };
    const owner = await auth.bootstrapOwner(body);
    await repo.createAudit({ action: "OWNER_BOOTSTRAPPED", entityType: "user", entityId: owner.id, summary: owner.email });
    return jsonResponse({ user: owner }, { status: 201 });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = (await request.json()) as { email: string; password: string };
    const normalizedEmail = String(body.email ?? "").trim().toLowerCase();
    const { ip: callerIp } = auditContextFrom(request);
    const recentFailures = await repo.countAuditEntriesSinceForIp("LOGIN_FAILED", normalizedEmail, callerIp, authThrottleSinceIso());
    if (recentFailures >= LOGIN_FAILED_LIMIT) {
      // Short-circuit before authenticating so a throttled attempt costs the same as
      // any other rejection — no PBKDF2 work, no DB read, no timing signal. Keyed on
      // (email, caller IP) so only the abusing IP is throttled, not the victim.
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    let result;
    try {
      result = await auth.login(body.email, body.password);
    } catch (error) {
      await repo.createAudit({ action: "LOGIN_FAILED", entityType: "user", entityId: normalizedEmail, summary: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await repo.createAudit({ actorType: "USER", actorId: result.user.id, action: "LOGIN", entityType: "user", entityId: result.user.id, summary: result.user.email });
    return jsonResponse(result);
  }

  if (url.pathname === "/api/auth/password-reset/request" && request.method === "POST") {
    const body = (await request.json()) as { email?: string };
    const email = String(body.email ?? "").trim();
    if (email) {
      // Resolve the account first so the throttle can key on its id (matching
      // PASSWORD_RESET_REQUESTED) and, crucially, run BEFORE any token is created.
      // Unknown emails yield no account and fall through to the enumeration-safe
      // 200 below without ever touching the rate limiter.
      const account = await repo.getUserForLogin(email);
      if (account && !account.disabled_at) {
        const recentRequests = await repo.countAuditEntriesSince("PASSWORD_RESET_REQUESTED", account.id, authThrottleSinceIso());
        if (recentRequests >= PASSWORD_RESET_LIMIT) {
          await repo.createAudit({ action: "PASSWORD_RESET_THROTTLED", entityType: "user", entityId: account.id, summary: account.email });
        } else {
          const created = await auth.createPasswordResetToken(email);
          if (created) {
            const link = `${resolveAppOrigin(env, url)}/?reset=${created.token}`;
            try {
              const resetBranding = await loadEmailBranding(repo, env);
              await new EmailService(env, DEFAULT_EMAIL_TEMPLATES, resetBranding).sendPasswordReset(created.user.email, created.user.name, link, PASSWORD_RESET_TTL_MINUTES);
              await repo.createAudit({ action: "PASSWORD_RESET_REQUESTED", entityType: "user", entityId: created.user.id, summary: created.user.email });
            } catch (error) {
              await repo.createAudit({
                action: "PASSWORD_RESET_EMAIL_FAILED",
                entityType: "user",
                entityId: created.user.id,
                summary: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      }
    }
    // Always report success so the endpoint cannot be used to probe which emails exist.
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/auth/password-reset/confirm" && request.method === "POST") {
    const body = (await request.json()) as { token?: string; password?: string };
    try {
      const resetUser = await auth.confirmPasswordReset(String(body.token ?? ""), String(body.password ?? ""));
      await repo.createAudit({ actorType: "USER", actorId: resetUser.id, action: "PASSWORD_RESET_COMPLETED", entityType: "user", entityId: resetUser.id, summary: resetUser.email });
      return jsonResponse({ ok: true });
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return jsonResponse({ error: "invalid_reset_token", message: error.message }, { status: 400 });
      }
      return jsonResponse({ error: "weak_password", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  if (url.pathname === "/api/documents" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse(await repo.listDteDocuments({
      status: url.searchParams.get("status"),
      q: url.searchParams.get("q"),
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") ?? 50)
    }));
  }

  if (url.pathname === "/api/donations/intents" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ intents: await repo.listRecentDonationIntents(50) });
  }

  if (url.pathname === "/api/credentials") {
    return handleCredentialsRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/credentials/writer-token") {
    return handleCredentialWriterTokenRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/settings/emission-environment") {
    return handleEmissionEnvironmentRoute(request, env, repo, user);
  }

  if (url.pathname === "/api/settings/email-templates") {
    return handleEmailTemplatesRoute(request, repo, user);
  }

  if (url.pathname === "/api/settings/branding") {
    return handleBrandingRoute(request, repo, user);
  }

  if (url.pathname === "/api/settings/branding/logo") {
    return handleBrandingLogoRoute(request, env, repo, user, ADMIN_EMAIL_LOGO_SLOT);
  }

  if (url.pathname === "/api/settings/branding/donor-logo") {
    return handleBrandingLogoRoute(request, env, repo, user, DONOR_LOGO_SLOT);
  }

  if (url.pathname === "/api/settings/alert-email") {
    return handleAlertEmailRoute(request, repo, user);
  }

  if (url.pathname === "/api/admin/retention-export" && request.method === "POST") {
    const actor = requireRole(user, "OWNER");
    const monthParam = url.searchParams.get("month");
    if (monthParam && !/^\d{4}-\d{2}$/.test(monthParam)) {
      return jsonResponse({ error: "invalid_retention_month", message: "Use el formato YYYY-MM." }, { status: 400 });
    }
    const lastClosedMonth = previousElSalvadorMonth(new Date());
    if (monthParam && monthParam > lastClosedMonth) {
      return jsonResponse(
        { error: "invalid_retention_month", message: `Solo se pueden exportar meses ya cerrados (hasta ${lastClosedMonth}).` },
        { status: 400 }
      );
    }
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "RETENTION_EXPORT_REQUESTED",
      entityType: "retention_export",
      entityId: monthParam ?? "previous_month",
      summary: monthParam ? `Exportación de retención solicitada para ${monthParam}` : "Exportación de retención solicitada para el mes anterior"
    });
    const result = await runRetentionExport(env, new Date(), monthParam ? { month: monthParam } : {});
    return jsonResponse({ ok: result.status !== "failed", ...result }, { status: result.status === "failed" ? 500 : 200 });
  }

  if (url.pathname === "/api/admin/backups" && request.method === "GET") {
    requireRole(user, "ADMIN");
    return jsonResponse(await listBackupMonths(env, repo, new Date()));
  }

  const backupVerifyMatch = url.pathname.match(/^\/api\/admin\/backups\/(\d{4}-\d{2})\/verify$/);
  if (backupVerifyMatch && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const result = await verifyBackupMonth(env, repo, backupVerifyMatch[1], actor);
    if (!result) {
      return notFound();
    }
    return jsonResponse(result);
  }

  const backupDownloadMatch = url.pathname.match(/^\/api\/admin\/backups\/(\d{4}-\d{2})\/download$/);
  if (backupDownloadMatch && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const month = backupDownloadMatch[1];
    const table = url.searchParams.get("table");
    if (!table || !/^[a-z_]+$|^manifest$/.test(table)) {
      return jsonResponse({ error: "invalid_backup_table", message: "Indique una tabla válida o 'manifest'." }, { status: 400 });
    }
    const key = table === "manifest" ? retentionManifestKey(month) : retentionTableKey(month, table);
    const object = await env.ARCHIVE.get(key);
    if (!object) {
      return notFound();
    }
    // These NDJSON snapshots carry donor PII; every access is audited with actor,
    // month, and table so the access trail is complete.
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "RETENTION_DOWNLOADED",
      entityType: "retention_export",
      entityId: month,
      summary: `Descarga de respaldo ${month}/${table}`,
      metadata: { month, table }
    });
    const filename = table === "manifest" ? `retention-${month}-manifest.json` : `retention-${month}-${table}.ndjson`;
    const contentType = table === "manifest" ? "application/json" : "application/x-ndjson";
    return new Response(object.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`
      }
    });
  }

  const backupDownloadAllMatch = url.pathname.match(/^\/api\/admin\/backups\/(\d{4}-\d{2})\/download-all$/);
  if (backupDownloadAllMatch && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const month = backupDownloadAllMatch[1];
    let entries: Array<{ name: string; data: Uint8Array }> | null;
    try {
      entries = await collectBackupMonthObjects(env, month);
    } catch (error) {
      if (error instanceof BackupArchiveTooLargeError) {
        return backupArchiveTooLargeResponse();
      }
      throw error;
    }
    if (!entries) {
      return notFound();
    }
    // Same PII-access audit as the per-table download; table "__all__" marks the whole
    // month was pulled in one archive.
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "RETENTION_DOWNLOADED",
      entityType: "retention_export",
      entityId: month,
      summary: `Descarga completa de respaldo ${month} (${entries.length} archivo(s))`,
      metadata: { month, table: "__all__", files: entries.length }
    });
    const zip = zipStored(entries);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="respaldo-${month}.zip"`
      }
    });
  }

  if (url.pathname === "/api/exports/f960" && request.method === "GET") {
    requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    return jsonResponse(selection);
  }

  if (url.pathname === "/api/exports/f960.csv" && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    await auditExport(repo, actor, "F960_EXPORTED", selection.csvFilename, selection.rowCount);
    return new Response(buildF960Csv(selection), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${selection.csvFilename}"`
      }
    });
  }

  if (url.pathname === "/api/exports/f960.xlsx" && request.method === "GET") {
    const actor = requireRole(user, "ADMIN");
    const selection = await f960Selection(repo, url);
    if (selection instanceof Response) return selection;
    await auditExport(repo, actor, "F960_INSPECTION_EXPORTED", selection.xlsxFilename, selection.rowCount);
    return new Response(buildF960Xlsx(selection), {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${selection.xlsxFilename}"`
      }
    });
  }

  if (url.pathname === "/api/exports/contacts" && request.method === "GET") {
    // Bulk donor PII for CRM import: ADMIN only (deliberately NOT operator/viewer).
    const actor = requireRole(user, "ADMIN");
    const environment = ambienteValue(url.searchParams.get("environment"));
    if (!environment) {
      return jsonResponse({ error: "invalid_export_environment", message: "Seleccione un ambiente válido (00 o 01)." }, { status: 400 });
    }

    // Optional [from, to] day range (YYYY-MM-DD, El Salvador local, inclusive). Both or
    // neither; malformed/inverted → 400. Reuses the analytics range→ISO-window helper so
    // the export honours the same El Salvador local-day semantics as the analytics view.
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    let window: { startIso: string; endIso: string } | undefined;
    if (fromParam || toParam) {
      const isDate = (value: string | null): value is string =>
        !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
      if (!isDate(fromParam) || !isDate(toParam) || fromParam > toParam) {
        return jsonResponse(
          { error: "invalid_export_range", message: "Use el formato YYYY-MM-DD y verifique que 'desde' no sea posterior a 'hasta'." },
          { status: 400 }
        );
      }
      window = elSalvadorRangeWindow({ from: fromParam, to: toParam });
    }

    // Optional giftType filter (DIEZMO|OFRENDA) — which donations count toward inclusion/totals.
    const giftTypeParam = url.searchParams.get("giftType");
    if (giftTypeParam && giftTypeParam !== "DIEZMO" && giftTypeParam !== "OFRENDA") {
      return jsonResponse({ error: "invalid_export_gift_type", message: "Seleccione Diezmo, Ofrenda o Todos." }, { status: 400 });
    }
    const giftType = giftTypeParam === "DIEZMO" || giftTypeParam === "OFRENDA" ? giftTypeParam : undefined;

    // Optional column whitelist; an unknown name is a 400 with the offending column named.
    let columns;
    try {
      columns = resolveContactColumns(url.searchParams.get("columns"));
    } catch (error) {
      return jsonResponse(
        { error: "invalid_export_columns", message: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }

    const contacts = await aggregateDonorContacts(repo, environment, { window, giftType });
    // Audit carries only the count + environment + applied filters — NEVER any donor PII.
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CONTACTS_EXPORTED",
      entityType: "export",
      entityId: `contacts:${environment}`,
      summary: `${contacts.length} contactos exportados (ambiente ${environment})`,
      metadata: {
        environment,
        contacts: contacts.length,
        ...(fromParam ? { from: fromParam, to: toParam } : {}),
        ...(giftType ? { giftType } : {}),
        // Only record a column count when a subset was actually requested, so the
        // default full-export audit keeps its original { environment, contacts } shape.
        ...(url.searchParams.get("columns") ? { columns: columns.length } : {})
      }
    });
    return new Response(buildContactsCsv(contacts, columns), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${contactsCsvFilename(environment, contacts.length)}"`
      }
    });
  }

  if (url.pathname === "/api/certificates/annual" && request.method === "GET") {
    requireRole(user, "ADMIN");
    const yearParam = url.searchParams.get("year");
    const yearError = certificateYearError(yearParam, new Date());
    if (yearError) {
      return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
    }
    return jsonResponse(await buildAnnualCertificatePreview(repo, Number(yearParam), url.searchParams.get("q")));
  }

  if (url.pathname === "/api/certificates/annual/send" && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const yearParam = url.searchParams.get("year");
    const yearError = certificateYearError(yearParam, new Date());
    if (yearError) {
      return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
    }
    const year = Number(yearParam);
    // Optional body: `{ donor: "<groupKey>" }` targets one donor (also the resend path);
    // an absent/empty body runs the full bulk batch as before.
    const body = (await request.json().catch(() => ({}))) as { donor?: unknown };
    const donorGroupKey = typeof body.donor === "string" && body.donor.trim() ? body.donor : undefined;
    let result;
    try {
      result = await sendAnnualCertificates(env, repo, year, actor.id, donorGroupKey);
    } catch (error) {
      if (error instanceof SingleDonorSendError) {
        return jsonResponse({ error: "single_donor_send_error", message: error.message }, { status: error.status });
      }
      throw error;
    }
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "DONOR_CERTIFICATES_RUN",
      entityType: "donor_certificate_run",
      entityId: String(year),
      summary: donorGroupKey
        ? `Constancia ${year} enviada individualmente: ${result.sent} enviada, ${result.failed} fallida`
        : `Constancias ${year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas`,
      metadata: { ...result, ...(donorGroupKey ? { mode: "single", donorGroupKey } : {}) }
    });
    return jsonResponse(result);
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/);
  if (documentMatch) {
    return handleDocumentRoute(request, env, repo, user, documentMatch[1], documentMatch[2]);
  }

  if (url.pathname === "/api/audit" && request.method === "GET") {
    const actor = requireRole(user, "VIEWER");
    const entityType = url.searchParams.get("entityType");
    const entityId = url.searchParams.get("entityId");
    if (entityType && entityId) {
      // Entity-scoped history keeps its original (uncapped-page) shape.
      return jsonResponse({ audit: await listAuditForUser(repo, actor, entityType, entityId), nextCursor: null });
    }
    // General history pages by keyset cursor ("<created_at>|<id>"): the audit trail
    // grows forever, so the old flat LIMIT 100 silently hid everything older.
    const limitParam = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 100) : 50;
    const rawCursor = url.searchParams.get("cursor");
    let cursor: { createdAt: string; id: string } | null = null;
    if (rawCursor) {
      const split = rawCursor.lastIndexOf("|");
      if (split > 0) {
        cursor = { createdAt: rawCursor.slice(0, split), id: rawCursor.slice(split + 1) };
      }
    }
    const rows = await repo.listAuditPage(cursor, limit);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1] as { created_at?: string; id?: string } | undefined;
    const nextCursor = rows.length > limit && last?.created_at && last?.id ? `${last.created_at}|${last.id}` : null;
    return jsonResponse({ audit: redactAuditForUser(page, actor), nextCursor });
  }

  if (url.pathname === "/api/analytics" && request.method === "GET") {
    return handleAnalyticsRoute(repo, env, user, url);
  }

  // Solo lectura (historial). La emisión en contingencia del CDE se eliminó: el
  // Anexo de validaciones del evento de contingencia (campo 35) no admite el tipo 15,
  // así que las rutas de apertura/barrido ya no existen. Ante una caída de MH la
  // emisión queda diferida (SIGNED + transmission_deferred_at) y el cron de 15
  // minutos la reintenta.
  if (url.pathname === "/api/contingency" && request.method === "GET") {
    const actor = requireRole(user, "VIEWER");
    return jsonResponse({ contingency: await contingencyState(repo, actor) });
  }

  if (url.pathname === "/api/test/dte" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await request.json().catch(() => ({}))) as DirectCdeInput;
    const donorFields = directDonorFields(input);
    if (donorFields instanceof Response) return donorFields;
    const config = getEmisorConfig(env);
    const environment = await activeEmissionEnvironment(repo, env);
    let document: Record<string, unknown>;
    try {
      const sequence = await repo.nextControlSequence(environment, config.controlPrefix);
      document = buildDirectCdeDocument({ ...input, ...donorFields }, config, { sequence, environment });
    } catch (error) {
      return jsonResponse({ error: "invalid_test_payload", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const summary = cdeDocumentSummary(document);
    const dte = await repo.createDteDocument({
      wompiEventId: null,
      environment: summary.environment,
      codigoGeneracion: summary.codigoGeneracion,
      numeroControl: summary.numeroControl,
      plainJson: document,
      donorEmail: summary.donorEmail,
      donorName: summary.donorName,
      amountCents: summary.amountCents,
      issuedAt: nowIso()
    });
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "QUICK_CDE_CREATED",
      entityType: "dte_document",
      entityId: dte.id,
      summary: dte.numero_control,
      metadata: { source: "quick_direct_generation" }
    });
    await env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
    return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
  }

  if (url.pathname === "/api/test/dte/advanced-template" && request.method === "POST") {
    requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await request.json().catch(() => ({}))) as DirectCdeInput;
    const donorFields = templateDonorFields(input);
    if (donorFields instanceof Response) return donorFields;
    try {
      const environment = await activeEmissionEnvironment(repo, env);
      const draft = buildDirectCdeDocument(
        { ...input, ...donorFields, amount: advancedTemplateAmount(input.amount) },
        getEmisorConfig(env),
        { sequence: 1, environment, templatePreview: true }
      );
      return jsonResponse({ draft, sections: ["identificacion", "emisor", "receptor", "otrosDocumentos", "cuerpoDocumento", "resumen", "apendice"] });
    } catch (error) {
      return jsonResponse({ error: "invalid_advanced_template", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  if (url.pathname === "/api/test/dte/advanced" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (isProduction(env)) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { draft?: unknown };
    const config = getEmisorConfig(env);
    const environment = await activeEmissionEnvironment(repo, env);
    let document: Record<string, unknown>;
    try {
      buildAdvancedCdeDocument(body.draft, config, { sequence: 1, environment });
      const sequence = await repo.nextControlSequence(environment, config.controlPrefix);
      document = buildAdvancedCdeDocument(body.draft, config, { sequence, environment });
    } catch (error) {
      return jsonResponse({ error: "invalid_advanced_cde", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const summary = cdeDocumentSummary(document);
    const dte = await repo.createDteDocument({
      wompiEventId: null,
      environment: summary.environment,
      codigoGeneracion: summary.codigoGeneracion,
      numeroControl: summary.numeroControl,
      plainJson: document,
      donorEmail: summary.donorEmail,
      donorName: summary.donorName,
      amountCents: summary.amountCents,
      issuedAt: nowIso()
    });
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "ADVANCED_CDE_CREATED",
      entityType: "dte_document",
      entityId: dte.id,
      summary: dte.numero_control,
      metadata: { source: "admin_advanced_direct_generation" }
    });
    await env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
    return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
  }

  if (url.pathname === "/api/users" && request.method === "GET") {
    requireRole(user, "ADMIN");
    return jsonResponse({ users: await repo.listUsers() });
  }

  if (url.pathname === "/api/users" && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json()) as { email: string; name: string; role: Role; password: string };
    // Only an OWNER may mint another OWNER; otherwise an ADMIN could self-escalate by
    // creating an OWNER account and then using the OWNER-only credential routes.
    if (body.role === "OWNER" && actor.role !== "OWNER") {
      return jsonResponse({ error: "owner_role_required", message: "Solo un propietario puede asignar el rol de propietario" }, { status: 403 });
    }
    const created = await auth.createUser(body);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_CREATED", entityType: "user", entityId: created.id, summary: created.email });
    return jsonResponse({ user: created }, { status: 201 });
  }

  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    // Vector inverso de escalación: restablecer la contraseña de un OWNER le daría a
    // un ADMIN esa sesión. Solo un propietario modifica a otro propietario.
    if (actor.role !== "OWNER" && (await repo.getUserRole(passwordMatch[1])) === "OWNER") {
      return jsonResponse({ error: "owner_target_protected", message: "Solo un propietario puede modificar a otro propietario" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== "string" || !body.password) {
      return jsonResponse({ error: "missing_user_password", message: "Ingrese nueva contraseña" }, { status: 400 });
    }
    try {
      await auth.resetUserPassword(passwordMatch[1], body.password);
    } catch (error) {
      return jsonResponse({ error: "invalid_user_password", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_PASSWORD_RESET", entityType: "user", entityId: passwordMatch[1], summary: "Contraseña restablecida por administrador" });
    return jsonResponse({ ok: true });
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === "PATCH") {
    const actor = requireRole(user, "ADMIN");
    const body = (await request.json().catch(() => ({}))) as { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown };
    const patch = userPatchInput(body);
    if (patch instanceof Response) return patch;
    // Same escalation guard as user creation: promoting an account to OWNER is
    // reserved for OWNERs.
    if (patch.role === "OWNER" && actor.role !== "OWNER") {
      return jsonResponse({ error: "owner_role_required", message: "Solo un propietario puede asignar el rol de propietario" }, { status: 403 });
    }
    // Y el vector inverso: un ADMIN tampoco modifica (desactiva, renombra, degrada) a
    // un OWNER existente.
    if (actor.role !== "OWNER" && (await repo.getUserRole(userMatch[1])) === "OWNER") {
      return jsonResponse({ error: "owner_target_protected", message: "Solo un propietario puede modificar a otro propietario" }, { status: 403 });
    }
    const updated = await repo.updateUser(userMatch[1], patch);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userMatch[1], summary: "Usuario actualizado", metadata: patch });
    return jsonResponse({ user: updated });
  }

  return notFound();
}

function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "local").toLowerCase() === "production";
}

// GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&environment=00 — Analítica del
// carril Wompi (solo lectura, rol VIEWER como /api/audit). Devuelve un único objeto
// con todas las secciones. Defaults: los últimos 90 días (El Salvador local) y el
// ambiente de emisión ACTIVO cuando no se especifica environment.
async function handleAnalyticsRoute(repo: Repository, env: Env, user: AuthUser | null, url: URL): Promise<Response> {
  requireRole(user, "VIEWER");
  const now = new Date();
  const environment = ambienteValue(url.searchParams.get("environment")) ?? (await activeEmissionEnvironment(repo, env));
  const range = analyticsRange(url.searchParams.get("from"), url.searchParams.get("to"), now);
  if (!range) {
    return jsonResponse({ error: "invalid_analytics_range", message: "Use el formato YYYY-MM-DD y verifique que 'desde' no sea posterior a 'hasta'." }, { status: 400 });
  }
  const analytics = await computeAnalytics(repo, range, environment, now, {
    department: (code) => findCatalogOption(CAT012_DEPARTMENTS, code)?.label ?? code,
    country: (code) => findCatalogOption(CAT020_COUNTRIES, code)?.label ?? code
  });
  return jsonResponse({ analytics });
}

// Validates and defaults the analytics date range. `from`/`to` are YYYY-MM-DD in El
// Salvador local time. Absent params default to the last 90 days ending today. Returns
// null on a malformed date, an inverted range, or a range wider than one year.
const MAX_ANALYTICS_RANGE_DAYS = 366;

function analyticsRange(fromParam: string | null, toParam: string | null, now: Date): AnalyticsRange | null {
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  const todayLocal = elSalvadorDateOnly(now);
  const to = toParam ?? todayLocal;
  const from = fromParam ?? elSalvadorDateOnly(new Date(now.getTime() - 89 * 86_400_000));
  if (!isDate(from) || !isDate(to) || from > to) {
    return null;
  }
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  const spanDays = Math.floor((toTime - fromTime) / 86_400_000) + 1;
  if (spanDays > MAX_ANALYTICS_RANGE_DAYS) {
    return null;
  }
  return { from, to };
}

// YYYY-MM-DD of an instant in El Salvador local time (fixed UTC-6).
function elSalvadorDateOnly(date: Date): string {
  const local = new Date(date.getTime() - 6 * 3_600_000);
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  return `${local.getUTCFullYear()}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}

async function handleEmissionEnvironmentRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  if (request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ emissionEnvironment: await emissionEnvironmentState(repo, env) });
  }
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  const body = (await request.json().catch(() => ({}))) as { environment?: unknown };
  const environment = ambienteValue(body.environment);
  if (!environment) {
    return jsonResponse({ error: "invalid_emission_environment", message: "Seleccione Pruebas 00 o Producción 01." }, { status: 400 });
  }
  await repo.setSetting(EMISSION_ENVIRONMENT_SETTING, environment, actor.id);
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "EMISSION_ENVIRONMENT_UPDATED",
    entityType: "app_setting",
    entityId: EMISSION_ENVIRONMENT_SETTING,
    summary: environment === "01" ? "Ambiente de emisión cambiado a Producción 01" : "Ambiente de emisión cambiado a Pruebas 00",
    metadata: { environment }
  });
  return jsonResponse({ ok: true, emissionEnvironment: await emissionEnvironmentState(repo, env) });
}

async function handleEmailTemplatesRoute(request: Request, repo: Repository, user: AuthUser | null): Promise<Response> {
  if (request.method === "GET") {
    requireRole(user, "OWNER");
    const settings = parseEmailTemplates(await repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
    return jsonResponse({ emailTemplates: emailTemplateResponse(settings) });
  }
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  const body = (await request.json().catch(() => ({}))) as { templates?: unknown };
  try {
    const templates = normalizeEmailTemplateSettings(body.templates);
    await repo.setSetting(EMAIL_TEMPLATES_SETTING_KEY, JSON.stringify(templates), actor.id);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "EMAIL_TEMPLATES_UPDATED",
      entityType: "app_setting",
      entityId: EMAIL_TEMPLATES_SETTING_KEY,
      summary: "Plantillas de correo actualizadas",
      metadata: { types: Object.keys(templates) }
    });
    return jsonResponse({ ok: true, emailTemplates: emailTemplateResponse(templates) });
  } catch (error) {
    if (error instanceof EmailTemplateValidationError) {
      return jsonResponse({ error: "invalid_email_templates", message: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function handleAlertEmailRoute(request: Request, repo: Repository, user: AuthUser | null): Promise<Response> {
  if (request.method === "GET") {
    requireRole(user, "OWNER");
    return jsonResponse({ alertEmail: (await repo.getSetting(ALERT_EMAIL_SETTING_KEY)) ?? "" });
  }
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  const body = (await request.json().catch(() => ({}))) as { alertEmail?: unknown };
  const alertEmail = normalizeAlertRecipients(typeof body.alertEmail === "string" ? body.alertEmail : "");
  if (alertEmail === null) {
    return jsonResponse({ error: "invalid_alert_email", message: "Ingrese correos válidos separados por coma." }, { status: 400 });
  }
  await repo.setSetting(ALERT_EMAIL_SETTING_KEY, alertEmail, actor.id);
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "ALERT_EMAIL_UPDATED",
    entityType: "app_setting",
    entityId: ALERT_EMAIL_SETTING_KEY,
    // The audit trail is readable by lower roles, so record only THAT the recipient
    // changed — never the OWNER-only address itself.
    summary: alertEmail ? "Correo de alertas configurado" : "Correo de alertas desactivado",
    metadata: { enabled: Boolean(alertEmail) }
  });
  return jsonResponse({ ok: true, alertEmail });
}

// Public branding read (unauthenticated): the login screen consumes this before any
// session. logoVersion is the cache-busting token clients append to the logo stream
// URL; null when no logo is stored so the client falls back to the built-in mark.
async function handlePublicBrandingRoute(repo: Repository): Promise<Response> {
  const branding = parseBrandingSettings(
    await repo.getSetting(BRANDING_DISPLAY_NAME_SETTING_KEY),
    await repo.getSetting(BRANDING_ACCENT_COLOR_SETTING_KEY),
    await repo.getSetting(BRANDING_SUPPORT_EMAIL_SETTING_KEY)
  );
  const logo = parseBrandingLogoMeta(await repo.getSetting(BRANDING_LOGO_SETTING_KEY));
  const donorLogo = parseBrandingLogoMeta(await repo.getSetting(BRANDING_DONOR_LOGO_SETTING_KEY));
  return jsonResponse({
    displayName: branding.displayName,
    accentColor: branding.accentColor,
    supportEmail: branding.supportEmail,
    logoVersion: logo?.version ?? null,
    donorLogoVersion: donorLogo?.version ?? null
  });
}

// Public branding logo stream (unauthenticated). A church-uploaded SVG can embed
// scripts, so the response is locked down: a strict CSP that blocks scripts and any
// subresource fetch, plus nosniff. The short cache keeps the login/header logo snappy
// while still turning over when the version query changes.
async function handleBrandingLogoStream(env: Env, repo: Repository, slot: BrandingLogoSlot): Promise<Response> {
  const meta = parseBrandingLogoMeta(await repo.getSetting(slot.settingKey));
  if (!meta) {
    return notFound();
  }
  const object = await env.ARCHIVE.get(slot.objectKey);
  if (!object) {
    return notFound();
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? meta.contentType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "script-src 'none'; default-src 'none'; style-src 'unsafe-inline'"
    }
  });
}

// Write branding name + color (OWNER). Both fields are required; validation errors
// carry Spanish messages. The audit never logs anything sensitive (name/color only).
async function handleBrandingRoute(request: Request, repo: Repository, user: AuthUser | null): Promise<Response> {
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  const body = (await request.json().catch(() => ({}))) as { displayName?: unknown; accentColor?: unknown; supportEmail?: unknown };
  let displayName: string;
  let accentColor: string;
  let supportEmail: string;
  try {
    displayName = normalizeBrandingDisplayName(body.displayName);
    accentColor = normalizeBrandingAccentColor(body.accentColor);
    supportEmail = normalizeBrandingSupportEmail(body.supportEmail);
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return jsonResponse({ error: "invalid_branding", message: error.message }, { status: 400 });
    }
    throw error;
  }
  await repo.setSetting(BRANDING_DISPLAY_NAME_SETTING_KEY, displayName, actor.id);
  await repo.setSetting(BRANDING_ACCENT_COLOR_SETTING_KEY, accentColor, actor.id);
  await repo.setSetting(BRANDING_SUPPORT_EMAIL_SETTING_KEY, supportEmail, actor.id);
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "BRANDING_UPDATED",
    entityType: "app_setting",
    entityId: BRANDING_DISPLAY_NAME_SETTING_KEY,
    summary: `Marca actualizada: ${displayName}`,
    // Support email is not a secret (it is published on donor pages and email footers).
    metadata: { displayName, accentColor, supportEmail }
  });
  return jsonResponse({ ok: true, displayName, accentColor, supportEmail });
}

// Upload (PUT) or remove (DELETE) the branding logo (OWNER). The binary goes to R2
// under BRANDING_LOGO_OBJECT_KEY; its metadata mirrors into app_settings so the public
// reads stay a single D1 lookup. The audit records the content type and size, never
// the bytes.
async function handleBrandingLogoRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null, slot: BrandingLogoSlot): Promise<Response> {
  if (request.method === "DELETE") {
    const actor = requireRole(user, "OWNER");
    await env.ARCHIVE.delete(slot.objectKey);
    await repo.setSetting(slot.settingKey, "", actor.id);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: slot.removedAction,
      entityType: "app_setting",
      entityId: slot.settingKey,
      summary: slot.removedSummary,
      metadata: {}
    });
    return jsonResponse({ ok: true, [slot.versionField]: null });
  }
  if (request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = requireRole(user, "OWNER");
  let contentType: string;
  try {
    contentType = normalizeBrandingLogoContentType(request.headers.get("Content-Type"));
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return jsonResponse({ error: "invalid_branding_logo", message: error.message }, { status: 400 });
    }
    throw error;
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    return jsonResponse({ error: "invalid_branding_logo", message: "El archivo del logo está vacío." }, { status: 400 });
  }
  if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
    return jsonResponse({ error: "invalid_branding_logo", message: "El logo no puede superar los 512 KB." }, { status: 400 });
  }
  // crypto.randomUUID gives a cache-busting version without a wall-clock read.
  const version = crypto.randomUUID();
  await env.ARCHIVE.put(slot.objectKey, bytes, { httpMetadata: { contentType } });
  await repo.setSetting(
    slot.settingKey,
    JSON.stringify({ contentType, size: bytes.byteLength, version }),
    actor.id
  );
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: slot.updatedAction,
    entityType: "app_setting",
    entityId: slot.settingKey,
    summary: slot.updatedSummary,
    metadata: { contentType, size: bytes.byteLength }
  });
  return jsonResponse({ ok: true, [slot.versionField]: version });
}

async function activeEmissionEnvironment(repo: Repository, env: Env): Promise<"00" | "01"> {
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  return configured ?? defaultEmissionEnvironment(env);
}

async function emissionEnvironmentState(repo: Repository, env: Env): Promise<{ environment: "00" | "01"; source: "setting" | "deployment_default"; appEnv: string }> {
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  return {
    environment: configured ?? defaultEmissionEnvironment(env),
    source: configured ? "setting" : "deployment_default",
    appEnv: env.APP_ENV ?? "local"
  };
}

function defaultEmissionEnvironment(env: Env): "00" | "01" {
  return isProduction(env) ? "01" : "00";
}

function ambienteValue(value: unknown): "00" | "01" | null {
  if (value === "00" || value === "test" || value === "staging") return "00";
  if (value === "01" || value === "production" || value === "prod") return "01";
  return null;
}

function userPatchInput(body: { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown }): Response | { role?: Role; disabled?: boolean; name?: string; email?: string } {
  const patch: { role?: Role; disabled?: boolean; name?: string; email?: string } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return jsonResponse({ error: "invalid_user_name", message: "Ingrese nombre del usuario" }, { status: 400 });
    }
    patch.name = body.name.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== "string" || !body.email.trim() || !body.email.includes("@")) {
      return jsonResponse({ error: "invalid_user_email", message: "Ingrese correo válido" }, { status: 400 });
    }
    patch.email = body.email.trim().toLowerCase();
  }
  if (body.role !== undefined) {
    if (!isRole(body.role)) {
      return jsonResponse({ error: "invalid_user_role", message: "Seleccione un rol válido" }, { status: 400 });
    }
    patch.role = body.role;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") {
      return jsonResponse({ error: "invalid_user_disabled", message: "Estado de usuario inválido" }, { status: 400 });
    }
    patch.disabled = body.disabled;
  }
  return patch;
}

function isRole(value: unknown): value is Role {
  return value === "VIEWER" || value === "OPERATOR" || value === "ADMIN" || value === "OWNER";
}

async function contingencyState(repo: Repository, user: AuthUser): Promise<Record<string, unknown>> {
  const activeRaw = await repo.getOpenContingency();
  const periodsRaw = await repo.listContingencyPeriods();
  const pendingDocuments = activeRaw
    ? await repo.listContingencyDocuments(String(activeRaw.id))
    : (await repo.listDteDocuments({ status: "CONTINGENCY_PENDING", limit: 100 })).documents;
  const batches = activeRaw ? await repo.listContingencyBatches(String(activeRaw.id)) : await repo.listContingencyBatches();
  const batchLines = activeRaw ? await repo.listContingencyBatchLines({ periodId: String(activeRaw.id) }) : await repo.listContingencyBatchLines();
  const events = await repo.listDteEventsByType("CONTINGENCIA");
  const periods = periodsRaw.map(contingencyPeriodView);
  const active = activeRaw ? contingencyPeriodView(activeRaw) : null;
  const countPeriodStatus = (status: string) => periods.filter((period) => period.status === status).length;
  return {
    active,
    pendingDocuments,
    batches,
    batchLines,
    periods,
    events,
    audit: active ? await listAuditForUser(repo, user, "contingency_period", String(active.id)) : [],
    summary: {
      pending: pendingDocuments.length,
      open: countPeriodStatus("OPEN"),
      eventAccepted: countPeriodStatus("EVENT_ACCEPTED"),
      closed: countPeriodStatus("CLOSED"),
      failed: countPeriodStatus("FAILED"),
      eventsAccepted: events.filter((event) => event.status === "ACCEPTED").length,
      eventsRejected: events.filter((event) => event.status === "REJECTED").length,
      batches: batches.length,
      batchAccepted: batchLines.filter((line) => line.status === "ACCEPTED").length,
      batchRejected: batchLines.filter((line) => line.status === "REJECTED" || line.status === "MANUAL_REVIEW").length,
      batchPending: batchLines.filter((line) => !["ACCEPTED", "REJECTED", "MANUAL_REVIEW"].includes(String(line.status))).length
    }
  };
}

function contingencyPeriodView(period: Record<string, unknown>): Record<string, unknown> {
  const endedAt = typeof period.ended_at === "string" ? period.ended_at : null;
  return {
    ...period,
    tipo_contingencia: Number(period.tipo_contingencia ?? 1),
    event_deadline_at: endedAt ? addHours(endedAt, 24) : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mhRejectionMessage(result: MhResponse): string {
  const raw = isRecord(result.raw) ? result.raw : {};
  const code = typeof raw.codigoMsg === "string" ? raw.codigoMsg : "";
  const description = typeof raw.descripcionMsg === "string" ? raw.descripcionMsg : "";
  const rawMessage = [code, description].filter(Boolean).join(": ");
  if (rawMessage) {
    return rawMessage;
  }
  if (result.observaciones.length > 0) {
    return result.observaciones.join("; ");
  }
  return result.estado || "Invalidación rechazada por el Ministerio de Hacienda";
}

function isRetryableDocument(document: Pick<DteDocumentRecord, "status" | "transmission_deferred_at">): boolean {
  // Un CDE diferido (SIGNED + transmission_deferred_at) NO es reintetable manualmente:
  // el cron de 15 minutos es el único dueño del reintento, porque el camino manual
  // genérico no completa la intención ni envía el comprobante definitivo. Un SIGNED
  // "plano" (transitorio de pipeline atascado, sin marcador) sigue siendo reintetable
  // como siempre.
  if (document.status === "SIGNED" && document.transmission_deferred_at) {
    return false;
  }
  return ["SIGNED", "REJECTED", "FAILED", "CONTINGENCY_PENDING"].includes(document.status);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function donorEmailField(input: DirectCdeInput): { donorEmail?: string } | Response {
  const donorEmail = typeof input.donorEmail === "string" ? input.donorEmail.trim() : "";
  if (donorEmail && !normalizeEmail(donorEmail)) {
    return jsonResponse({ error: "invalid_donor_email", message: "Ingrese un correo válido" }, { status: 400 });
  }
  return donorEmail ? { donorEmail } : {};
}

function directDonorFields(input: DirectCdeInput): { donorName: string; donorDocument: string; donorEmail?: string } | Response {
  const donorName = input.donorName?.trim();
  if (!donorName) {
    return jsonResponse({ error: "missing_donor_name" }, { status: 400 });
  }
  const donorDocument = input.donorDocument?.trim();
  if (!donorDocument) {
    return jsonResponse({ error: "missing_donor_document" }, { status: 400 });
  }
  const email = donorEmailField(input);
  if (email instanceof Response) {
    return email;
  }
  return { donorName, donorDocument, ...email };
}

// Unlike directDonorFields (shared with quick DTE creation), the advanced-template preview
// only builds a draft for the wizard to edit further, so an empty donor name/document is
// allowed here. Final generation (POST /api/test/dte/advanced) still validates the full MH schema.
function templateDonorFields(input: DirectCdeInput): { donorName: string; donorDocument: string; donorEmail?: string } | Response {
  const email = donorEmailField(input);
  if (email instanceof Response) {
    return email;
  }
  return { donorName: input.donorName?.trim() ?? "", donorDocument: input.donorDocument?.trim() ?? "", ...email };
}

function advancedTemplateAmount(value: unknown): string | number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : "1.00";
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? value : "1.00";
  }
  return "1.00";
}

async function handleCredentialsRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  const actor = requireRole(user, "OWNER");
  if (request.method === "GET") {
    return jsonResponse({ credentials: credentialStatus(env) });
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const input = (await request.json()) as CredentialUpdateInput;
  if (input.environment !== "test" && input.environment !== "production") {
    return jsonResponse({ error: "invalid_credential_environment" }, { status: 400 });
  }
  const patch = buildCredentialSecretPatch(input);
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ error: "no_credentials_supplied" }, { status: 400 });
  }
  try {
    const result = await patchCloudflareWorkerSecrets(env, patch);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CREDENTIALS_UPDATED",
      entityType: "credentials",
      entityId: input.environment,
      summary: input.environment === "production" ? "Secretos de producción actualizados" : "Secretos de pruebas actualizados",
      metadata: { updated: result.updated, deleted: result.deleted }
    });
    return jsonResponse({ ok: true, updated: result.updated, deleted: result.deleted });
  } catch (error) {
    if (error instanceof CredentialWriterConfigError) {
      return jsonResponse({ error: "credential_writer_not_configured", message: error.message }, { status: 503 });
    }
    return jsonResponse({ error: "credential_update_failed", message: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

async function handleCredentialWriterTokenRoute(request: Request, env: Env, repo: Repository, user: AuthUser | null): Promise<Response> {
  const actor = requireRole(user, "OWNER");
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return jsonResponse({ error: "cloudflare_token_required", message: "Ingrese el token API de Cloudflare." }, { status: 400 });
  }
  try {
    const result = await bootstrapCloudflareWriterToken(env, token);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CLOUDFLARE_WRITER_ENABLED",
      entityType: "credentials",
      entityId: env.CLOUDFLARE_SCRIPT_NAME ?? "worker",
      summary: "Edición de secretos desde UI habilitada",
      metadata: { updated: result.updated }
    });
    return jsonResponse({ ok: true, updated: result.updated, credentials: credentialStatus({ ...env, CLOUDFLARE_API_TOKEN: token }) });
  } catch (error) {
    if (error instanceof CredentialWriterConfigError) {
      return jsonResponse({ error: "credential_writer_not_configured", message: error.message }, { status: 503 });
    }
    return jsonResponse({ error: "cloudflare_token_rejected", message: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

async function handleDocumentRoute(
  request: Request,
  env: Env,
  repo: Repository,
  user: AuthUser | null,
  documentId: string,
  action?: string
): Promise<Response> {
  const document = await repo.getDteDocument(documentId);
  if (!document) {
    return notFound();
  }

  if (!action && request.method === "GET") {
    const actor = requireRole(user, "VIEWER");
    // donorDataVerified: this CDE was produced from a completed donation-intent, so
    // the donor's data came from the validated /donar form rather than the raw webhook.
    const donorDataVerified = (await repo.getCompletedIntentForDocument(document.id)) !== null;
    return jsonResponse({ document, donorDataVerified, audit: await listAuditForUser(repo, actor, "dte_document", document.id) });
  }

  if (action === "pdf" && request.method === "GET") {
    requireRole(user, "VIEWER");
    const pdf = await renderDtePdf(document);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.pdf"`
      }
    });
  }

  if (action === "json" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return new Response(document.plain_json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.json"`
      }
    });
  }

  if (action === "email" && request.method === "PATCH") {
    const actor = requireRole(user, "OPERATOR");
    const body = (await request.json()) as { email?: string };
    const email = normalizeEmail(body.email);
    if (!email) {
      return jsonResponse({ error: "invalid_email", message: "Ingrese un correo válido." }, { status: 400 });
    }
    await repo.updateDocumentDonorEmail(document.id, email);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "DTE_EMAIL_UPDATED",
      entityType: "dte_document",
      entityId: document.id,
      summary: `Correo de envío actualizado a ${email}`,
      metadata: { previousEmail: document.donor_email, email }
    });
    return jsonResponse({ document: await repo.getDteDocument(document.id) });
  }

  if (action === "resend" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const toEmail = body.email ?? document.donor_email;
    if (!toEmail) {
      return jsonResponse({ error: "missing_email" }, { status: 400 });
    }
    try {
      const templates = parseEmailTemplates(await repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
      const branding = await loadEmailBranding(repo, env);
      const response = await new EmailService(env, templates, branding).sendReceipt(document, toEmail);
      await repo.recordEmailDelivery({
        documentId: document.id,
        toEmail,
        status: "SENT",
        providerResponse: response.providerResponse,
        emailType: response.emailType,
        documentStatusAtSend: response.documentStatusAtSend,
        templateVersion: response.templateVersion,
        pdfRendererVersion: response.pdfRendererVersion,
        pdfSha256: response.pdfSha256,
        dteJsonSha256: response.dteJsonSha256,
        providerDeliveryId: response.providerDeliveryId
      });
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "EMAIL_RESENT", entityType: "dte_document", entityId: document.id, summary: `Reenviado a ${toEmail}`, metadata: response });
      return jsonResponse({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repo.recordEmailDelivery({ documentId: document.id, toEmail, status: "FAILED", providerResponse: { error: message } });
      await repo.createAudit({
        actorType: "USER",
        actorId: actor.id,
        action: "EMAIL_RESEND_FAILED",
        entityType: "dte_document",
        entityId: document.id,
        summary: message,
        metadata: { toEmail }
      });
      return jsonResponse({ error: "email_send_failed", message }, { status: 502 });
    }
  }

  if (action === "retry" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (!isRetryableDocument(document)) {
      return jsonResponse(
        {
          error: "document_not_retryable",
          message: "Este DTE no tiene fallos pendientes para reintentar."
        },
        { status: 409 }
      );
    }
    if (document.status === "REJECTED" && document.wompi_event_id) {
      // MH rejected the CONTENT of this CDE: retransmitting the same signed JWS
      // would be rejected identically, so rebuild it from the original webhook.
      let result: MhResponse;
      try {
        result = await new IssuancePipeline(env).rebuildRejectedWompiDocument(document);
      } catch (error) {
        if (error instanceof RejectedWompiRetryConflictError) {
          // A concurrent retry already claimed the rebuild: refuse cleanly so we never
          // transmit a second distinct legal DTE for the same Wompi event.
          return jsonResponse({ error: "document_retry_in_progress", message: error.message }, { status: 409 });
        }
        throw error;
      }
      await repo.createAudit({
        actorType: "USER",
        actorId: actor.id,
        action: "DTE_RETRIED",
        entityType: "dte_document",
        entityId: document.id,
        summary: `${result.estado} (reconstruido)`,
        metadata: result.raw
      });
      return jsonResponse({ ok: true, result });
    }
    if (!document.signed_jws) {
      if (document.wompi_event_id) {
        await env.ISSUANCE_QUEUE.send({ wompiEventId: document.wompi_event_id });
      } else {
        await env.ISSUANCE_QUEUE.send({ advancedDocumentId: document.id });
      }
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRY_ENQUEUED", entityType: "dte_document", entityId: document.id, summary: "Reintento en cola" });
      return jsonResponse({ ok: true, queued: true });
    }
    const result = await new MhClient(env).transmitDte({
      ambiente: document.environment,
      version: 2,
      tipoDte: document.tipo_dte,
      codigoGeneracion: document.codigo_generacion,
      signedJws: document.signed_jws
    });
    await repo.updateDocumentMhResult(document.id, {
      status: result.accepted ? "ACCEPTED" : "REJECTED",
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null
    });
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRIED", entityType: "dte_document", entityId: document.id, summary: result.estado, metadata: result.raw });
    return jsonResponse({ ok: true, result });
  }

  if (action === "invalidate" && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    if (document.status !== "ACCEPTED" || !document.sello_recibido || !document.accepted_at) {
      return jsonResponse({ error: "document_not_accepted" }, { status: 409 });
    }
    const deadline = cdeInvalidationDeadline(document.accepted_at);
    if (!isWithinDeadline(deadline)) {
      return jsonResponse({ error: "outside_legal_window", deadline }, { status: 409 });
    }
    const body = (await request.json()) as Partial<InvalidationInput>;
    if (body.tipoAnulacion === 1 && !body.codigoGeneracionR) {
      return jsonResponse({ error: "replacement_required_for_tipo_1" }, { status: 400 });
    }
    const config = getEmisorConfig(env);
    const input: InvalidationInput = {
      tipoAnulacion: body.tipoAnulacion ?? 2,
      motivoAnulacion: body.motivoAnulacion ?? "Invalidación solicitada por operador",
      nombreResponsable: body.nombreResponsable ?? config.responsable.nombre,
      tipDocResponsable: body.tipDocResponsable ?? config.responsable.tipoDocumento,
      numDocResponsable: body.numDocResponsable ?? config.responsable.numeroDocumento,
      nombreSolicita: body.nombreSolicita ?? actor.name,
      tipDocSolicita: body.tipDocSolicita ?? config.responsable.tipoDocumento,
      numDocSolicita: body.numDocSolicita ?? config.responsable.numeroDocumento,
      codigoGeneracionR: body.codigoGeneracionR ?? null
    };
    const eventDocument = buildInvalidacionEvent(document, config, input);
    const signedJws = await signMhDocument(eventDocument, getMhCertificateXml(env), requireSecret(env, "MH_CERT_PASSWORD"));
    const eventId = await repo.createDteEvent({
      documentId: document.id,
      eventType: "INVALIDACION",
      environment: document.environment,
      codigoGeneracion: (eventDocument.identificacion as { codigoGeneracion: string }).codigoGeneracion,
      plainJson: eventDocument,
      signedJws,
      legalDeadlineAt: deadline,
      createdBy: actor.id
    });
    const result = await new MhClient(env).transmitInvalidacion({ ambiente: document.environment, version: 3, signedJws });
    await repo.updateDteEventResult(eventId, {
      status: result.accepted ? "ACCEPTED" : "REJECTED",
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null
    });
    let emailSent = false;
    let emailError: string | undefined;
    if (result.accepted) {
      await repo.markDocumentInvalidated(document.id);
      const invalidatedDocument = (await repo.getDteDocument(document.id)) ?? { ...document, status: "INVALIDATED" };
      if (invalidatedDocument.donor_email) {
        try {
          const templates = parseEmailTemplates(await repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
          const branding = await loadEmailBranding(repo, env);
          const emailResponse = await new EmailService(env, templates, branding).sendInvalidationNotice(invalidatedDocument, invalidatedDocument.donor_email);
          await repo.recordEmailDelivery({
            documentId: document.id,
            toEmail: invalidatedDocument.donor_email,
            status: "SENT",
            providerResponse: emailResponse.providerResponse,
            emailType: emailResponse.emailType,
            documentStatusAtSend: emailResponse.documentStatusAtSend,
            templateVersion: emailResponse.templateVersion,
            pdfRendererVersion: emailResponse.pdfRendererVersion,
            pdfSha256: emailResponse.pdfSha256,
            dteJsonSha256: emailResponse.dteJsonSha256,
            providerDeliveryId: emailResponse.providerDeliveryId
          });
          await repo.createAudit({
            actorType: "USER",
            actorId: actor.id,
            action: "EMAIL_INVALIDATION_SENT",
            entityType: "dte_document",
            entityId: document.id,
            summary: `Aviso de invalidación enviado a ${invalidatedDocument.donor_email}`,
            metadata: emailResponse
          });
          emailSent = true;
        } catch (error) {
          emailError = error instanceof Error ? error.message : String(error);
          await repo.recordEmailDelivery({ documentId: document.id, toEmail: invalidatedDocument.donor_email, status: "FAILED", providerResponse: { error: emailError } });
          await repo.createAudit({
            actorType: "USER",
            actorId: actor.id,
            action: "EMAIL_INVALIDATION_FAILED",
            entityType: "dte_document",
            entityId: document.id,
            summary: emailError,
            metadata: { toEmail: invalidatedDocument.donor_email }
          });
        }
      }
    }
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: result.accepted ? "DTE_INVALIDATED" : "DTE_INVALIDATION_REJECTED",
      entityType: "dte_document",
      entityId: document.id,
      summary: result.estado,
      metadata: result.raw
    });
    const responseBody = { accepted: result.accepted, eventId, deadline, result, emailSent, ...(emailError ? { emailError } : {}) };
    if (!result.accepted) {
      return jsonResponse(
        {
          ...responseBody,
          error: "invalidation_rejected",
          message: mhRejectionMessage(result)
        },
        { status: 409 }
      );
    }
    return jsonResponse(responseBody);
  }

  return methodNotAllowed();
}

async function f960Selection(repo: Repository, url: URL): Promise<F960Selection | Response> {
  try {
    return buildF960Selection(await repo.listAcceptedDteDocumentsForExport(), {
      period: url.searchParams.get("period"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate")
    });
  } catch (error) {
    return jsonResponse({ error: "invalid_export_filter", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function auditExport(repo: Repository, actor: AuthUser, action: string, filename: string, rowCount: number): Promise<void> {
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action,
    entityType: "export",
    entityId: filename,
    summary: `${rowCount} filas exportadas`
  });
}

function hasValidBootstrapOwnerToken(request: Request, env: Env): boolean {
  const expected = env.BOOTSTRAP_OWNER_TOKEN?.trim();
  const supplied = request.headers.get(BOOTSTRAP_OWNER_TOKEN_HEADER)?.trim();
  return Boolean(expected && supplied && timingSafeEqual(supplied, expected));
}
