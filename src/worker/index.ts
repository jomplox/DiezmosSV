import { getEmisorConfig, getMhCertificateXml, requireSecret } from "./config";
import { buildAdvancedCdeDocument, buildDirectCdeDocument, buildInvalidacionEvent, cdeDocumentSummary, type DirectCdeInput, type InvalidationInput } from "./domain/dteBuilder";
import { certificateExpiry, signMhDocument } from "./domain/signer";
import { isApprovedDonation, normalizeWompiWebhook, verifyWompiHash, WompiPayloadError, wompiHashHeader } from "./domain/wompi";
import { ALERT_EMAIL_SETTING_KEY, sendOperationalAlert } from "./services/alerts";
import { AuthError, AuthService, PASSWORD_RESET_TTL_MINUTES, PasswordResetError, requireRole, type AuthUser, type Role } from "./services/auth";
import { bootstrapCloudflareWriterToken, buildCredentialSecretPatch, CredentialWriterConfigError, credentialStatus, patchCloudflareWorkerSecrets, type CredentialUpdateInput } from "./services/credentials";
import {
  clientIpFrom,
  createDonationIntent,
  IntentLinkError,
  intentThrottleSinceIso,
  IntentValidationError,
  INTENT_THROTTLE_LIMIT,
  validateIntentInput
} from "./services/donations";
import { EmailService } from "./services/email";
import { EMAIL_TEMPLATES_SETTING_KEY, EmailTemplateValidationError, emailTemplateResponse, normalizeEmailTemplateSettings, parseEmailTemplates } from "./services/emailTemplates";
import { buildAnnualCertificatePreview, certificateYearError, sendAnnualCertificates } from "./services/certificate";
import { buildF960Csv, buildF960Selection, buildF960Xlsx, XLSX_MIME, type F960Selection } from "./services/f960";
import { MhClient } from "./services/mhClient";
import { IssuancePipeline } from "./services/pipeline";
import { renderDtePdf } from "./services/pdf";
import { auditContextFrom } from "./services/requestContext";
import { listBackupMonths, verifyBackupMonth } from "./services/backups";
import { previousElSalvadorMonth, retentionManifestKey, retentionTableKey, runRetentionExport } from "./services/retention";
import { WompiApiService } from "./services/wompiApi";
import { formatElSalvadorDate } from "../shared/legalWindows";
import { Repository } from "./storage/repository";
import type { Env, IssuanceMessage, MhResponse, WompiWebhook } from "./types";
import { addHours, cdeInvalidationDeadline, isWithinDeadline, nowIso } from "./utils/dates";
import { timingSafeEqual } from "./utils/encoding";
import { jsonResponse, methodNotAllowed, notFound } from "./utils/http";

const BOOTSTRAP_OWNER_TOKEN_HEADER = "X-Bootstrap-Owner-Token";
const EMISSION_ENVIRONMENT_SETTING = "emission_environment";
const RETENTION_EXPORT_CRON = "0 9 1 * *";
const CERT_EXPIRY_ALERT_THRESHOLD_DAYS = [30, 14, 3];
// Audit-based auth throttling. Failed logins and password-reset requests are
// counted over a rolling window keyed on (action, entity_id); crossing the
// threshold short-circuits the endpoint before any credential work runs, so
// there is no timing oracle to distinguish throttled from rejected.
const AUTH_THROTTLE_WINDOW_MINUTES = 15;
const LOGIN_FAILED_LIMIT = 5;
const PASSWORD_RESET_LIMIT = 3;

function authThrottleSinceIso(): string {
  return new Date(Date.now() - AUTH_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
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
      // Snapshot what the UPDATE will expire BEFORE running it (afterwards the rows
      // no longer match the predicate), so we can deactivate their Wompi links.
      const expiring = await repo.listIntentsExpiringBefore(now);
      await repo.expireUnpaidIntentsBefore(now);
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
      await checkCertificateExpiry(env, new Repository(env.DB));
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
// certificate (new expiresAt) re-arms every threshold.
async function checkCertificateExpiry(env: Env, repo: Repository): Promise<void> {
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
  const remainingDays = Math.floor((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
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
  const environment = await activeEmissionEnvironment(repo, env);
  const headers = Object.fromEntries([...request.headers.entries()].filter(([key]) => key.toLowerCase() !== "authorization"));
  const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, headers, environment);
  await repo.createAudit({
    action: inserted ? "WOMPI_RECEIVED" : "WOMPI_DUPLICATE",
    entityType: "wompi_event",
    entityId: record.id,
    summary: `${payload.IdTransaccion} ${payload.ResultadoTransaccion}`
  });
  if (inserted && isApprovedDonation(payload)) {
    await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id });
  }
  return jsonResponse({ ok: true, wompiEventId: record.id, inserted, queued: inserted && isApprovedDonation(payload) }, { status: inserted ? 202 : 200 });
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

  // Public donor checkout: unauthenticated, runs before any role check.
  if (url.pathname === "/api/donations/intent" && request.method === "POST") {
    const clientIp = clientIpFrom(request);
    const recentIntents = await repo.countRecentIntentsByIp(clientIp, intentThrottleSinceIso());
    if (recentIntents >= INTENT_THROTTLE_LIMIT) {
      // Short-circuit before any validation/persistence so a throttled attempt is cheap.
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    let input;
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      input = validateIntentInput(body);
    } catch (error) {
      if (error instanceof IntentValidationError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: 400 });
      }
      throw error;
    }
    try {
      const created = await createDonationIntent(env, repo, input, clientIp);
      return jsonResponse(created, { status: 201 });
    } catch (error) {
      if (error instanceof IntentLinkError) {
        // Intent stays PENDING and expires harmlessly on the cron sweep.
        return jsonResponse({ error: "wompi_link_failed", message: "No se pudo generar el enlace de pago. Intente de nuevo en unos minutos." }, { status: 502 });
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
    return jsonResponse({ status: intent.status });
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
    const recentFailures = await repo.countAuditEntriesSince("LOGIN_FAILED", normalizedEmail, authThrottleSinceIso());
    if (recentFailures >= LOGIN_FAILED_LIMIT) {
      // Short-circuit before authenticating so a throttled attempt costs the same as
      // any other rejection — no PBKDF2 work, no DB read, no timing signal.
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
            const link = `${url.origin}/?reset=${created.token}`;
            try {
              await new EmailService(env).sendPasswordReset(created.user.email, created.user.name, link, PASSWORD_RESET_TTL_MINUTES);
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

  if (url.pathname === "/api/certificates/annual" && request.method === "GET") {
    requireRole(user, "ADMIN");
    const yearParam = url.searchParams.get("year");
    const yearError = certificateYearError(yearParam, new Date());
    if (yearError) {
      return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
    }
    return jsonResponse(await buildAnnualCertificatePreview(repo, Number(yearParam)));
  }

  if (url.pathname === "/api/certificates/annual/send" && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
    const yearParam = url.searchParams.get("year");
    const yearError = certificateYearError(yearParam, new Date());
    if (yearError) {
      return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
    }
    const year = Number(yearParam);
    const result = await sendAnnualCertificates(env, repo, year, actor.id);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "DONOR_CERTIFICATES_RUN",
      entityType: "donor_certificate_run",
      entityId: String(year),
      summary: `Constancias ${year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas`,
      metadata: result
    });
    return jsonResponse(result);
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/);
  if (documentMatch) {
    return handleDocumentRoute(request, env, repo, user, documentMatch[1], documentMatch[2]);
  }

  if (url.pathname === "/api/audit" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ audit: await repo.listAudit(url.searchParams.get("entityType") ?? undefined, url.searchParams.get("entityId") ?? undefined) });
  }

  // Solo lectura (historial). La emisión en contingencia del CDE se eliminó: el
  // Anexo de validaciones del evento de contingencia (campo 35) no admite el tipo 15,
  // así que las rutas de apertura/barrido ya no existen. Ante una caída de MH la
  // emisión queda TRANSMISSION_PENDING y el cron de 15 minutos la reintenta.
  if (url.pathname === "/api/contingency" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ contingency: await contingencyState(repo) });
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
    const created = await auth.createUser(body);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_CREATED", entityType: "user", entityId: created.id, summary: created.email });
    return jsonResponse({ user: created }, { status: 201 });
  }

  const passwordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (passwordMatch && request.method === "POST") {
    const actor = requireRole(user, "ADMIN");
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
    const updated = await repo.updateUser(userMatch[1], patch);
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userMatch[1], summary: "Usuario actualizado", metadata: patch });
    return jsonResponse({ user: updated });
  }

  return notFound();
}

function isProduction(env: Env): boolean {
  return (env.APP_ENV ?? "local").toLowerCase() === "production";
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
  const raw = typeof body.alertEmail === "string" ? body.alertEmail.trim() : "";
  if (raw && !normalizeEmail(raw)) {
    return jsonResponse({ error: "invalid_alert_email", message: "Ingrese un correo válido." }, { status: 400 });
  }
  await repo.setSetting(ALERT_EMAIL_SETTING_KEY, raw, actor.id);
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "ALERT_EMAIL_UPDATED",
    entityType: "app_setting",
    entityId: ALERT_EMAIL_SETTING_KEY,
    summary: raw ? `Correo de alertas configurado a ${raw}` : "Correo de alertas desactivado",
    metadata: { alertEmail: raw }
  });
  return jsonResponse({ ok: true, alertEmail: raw });
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

async function contingencyState(repo: Repository): Promise<Record<string, unknown>> {
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
    audit: active ? await repo.listAudit("contingency_period", String(active.id)) : [],
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

function isRetryableDocumentStatus(status: string): boolean {
  return ["SIGNED", "REJECTED", "FAILED", "CONTINGENCY_PENDING"].includes(status);
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
    requireRole(user, "VIEWER");
    // donorDataVerified: this CDE was produced from a completed donation-intent, so
    // the donor's data came from the validated /donar form rather than the raw webhook.
    const donorDataVerified = (await repo.getCompletedIntentForDocument(document.id)) !== null;
    return jsonResponse({ document, donorDataVerified, audit: await repo.listAudit("dte_document", document.id) });
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
      const response = await new EmailService(env, templates).sendReceipt(document, toEmail);
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
    if (!isRetryableDocumentStatus(document.status)) {
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
      const result = await new IssuancePipeline(env).rebuildRejectedWompiDocument(document);
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
          const emailResponse = await new EmailService(env, templates).sendInvalidationNotice(invalidatedDocument, invalidatedDocument.donor_email);
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
