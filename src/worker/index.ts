import { getEmisorConfig, getMhCertificateXml, requireSecret } from "./config";
import { buildAdvancedCdeDocument, buildDirectCdeDocument, buildInvalidacionEvent, cdeDocumentSummary, type DirectCdeInput, type InvalidationInput } from "./domain/dteBuilder";
import { certificateExpiry, signMhDocument } from "./domain/signer";
import { ambienteFromWompi, isApprovedDonation, normalizeWompiWebhook, verifyWompiHash, WompiPayloadError, wompiHashHeader } from "./domain/wompi";
import { ALERT_EMAIL_SETTING_KEY, normalizeAlertRecipients, sendOperationalAlert } from "./services/alerts";
import { AuthError, AuthService, BootstrapUnavailableError, PASSWORD_RESET_TTL_MINUTES, PasswordPolicyError, PasswordResetError, requireRole, type AuthUser, type Role, UserNotFoundError } from "./services/auth";
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
  INTENT_THROTTLE_WINDOW_MINUTES,
  isDraftIntentBody,
  validateDatosInput,
  validateDraftIntentInput,
  validateIntentInput
} from "./services/donations";
import { classifyEmailDispatchError, emailDeliveryAuditEvidence, EmailService, type EmailDeliveryResult } from "./services/email";
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATES_SETTING_KEY, EmailTemplateValidationError, emailTemplateResponse, normalizeEmailTemplateSettings, parseEmailTemplates } from "./services/emailTemplates";
import { resolveDonationIntentBinding } from "./services/donationIntentBinding";
import { issuanceFailureEvidence } from "./services/issuanceFailure";
import { logWorkerError } from "./services/observability";
import { stagingSmokeRunId } from "./services/stagingSmoke";
import {
  assertDeploymentCanCollectPayments,
  assertDeploymentAllowsAmbiente,
  deploymentEnvironmentPolicy,
  EnvironmentNotAllowedError,
  PaymentCollectionDisabledError
} from "./services/environmentPolicy";
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
import { AnalyticsCapacityError, computeAnalytics, elSalvadorRangeWindow, type AnalyticsRange } from "./services/analytics";
import { CAT012_DEPARTMENTS, CAT020_COUNTRIES, findCatalogOption } from "../shared/catalogs";
import { aggregateDonorContacts, buildContactsCsv, resolveContactColumns, contactsCsvFilename } from "./services/contacts";
import { buildF960Csv, buildF960Selection, buildF960Xlsx, XLSX_MIME, type F960Selection } from "./services/f960";
import { MhClient, MhPreDispatchError } from "./services/mhClient";
import { IssuancePipeline } from "./services/pipeline";
import { renderDtePdf } from "./services/pdf";
import { auditContextFrom } from "./services/requestContext";
import { projectAuditRows } from "./services/auditProjection";
import { BackupArchiveTooLargeError, BACKUP_MONTH_DOWNLOAD_MAX_BYTES, collectBackupMonthObjects, listBackupMonths, verifyBackupMonth } from "./services/backups";
import { zipStored } from "./utils/zip";
import { previousElSalvadorMonth, retentionManifestKey, retentionTableKey, runRetentionExport } from "./services/retention";
import { WompiApiService } from "./services/wompiApi";
import { formatElSalvadorDate } from "../shared/legalWindows";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection,
  type FiscalReceptorCorrection
} from "../shared/fiscalCorrection";
import {
  buildCorrectedDirectCandidate,
  buildCorrectedWompiCandidate,
  effectiveDocumentCorrectionData,
  effectiveWompiCorrectionData
} from "./services/fiscalCorrection";
import {
  legacyIssuanceAttemptId,
  OwnerTargetProtectedError,
  Repository,
  UserMutationConflictError
} from "./storage/repository";
import type { Ambiente, DteDocumentRecord, Env, IssuanceMessage, MhResponse, WompiWebhook } from "./types";
import { addHours, cdeInvalidationDeadline, isWithinDeadline, nowIso } from "./utils/dates";
import { sha256Hex, timingSafeEqual, utf8Bytes } from "./utils/encoding";
import { newId } from "./utils/ids";
import {
  InvalidJsonBodyError,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readBodyBytes,
  readBodyText,
  readJsonObject,
  RequestBodyTooLargeError
} from "./utils/http";

const BOOTSTRAP_OWNER_TOKEN_HEADER = "X-Bootstrap-Owner-Token";
const EMISSION_ENVIRONMENT_SETTING = "emission_environment";
const RETENTION_EXPORT_CRON = "0 9 1 * *";
const CERT_EXPIRY_ALERT_THRESHOLD_DAYS = [30, 14, 3];
// Auth throttling uses atomic claim ledgers for aggregate login attempts and
// password-reset requests. Account-specific login failures remain keyed on
// (email, caller IP), so a third party cannot lock out a victim's email by spamming
// failures from another address while brute-force traffic from one IP is still capped.
const AUTH_THROTTLE_WINDOW_MINUTES = 15;
const LOGIN_FAILED_LIMIT = 5;
const LOGIN_IP_ATTEMPT_LIMIT = 60;
const PASSWORD_RESET_PAIR_LIMIT = 3;
const PASSWORD_RESET_ACCOUNT_LIMIT = 3;
const BOOTSTRAP_ATTEMPT_LIMIT = 10;
const BOOTSTRAP_TOKEN_PATTERN = /^bt_[A-Za-z0-9_-]{43}$/;

// Public donation endpoints parse untrusted JSON before validation and rate-limit
// admission. Cap bodies at 16 KiB (normal payloads are a few hundred bytes) so an
// oversized request is rejected before it can consume application resources.
const PUBLIC_JSON_BODY_LIMIT_BYTES = 16 * 1024;
const AUTHENTICATED_JSON_BODY_LIMIT_BYTES = 256 * 1024;
const WOMPI_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
const INVALIDATION_REQUEST_KEYS = new Set(["tipoAnulacion", "motivoAnulacion", "codigoGeneracionR"]);
const FISCAL_CORRECTION_REQUEST_KEYS = new Set(["correctionRequestId", "receptor"]);

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

function wompiIssuanceOperationFailedResponse(): Response {
  return jsonResponse(
    {
      error: "wompi_issuance_operation_failed",
      message: "No se pudo completar la operación de emisión. Intente de nuevo."
    },
    { status: 500 }
  );
}

function authThrottleSinceIso(): string {
  return new Date(Date.now() - AUTH_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
}

function authThrottleExpiresIso(): string {
  return new Date(Date.now() + AUTH_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
}

async function rateLimitKey(value: string | null): Promise<string> {
  return sha256Hex(utf8Bytes(value?.trim() || "unknown"));
}

function intentThrottleExpiresIso(): string {
  return new Date(Date.now() + INTENT_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
}

async function listAuditForUser(
  repo: Repository,
  user: AuthUser,
  entityType?: string,
  entityId?: string
): Promise<Array<Record<string, unknown>>> {
  return projectAuditRows(await repo.listAudit(entityType, entityId), user.role);
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

// A cross-origin browser can send a CORS-simple text/plain POST even when it cannot
// read the response. Reject that request before it can spend the visitor's IP quota,
// write D1 state, or call Wompi. Direct server clients may omit Origin, but every
// caller must use JSON; browser requests that do provide Origin must match the URL
// that received the request. APP_ORIGIN remains the canonical link-generation origin.
function rejectUnsafePublicDonationMutation(request: Request, url: URL): Response | null {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return jsonResponse(
      { error: "unsupported_media_type", message: "Use Content-Type: application/json." },
      { status: 415 }
    );
  }
  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
    return jsonResponse({ error: "cross_site_request", message: "Solicitud de origen no permitido." }, { status: 403 });
  }
  const suppliedOrigin = request.headers.get("origin");
  if (suppliedOrigin === null) {
    return null;
  }
  try {
    if (new URL(suppliedOrigin).origin === url.origin) {
      return null;
    }
  } catch {
    // Invalid and opaque origins fail closed below.
  }
  return jsonResponse({ error: "cross_site_request", message: "Solicitud de origen no permitido." }, { status: 403 });
}

function documentResponseWithSecurityHeaders(response: Response): Response {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }
  const headers = new Headers(response.headers);
  const directives = (headers.get("Content-Security-Policy") ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors(?:\s|$)/i.test(directive));
  directives.push("frame-ancestors 'none'");
  headers.set("Content-Security-Policy", directives.join("; "));
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, ctx);
      }
      if (url.pathname === "/webhooks/wompi") {
        return await handleWompiWebhook(request, env);
      }
      return documentResponseWithSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: "request_body_too_large", message: "La solicitud es demasiado grande." }, { status: 413 });
      }
      if (error instanceof InvalidJsonBodyError) {
        return jsonResponse({ error: "invalid_json_body", message: "La solicitud no contiene JSON válido." }, { status: 400 });
      }
      if (error instanceof AuthError) {
        return jsonResponse({ error: "auth_error", message: error.message }, { status: error.status });
      }
      if (error instanceof EnvironmentNotAllowedError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: 409 });
      }
      if (error instanceof PaymentCollectionDisabledError) {
        return jsonResponse({ error: error.code, message: error.message }, { status: 503 });
      }
      logWorkerError(env, "unhandled_worker_request_error", error);
      return jsonResponse({ error: "internal_error", message: "Ocurrió un error interno." }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
    try {
      await handleQueueBatch(batch, env);
    } catch (error) {
      // retryAll applies only to messages without an earlier per-message ack/retry;
      // Cloudflare's first explicit disposition wins for already-processed messages.
      batch.retryAll();
      logWorkerError(env, "queue_handler_failed", error);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await handleScheduled(event, env);
    } catch (error) {
      // Cron has no queue-style retry contract. Abort this tick after one safe event;
      // a later scheduled tick can retry the prerequisites and subsequent sweeps.
      logWorkerError(env, "scheduled_handler_failed", error);
    }
  }
};

async function handleQueueBatch(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
  if (batch.queue.endsWith("-dlq")) {
    await handleDeadLetterBatch(batch, env);
    return;
  }
  const pipeline = new IssuancePipeline(env);
  const repo = new Repository(env.DB);
  for (const message of batch.messages) {
    if (message.body.fiscalCorrectionId) {
      await handleFiscalCorrectionQueueMessage(message, pipeline, repo, env);
      continue;
    }
    const wompiEventId = message.body.wompiEventId;
    const legacyMessage = Boolean(wompiEventId && !message.body.issuanceAttemptId);
    const issuanceAttemptId = wompiEventId
      ? message.body.issuanceAttemptId ?? legacyIssuanceAttemptId(wompiEventId)
      : null;
    let currentWompiAttempt = false;
    try {
      if (message.body.advancedDocumentId) {
        await pipeline.processDteDocument(
          message.body.advancedDocumentId,
          message.body.issuanceAttemptId ?? message.id
        );
      } else if (wompiEventId && issuanceAttemptId) {
        currentWompiAttempt = await repo.markWompiIssuanceProcessing(
          wompiEventId,
          issuanceAttemptId,
          legacyMessage
        );
        if (!currentWompiAttempt) {
          const existing = await repo.getDteDocumentByWompiEvent(wompiEventId);
          if (!existing) {
            message.ack();
            continue;
          }
          // A prior delivery may already have created/accepted the CDE and then
          // crashed during intent/email bookkeeping. Resume that persisted row
          // without reopening the pre-CDE lifecycle or retransmitting a terminal CDE.
          await pipeline.processDteDocument(existing.id, issuanceAttemptId);
        } else {
          await pipeline.processWompiEvent(wompiEventId, issuanceAttemptId);
        }
      } else {
        throw new Error("Issuance message did not include a target id");
      }
      message.ack();
    } catch (error) {
      logWorkerError(env, "issuance_message_failed", error);
      if (wompiEventId && issuanceAttemptId) {
        const recorded = currentWompiAttempt && await repo.recordWompiIssuanceFailure(
          wompiEventId,
          issuanceAttemptId,
          issuanceFailureEvidence(error)
        );
        if (!recorded) {
          const existing = await repo.getDteDocumentByWompiEvent(wompiEventId);
          if (existing) {
            message.retry();
          } else {
            message.ack();
          }
          continue;
        }
      }
      message.retry();
    }
  }
}

async function handleFiscalCorrectionQueueMessage(
  message: Message<IssuanceMessage>,
  pipeline: IssuancePipeline,
  repo: Repository,
  env: Env
): Promise<void> {
  const correctionId = message.body.fiscalCorrectionId;
  const processingClaimId = message.body.fiscalCorrectionProcessingClaimId;
  const issuanceAttemptId = message.body.issuanceAttemptId;
  const fiscalClaimId = message.body.fiscalClaimId;
  try {
    if (
      !correctionId
      || !processingClaimId
      || Boolean(issuanceAttemptId) === Boolean(fiscalClaimId)
    ) {
      throw new Error("Fiscal correction message is missing an ownership token");
    }
    await pipeline.processFiscalCorrection(correctionId, {
      processingClaimId,
      ...(issuanceAttemptId ? { issuanceAttemptId } : {}),
      ...(fiscalClaimId ? { fiscalClaimId } : {})
    });
    message.ack();
  } catch (error) {
    logWorkerError(env, "fiscal_correction_message_failed", error);
    const correction = correctionId
      ? await repo.getFiscalCorrection(correctionId)
      : null;
    const ownsCorrection = Boolean(
      correction
      && processingClaimId
      && correction.processing_claim_id === processingClaimId
      && correction.issuance_attempt_id === (issuanceAttemptId ?? null)
      && correction.fiscal_claim_id === (fiscalClaimId ?? null)
    );
    if (
      !correction
      || !ownsCorrection
      || ["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)
      || (correction.status === "PROCESSING" && correction.mh_dispatch_started_at !== null)
    ) {
      message.ack();
      return;
    }
    if (
      correction.status === "QUEUED"
      || (correction.status === "PROCESSING" && correction.mh_dispatch_started_at === null)
    ) {
      message.retry();
      return;
    }
    message.ack();
  }
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  if (event.cron === RETENTION_EXPORT_CRON) {
    try {
      await runRetentionExport(env, new Date(event.scheduledTime));
    } catch (error) {
      logWorkerError(env, "retention_export_failed", error);
    }
    return;
  }
  const repo = new Repository(env.DB);
  const now = nowIso();
  await repo.deleteExpiredLoginRateLimits(now);
  await repo.deleteExpiredSecurityRateLimitClaims(now);
  const pipeline = new IssuancePipeline(env);
  try {
    await pipeline.retryDeferredTransmissions();
  } catch (error) {
    logWorkerError(env, "deferred_transmission_retry_sweep_failed", error);
  }
  try {
    await pipeline.retryPendingPostAcceptFinalizations();
  } catch (error) {
    logWorkerError(env, "post_accept_finalization_sweep_failed", error);
  }
  try {
    await pipeline.retryAcceptedWompiFinalizations();
  } catch (error) {
    logWorkerError(env, "accepted_wompi_finalization_retry_failed", error);
  }
  try {
    await pipeline.sweepStalledWompiEvents();
  } catch (error) {
    logWorkerError(env, "stalled_wompi_event_sweep_failed", error);
  }
  try {
    await pipeline.recoverStalledFiscalCorrections();
  } catch (error) {
    logWorkerError(env, "fiscal_correction_recovery_failed", error);
  }
  try {
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
        logWorkerError(env, "wompi_link_deactivation_failed", error);
      }
    }
  } catch (error) {
    logWorkerError(env, "donation_intent_expiry_sweep_failed", error);
  }
  try {
    // Drive the expiry math from the scheduled tick's time, the same reference the
    // retention export above uses, so the countdown never depends on the wall clock.
    await checkCertificateExpiry(env, new Repository(env.DB), event.scheduledTime ?? Date.now());
  } catch (error) {
    logWorkerError(env, "certificate_expiry_check_failed", error);
  }
}

async function handleDeadLetterBatch(batch: MessageBatch<IssuanceMessage>, env: Env): Promise<void> {
  const repo = new Repository(env.DB);
  for (const message of batch.messages) {
    const documentId = message.body.advancedDocumentId;
    const wompiEventId = message.body.wompiEventId;
    const entityType = documentId ? "dte_document" : "wompi_event";
    const entityId = documentId ?? wompiEventId ?? "desconocido";
    let incidentId = message.body.issuanceAttemptId ?? message.id ?? entityId;
    const summary = "Mensaje de emisión agotó sus reintentos en cola; conservado para revisión";
    if (wompiEventId) {
      const legacyMessage = !message.body.issuanceAttemptId;
      const attemptId = message.body.issuanceAttemptId ?? legacyIssuanceAttemptId(wompiEventId);
      incidentId = attemptId;
      const current = await repo.markWompiIssuanceDeadLettered(
        wompiEventId,
        attemptId,
        legacyMessage
      );
      if (!current) {
        message.ack();
        continue;
      }
      const audited = await repo.createWompiAttemptAudit({
        wompiEventId,
        attemptId,
        action: "ISSUANCE_DEAD_LETTERED",
        summary,
        metadata: { attemptId }
      });
      if (!audited) {
        message.ack();
        continue;
      }
    } else {
      await repo.createAudit({
        action: "ISSUANCE_DEAD_LETTERED",
        entityType,
        entityId,
        summary
      });
    }
    await sendOperationalAlert(env, repo, {
      kind: "ISSUANCE_DEAD_LETTERED",
      title: "Mensaje de emisión agotó reintentos",
      detail: summary,
      entityType,
      entityId,
      incidentId
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
      entityId: `${expiresAt}:${threshold}`,
      incidentId: `${expiresAt}:${threshold}`
    });
  }
}

async function handleWompiWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const rawBody = await readBodyText(request, WOMPI_WEBHOOK_BODY_LIMIT_BYTES);
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
  // The signed payload remains the event's fiscal environment, but the deployment
  // capability decides whether this Worker may issue it. Incompatible events are
  // retained as evidence and quarantined from paid marking and the issuance queue.
  const environment = ambienteFromWompi(payload);
  const policy = deploymentEnvironmentPolicy(env);
  const environmentAllowed = policy.allowedAmbiente === environment;
  const headers = Object.fromEntries([...request.headers.entries()].filter(([key]) => key.toLowerCase() !== "authorization"));
  const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, headers, environment);
  await repo.createAudit({
    action: inserted ? "WOMPI_RECEIVED" : "WOMPI_DUPLICATE",
    entityType: "wompi_event",
    entityId: record.id,
    summary: `${payload.IdTransaccion} ${payload.ResultadoTransaccion}`
  });
  if (inserted && !environmentAllowed) {
    await repo.createAudit({
      action: "WOMPI_ENVIRONMENT_MISMATCH",
      entityType: "wompi_event",
      entityId: record.id,
      summary: `El webhook declara ambiente ${environment}, incompatible con este despliegue; queda en cuarentena`,
      metadata: { payloadEnvironment: environment, activeEnvironment: policy.allowedAmbiente }
    });
  }
  // Stamp the donor's payment marker synchronously, BEFORE the queue enqueue and
  // regardless of it. The donor-facing "thanks" keys on paid_at (the PAYMENT), not on
  // COMPLETED (the CDE's MH acceptance, which the async pipeline sets and can lag).
  // Runs on replays too (markIntentPaid is idempotent). Wrapped defensively — a
  // bad/unknown intent id must never break webhook processing.
  if (environmentAllowed) {
    await markIntentPaidFromWebhook(env, repo, payload);
  }
  let queued = false;
  if (inserted && environmentAllowed && isApprovedDonation(payload)) {
    const attemptId = await repo.claimInitialWompiIssuanceAttempt(record.id);
    if (attemptId) {
      await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id, issuanceAttemptId: attemptId });
      queued = true;
    }
  }
  return jsonResponse({ ok: true, wompiEventId: record.id, inserted, queued }, { status: inserted ? 202 : 200 });
}

// Marks payment only after the shared resolver binds both Wompi identifiers to the
// exact stored intent/link. Legacy static-link payloads remain untouched. Never throws:
// the paid marker is donor-UI convenience while the pipeline owns fiscal completion.
async function markIntentPaidFromWebhook(env: Env, repo: Repository, payload: WompiWebhook): Promise<void> {
  try {
    if (!isApprovedDonation(payload)) {
      return;
    }
    const binding = await resolveDonationIntentBinding(repo, payload);
    if (binding.kind !== "bound" || binding.intent.wompi_id_enlace === null) {
      return;
    }
    await repo.markIntentPaid(binding.intent.id, binding.intent.wompi_id_enlace);
  } catch (error) {
    logWorkerError(env, "mark_intent_paid_from_webhook_failed", error);
  }
}

async function processPasswordResetRequest(
  repo: Repository,
  auth: AuthService,
  env: Env,
  url: URL,
  email: string,
  clientIp: string
): Promise<void> {
  const account = await repo.getUserForLogin(email);
  if (!account || account.disabled_at) return;

  const claimNow = nowIso();
  const rateLimitClaimId = await repo.claimPasswordResetBudgets(
    await rateLimitKey(`password-reset:${account.id}:${clientIp}`),
    await rateLimitKey(`password-reset-account:${account.id}`),
    account.id,
    claimNow,
    authThrottleSinceIso(),
    authThrottleExpiresIso(),
    PASSWORD_RESET_PAIR_LIMIT,
    PASSWORD_RESET_ACCOUNT_LIMIT
  );
  if (!rateLimitClaimId) return;

  const created = await auth.createPasswordResetToken(email);
  if (!created) return;

  const link = `${resolveAppOrigin(env, url)}/#reset=${created.token}`;
  try {
    const resetBranding = await loadEmailBranding(repo, env);
    await new EmailService(env, DEFAULT_EMAIL_TEMPLATES, resetBranding).sendPasswordReset(
      created.user.email,
      created.user.name,
      link,
      PASSWORD_RESET_TTL_MINUTES
    );
    await repo.createAudit({
      action: "PASSWORD_RESET_REQUESTED",
      entityType: "user",
      entityId: created.user.id,
      summary: created.user.email,
      rateLimitClaimId
    });
  } catch (error) {
    await repo.invalidatePasswordResetToken(created.tokenId);
    await repo.createAudit({
      action: "PASSWORD_RESET_EMAIL_FAILED",
      entityType: "user",
      entityId: created.user.id,
      summary: error instanceof Error ? error.message : String(error),
      rateLimitClaimId
    });
  }
}

async function handleApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
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
    const hasNoUsers = (await repo.countUsers()) === 0;
    return jsonResponse({ bootstrapAvailable: isBootstrapOwnerTokenConfigured(env) && hasNoUsers });
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
    const rejected = rejectUnsafePublicDonationMutation(request, url);
    if (rejected) return rejected;
    assertDeploymentCanCollectPayments(env);
    const clientIp = clientIpFrom(request);
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" });
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
    const claimNow = nowIso();
    const rateLimitClaimId = await repo.claimDonationIntentRateLimit(
      await rateLimitKey(clientIp),
      clientIp,
      claimNow,
      intentThrottleSinceIso(),
      intentThrottleExpiresIso(),
      INTENT_THROTTLE_LIMIT
    );
    if (!rateLimitClaimId) {
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    try {
      const created = draft
        ? await createDraftDonationIntent(env, repo, input as ReturnType<typeof validateDraftIntentInput>, clientIp, rateLimitClaimId)
        : await createDonationIntent(env, repo, input as ReturnType<typeof validateIntentInput>, clientIp, rateLimitClaimId);
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
  // fast D1-only call (no Wompi). Its dedicated per-IP budget counts every attempt,
  // including malformed bodies and failed capability guesses.
  const intentDatosMatch = url.pathname.match(/^\/api\/donations\/intent\/([^/]+)\/datos$/);
  if (intentDatosMatch && request.method === "POST") {
    const clientIp = clientIpFrom(request);
    const claimNow = nowIso();
    const rateLimitClaimId = await repo.claimDonationDatosRateLimit(
      await rateLimitKey(clientIp),
      claimNow,
      intentThrottleSinceIso(),
      intentThrottleExpiresIso(),
      INTENT_THROTTLE_LIMIT
    );
    if (!rateLimitClaimId) {
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    let data;
    try {
      const body = await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" });
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
      const completed = await applyIntentDatos(
        repo,
        intentDatosMatch[1],
        request.headers.get("X-Donation-Datos-Token") ?? "",
        data
      );
      return jsonResponse(completed);
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
    if (!isBootstrapOwnerTokenConfigured(env)) {
      return jsonResponse({ error: "bootstrap_configuration_invalid" }, { status: 503 });
    }
    const claimNow = nowIso();
    const accepted = await repo.claimLoginAttempt(
      await rateLimitKey(`bootstrap-owner:${clientIpFrom(request)}`),
      claimNow,
      authThrottleSinceIso(),
      authThrottleExpiresIso(),
      BOOTSTRAP_ATTEMPT_LIMIT
    );
    if (!accepted) {
      return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
    }
    if (!(await hasValidBootstrapOwnerToken(request, env))) {
      return jsonResponse({ error: "bootstrap_token_required" }, { status: 403 });
    }
    const body = (await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as { email: string; name: string; password: string };
    let owner;
    try {
      owner = await auth.bootstrapOwner(body);
    } catch (error) {
      if (error instanceof BootstrapUnavailableError) {
        return jsonResponse({ error: "bootstrap_unavailable", message: error.message }, { status: 409 });
      }
      throw error;
    }
    await repo.createAudit({ action: "OWNER_BOOTSTRAPPED", entityType: "user", entityId: owner.id, summary: owner.email });
    return jsonResponse({ user: owner }, { status: 201 });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = (await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as { email: string; password: string };
    const normalizedEmail = String(body.email ?? "").trim().toLowerCase();
    const { ip: callerIp } = auditContextFrom(request);
    const claimNow = nowIso();
    const accepted = await repo.claimLoginAttempt(
      await rateLimitKey(callerIp),
      claimNow,
      authThrottleSinceIso(),
      authThrottleExpiresIso(),
      LOGIN_IP_ATTEMPT_LIMIT
    );
    if (!accepted) {
      return jsonResponse(
        {
          error: "too_many_attempts",
          message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
        },
        { status: 429 }
      );
    }
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

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    await auth.logout(request);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/auth/password-reset/request" && request.method === "POST") {
    const body = (await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as { email?: string };
    const email = String(body.email ?? "").trim();
    if (email) {
      const task = processPasswordResetRequest(repo, auth, env, url, email, clientIpFrom(request))
        .catch((error) => logWorkerError(env, "password_reset_request_failed", error));
      if (ctx) {
        ctx.waitUntil(task);
      } else {
        void task;
      }
    }
    // Always report success so the endpoint cannot be used to probe which emails exist.
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/auth/password-reset/confirm" && request.method === "POST") {
    const body = (await readJsonObject(request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as { token?: string; password?: string };
    try {
      const resetUser = await auth.confirmPasswordReset(String(body.token ?? ""), String(body.password ?? ""));
      await repo.createAudit({ actorType: "USER", actorId: resetUser.id, action: "PASSWORD_RESET_COMPLETED", entityType: "user", entityId: resetUser.id, summary: resetUser.email });
      return jsonResponse({ ok: true });
    } catch (error) {
      if (error instanceof PasswordResetError) {
        return jsonResponse({ error: "invalid_reset_token", message: error.message }, { status: 400 });
      }
      if (error instanceof PasswordPolicyError) {
        return jsonResponse({ error: "weak_password", message: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  if (url.pathname === "/api/documents" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse(await repo.listDteDocuments({
      status: url.searchParams.get("status"),
      attention: url.searchParams.get("attention") === "failures" ? "failures" : null,
      q: url.searchParams.get("q"),
      cursor: url.searchParams.get("cursor"),
      limit: Number(url.searchParams.get("limit") ?? 50)
    }));
  }

  if (url.pathname === "/api/donations/intents" && request.method === "GET") {
    requireRole(user, "VIEWER");
    return jsonResponse({ intents: await repo.listRecentDonationIntents(50) });
  }

  if (url.pathname === "/api/wompi-events/issuance-failures" && request.method === "GET") {
    requireRole(user, "VIEWER");
    try {
      return jsonResponse({ failures: await repo.listWompiIssuanceFailures(100) });
    } catch (error) {
      logWorkerError(env, "wompi_issuance_failure_list_failed", error);
      return wompiIssuanceOperationFailedResponse();
    }
  }

  const wompiIssuanceRetryMatch = url.pathname.match(/^\/api\/wompi-events\/([^/]+)\/retry$/);
  if (wompiIssuanceRetryMatch && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    const wompiEventId = wompiIssuanceRetryMatch[1];
    try {
      const attemptId = await repo.claimWompiIssuanceRetry(wompiEventId, actor.id);
      if (!attemptId) {
        const current = await repo.getWompiIssuanceFailureById(wompiEventId);
        if (!current) {
          return notFound();
        }
        if (current.issuance_status === "RETRY_QUEUED" || current.issuance_status === "PROCESSING") {
          return jsonResponse({ queued: false, failure: current });
        }
        return jsonResponse(
          {
            error: "wompi_issuance_retry_not_available",
            message: "El evento Wompi ya no está disponible para reintento.",
            failure: current
          },
          { status: 409 }
        );
      }
      await env.ISSUANCE_QUEUE.send({ wompiEventId, issuanceAttemptId: attemptId });
      return jsonResponse({ ok: true, queued: true }, { status: 202 });
    } catch (error) {
      logWorkerError(env, "wompi_issuance_retry_failed", error);
      return wompiIssuanceOperationFailedResponse();
    }
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
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { donor?: unknown };
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

  const wompiCorrectionDataMatch =
    url.pathname.match(/^\/api\/wompi-events\/([^/]+)\/correction-data$/);
  if (wompiCorrectionDataMatch && request.method === "GET") {
    requireRole(user, "OPERATOR");
    const data = await effectiveWompiCorrectionData(repo, wompiCorrectionDataMatch[1]);
    if (!data) return notFound();
    data.activeCorrection = await repo.getActiveFiscalCorrectionForTarget(
      "WOMPI_EVENT",
      wompiCorrectionDataMatch[1]
    );
    return jsonResponse(data);
  }

  const wompiCorrectRetryMatch =
    url.pathname.match(/^\/api\/wompi-events\/([^/]+)\/correct-and-retry$/);
  if (wompiCorrectRetryMatch && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    return handleWompiFiscalCorrection(
      request,
      env,
      repo,
      actor,
      wompiCorrectRetryMatch[1]
    );
  }

  const documentCorrectionDataMatch =
    url.pathname.match(/^\/api\/documents\/([^/]+)\/correction-data$/);
  if (documentCorrectionDataMatch && request.method === "GET") {
    requireRole(user, "OPERATOR");
    const document = await repo.getDteDocument(documentCorrectionDataMatch[1]);
    if (!document) return notFound();
    const data = effectiveDocumentCorrectionData(document);
    data.activeCorrection = await repo.getActiveFiscalCorrectionForTarget(
      "DTE_DOCUMENT",
      document.id
    );
    return jsonResponse(data);
  }

  const documentCorrectRetryMatch =
    url.pathname.match(/^\/api\/documents\/([^/]+)\/correct-and-retry$/);
  if (documentCorrectRetryMatch && request.method === "POST") {
    const actor = requireRole(user, "OPERATOR");
    return handleDocumentFiscalCorrection(
      request,
      env,
      repo,
      actor,
      documentCorrectRetryMatch[1]
    );
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
    return jsonResponse({ audit: projectAuditRows(page, actor.role), nextCursor });
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
    if (!deploymentEnvironmentPolicy(env).directGenerationAllowed) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as DirectCdeInput & {
      smokeRunId?: unknown;
    };
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
    const smokeRunId = stagingSmokeRunId(env, input.smokeRunId);
    if (smokeRunId) {
      await repo.createAuditIfAbsent({
        action: "STAGING_SMOKE_RUN",
        entityType: "dte_document",
        entityId: dte.id,
        summary: "CDE creado por la prueba integral de staging",
        metadata: { runId: smokeRunId, path: "admin", source: "staging-smoke" }
      });
    }
    await env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
    return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
  }

  if (url.pathname === "/api/test/dte/advanced-template" && request.method === "POST") {
    requireRole(user, "OPERATOR");
    if (!deploymentEnvironmentPolicy(env).directGenerationAllowed) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const input = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as DirectCdeInput;
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
    if (!deploymentEnvironmentPolicy(env).directGenerationAllowed) {
      return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
    }
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { draft?: unknown };
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
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as { email: string; name: string; role: Role; password: string };
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
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { password?: unknown };
    if (typeof body.password !== "string" || !body.password) {
      return jsonResponse({ error: "missing_user_password", message: "Ingrese nueva contraseña" }, { status: 400 });
    }
    try {
      await auth.resetUserPassword(passwordMatch[1], body.password, actor.role === "OWNER");
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        return jsonResponse({ error: "invalid_user_password", message: error.message }, { status: 400 });
      }
      if (error instanceof UserNotFoundError) {
        return jsonResponse({ error: "user_not_found", message: error.message }, { status: 404 });
      }
      if (error instanceof OwnerTargetProtectedError) {
        return jsonResponse({ error: "owner_target_protected", message: error.message }, { status: 403 });
      }
      throw error;
    }
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_PASSWORD_RESET", entityType: "user", entityId: passwordMatch[1], summary: "Contraseña restablecida por administrador" });
    return jsonResponse({ ok: true });
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && request.method === "PATCH") {
    const actor = requireRole(user, "ADMIN");
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown };
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
    let updated: Record<string, unknown>;
    try {
      updated = await repo.updateUser(userMatch[1], patch, actor.role === "OWNER");
    } catch (error) {
      if (error instanceof OwnerTargetProtectedError) {
        return jsonResponse({ error: "owner_target_protected", message: error.message }, { status: 403 });
      }
      if (error instanceof UserMutationConflictError) {
        return jsonResponse({ error: "user_update_conflict", message: error.message }, { status: 409 });
      }
      throw error;
    }
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userMatch[1], summary: "Usuario actualizado", metadata: patch });
    return jsonResponse({ user: updated });
  }

  return notFound();
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
  try {
    const analytics = await computeAnalytics(repo, range, environment, now, {
      department: (code) => findCatalogOption(CAT012_DEPARTMENTS, code)?.label ?? code,
      country: (code) => findCatalogOption(CAT020_COUNTRIES, code)?.label ?? code
    });
    return jsonResponse({ analytics });
  } catch (error) {
    if (error instanceof AnalyticsCapacityError) {
      return jsonResponse(
        { error: error.code, message: error.message },
        { status: 422 }
      );
    }
    throw error;
  }
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
  const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { environment?: unknown };
  const environment = ambienteValue(body.environment);
  if (!environment) {
    return jsonResponse({ error: "invalid_emission_environment", message: "Seleccione Pruebas 00 o Producción 01." }, { status: 400 });
  }
  assertDeploymentAllowsAmbiente(env, environment);
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
  const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { templates?: unknown };
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
  const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { alertEmail?: unknown };
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
  const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { displayName?: unknown; accentColor?: unknown; supportEmail?: unknown };
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
  const bytes = await readBodyBytes(request, BRANDING_LOGO_MAX_BYTES);
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

async function activeEmissionEnvironment(repo: Repository, env: Env): Promise<Ambiente> {
  const policy = deploymentEnvironmentPolicy(env);
  if (!policy.allowedAmbiente) {
    throw new EnvironmentNotAllowedError("00", policy);
  }
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  return configured === policy.allowedAmbiente ? configured : policy.allowedAmbiente;
}

async function emissionEnvironmentState(repo: Repository, env: Env): Promise<{
  environment: Ambiente;
  source: "setting" | "deployment_default";
  appEnv: string;
  locked: true;
  allowedEnvironments: Ambiente[];
}> {
  const policy = deploymentEnvironmentPolicy(env);
  const configured = ambienteValue(await repo.getSetting(EMISSION_ENVIRONMENT_SETTING));
  const matchingSetting = configured !== null && configured === policy.allowedAmbiente;
  return {
    environment: policy.allowedAmbiente ?? "00",
    source: matchingSetting ? "setting" : "deployment_default",
    appEnv: policy.appEnv,
    locked: true,
    allowedEnvironments: policy.allowedAmbiente ? [policy.allowedAmbiente] : []
  };
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

function isRetryableDocument(document: Pick<DteDocumentRecord, "status" | "transmission_deferred_at" | "fiscal_operation_claim_id">): boolean {
  if (document.fiscal_operation_claim_id) {
    return false;
  }
  // Un CDE diferido (SIGNED + transmission_deferred_at) NO es reintetable manualmente:
  // el cron de 15 minutos es el único dueño del reintento, porque el camino manual
  // genérico no completa la intención ni envía el comprobante definitivo. Un SIGNED
  // "plano" (transitorio de pipeline atascado, sin marcador) sigue siendo reintetable
  // como siempre.
  if (document.status === "SIGNED" && document.transmission_deferred_at) {
    return false;
  }
  return ["SIGNED", "FAILED", "CONTINGENCY_PENDING"].includes(document.status);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizeResendRequestId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const requestId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
    ? requestId
    : null;
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

  const input = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as CredentialUpdateInput;
  if (input.environment !== "test" && input.environment !== "production") {
    return jsonResponse({ error: "invalid_credential_environment" }, { status: 400 });
  }
  assertDeploymentAllowsAmbiente(env, input.environment === "production" ? "01" : "00");
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
  const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { token?: unknown };
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

async function handleWompiFiscalCorrection(
  request: Request,
  env: Env,
  repo: Repository,
  actor: AuthUser,
  wompiEventId: string
): Promise<Response> {
  const parsed = await readFiscalCorrectionRequest(request);
  if (parsed instanceof Response) return parsed;

  const event = await repo.getWompiEventById(wompiEventId);
  if (!event) return notFound();
  const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
  if (!isApprovedDonation(payload)) {
    return fiscalCorrectionConflict(
      "payment_not_approved",
      "Solo un pago aprobado puede corregirse y reintentarse."
    );
  }
  if (
    event.created_document_id
    || event.issuance_claim_id
    || !["FAILED", "DEAD_LETTERED"].includes(event.issuance_status ?? "")
  ) {
    const existing = await existingFiscalCorrectionResponse(
      repo,
      parsed.requestId,
      "WOMPI_EVENT",
      wompiEventId,
      parsed.receptor
    );
    if (existing) return existing;
    return fiscalCorrectionConflict(
      "wompi_correction_not_available",
      "El evento Wompi ya no está disponible para una corrección."
    );
  }
  assertDeploymentAllowsAmbiente(env, event.environment);

  const beforeData = await effectiveWompiCorrectionData(repo, wompiEventId);
  if (!beforeData) return notFound();
  if (!beforeData.correctable) {
    return fiscalCorrectionNotAllowedResponse(beforeData.guidance);
  }
  const changedFields = fiscalCorrectionChangedFields(
    beforeData.receptor,
    parsed.receptor
  );
  if (changedFields.length === 0) return unchangedFiscalCorrectionResponse();

  const binding = await resolveDonationIntentBinding(repo, payload);
  const config = getEmisorConfig(env);
  buildCorrectedWompiCandidate({
    payload,
    intent: binding.kind === "bound" ? binding.intent : null,
    correction: parsed.receptor,
    config,
    environment: event.environment,
    sequence: event.control_sequence ?? 1,
    codigoGeneracion: event.reserved_codigo_generacion ?? undefined
  });

  const claim = await repo.claimWompiFiscalCorrection({
    wompiEventId,
    requestId: parsed.requestId,
    requestPayloadSha256: await fiscalCorrectionRequestDigest(parsed.receptor),
    environment: event.environment,
    beforeReceptorJson: fiscalCorrectionPayload(beforeData.receptor),
    correctedReceptorJson: fiscalCorrectionPayload(parsed.receptor),
    changedFieldsJson: JSON.stringify(changedFields),
    createdBy: actor.id
  });
  if (claim.kind === "conflict") return fiscalCorrectionRequestConflictResponse();
  if (claim.kind === "ineligible") {
    return fiscalCorrectionConflict(
      "wompi_correction_not_available",
      "El evento Wompi cambió mientras se procesaba la corrección."
    );
  }
  if (claim.kind === "duplicate") return duplicateFiscalCorrectionResponse(claim.correction);
  if (!claim.correction.issuance_attempt_id) {
    throw new Error("La corrección Wompi reclamada no tiene intento de emisión.");
  }
  await repo.createFiscalCorrectionAudit(claim.correction, "QUEUED", {
    type: "USER",
    id: actor.id
  });
  try {
    await env.ISSUANCE_QUEUE.send({
      wompiEventId,
      fiscalCorrectionId: claim.correction.id,
      fiscalCorrectionProcessingClaimId: claim.correction.processing_claim_id,
      issuanceAttemptId: claim.correction.issuance_attempt_id
    });
  } catch (error) {
    logWorkerError(env, "fiscal_correction_queue_failed", error);
    return fiscalCorrectionQueueFailedResponse();
  }
  return queuedFiscalCorrectionResponse(claim.correction.id);
}

async function handleDocumentFiscalCorrection(
  request: Request,
  env: Env,
  repo: Repository,
  actor: AuthUser,
  documentId: string
): Promise<Response> {
  const parsed = await readFiscalCorrectionRequest(request);
  if (parsed instanceof Response) return parsed;

  const document = await repo.getDteDocument(documentId);
  if (!document) return notFound();
  if (document.fiscal_operation_claim_id) {
    const existing = await existingFiscalCorrectionResponse(
      repo,
      parsed.requestId,
      "DTE_DOCUMENT",
      documentId,
      parsed.receptor
    );
    if (existing) return existing;
    return fiscalCorrectionConflict(
      "fiscal_outcome_pending_reconciliation",
      "El resultado fiscal está pendiente de conciliación."
    );
  }
  if (document.status !== "REJECTED") {
    const existing = await existingFiscalCorrectionResponse(
      repo,
      parsed.requestId,
      "DTE_DOCUMENT",
      documentId,
      parsed.receptor
    );
    if (existing) return existing;
    return fiscalCorrectionConflict(
      "document_correction_not_available",
      "Solo un CDE rechazado explícitamente puede corregirse."
    );
  }
  assertDeploymentAllowsAmbiente(env, document.environment);

  const beforeData = effectiveDocumentCorrectionData(document);
  if (!beforeData.correctable) {
    return fiscalCorrectionNotAllowedResponse(beforeData.guidance);
  }
  const changedFields = fiscalCorrectionChangedFields(
    beforeData.receptor,
    parsed.receptor
  );
  if (changedFields.length === 0) return unchangedFiscalCorrectionResponse();

  const config = getEmisorConfig(env);
  buildCorrectedDirectCandidate({
    sourceDocument: document,
    correction: parsed.receptor,
    config,
    sequence: 1
  });

  const claim = await repo.claimDocumentFiscalCorrection({
    documentId,
    requestId: parsed.requestId,
    requestPayloadSha256: await fiscalCorrectionRequestDigest(parsed.receptor),
    environment: document.environment,
    beforeReceptorJson: fiscalCorrectionPayload(beforeData.receptor),
    correctedReceptorJson: fiscalCorrectionPayload(parsed.receptor),
    changedFieldsJson: JSON.stringify(changedFields),
    createdBy: actor.id
  });
  if (claim.kind === "conflict") return fiscalCorrectionRequestConflictResponse();
  if (claim.kind === "ineligible") {
    return fiscalCorrectionConflict(
      "document_correction_not_available",
      "El CDE cambió mientras se procesaba la corrección."
    );
  }
  if (claim.kind === "duplicate") return duplicateFiscalCorrectionResponse(claim.correction);
  if (!claim.correction.fiscal_claim_id) {
    throw new Error("La corrección de CDE reclamada no tiene propiedad fiscal.");
  }
  await repo.createFiscalCorrectionAudit(claim.correction, "QUEUED", {
    type: "USER",
    id: actor.id
  });
  try {
    await env.ISSUANCE_QUEUE.send({
      advancedDocumentId: documentId,
      fiscalCorrectionId: claim.correction.id,
      fiscalCorrectionProcessingClaimId: claim.correction.processing_claim_id,
      fiscalClaimId: claim.correction.fiscal_claim_id
    });
  } catch (error) {
    logWorkerError(env, "fiscal_correction_queue_failed", error);
    return fiscalCorrectionQueueFailedResponse();
  }
  return queuedFiscalCorrectionResponse(claim.correction.id);
}

async function readFiscalCorrectionRequest(
  request: Request
): Promise<{
  requestId: string;
  receptor: FiscalReceptorCorrection;
} | Response> {
  const body = await readJsonObject(request, {
    limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES,
    malformed: "throw"
  });
  if (Object.keys(body).some((key) => !FISCAL_CORRECTION_REQUEST_KEYS.has(key))) {
    return jsonResponse(
      {
        error: "protected_field",
        message: "La solicitud contiene campos fiscales protegidos."
      },
      { status: 400 }
    );
  }
  const requestId = normalizeCorrectionRequestId(body.correctionRequestId);
  if (!requestId) {
    return jsonResponse(
      {
        error: "invalid_correction_request_id",
        message: "La corrección requiere un UUID único."
      },
      { status: 400 }
    );
  }
  if (!isRecord(body.receptor)) {
    return jsonResponse(
      {
        error: "invalid_correction",
        message: "receptor debe ser un objeto."
      },
      { status: 400 }
    );
  }
  try {
    return {
      requestId,
      receptor: validateFiscalReceptorCorrection(body.receptor)
    };
  } catch (error) {
    if (error instanceof FiscalCorrectionValidationError) {
      return jsonResponse(
        { error: error.code, message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}

function normalizeCorrectionRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const requestId = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)
    ? requestId
    : null;
}

async function fiscalCorrectionRequestDigest(
  correction: FiscalReceptorCorrection
): Promise<string> {
  return sha256Hex(utf8Bytes(fiscalCorrectionPayload(correction)));
}

function queuedFiscalCorrectionResponse(correctionId: string): Response {
  return jsonResponse(
    { ok: true, queued: true, correctionId, status: "QUEUED" },
    { status: 202 }
  );
}

function duplicateFiscalCorrectionResponse(
  correction: { id: string; status: string }
): Response {
  return jsonResponse({
    ok: true,
    queued: false,
    duplicate: true,
    correctionId: correction.id,
    status: correction.status
  });
}

function fiscalCorrectionRequestConflictResponse(): Response {
  return fiscalCorrectionConflict(
    "correction_request_conflict",
    "Este identificador de corrección ya pertenece a otra solicitud."
  );
}

async function existingFiscalCorrectionResponse(
  repo: Repository,
  requestId: string,
  targetKind: "WOMPI_EVENT" | "DTE_DOCUMENT",
  targetId: string,
  correction: FiscalReceptorCorrection
): Promise<Response | null> {
  const existing = await repo.getFiscalCorrectionByRequestId(requestId);
  if (!existing) return null;
  const existingTargetId = existing.target_kind === "WOMPI_EVENT"
    ? existing.wompi_event_id
    : existing.document_id;
  if (
    existing.target_kind !== targetKind
    || existingTargetId !== targetId
    || existing.corrected_receptor_json !== fiscalCorrectionPayload(correction)
  ) {
    return fiscalCorrectionRequestConflictResponse();
  }
  return duplicateFiscalCorrectionResponse(existing);
}

function unchangedFiscalCorrectionResponse(): Response {
  return jsonResponse(
    {
      error: "unchanged_correction",
      message: "La corrección no cambia ningún campo del receptor."
    },
    { status: 400 }
  );
}

function fiscalCorrectionConflict(error: string, message: string): Response {
  return jsonResponse({ error, message }, { status: 409 });
}

function fiscalCorrectionNotAllowedResponse(guidance: string | null): Response {
  return fiscalCorrectionConflict(
    "fiscal_correction_not_allowed",
    guidance ?? "Revise Configuración o solicite soporte técnico antes de volver a intentar."
  );
}

function fiscalCorrectionQueueFailedResponse(): Response {
  return jsonResponse(
    {
      error: "fiscal_correction_queue_failed",
      message: "La corrección quedó guardada y será reintentada automáticamente."
    },
    { status: 500 }
  );
}

async function handleDocumentRoute(
  request: Request,
  env: Env,
  repo: Repository,
  user: AuthUser | null,
  documentId: string,
  action?: string
): Promise<Response> {
  const mutationAction = action === "email" || action === "resend" || action === "retry" || action === "invalidate";
  const actor = requireRole(user, mutationAction ? "OPERATOR" : "VIEWER");
  const document = await repo.getDteDocument(documentId);
  if (!document) {
    return notFound();
  }

  if (!action && request.method === "GET") {
    // donorDataVerified: this CDE was produced from a completed donation-intent, so
    // the donor's data came from the validated /donar form rather than the raw webhook.
    const [completedIntent, receiptEmailDelivery, audit] = await Promise.all([
      repo.getCompletedIntentForDocument(document.id),
      repo.getLatestReceiptEmailDelivery(document.id),
      listAuditForUser(repo, actor, "dte_document", document.id)
    ]);
    return jsonResponse({
      document,
      donorDataVerified: completedIntent !== null,
      receiptEmailDelivery,
      audit
    });
  }

  if (action === "pdf" && request.method === "GET") {
    const pdf = await renderDtePdf(document);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.pdf"`
      }
    });
  }

  if (action === "json" && request.method === "GET") {
    return new Response(document.plain_json, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${document.codigo_generacion}.json"`
      }
    });
  }

  if (action === "email" && request.method === "PATCH") {
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as { email?: string };
    const email = normalizeEmail(body.email);
    if (!email) {
      return jsonResponse({ error: "invalid_email", message: "Ingrese un correo válido." }, { status: 400 });
    }
    if (!(await repo.updateDocumentDonorEmail(document.id, email))) {
      return jsonResponse(
        {
          error: "document_finalization_pending",
          message: "El comprobante aceptado está finalizando; vuelva a intentar la corrección de correo al terminar."
        },
        { status: 409 }
      );
    }
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "DTE_EMAIL_UPDATED",
      entityType: "dte_document",
      entityId: document.id,
      summary: "Correo de envío actualizado.",
      metadata: { changed: true }
    });
    return jsonResponse({ document: await repo.getDteDocument(document.id) });
  }

  if (action === "resend" && request.method === "POST") {
    if (document.status === "ACCEPTED" && !document.post_accept_finalized_at) {
      return jsonResponse(
        { error: "document_finalization_pending", message: "El comprobante aceptado aún está completando su registro y envío definitivo." },
        { status: 409 }
      );
    }
    if (document.fiscal_operation_claim_id) {
      return jsonResponse(
        {
          error: "fiscal_outcome_pending_reconciliation",
          message: "El resultado fiscal está pendiente de conciliación; no se puede reenviar un comprobante potencialmente incorrecto."
        },
        { status: 409 }
      );
    }
    const body = (await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as {
      email?: string;
      resendRequestId?: string;
    };
    const resendRequestId = normalizeResendRequestId(body.resendRequestId);
    if (!resendRequestId) {
      return jsonResponse(
        {
          error: "invalid_resend_request_id",
          message: "El reenvío requiere un identificador único generado por esta acción."
        },
        { status: 400 }
      );
    }
    const toEmail = normalizeEmail(body.email ?? document.donor_email);
    if (!toEmail) {
      return jsonResponse({ error: "missing_email", message: "Ingrese un correo válido." }, { status: 400 });
    }
    const emailType =
      document.status === "SIGNED" && document.transmission_deferred_at
        ? "dteReceiptTransitorio"
        : "dteReceipt";
    const claim = await repo.claimManualEmailDelivery({
      documentId: document.id,
      toEmail,
      emailType,
      documentStatusAtSend: document.status,
      resendRequestId
    });
    if (claim.kind === "already_sent") {
      return jsonResponse({ ok: true, duplicateSuppressed: true, attemptNo: claim.attemptNo });
    }
    if (claim.kind === "conflict") {
      return jsonResponse(
        {
          error: "resend_request_conflict",
          message: "Este identificador de reenvío ya pertenece a otra solicitud."
        },
        { status: 409 }
      );
    }
    if (claim.kind === "in_progress") {
      return jsonResponse(
        {
          error: "resend_in_progress",
          message: "Este reenvío ya está en curso.",
          attemptNo: claim.attemptNo
        },
        { status: 409 }
      );
    }
    if (claim.kind === "manual_review") {
      return jsonResponse(
        {
          error: "resend_requires_review",
          message: "El resultado anterior no permite reenviar automáticamente; requiere revisión manual.",
          outcomeClass: claim.outcomeClass,
          attemptNo: claim.attemptNo
        },
        { status: 409 }
      );
    }

    let providerDispatchStarted = false;
    let response: EmailDeliveryResult;
    try {
      const templates = parseEmailTemplates(await repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
      const branding = await loadEmailBranding(repo, env);
      response = await new EmailService(env, templates, branding).sendReceipt(
        document,
        toEmail,
        claim.idempotencyKey,
        async () => {
          const marked = await repo.markEmailDeliveryDispatchStarted(claim.id, claim.claimToken);
          if (!marked) {
            throw new Error("La reserva del reenvío perdió propiedad antes del envío");
          }
          providerDispatchStarted = true;
        }
      );
    } catch (error) {
      const failure = classifyEmailDispatchError(error, providerDispatchStarted);
      await repo.finalizeEmailDeliveryClaim(claim.id, claim.claimToken, {
        status: "FAILED",
        providerResponse: failure.providerResponse,
        emailType,
        documentStatusAtSend: document.status,
        outcomeClass: failure.outcomeClass,
        failureCode: failure.code,
        retrySafe: failure.retrySafe
      });
      await repo.createAudit({
        actorType: "USER",
        actorId: actor.id,
        action: "EMAIL_RESEND_FAILED",
        entityType: "dte_document",
        entityId: document.id,
        summary: failure.message,
        metadata: {
          resendRequestId,
          attemptNo: claim.attemptNo,
          outcomeClass: failure.outcomeClass,
          failureCode: failure.code
        }
      });
      await sendOperationalAlert(env, repo, {
        kind: "EMAIL_FAILED",
        title: "Fallo al reenviar comprobante",
        detail: `El comprobante ${document.numero_control} no pudo reenviarse: ${failure.message}`,
        entityType: "dte_document",
        entityId: document.id,
        incidentId: claim.claimToken
      });
      return jsonResponse(
        {
          error: "email_send_failed",
          message: failure.message,
          outcomeClass: failure.outcomeClass,
          manualReview: !failure.retrySafe,
          attemptNo: claim.attemptNo
        },
        { status: 502 }
      );
    }

    await repo.finalizeEmailDeliveryClaim(claim.id, claim.claimToken, {
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
    try {
      await repo.createAudit({
        actorType: "USER",
        actorId: actor.id,
        action: "EMAIL_RESENT",
        entityType: "dte_document",
        entityId: document.id,
        summary: "Comprobante reenviado al correo registrado.",
        metadata: {
          ...emailDeliveryAuditEvidence(response),
          resendRequestId,
          attemptNo: claim.attemptNo
        }
      });
    } catch (error) {
      // SENT is the side-effect authority. An audit failure must not permit another
      // provider dispatch when the browser repeats the same resend request.
      logWorkerError(env, "manual_receipt_resend_audit_failed", error);
    }
    return jsonResponse({ ok: true, duplicateSuppressed: false, attemptNo: claim.attemptNo });
  }

  if (action === "retry" && request.method === "POST") {
    if (document.fiscal_operation_claim_id) {
      return jsonResponse(
        {
          error: "fiscal_outcome_pending_reconciliation",
          message: "MH pudo haber procesado la operación. Concilie el resultado antes de cualquier reintento."
        },
        { status: 409 }
      );
    }
    if (document.status === "REJECTED") {
      return jsonResponse(
        {
          error: "document_correction_required",
          message: "Corrija los datos rechazados antes de crear un nuevo intento fiscal."
        },
        { status: 409 }
      );
    }
    if (!isRetryableDocument(document)) {
      return jsonResponse(
        {
          error: "document_not_retryable",
          message: "Este DTE no tiene fallos pendientes para reintentar."
        },
        { status: 409 }
      );
    }
    assertDeploymentAllowsAmbiente(env, document.environment);
    if (!document.signed_jws) {
      await env.ISSUANCE_QUEUE.send({ advancedDocumentId: document.id });
      await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRY_ENQUEUED", entityType: "dte_document", entityId: document.id, summary: "Reintento en cola" });
      return jsonResponse({ ok: true, queued: true });
    }
    const claimId = newId("fiscal");
    const claimed = await repo.claimDocumentTransmission(document.id, document.status, document.signed_jws, claimId);
    if (!claimed) {
      return jsonResponse(
        { error: "document_retry_in_progress", message: "Ya hay una operación fiscal en curso para este documento." },
        { status: 409 }
      );
    }
    // Once dispatch has started, a transport exception cannot prove that MH did
    // not accept the document. Keep the durable claim so another retry cannot
    // create a second fiscal side effect before reconciliation.
    let result;
    try {
      result = await new MhClient(env).transmitDte({
        ambiente: document.environment,
        version: 2,
        tipoDte: document.tipo_dte,
        codigoGeneracion: document.codigo_generacion,
        signedJws: document.signed_jws
      });
    } catch (error) {
      if (error instanceof MhPreDispatchError) {
        await repo.releaseDocumentFiscalOperation(document.id, claimId);
      }
      throw error;
    }
    const completed = await repo.completeDocumentTransmission(document.id, claimId, {
      status: result.accepted ? "ACCEPTED" : "REJECTED",
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null
    });
    if (!completed) {
      return jsonResponse(
        { error: "document_retry_in_progress", message: "La operación fiscal ya no pertenece a este reintento." },
        { status: 409 }
      );
    }
    await repo.createAudit({ actorType: "USER", actorId: actor.id, action: "DTE_RETRIED", entityType: "dte_document", entityId: document.id, summary: result.estado, metadata: result.raw });
    return jsonResponse({ ok: true, result });
  }

  if (action === "invalidate" && request.method === "POST") {
    if (document.fiscal_operation_claim_id) {
      return jsonResponse(
        {
          error: "fiscal_outcome_pending_reconciliation",
          message: "MH pudo haber procesado la operación. Concilie el resultado antes de otra invalidación."
        },
        { status: 409 }
      );
    }
    if (document.status !== "ACCEPTED" || !document.sello_recibido || !document.accepted_at) {
      return jsonResponse({ error: "document_not_accepted" }, { status: 409 });
    }
    const deadline = cdeInvalidationDeadline(document.accepted_at);
    if (!isWithinDeadline(deadline)) {
      return jsonResponse({ error: "outside_legal_window", deadline }, { status: 409 });
    }
    assertDeploymentAllowsAmbiente(env, document.environment);
    const body = await readJsonObject(request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" });
    if (Object.keys(body).some((key) => !INVALIDATION_REQUEST_KEYS.has(key))) {
      return jsonResponse({ error: "invalid_invalidation_input", message: "La solicitud contiene campos no permitidos" }, { status: 400 });
    }
    const requested = body as { tipoAnulacion?: 1 | 2 | 3; motivoAnulacion?: string; codigoGeneracionR?: string | null };
    if (requested.tipoAnulacion === 1 && !requested.codigoGeneracionR) {
      return jsonResponse({ error: "replacement_required_for_tipo_1" }, { status: 400 });
    }
    const config = getEmisorConfig(env);
    const input: InvalidationInput = {
      tipoAnulacion: requested.tipoAnulacion ?? 2,
      motivoAnulacion: requested.motivoAnulacion ?? "Invalidación solicitada por operador",
      nombreResponsable: config.responsable.nombre,
      tipDocResponsable: config.responsable.tipoDocumento,
      numDocResponsable: config.responsable.numeroDocumento,
      nombreSolicita: config.responsable.nombre,
      tipDocSolicita: config.responsable.tipoDocumento,
      numDocSolicita: config.responsable.numeroDocumento,
      codigoGeneracionR: requested.codigoGeneracionR ?? null
    };
    const eventDocument = buildInvalidacionEvent(document, config, input);
    const signedJws = await signMhDocument(eventDocument, getMhCertificateXml(env), requireSecret(env, "MH_CERT_PASSWORD"));
    const claimId = newId("fiscal");
    if (!(await repo.claimDocumentInvalidation(document.id, claimId))) {
      return jsonResponse(
        { error: "document_fiscal_operation_in_progress", message: "Ya hay una operación fiscal en curso para este documento." },
        { status: 409 }
      );
    }
    let eventId: string;
    try {
      eventId = await repo.createAndAttachDocumentInvalidationEvent({
        documentId: document.id,
        claimId,
        environment: document.environment,
        codigoGeneracion: (eventDocument.identificacion as { codigoGeneracion: string }).codigoGeneracion,
        plainJson: eventDocument,
        signedJws,
        legalDeadlineAt: deadline,
        createdBy: actor.id
      });
    } catch (error) {
      await repo.releaseDocumentFiscalOperation(document.id, claimId);
      throw error;
    }
    let result;
    try {
      result = await new MhClient(env).transmitInvalidacion({ ambiente: document.environment, version: 3, signedJws });
    } catch (error) {
      if (error instanceof MhPreDispatchError) {
        await repo.releaseDocumentInvalidationBeforeDispatch(document.id, claimId, eventId, error.message);
      }
      throw error;
    }
    const completed = await repo.completeDocumentInvalidation({
      documentId: document.id,
      claimId,
      eventId,
      accepted: result.accepted,
      sello: result.selloRecibido,
      mhEstado: result.estado,
      observaciones: result.observaciones,
      acceptedAt: result.accepted ? nowIso() : null,
      actorId: actor.id,
      raw: result.raw
    });
    if (!completed) {
      throw new Error("La invalidación no pudo completar atómicamente su evento y documento");
    }
    let emailSent = false;
    let emailError: string | undefined;
    if (result.accepted) {
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
            summary: "Aviso de invalidación enviado al correo registrado.",
            metadata: emailDeliveryAuditEvidence(emailResponse)
          });
          emailSent = true;
        } catch (error) {
          emailError = "No se pudo enviar el aviso de invalidación.";
          await repo.recordEmailDelivery({
            documentId: document.id,
            toEmail: invalidatedDocument.donor_email,
            status: "FAILED",
            providerResponse: { code: "EMAIL_INVALIDATION_SEND_FAILED" },
            emailType: "dteInvalidation",
            documentStatusAtSend: invalidatedDocument.status
          });
          await repo.createAudit({
            actorType: "USER",
            actorId: actor.id,
            action: "EMAIL_INVALIDATION_FAILED",
            entityType: "dte_document",
            entityId: document.id,
            summary: emailError,
            metadata: { failureCode: "EMAIL_INVALIDATION_SEND_FAILED" }
          });
        }
      }
    }
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

function isBootstrapOwnerTokenConfigured(env: Env): boolean {
  return BOOTSTRAP_TOKEN_PATTERN.test(env.BOOTSTRAP_OWNER_TOKEN?.trim() ?? "");
}

async function hasValidBootstrapOwnerToken(request: Request, env: Env): Promise<boolean> {
  const expected = env.BOOTSTRAP_OWNER_TOKEN?.trim() ?? "";
  const supplied = request.headers.get(BOOTSTRAP_OWNER_TOKEN_HEADER)?.trim() ?? "";
  return timingSafeEqual(await rateLimitKey(supplied), await rateLimitKey(expected));
}
