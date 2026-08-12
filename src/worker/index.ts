import { getEmisorConfig, getMhCertificateXml, isMockMode, requireSecret } from "./config";
import { buildAdvancedCdeDocument, buildDirectCdeDocument, buildInvalidacionEvent, cdeDocumentSummary, webhookDonorComplemento, type DirectCdeInput, type InvalidationInput } from "./domain/dteBuilder";
import { certificateExpiry, signMhDocument } from "./domain/signer";
import { ambienteFromWompi, isApprovedDonation, normalizeWompiWebhook, verifyWompiHash, WompiPayloadError, wompiHashHeader, wompiWebhookFromPaymentLink } from "./domain/wompi";
import { ALERT_EMAIL_SETTING_KEY, normalizeAlertRecipients, sendOperationalAlert } from "./services/alerts";
import { AuthError, AuthService, BootstrapUnavailableError, PASSWORD_RESET_TTL_MINUTES, PasswordPolicyError, PasswordResetError, requireRole, type AuthUser, type Role, UserNotFoundError } from "./services/auth";
import {
  CredentialWriterConfigError,
  StripeCredentialValidationError,
  bootstrapCloudflareWriterToken,
  buildCredentialSecretPatch,
  buildStripeCredentialSecretPatch,
  buildStripeWebhookCancellationPatch,
  buildStripeWebhookPromotionPatch,
  buildStripeWebhookStagePatch,
  credentialStatus,
  patchCloudflareWorkerSecrets,
  type CredentialUpdateInput,
  type StripeCredentialUpdateInput
} from "./services/credentials";
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
import {
  EMAIL_REPLY_TO_SETTING_KEY,
  EMAIL_SENDER_NAME_SETTING_KEY,
  EmailSenderValidationError,
  normalizeEmailReplyToAddress,
  normalizeEmailSenderName,
  resolveEmailReplyToAddress
} from "./services/emailSender";
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATES_SETTING_KEY, EmailTemplateValidationError, emailTemplateResponse, normalizeEmailTemplateSettings, parseEmailTemplates } from "./services/emailTemplates";
import { resolveDonationIntentBinding } from "./services/donationIntentBinding";
import { issuanceFailureEvidence } from "./services/issuanceFailure";
import { createStripeGateway, StripeWebhookSignatureError } from "./services/stripeClient";
import {
  StripeConfigurationError,
  StripeDonationValidationError,
  STRIPE_API_VERSION,
  buildStripeCheckoutSessionParams,
  integrationIdentifierForRequest,
  resolveStripeConfiguration,
  validateStripeCheckoutInput
} from "./services/stripeDonations";
import { processStripeWebhookEvent, StripeWebhookEventError } from "./services/stripeWebhook";
import { deliverNextStripeAcknowledgment } from "./services/stripeAcknowledgment";
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
import {
  buildAnnualCertificatePreview,
  CertificateDossierChangedError,
  CertificateDossierLimitError,
  certificateYearError,
  sendAnnualCertificates,
  SingleDonorSendError,
  type AnnualCertificateSendRequest
} from "./services/certificate";
import {
  buildStripeAnnualStatementPreview,
  sendStripeAnnualStatements,
  StripeAnnualStatementConfigurationError,
  StripeAnnualStatementSingleDonorError,
  stripeUsTimeZone,
  type StripeAnnualStatementSendRequest
} from "./services/stripeAnnualStatement";
import { AnalyticsCapacityError, computeAnalytics, elSalvadorRangeWindow, type AnalyticsRange } from "./services/analytics";
import { CAT012_DEPARTMENTS, CAT020_COUNTRIES, CAT022_DOCUMENT_TYPES, findCatalogOption } from "../shared/catalogs";
import { aggregateDonorContacts, buildContactsCsv, resolveContactColumns, contactsCsvFilename } from "./services/contacts";
import { buildDonorExplorerCsv, donorExplorerCsvFilename } from "./services/donorExport";
import { buildF960Csv, buildF960Selection, buildF960Xlsx, XLSX_MIME, type F960Selection } from "./services/f960";
import { MhClient, MhPreDispatchError } from "./services/mhClient";
import { IssuancePipeline } from "./services/pipeline";
import { loadPdfBrandingLogo, renderDtePdf } from "./services/pdf";
import { auditContextFrom } from "./services/requestContext";
import { projectAuditRows } from "./services/auditProjection";
import { BackupArchiveTooLargeError, BACKUP_MONTH_DOWNLOAD_MAX_BYTES, collectBackupMonthObjects, isManifestedBackupTable, listBackupMonths, verifyBackupMonth } from "./services/backups";
import { zipStored } from "./utils/zip";
import { previousElSalvadorMonth, retentionManifestKey, retentionTableKey, runRetentionExport } from "./services/retention";
import { WompiApiService } from "./services/wompiApi";
import {
  loadWompiNotificationSettings,
  normalizeWompiNotificationSettings,
  WOMPI_NOTIFICATION_EMAILS_SETTING_KEY,
  WOMPI_NOTIFICATION_PHONES_SETTING_KEY,
  WOMPI_NOTIFY_DONOR_EMAIL_SETTING_KEY,
  WompiNotificationValidationError
} from "./services/wompiNotifications";
import { isValidEmail } from "../shared/email";
import { elSalvadorDateOnly, formatElSalvadorDate } from "../shared/legalWindows";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection,
  type FiscalReceptorCorrection
} from "../shared/fiscalCorrection";
import {
  assertDirectCorrectionSourceTrusted,
  buildCorrectedDirectCandidate,
  buildCorrectedWompiCandidate,
  effectiveDocumentCorrectionData,
  effectiveWompiCorrectionData,
  requiresFiscalReceptorCorrection
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
import { isRecord, normalizeUuidV4 } from "./utils/guards";
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
import { dispatchRoutes, type Route, type RoutableContext } from "./routes/router";

const BOOTSTRAP_OWNER_TOKEN_HEADER = "X-Bootstrap-Owner-Token";
const EMISSION_ENVIRONMENT_SETTING = "emission_environment";
const RETENTION_EXPORT_CRON = "0 9 1 * *";
const CERT_EXPIRY_ALERT_THRESHOLD_DAYS = [30, 14, 3];
const WOMPI_RECONCILIATION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const WOMPI_RECONCILIATION_RECHECK_MS = 10 * 60 * 1000;
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
const STRIPE_WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;
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

function redirectToCanonicalDocument(env: Env, url: URL): Response | null {
  const canonicalOrigin = resolveAppOrigin(env, url);
  const documentOrigin = env.APP_ENV === "production" ? canonicalOrigin : url.origin;
  const shouldCanonicalizeOrigin =
    env.APP_ENV === "production" && url.origin !== canonicalOrigin;
  const isAdminPath = url.pathname === "/admin" || url.pathname.startsWith("/admin/");
  const isGraciasPath =
    url.pathname === "/donar/gracias" || url.pathname === "/donar/gracias/";
  const isStripeResultPath =
    url.pathname === "/donar/stripe/resultado" || url.pathname === "/donar/stripe/resultado/";

  if (shouldCanonicalizeOrigin) {
    const target = new URL(canonicalOrigin);
    if (isAdminPath || isGraciasPath || isStripeResultPath) {
      target.pathname = url.pathname;
      target.search = url.search;
    } else if (url.pathname === "/donar" || url.pathname === "/donar/") {
      target.search = url.search;
    }
    return Response.redirect(target.toString(), 302);
  }

  if (url.pathname === "/donar" || url.pathname === "/donar/") {
    const target = new URL(documentOrigin);
    target.search = url.search;
    return Response.redirect(target.toString(), 302);
  }

  if (
    url.pathname === "/" ||
    isAdminPath ||
    isGraciasPath ||
    isStripeResultPath ||
    url.pathname.startsWith("/assets/")
  ) {
    return null;
  }

  return Response.redirect(`${documentOrigin}/`, 302);
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

const DONOR_DOCUMENT_PATHS = new Set([
  "/",
  "/donar",
  "/donar/",
  "/donar/gracias",
  "/donar/gracias/"
]);

function emergencyDonationShutdownResponse(request: Request, env: Env, url: URL): Response | null {
  if (env.DONATION_INTAKE_DISABLED !== "true") {
    return null;
  }
  if (
    request.method === "POST" &&
    (
      url.pathname === "/api/donations/intent"
      || url.pathname.startsWith("/api/donations/intent/")
      || url.pathname === "/api/donations/stripe/checkout"
    )
  ) {
    return jsonResponse(
      { error: "donation_intake_disabled" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!DONOR_DOCUMENT_PATHS.has(url.pathname)) {
    return null;
  }
  return new Response(null, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const shutdownResponse = emergencyDonationShutdownResponse(request, env, url);
      if (shutdownResponse) {
        return shutdownResponse;
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, ctx);
      }
      if (url.pathname === "/webhooks/wompi") {
        return await handleWompiWebhook(request, env);
      }
      if (url.pathname === "/webhooks/stripe") {
        return await handleStripeWebhook(request, env, ctx);
      }
      const documentRedirect = redirectToCanonicalDocument(env, url);
      if (documentRedirect) {
        return documentRedirect;
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
    if (!correction || !ownsCorrection) {
      message.ack();
      return;
    }
    if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
      try {
        await repo.reconcileFiscalCorrectionAudits(correction);
        message.ack();
      } catch (auditError) {
        logWorkerError(env, "fiscal_correction_audit_reconciliation_failed", auditError);
        message.retry();
      }
      return;
    }
    if (
      correction.status === "QUEUED"
      || correction.status === "PROCESSING"
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
  if (env.STRIPE_MOCK_MODE === "1" || env.STRIPE_RESTRICTED_KEY?.trim()) {
    try {
      for (let processed = 0; processed < 25; processed += 1) {
        const result = await deliverNextStripeAcknowledgment(env, repo);
        if (!result.processed) break;
      }
    } catch (error) {
      logWorkerError(env, "stripe_acknowledgment_sweep_failed", error);
    }
  }
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
  const wompi = new WompiApiService(env);
  try {
    await reconcileMissingWompiCallbacks(env, repo, wompi, event.scheduledTime ?? Date.now());
  } catch (error) {
    logWorkerError(env, "wompi_payment_link_reconciliation_failed", error);
  }
  try {
    // Process a bounded page per tick: snapshot the capped set of expiring intents,
    // then expire exactly that page by id, so public intent creation cannot force one
    // cron invocation to snapshot or deactivate an unbounded row set. The remainder
    // is picked up by the next tick.
    const expiring = await repo.listIntentsExpiringBefore(now);
    await repo.expireDonationIntentsByIds(expiring.map((intent) => intent.id), now);
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
  const pipeline = new IssuancePipeline(env);
  for (const message of batch.messages) {
    if (message.body.fiscalCorrectionId) {
      await handleFiscalCorrectionDeadLetterMessage(message, pipeline, repo);
      continue;
    }
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

async function handleFiscalCorrectionDeadLetterMessage(
  message: Message<IssuanceMessage>,
  pipeline: IssuancePipeline,
  repo: Repository
): Promise<void> {
  const correctionId = message.body.fiscalCorrectionId;
  const processingClaimId = message.body.fiscalCorrectionProcessingClaimId;
  const issuanceAttemptId = message.body.issuanceAttemptId;
  const fiscalClaimId = message.body.fiscalClaimId;
  if (
    !correctionId
    || !processingClaimId
    || Boolean(issuanceAttemptId) === Boolean(fiscalClaimId)
  ) {
    message.ack();
    return;
  }
  const correction = await repo.getFiscalCorrection(correctionId);
  const ownsCorrection = Boolean(
    correction
    && correction.processing_claim_id === processingClaimId
    && correction.issuance_attempt_id === (issuanceAttemptId ?? null)
    && correction.fiscal_claim_id === (fiscalClaimId ?? null)
    && (
      correction.target_kind === "WOMPI_EVENT"
        ? (
            message.body.wompiEventId === correction.wompi_event_id
            && message.body.advancedDocumentId === undefined
          )
        : (
            message.body.advancedDocumentId === correction.document_id
            && message.body.wompiEventId === undefined
          )
    )
  );
  if (!correction || !ownsCorrection) {
    message.ack();
    return;
  }
  if (["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
    await repo.reconcileFiscalCorrectionAudits(correction);
    message.ack();
    return;
  }
  if (
    correction.status === "PROCESSING"
    && correction.mh_dispatch_started_at !== null
  ) {
    await pipeline.processFiscalCorrection(correction.id, {
      processingClaimId,
      ...(issuanceAttemptId ? { issuanceAttemptId } : {}),
      ...(fiscalClaimId ? { fiscalClaimId } : {})
    });
    message.ack();
    return;
  }
  if (
    correction.mh_dispatch_started_at === null
    && (correction.status === "QUEUED" || correction.status === "PROCESSING")
  ) {
    // Leave proven pre-dispatch work under its current correction ownership.
    // The scheduled stale-correction sweep can rotate that ownership and requeue
    // it safely; the ordinary DLQ path must not dead-letter the backing Wompi event.
    await repo.reconcileFiscalCorrectionAudits(correction);
  }
  message.ack();
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
  const headers = Object.fromEntries([...request.headers.entries()].filter(([key]) => key.toLowerCase() !== "authorization"));
  const ingested = await ingestTrustedWompiPayload(env, repo, payload, rawBody, headers, {
    insertedAction: "WOMPI_RECEIVED",
    duplicateAction: "WOMPI_DUPLICATE"
  });
  return jsonResponse({
    ok: true,
    wompiEventId: ingested.wompiEventId,
    inserted: ingested.inserted,
    queued: ingested.queued
  }, { status: ingested.inserted ? 202 : 200 });
}

async function handleStripeWebhook(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  const signature = request.headers.get("stripe-signature")?.trim();
  if (!signature) {
    return jsonResponse({ error: "invalid_stripe_signature" }, { status: 400 });
  }
  let configuration;
  try {
    configuration = resolveStripeConfiguration(env);
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return jsonResponse({ error: "stripe_webhook_unavailable" }, { status: 503 });
    }
    throw error;
  }
  const rawBody = await readBodyText(request, STRIPE_WEBHOOK_BODY_LIMIT_BYTES);
  let event;
  try {
    event = await createStripeGateway(configuration).constructWebhookEvent(rawBody, signature);
  } catch (error) {
    if (error instanceof StripeWebhookSignatureError) {
      return jsonResponse({ error: "invalid_stripe_signature" }, { status: 400 });
    }
    throw error;
  }
  if (
    event.livemode !== configuration.livemode
    || event.api_version !== STRIPE_API_VERSION
    || !/^evt_[A-Za-z0-9_-]{4,250}$/.test(event.id)
  ) {
    return jsonResponse({ error: "invalid_stripe_event_context" }, { status: 400 });
  }

  const repo = new Repository(env.DB, auditContextFrom(request));
  const claimId = newId("stripe_event_claim");
  const claimed = await repo.claimStripeWebhookEvent({
    eventId: event.id,
    eventType: event.type,
    livemode: event.livemode,
    claimId,
    now: nowIso()
  });
  if (claimed.kind === "DUPLICATE") {
    return jsonResponse({ received: true });
  }
  if (claimed.kind === "BUSY") {
    return jsonResponse({ error: "stripe_event_in_progress" }, { status: 409 });
  }
  if (claimed.kind === "CONFLICT") {
    return jsonResponse({ error: "stripe_event_conflict" }, { status: 400 });
  }

  try {
    await processStripeWebhookEvent(repo, event, nowIso());
    const finalized = await repo.finalizeStripeWebhookEvent({
      eventId: event.id,
      claimId,
      outcome: "PROCESSED",
      now: nowIso()
    });
    if (!finalized) {
      throw new StripeWebhookEventError("event_claim_lost");
    }
    const acknowledgmentTask = deliverNextStripeAcknowledgment(env, repo)
      .catch((error) => logWorkerError(env, "stripe_acknowledgment_delivery_failed", error));
    if (executionContext) {
      executionContext.waitUntil(acknowledgmentTask);
    } else {
      await acknowledgmentTask;
    }
    return jsonResponse({ received: true });
  } catch (error) {
    await repo.finalizeStripeWebhookEvent({
      eventId: event.id,
      claimId,
      outcome: "FAILED",
      failureCode: error instanceof StripeWebhookEventError
        ? error.code
        : "stripe_event_processing_failed",
      now: nowIso()
    });
    logWorkerError(env, "stripe_webhook_processing_failed", error);
    return jsonResponse({ error: "stripe_event_processing_failed" }, { status: 500 });
  }
}

interface TrustedWompiIngestionSource {
  insertedAction: string;
  duplicateAction?: string;
  auditMetadata?: Record<string, unknown>;
}

async function ingestTrustedWompiPayload(
  env: Env,
  repo: Repository,
  payload: WompiWebhook,
  rawBody: string,
  headers: Record<string, string>,
  source: TrustedWompiIngestionSource
): Promise<{
  wompiEventId: string;
  inserted: boolean;
  queued: boolean;
  environmentAllowed: boolean;
}> {
  // The signed webhook or authenticated payment-link response remains the event's
  // fiscal environment, but the deployment capability decides whether this Worker
  // may issue it. Incompatible events are retained as evidence and quarantined.
  const environment = ambienteFromWompi(payload);
  const policy = deploymentEnvironmentPolicy(env);
  const environmentAllowed = policy.allowedAmbiente === environment;
  const { record, inserted } = await repo.insertWompiEvent(payload, rawBody, headers, environment);
  const action = inserted ? source.insertedAction : source.duplicateAction;
  if (action) {
    await repo.createAudit({
      action,
      entityType: "wompi_event",
      entityId: record.id,
      summary: `${payload.IdTransaccion} ${payload.ResultadoTransaccion}`,
      metadata: source.auditMetadata
    });
  }
  if (inserted && !environmentAllowed) {
    await repo.createAudit({
      action: "WOMPI_ENVIRONMENT_MISMATCH",
      entityType: "wompi_event",
      entityId: record.id,
      summary: `El evento Wompi declara ambiente ${environment}, incompatible con este despliegue; queda en cuarentena`,
      metadata: {
        payloadEnvironment: environment,
        activeEnvironment: policy.allowedAmbiente,
        ...source.auditMetadata
      }
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
  if (environmentAllowed && isApprovedDonation(payload)) {
    // Claim on duplicates too. If a previous delivery inserted the event but failed
    // before queueing it, the CAS repairs that gap; an already-queued event returns null.
    const attemptId = await repo.claimInitialWompiIssuanceAttempt(record.id);
    if (attemptId) {
      await env.ISSUANCE_QUEUE.send({ wompiEventId: record.id, issuanceAttemptId: attemptId });
      queued = true;
    }
  }
  return {
    wompiEventId: record.id,
    inserted,
    queued,
    environmentAllowed
  };
}

async function reconcileMissingWompiCallbacks(
  env: Env,
  repo: Repository,
  wompi: WompiApiService,
  scheduledTime: number
): Promise<void> {
  if (isMockMode(env)) {
    return;
  }
  const checkedAt = new Date(scheduledTime).toISOString();
  const createdAfter = new Date(scheduledTime - WOMPI_RECONCILIATION_LOOKBACK_MS).toISOString();
  const checkedBefore = new Date(scheduledTime - WOMPI_RECONCILIATION_RECHECK_MS).toISOString();
  const candidates = await repo.listIntentsForWompiReconciliation(createdAfter, checkedBefore);

  for (const intent of candidates) {
    if (intent.wompi_id_enlace === null) {
      continue;
    }
    try {
      const link = await wompi.getPaymentLink(intent.wompi_id_enlace);
      const payload = wompiWebhookFromPaymentLink(intent, link);
      if (!payload) {
        await repo.touchIntentWompiReconciliationCheck(
          intent.id,
          intent.wompi_id_enlace,
          intent.updated_at,
          checkedAt
        );
        continue;
      }
      const ingested = await ingestTrustedWompiPayload(
        env,
        repo,
        payload,
        JSON.stringify(payload),
        { "x-wompi-event-source": "payment-link-reconciliation" },
        {
          insertedAction: "WOMPI_RECONCILED",
          auditMetadata: {
            source: "payment_link_api",
            paymentLinkId: intent.wompi_id_enlace
          }
        }
      );
      if (!ingested.environmentAllowed) {
        await repo.touchIntentWompiReconciliationCheck(
          intent.id,
          intent.wompi_id_enlace,
          intent.updated_at,
          checkedAt
        );
      }
    } catch (error) {
      if (error instanceof WompiPayloadError) {
        try {
          await repo.createAuditIfAbsent({
            action: "WOMPI_RECONCILIATION_REJECTED",
            entityType: "donation_intent",
            entityId: intent.id,
            summary: "La respuesta del enlace Wompi no superó la correlación estricta",
            metadata: {
              paymentLinkId: intent.wompi_id_enlace,
              reason: error.message
            }
          });
          await repo.touchIntentWompiReconciliationCheck(
            intent.id,
            intent.wompi_id_enlace,
            intent.updated_at,
            checkedAt
          );
        } catch (repositoryError) {
          logWorkerError(env, "wompi_payment_link_reconciliation_failed", repositoryError);
        }
        continue;
      }
      // Network/API failures remain eligible for the next cron tick; do not move
      // updated_at when Wompi itself could not answer.
      logWorkerError(env, "wompi_payment_link_reconciliation_failed", error);
    }
  }
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
    // Wompi's sheet is now the only source for phone and address, so persist both here
    // (normalized on this side of the boundary — the repository stays payload-agnostic).
    await repo.markIntentPaid(
      binding.intent.id,
      binding.intent.wompi_id_enlace,
      payload.Cliente?.Celular?.trim() || null,
      webhookDonorComplemento(payload)
    );
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

  const link = `${resolveAppOrigin(env, url)}/admin#reset=${created.token}`;
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

interface ApiRouteContext extends RoutableContext {
  env: Env;
  repo: Repository;
  auth: AuthService;
  url: URL;
  executionContext?: ExecutionContext;
}

async function handleHealth(ctx: ApiRouteContext): Promise<Response> {
  return jsonResponse({ ok: true, appEnv: ctx.env.APP_ENV ?? "unknown", now: nowIso() });
}

async function handleBootstrapStatus(ctx: ApiRouteContext): Promise<Response> {
  const hasNoUsers = (await ctx.repo.countUsers()) === 0;
  return jsonResponse({ bootstrapAvailable: isBootstrapOwnerTokenConfigured(ctx.env) && hasNoUsers });
}

// Public branding read: the login screen needs the display name, accent color, and
// logo version BEFORE any session exists, so these two routes are unauthenticated.
async function handlePublicBranding(ctx: ApiRouteContext): Promise<Response> {
  return handlePublicBrandingRoute(ctx.repo);
}

async function handleAdminBrandingLogo(ctx: ApiRouteContext): Promise<Response> {
  return handleBrandingLogoStream(ctx.env, ctx.repo, ADMIN_EMAIL_LOGO_SLOT);
}

async function handleDonorBrandingLogo(ctx: ApiRouteContext): Promise<Response> {
  return handleBrandingLogoStream(ctx.env, ctx.repo, DONOR_LOGO_SLOT);
}

// Public donor checkout: unauthenticated, runs before any role check. A body with
// only { amount, giftType } is a DRAFT create (the wizard mints the Wompi link in the
// background on Paso 1→2); a body carrying donor data is a full create (the fallback
// when no usable premint draft exists). Both mint the link identically.
async function handleCreateDonationIntent(ctx: ApiRouteContext): Promise<Response> {
  const rejected = rejectUnsafePublicDonationMutation(ctx.request, ctx.url);
  if (rejected) return rejected;
  assertDeploymentCanCollectPayments(ctx.env);
  const clientIp = clientIpFrom(ctx.request);
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" });
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
  const rateLimitClaimId = await ctx.repo.claimDonationIntentRateLimit(
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
      ? await createDraftDonationIntent(ctx.env, ctx.repo, input as ReturnType<typeof validateDraftIntentInput>, clientIp, rateLimitClaimId)
      : await createDonationIntent(ctx.env, ctx.repo, input as ReturnType<typeof validateIntentInput>, clientIp, rateLimitClaimId);
    return jsonResponse(created, { status: 201 });
  } catch (error) {
    if (error instanceof IntentLinkError) {
      // Intent stays PENDING and expires harmlessly on the cron sweep.
      return jsonResponse({ error: "wompi_link_failed", message: "No se pudo generar el enlace de pago. Intente de nuevo en unos minutos." }, { status: 502 });
    }
    throw error;
  }
}

async function handleCreateStripeCheckout(ctx: ApiRouteContext): Promise<Response> {
  const rejected = rejectUnsafePublicDonationMutation(ctx.request, ctx.url);
  if (rejected) return rejected;
  assertDeploymentCanCollectPayments(ctx.env);

  let input;
  try {
    input = validateStripeCheckoutInput(await readJsonObject(ctx.request, {
      limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES,
      malformed: "empty-object"
    }));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return donationBodyTooLargeResponse();
    }
    if (error instanceof StripeDonationValidationError) {
      return jsonResponse({ error: error.code, message: error.message }, { status: 400 });
    }
    throw error;
  }

  let stripeConfiguration;
  try {
    stripeConfiguration = resolveStripeConfiguration(ctx.env);
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return jsonResponse(
        { error: "stripe_unavailable", message: "La entrega por Stripe no está disponible en este momento." },
        { status: 503 }
      );
    }
    throw error;
  }

  const fingerprint = `${input.frequency.toLowerCase()}:${input.giftType.toLowerCase()}:${input.amountCents}`;
  const existing = await ctx.repo.getStripeCheckoutByRequestId(input.requestId);
  let checkout: import("./storage/repository").StripeCheckoutRecord;
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) {
      return stripeCheckoutConflictResponse();
    }
    if (existing.status !== "FAILED" && existing.status !== "CREATING") {
      return existingStripeCheckoutResponse(existing, stripeConfiguration);
    }
    const reclaimed = await ctx.repo.reclaimStripeCheckoutCreation({
      id: existing.id,
      now: nowIso()
    });
    if (!reclaimed) {
      return existingStripeCheckoutResponse(existing, stripeConfiguration);
    }
    checkout = reclaimed;
  } else {
    const clientIp = clientIpFrom(ctx.request);
    const claimNow = nowIso();
    const rateLimitClaimId = await ctx.repo.claimDonationIntentRateLimit(
      await rateLimitKey(clientIp),
      clientIp,
      claimNow,
      intentThrottleSinceIso(),
      intentThrottleExpiresIso(),
      INTENT_THROTTLE_LIMIT
    );
    if (!rateLimitClaimId) {
      return jsonResponse(
        { error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." },
        { status: 429 }
      );
    }

    const reservation = await ctx.repo.reserveStripeCheckout({
      id: newId("stripe_checkout"),
      requestId: input.requestId,
      requestFingerprint: fingerprint,
      frequency: input.frequency,
      giftType: input.giftType,
      amountCents: input.amountCents,
      livemode: stripeConfiguration.livemode,
      rateLimitClaimId,
      now: claimNow
    });
    if (reservation.kind === "CONFLICT") {
      return stripeCheckoutConflictResponse();
    }
    if (reservation.kind === "EXISTING") {
      return existingStripeCheckoutResponse(reservation.record, stripeConfiguration);
    }
    checkout = reservation.record;
  }

  const organizationName = parseBrandingSettings(
    await ctx.repo.getSetting(BRANDING_DISPLAY_NAME_SETTING_KEY),
    null,
    null
  ).displayName;
  const gateway = createStripeGateway(stripeConfiguration);
  try {
    const session = await gateway.createCheckoutSession(
      buildStripeCheckoutSessionParams({
        checkoutId: checkout.id,
        requestId: input.requestId,
        amountCents: input.amountCents,
        frequency: input.frequency,
        giftType: input.giftType,
        organizationName,
        appOrigin: resolveAppOrigin(ctx.env, ctx.url),
        paymentMethodConfigurationId: stripeConfiguration.paymentMethodConfigurationId,
        integrationIdentifier: await integrationIdentifierForRequest(input.requestId)
      }),
      `stripe-checkout:${input.requestId}`
    );
    assertCreatedStripeCheckout(session, checkout);
    const completed = await ctx.repo.completeStripeCheckoutCreation({
      id: checkout.id,
      stripeSessionId: session.id,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      now: nowIso()
    });
    if (!completed || !session.clientSecret) {
      throw new Error("Stripe Checkout reservation lost before finalization");
    }
    return jsonResponse(
      {
        sessionId: session.id,
        clientSecret: session.clientSecret,
        publishableKey: stripeConfiguration.publishableKey,
        mock: stripeConfiguration.mock
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await ctx.repo.failStripeCheckoutCreation({
      id: checkout.id,
      errorCode: "stripe_checkout_create_failed",
      now: nowIso()
    });
    logWorkerError(ctx.env, "stripe_checkout_create_failed", error);
    return jsonResponse(
      { error: "stripe_checkout_failed", message: "No pudimos preparar su entrega con Stripe. Inténtelo de nuevo." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function existingStripeCheckoutResponse(
  checkout: import("./storage/repository").StripeCheckoutRecord,
  configuration: ReturnType<typeof resolveStripeConfiguration>
): Promise<Response> {
  if (checkout.status === "CREATING") {
    return jsonResponse(
      { error: "stripe_checkout_in_progress", message: "Su entrega se está preparando. Inténtelo de nuevo en un momento." },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (checkout.status !== "OPEN" || !checkout.stripe_session_id) {
    return jsonResponse(
      { error: "stripe_checkout_unavailable", message: "Inicie una nueva entrega para continuar con Stripe." },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  try {
    const session = await createStripeGateway(configuration)
      .retrieveCheckoutSession(checkout.stripe_session_id);
    assertStripeEmbeddedSession(session);
    return jsonResponse(
      {
        sessionId: session.id,
        clientSecret: session.clientSecret,
        publishableKey: configuration.publishableKey,
        mock: configuration.mock
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return jsonResponse(
      { error: "stripe_checkout_unavailable", message: "No pudimos recuperar su entrega con Stripe. Inténtelo de nuevo." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function stripeCheckoutConflictResponse(): Response {
  return jsonResponse(
    {
      error: "stripe_checkout_request_conflict",
      message: "Esta solicitud ya corresponde a otra entrega. Inicie una nueva entrega para continuar."
    },
    { status: 409, headers: { "Cache-Control": "no-store" } }
  );
}

function assertCreatedStripeCheckout(
  session: import("./services/stripeClient").StripeCheckoutSnapshot,
  checkout: import("./storage/repository").StripeCheckoutRecord
): void {
  const expectedMode = checkout.frequency === "MONTHLY" ? "subscription" : "payment";
  if (
    session.livemode !== Boolean(checkout.livemode)
    || session.mode !== expectedMode
    || session.amountTotal !== checkout.amount_cents
    || session.currency !== "usd"
    || session.metadata.checkout_id !== checkout.id
    || session.metadata.lane !== "eeuu_501c3"
    || session.metadata.gift_type !== (checkout.gift_type === "TITHE" ? "tithe" : "offering")
  ) {
    throw new Error("Stripe Checkout response did not match the reserved donation");
  }
  assertStripeEmbeddedSession(session);
}

function assertStripeEmbeddedSession(
  session: import("./services/stripeClient").StripeCheckoutSnapshot
): asserts session is import("./services/stripeClient").StripeCheckoutSnapshot & { clientSecret: string } {
  if (session.url !== null || !session.clientSecret || !session.clientSecret.startsWith(`${session.id}_secret_`)) {
    throw new Error("Stripe Embedded Checkout Session client secret was rejected");
  }
}

function assertStripeHostedUrl(
  raw: string | null,
  kind: "checkout" | "billing",
  mock: boolean
): asserts raw is string {
  if (!raw) throw new Error("Stripe hosted URL is missing");
  const parsed = new URL(raw);
  const expectedHost = kind === "checkout"
    ? (mock ? "checkout.stripe.test" : "checkout.stripe.com")
    : (mock ? "billing.stripe.test" : "billing.stripe.com");
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== expectedHost
    || parsed.username
    || parsed.password
    || parsed.port
  ) {
    throw new Error("Stripe hosted URL was rejected");
  }
}

async function handleStripeCheckoutStatus(ctx: ApiRouteContext): Promise<Response> {
  const sessionId = ctx.params[0];
  if (!/^cs_(?:test|live)_[A-Za-z0-9_-]{8,200}$/.test(sessionId)) {
    return jsonResponse({ error: "stripe_session_not_found" }, { status: 404 });
  }
  const checkout = await ctx.repo.getStripeCheckoutBySessionId(sessionId);
  if (!checkout) {
    return jsonResponse({ error: "stripe_session_not_found" }, { status: 404 });
  }
  const status = checkout.status === "COMPLETE" && checkout.payment_status === "PAID"
    ? "PAID"
    : checkout.status === "COMPLETE"
      ? "PENDING"
      : checkout.status;
  const canManageRecurring = checkout.frequency === "MONTHLY"
    && checkout.payment_status === "PAID"
    && Boolean(checkout.stripe_customer_id)
    && checkout.subscription_status !== "CANCELED";
  return jsonResponse({
    status,
    frequency: checkout.frequency,
    giftType: checkout.gift_type,
    amountCents: checkout.amount_cents,
    currency: checkout.currency,
    canManageRecurring,
    recurringStatus: checkout.subscription_status
  }, { headers: { "Cache-Control": "no-store" } });
}

async function handleStripePortal(ctx: ApiRouteContext): Promise<Response> {
  const rejected = rejectUnsafePublicDonationMutation(ctx.request, ctx.url);
  if (rejected) return rejected;
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(ctx.request, {
      limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES,
      malformed: "empty-object"
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return donationBodyTooLargeResponse();
    }
    throw error;
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!/^cs_(?:test|live)_[A-Za-z0-9_-]{8,200}$/.test(sessionId)) {
    return jsonResponse({ error: "stripe_session_not_found" }, { status: 404 });
  }
  const checkout = await ctx.repo.getStripeCheckoutBySessionId(sessionId);
  if (
    !checkout
    || checkout.frequency !== "MONTHLY"
    || checkout.payment_status !== "PAID"
    || !checkout.stripe_customer_id
  ) {
    return jsonResponse(
      { error: "stripe_portal_unavailable", message: "La administración de su entrega mensual aún no está disponible." },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    );
  }
  let configuration;
  try {
    configuration = resolveStripeConfiguration(ctx.env);
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return jsonResponse({ error: "stripe_portal_unavailable" }, { status: 503 });
    }
    throw error;
  }
  try {
    const portal = await createStripeGateway(configuration).createBillingPortalSession({
      customerId: checkout.stripe_customer_id,
      configurationId: configuration.billingPortalConfigurationId,
      returnUrl: `${resolveAppOrigin(ctx.env, ctx.url)}/donar/stripe/resultado?session_id=${encodeURIComponent(sessionId)}`
    });
    assertStripeHostedUrl(portal.url, "billing", configuration.mock);
    return jsonResponse(portal, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logWorkerError(ctx.env, "stripe_portal_create_failed", error);
    return jsonResponse(
      { error: "stripe_portal_unavailable", message: "No pudimos abrir la administración de su entrega mensual." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Public datos completion: attaches the donor's fiscal data to a minted draft with a
// fast D1-only call (no Wompi). Its dedicated per-IP budget counts every attempt,
// including malformed bodies and failed capability guesses.
async function handleDonationIntentDatos(ctx: ApiRouteContext): Promise<Response> {
  const clientIp = clientIpFrom(ctx.request);
  const claimNow = nowIso();
  const rateLimitClaimId = await ctx.repo.claimDonationDatosRateLimit(
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
    const body = await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" });
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
      ctx.repo,
      ctx.params[0],
      ctx.request.headers.get("X-Donation-Datos-Token") ?? "",
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

async function handleDonationIntentStatus(ctx: ApiRouteContext): Promise<Response> {
  const intent = await ctx.repo.getDonationIntent(ctx.params[0]);
  if (!intent) {
    // Enumeration-safe: unknown ids get the same shape a foreign id would.
    return jsonResponse({ error: "intent_not_found" }, { status: 404 });
  }
  // status stays for backward compatibility (COMPLETED = CDE accepted by MH). paid
  // reflects the payment marker (paid_at), so the donor's wizard can show "thanks" the
  // moment Wompi confirms the payment, without waiting on MH acceptance.
  return jsonResponse({ status: intent.status, paid: intent.paid_at != null });
}

async function handleBootstrapOwner(ctx: ApiRouteContext): Promise<Response> {
  if (!isBootstrapOwnerTokenConfigured(ctx.env)) {
    return jsonResponse({ error: "bootstrap_configuration_invalid" }, { status: 503 });
  }
  const claimNow = nowIso();
  const accepted = await ctx.repo.claimLoginAttempt(
    await rateLimitKey(`bootstrap-owner:${clientIpFrom(ctx.request)}`),
    claimNow,
    authThrottleSinceIso(),
    authThrottleExpiresIso(),
    BOOTSTRAP_ATTEMPT_LIMIT
  );
  if (!accepted) {
    return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
  }
  if (!(await hasValidBootstrapOwnerToken(ctx.request, ctx.env))) {
    return jsonResponse({ error: "bootstrap_token_required" }, { status: 403 });
  }
  const body = (await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as { email: string; name: string; password: string };
  let owner;
  try {
    owner = await ctx.auth.bootstrapOwner(body);
  } catch (error) {
    if (error instanceof BootstrapUnavailableError) {
      return jsonResponse({ error: "bootstrap_unavailable", message: error.message }, { status: 409 });
    }
    // The operator's likeliest mistake here is a password that misses one policy rule.
    // Re-throwing turned that into an opaque 500 with nothing to act on; mirror the
    // mapping the user-create and password-reset routes already use.
    if (error instanceof PasswordPolicyError) {
      return jsonResponse({ error: "weak_password", message: error.message }, { status: 400 });
    }
    throw error;
  }
  await ctx.repo.createAudit({ action: "OWNER_BOOTSTRAPPED", entityType: "user", entityId: owner.id, summary: owner.email });
  return jsonResponse({ user: owner }, { status: 201 });
}

async function handleLogin(ctx: ApiRouteContext): Promise<Response> {
  const body = (await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as { email: string; password: string };
  const normalizedEmail = String(body.email ?? "").trim().toLowerCase();
  const { ip: callerIp } = auditContextFrom(ctx.request);
  const claimNow = nowIso();
  const accepted = await ctx.repo.claimLoginAttempt(
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
  const recentFailures = await ctx.repo.countAuditEntriesSinceForIp("LOGIN_FAILED", normalizedEmail, callerIp, authThrottleSinceIso());
  if (recentFailures >= LOGIN_FAILED_LIMIT) {
    // Short-circuit before authenticating so a throttled attempt costs the same as
    // any other rejection — no PBKDF2 work, no DB read, no timing signal. Keyed on
    // (email, caller IP) so only the abusing IP is throttled, not the victim.
    return jsonResponse({ error: "too_many_attempts", message: "Demasiados intentos. Espere 15 minutos e intente de nuevo." }, { status: 429 });
  }
  let result;
  try {
    result = await ctx.auth.login(body.email, body.password);
  } catch (error) {
    await ctx.repo.createAudit({ action: "LOGIN_FAILED", entityType: "user", entityId: normalizedEmail, summary: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await ctx.repo.createAudit({ actorType: "USER", actorId: result.user.id, action: "LOGIN", entityType: "user", entityId: result.user.id, summary: result.user.email });
  return jsonResponse(result);
}

async function handleLogout(ctx: ApiRouteContext): Promise<Response> {
  await ctx.auth.logout(ctx.request);
  return new Response(null, { status: 204 });
}

async function handlePasswordResetRequest(ctx: ApiRouteContext): Promise<Response> {
  const body = (await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as { email?: string };
  const email = String(body.email ?? "").trim();
  if (email) {
    const task = processPasswordResetRequest(ctx.repo, ctx.auth, ctx.env, ctx.url, email, clientIpFrom(ctx.request))
      .catch((error) => logWorkerError(ctx.env, "password_reset_request_failed", error));
    if (ctx.executionContext) {
      ctx.executionContext.waitUntil(task);
    } else {
      void task;
    }
  }
  // Always report success so the endpoint cannot be used to probe which emails exist.
  return jsonResponse({ ok: true });
}

async function handlePasswordResetConfirm(ctx: ApiRouteContext): Promise<Response> {
  const body = (await readJsonObject(ctx.request, { limitBytes: PUBLIC_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as { token?: string; password?: string };
  try {
    const resetUser = await ctx.auth.confirmPasswordReset(String(body.token ?? ""), String(body.password ?? ""));
    await ctx.repo.createAudit({ actorType: "USER", actorId: resetUser.id, action: "PASSWORD_RESET_COMPLETED", entityType: "user", entityId: resetUser.id, summary: resetUser.email });
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

async function handleWompiIssuanceFailures(ctx: ApiRouteContext): Promise<Response> {
  try {
    const failures = await ctx.repo.listWompiIssuanceFailures(100);
    const projected = await Promise.all(failures.map(async (failure) => {
      if (!requiresFiscalReceptorCorrection(
        failure.issuance_error_code,
        failure.issuance_error_message ?? ""
      )) {
        return { ...failure, correction_available: null };
      }
      const correctionData = await effectiveWompiCorrectionData(ctx.repo, failure.id);
      return {
        ...failure,
        correction_available: correctionData?.correctable === true
      };
    }));
    return jsonResponse({ failures: projected });
  } catch (error) {
    logWorkerError(ctx.env, "wompi_issuance_failure_list_failed", error);
    return wompiIssuanceOperationFailedResponse();
  }
}

async function handleWompiIssuanceRetry(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  const wompiEventId = ctx.params[0];
  try {
    const current = await ctx.repo.getWompiIssuanceRetrySnapshotById(wompiEventId);
    if (!current) {
      return notFound();
    }
    if (requiresFiscalReceptorCorrection(
      current.issuance_error_code,
      current.issuance_error_message ?? ""
    )) {
      return wompiCorrectionRequiredResponse();
    }
    const attemptId = await ctx.repo.claimWompiIssuanceRetry(
      wompiEventId,
      actor.id,
      current
    );
    if (!attemptId) {
      const latest = await ctx.repo.getWompiIssuanceFailureById(wompiEventId);
      if (!latest) {
        return notFound();
      }
      if (requiresFiscalReceptorCorrection(
        latest.issuance_error_code,
        latest.issuance_error_message ?? ""
      )) {
        return wompiCorrectionRequiredResponse();
      }
      const failure = { ...latest, correction_available: null };
      if (latest.issuance_status === "RETRY_QUEUED" || latest.issuance_status === "PROCESSING") {
        return jsonResponse({ queued: false, failure });
      }
      return jsonResponse(
        {
          error: "wompi_issuance_retry_not_available",
          message: "El evento Wompi ya no está disponible para reintento.",
          failure
        },
        { status: 409 }
      );
    }
    await ctx.env.ISSUANCE_QUEUE.send({ wompiEventId, issuanceAttemptId: attemptId });
    return jsonResponse({ ok: true, queued: true }, { status: 202 });
  } catch (error) {
    logWorkerError(ctx.env, "wompi_issuance_retry_failed", error);
    return wompiIssuanceOperationFailedResponse();
  }
}

async function handleWompiCorrectionData(ctx: ApiRouteContext): Promise<Response> {
  const data = await effectiveWompiCorrectionData(ctx.repo, ctx.params[0]);
  if (!data) return notFound();
  data.activeCorrection = await ctx.repo.getActiveFiscalCorrectionForTarget(
    "WOMPI_EVENT",
    ctx.params[0]
  );
  return jsonResponse(data);
}

async function handleWompiCorrectionRetry(ctx: ApiRouteContext): Promise<Response> {
  return handleWompiFiscalCorrection(
    ctx.request,
    ctx.env,
    ctx.repo,
    ctx.actor!,
    ctx.params[0]
  );
}

async function handleDocumentCorrectionData(ctx: ApiRouteContext): Promise<Response> {
  const document = await ctx.repo.getDteDocument(ctx.params[0]);
  if (!document) return notFound();
  const data = effectiveDocumentCorrectionData(document);
  data.activeCorrection = await ctx.repo.getActiveFiscalCorrectionForTarget(
    "DTE_DOCUMENT",
    document.id
  );
  return jsonResponse(data);
}

async function handleDocumentCorrectionRetry(ctx: ApiRouteContext): Promise<Response> {
  return handleDocumentFiscalCorrection(
    ctx.request,
    ctx.env,
    ctx.repo,
    ctx.actor!,
    ctx.params[0]
  );
}

// Re-issue a CDE that MH rejected for a reason unrelated to the receptor (a bad
// certificate, a misconfigured emisor) once that configuration has been fixed. Same
// pipeline, claims and fresh-identifier allocation as a correction — see
// handleDocumentFiscalCorrection for why the two modes refuse each other's failures.
async function handleDocumentReissue(ctx: ApiRouteContext): Promise<Response> {
  return handleDocumentFiscalCorrection(
    ctx.request,
    ctx.env,
    ctx.repo,
    ctx.actor!,
    ctx.params[0],
    "reissue"
  );
}

async function handleDocumentList(ctx: ApiRouteContext): Promise<Response> {
  const statusParam = ctx.url.searchParams.get("status");
  const allowedStatuses = new Set([
    "PENDING",
    "SIGNED",
    "TRANSMITTED",
    "ACCEPTED",
    "REJECTED",
    "FAILED",
    "CONTINGENCY_PENDING",
    "INVALIDATED",
    "TRANSMISSION_PENDING"
  ]);
  const statuses = statusParam?.length && statusParam.length <= 160
    ? statusParam.split(",").map((status) => status.trim()).filter(Boolean)
    : [];
  if (
    statusParam !== null &&
    (statuses.length === 0 || statuses.length > allowedStatuses.size || statuses.some((status) => !allowedStatuses.has(status)))
  ) {
    return jsonResponse(
      { error: "invalid_document_status", message: "Seleccione uno o más estados de documento válidos." },
      { status: 400 }
    );
  }

  return jsonResponse(await ctx.repo.listDteDocuments({
    status: statuses.length ? [...new Set(statuses)].join(",") : null,
    attention: ctx.url.searchParams.get("attention") === "failures" ? "failures" : null,
    q: ctx.url.searchParams.get("q"),
    cursor: ctx.url.searchParams.get("cursor"),
    limit: Number(ctx.url.searchParams.get("limit") ?? 50)
  }));
}

async function handleDonationIntentList(ctx: ApiRouteContext): Promise<Response> {
  return jsonResponse({ intents: await ctx.repo.listRecentDonationIntents(50) });
}

type DonorFilterValues = Omit<
  Parameters<Repository["listDonors"]>[0],
  "limit" | "offset"
>;

type DonorFilterParseResult =
  | { ok: true; filters: DonorFilterValues }
  | { ok: false; response: Response };

function parseNonNegativeIntegerParam(
  params: URLSearchParams,
  name: string,
  fallback: number
): number | null {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseDonorFilterValues(url: URL): DonorFilterParseResult {
  const environment = ambienteValue(url.searchParams.get("environment"));
  if (!environment) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "invalid_donor_environment", message: "Seleccione un ambiente válido (00 o 01)." },
        { status: 400 }
      )
    };
  }
  const documentType = url.searchParams.get("documentType")?.trim() ?? "";
  const giftTypeParam = url.searchParams.get("giftType");
  const sourceParam = url.searchParams.get("source");
  const minTotalCents = url.searchParams.has("minTotalCents")
    ? parseNonNegativeIntegerParam(url.searchParams, "minTotalCents", 0)
    : undefined;
  const maxTotalCents = url.searchParams.has("maxTotalCents")
    ? parseNonNegativeIntegerParam(url.searchParams, "maxTotalCents", 0)
    : undefined;
  const invalid =
    (documentType !== "" && !findCatalogOption(CAT022_DOCUMENT_TYPES, documentType))
    || (giftTypeParam !== null && giftTypeParam !== "DIEZMO" && giftTypeParam !== "OFRENDA")
    || (sourceParam !== null && sourceParam !== "WOMPI" && sourceParam !== "MANUAL")
    || minTotalCents === null
    || maxTotalCents === null
    || (minTotalCents !== undefined && maxTotalCents !== undefined && minTotalCents > maxTotalCents);
  if (invalid) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "invalid_donor_filters", message: "Revise los filtros del explorador de donantes." },
        { status: 400 }
      )
    };
  }

  return {
    ok: true,
    filters: {
      environment,
      documentType: documentType || undefined,
      documentValue: url.searchParams.get("documentValue")?.trim() || undefined,
      name: url.searchParams.get("name")?.trim() || undefined,
      email: url.searchParams.get("email")?.trim() || undefined,
      minTotalCents,
      maxTotalCents,
      giftType: giftTypeParam === "DIEZMO" || giftTypeParam === "OFRENDA"
        ? giftTypeParam
        : undefined,
      source: sourceParam === "WOMPI" || sourceParam === "MANUAL"
        ? sourceParam
        : undefined
    }
  };
}

async function handleDonorList(ctx: ApiRouteContext): Promise<Response> {
  const parsed = parseDonorFilterValues(ctx.url);
  if (!parsed.ok) return parsed.response;
  const limit = parseNonNegativeIntegerParam(ctx.url.searchParams, "limit", 25);
  const offset = parseNonNegativeIntegerParam(ctx.url.searchParams, "offset", 0);
  if (limit === null || limit < 1 || limit > 100 || offset === null) {
    return jsonResponse(
      { error: "invalid_donor_filters", message: "Revise los filtros del explorador de donantes." },
      { status: 400 }
    );
  }
  return jsonResponse(await ctx.repo.listDonors({
    ...parsed.filters,
    limit,
    offset
  }));
}

const DONOR_EXPORT_MAX_ROWS = 1000;

async function handleDonorExport(ctx: ApiRouteContext): Promise<Response> {
  const parsed = parseDonorFilterValues(ctx.url);
  if (!parsed.ok) return parsed.response;

  const donors = [];
  let offset = 0;
  for (;;) {
    const page = await ctx.repo.listDonors({
      ...parsed.filters,
      limit: 100,
      offset
    });
    if (page.total > DONOR_EXPORT_MAX_ROWS) {
      return jsonResponse(
        {
          error: "donor_export_too_large",
          message: `La exportación supera el límite de ${DONOR_EXPORT_MAX_ROWS} donantes. Aplique filtros adicionales.`
        },
        { status: 413 }
      );
    }
    donors.push(...page.donors);
    if (!page.hasMore || page.donors.length === 0) break;
    offset += page.donors.length;
  }

  const filterMetadata: Record<string, string | number | boolean> = {
    ...(parsed.filters.documentType ? { documentType: parsed.filters.documentType } : {}),
    ...(parsed.filters.documentValue ? { hasDocumentValue: true } : {}),
    ...(parsed.filters.name ? { hasName: true } : {}),
    ...(parsed.filters.email ? { hasEmail: true } : {}),
    ...(parsed.filters.minTotalCents !== undefined
      ? { minTotalCents: parsed.filters.minTotalCents }
      : {}),
    ...(parsed.filters.maxTotalCents !== undefined
      ? { maxTotalCents: parsed.filters.maxTotalCents }
      : {}),
    ...(parsed.filters.giftType ? { giftType: parsed.filters.giftType } : {}),
    ...(parsed.filters.source ? { source: parsed.filters.source } : {})
  };
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
    action: "DONORS_EXPORTED",
    entityType: "export",
    entityId: `donors:${parsed.filters.environment}`,
    summary: donors.length === 1
      ? `1 donante exportado (ambiente ${parsed.filters.environment})`
      : `${donors.length} donantes exportados (ambiente ${parsed.filters.environment})`,
    metadata: {
      environment: parsed.filters.environment,
      donors: donors.length,
      filters: filterMetadata
    }
  });

  return new Response(buildDonorExplorerCsv(donors), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${donorExplorerCsvFilename(
        parsed.filters.environment,
        donors.length
      )}"`
    }
  });
}

function documentRouteRole(ctx: ApiRouteContext): Role {
  const action = ctx.params[1];
  if (action === "email" && ctx.request.method === "PATCH") return "OPERATOR";
  if ((action === "resend" || action === "retry" || action === "invalidate") && ctx.request.method === "POST") {
    return "OPERATOR";
  }
  return "VIEWER";
}

async function handleGenericDocument(ctx: ApiRouteContext): Promise<Response> {
  return handleDocumentRoute(ctx.request, ctx.env, ctx.repo, ctx.actor!, ctx.params[0], ctx.params[1]);
}

async function handleRetentionExport(ctx: ApiRouteContext): Promise<Response> {
  const monthParam = ctx.url.searchParams.get("month");
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
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
    action: "RETENTION_EXPORT_REQUESTED",
    entityType: "retention_export",
    entityId: monthParam ?? "previous_month",
    summary: monthParam ? `Exportación de retención solicitada para ${monthParam}` : "Exportación de retención solicitada para el mes anterior"
  });
  const result = await runRetentionExport(ctx.env, new Date(), monthParam ? { month: monthParam } : {});
  return jsonResponse({ ok: result.status !== "failed", ...result }, { status: result.status === "failed" ? 500 : 200 });
}

async function handleBackupList(ctx: ApiRouteContext): Promise<Response> {
  return jsonResponse(await listBackupMonths(ctx.env, ctx.repo, new Date()));
}

async function handleBackupVerify(ctx: ApiRouteContext): Promise<Response> {
  const result = await verifyBackupMonth(ctx.env, ctx.repo, ctx.params[0], ctx.actor!);
  if (!result) {
    return notFound();
  }
  return jsonResponse(result);
}

async function handleBackupDownload(ctx: ApiRouteContext): Promise<Response> {
  const month = ctx.params[0];
  const table = ctx.url.searchParams.get("table");
  if (!table || !/^[a-z_]+$|^manifest$/.test(table)) {
    return jsonResponse({ error: "invalid_backup_table", message: "Indique una tabla válida o 'manifest'." }, { status: 400 });
  }
  if (table !== "manifest" && !await isManifestedBackupTable(ctx.env, month, table)) {
    return notFound();
  }
  const key = table === "manifest" ? retentionManifestKey(month) : retentionTableKey(month, table);
  const object = await ctx.env.ARCHIVE.get(key);
  if (!object) {
    return notFound();
  }
  // These NDJSON snapshots carry donor PII; every access is audited with actor,
  // month, and table so the access trail is complete.
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
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

async function handleBackupDownloadAll(ctx: ApiRouteContext): Promise<Response> {
  const month = ctx.params[0];
  let entries: Array<{ name: string; data: Uint8Array }> | null;
  try {
    entries = await collectBackupMonthObjects(ctx.env, month);
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
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
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

async function handleF960Selection(ctx: ApiRouteContext): Promise<Response> {
  const selection = await f960Selection(ctx.repo, ctx.url);
  if (selection instanceof Response) return selection;
  return jsonResponse(selection);
}

async function handleF960Csv(ctx: ApiRouteContext): Promise<Response> {
  const selection = await f960Selection(ctx.repo, ctx.url);
  if (selection instanceof Response) return selection;
  await auditExport(ctx.repo, ctx.actor!, "F960_EXPORTED", selection.csvFilename, selection.rowCount);
  return new Response(buildF960Csv(selection), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${selection.csvFilename}"`
    }
  });
}

async function handleF960Xlsx(ctx: ApiRouteContext): Promise<Response> {
  const selection = await f960Selection(ctx.repo, ctx.url);
  if (selection instanceof Response) return selection;
  await auditExport(ctx.repo, ctx.actor!, "F960_INSPECTION_EXPORTED", selection.xlsxFilename, selection.rowCount);
  return new Response(buildF960Xlsx(selection), {
    headers: {
      "Content-Type": XLSX_MIME,
      "Content-Disposition": `attachment; filename="${selection.xlsxFilename}"`
    }
  });
}

async function handleContactsExport(ctx: ApiRouteContext): Promise<Response> {
  // Bulk donor PII for CRM import: ADMIN only (deliberately NOT operator/viewer).
  const environment = ambienteValue(ctx.url.searchParams.get("environment"));
  if (!environment) {
    return jsonResponse({ error: "invalid_export_environment", message: "Seleccione un ambiente válido (00 o 01)." }, { status: 400 });
  }

  // Optional [from, to] day range (YYYY-MM-DD, El Salvador local, inclusive). Both or
  // neither; malformed/inverted → 400. Reuses the analytics range→ISO-window helper so
  // the export honours the same El Salvador local-day semantics as the analytics view.
  const fromParam = ctx.url.searchParams.get("from");
  const toParam = ctx.url.searchParams.get("to");
  let window: { startIso: string; endIso: string } | undefined;
  if (fromParam || toParam) {
    const isDate = (value: string | null): value is string => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const timestamp = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
    };
    if (!isDate(fromParam) || !isDate(toParam) || fromParam > toParam) {
      return jsonResponse(
        { error: "invalid_export_range", message: "Use el formato YYYY-MM-DD y verifique que 'desde' no sea posterior a 'hasta'." },
        { status: 400 }
      );
    }
    window = elSalvadorRangeWindow({ from: fromParam, to: toParam });
  }

  // Optional giftType filter (DIEZMO|OFRENDA) — which donations count toward inclusion/totals.
  const giftTypeParam = ctx.url.searchParams.get("giftType");
  if (giftTypeParam && giftTypeParam !== "DIEZMO" && giftTypeParam !== "OFRENDA") {
    return jsonResponse({ error: "invalid_export_gift_type", message: "Seleccione Diezmo, Ofrenda o Todos." }, { status: 400 });
  }
  const giftType = giftTypeParam === "DIEZMO" || giftTypeParam === "OFRENDA" ? giftTypeParam : undefined;

  // Optional column whitelist; an unknown name is a 400 with the offending column named.
  let columns;
  try {
    columns = resolveContactColumns(ctx.url.searchParams.get("columns"));
  } catch (error) {
    return jsonResponse(
      { error: "invalid_export_columns", message: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  const contacts = await aggregateDonorContacts(ctx.repo, environment, { window, giftType });
  // Audit carries only the count + environment + applied filters — NEVER any donor PII.
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
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
      ...(ctx.url.searchParams.get("columns") ? { columns: columns.length } : {})
    }
  });
  return new Response(buildContactsCsv(contacts, columns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${contactsCsvFilename(environment, contacts.length)}"`
    }
  });
}

async function handleAnnualCertificatePreview(ctx: ApiRouteContext): Promise<Response> {
  const yearParam = ctx.url.searchParams.get("year");
  const yearError = certificateYearError(yearParam, new Date());
  if (yearError) {
    return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
  }
  return jsonResponse(await buildAnnualCertificatePreview(
    ctx.repo,
    Number(yearParam),
    ctx.url.searchParams.get("q"),
    ctx.url.searchParams.get("after")
  ));
}

async function handleAnnualCertificateSend(ctx: ApiRouteContext): Promise<Response> {
  const yearParam = ctx.url.searchParams.get("year");
  const yearError = certificateYearError(yearParam, new Date());
  if (yearError) {
    return jsonResponse({ error: "invalid_certificate_year", message: yearError }, { status: 400 });
  }
  const year = Number(yearParam);
  const rawBody = (await readBodyText(ctx.request, AUTHENTICATED_JSON_BODY_LIMIT_BYTES)).trim();
  let body: Record<string, unknown> = {};
  if (rawBody) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new InvalidJsonBodyError();
    }
    if (!isRecord(parsed)) {
      return jsonResponse({ error: "invalid_certificate_send_request" }, { status: 400 });
    }
    body = parsed;
  }
  if (Object.keys(body).some((key) => key !== "donor" && key !== "after")) {
    return jsonResponse({ error: "invalid_certificate_send_request" }, { status: 400 });
  }
  const hasDonor = Object.hasOwn(body, "donor");
  const hasAfter = Object.hasOwn(body, "after");
  const donor = hasDonor && typeof body.donor === "string" ? body.donor.trim() : "";
  const after = hasAfter && typeof body.after === "string" ? body.after.trim() : "";
  if (
    (hasDonor && (!donor || donor.length > 320)) ||
    (hasAfter && (!after || after.length > 320)) ||
    (donor && after)
  ) {
    return jsonResponse({ error: "invalid_certificate_send_request" }, { status: 400 });
  }
  const sendRequest: AnnualCertificateSendRequest = donor ? { donor } : after ? { after } : {};
  let result;
  try {
    result = await sendAnnualCertificates(ctx.env, ctx.repo, year, ctx.actor!.id, sendRequest);
  } catch (error) {
    if (error instanceof CertificateDossierChangedError) {
      return jsonResponse({ error: "certificate_dossier_changed", message: error.message }, { status: 409 });
    }
    if (error instanceof CertificateDossierLimitError) {
      return jsonResponse({ error: "certificate_dossier_too_large", message: error.message }, { status: 422 });
    }
    if (error instanceof SingleDonorSendError) {
      return jsonResponse({ error: "single_donor_send_error", message: error.message }, { status: error.status });
    }
    throw error;
  }
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
    action: "DONOR_CERTIFICATES_RUN",
    entityType: "donor_certificate_run",
    entityId: String(year),
    summary: result.mode === "single"
      ? `Constancia ${year} enviada individualmente: ${result.sent} enviada, ${result.failed} fallida`
      : `Tanda de constancias ${year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas; ${result.hasMore ? "quedan donantes por procesar" : "no quedan donantes por procesar"}`,
    metadata: {
      mode: result.mode,
      processed: result.processed,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      hasMore: result.hasMore
    }
  });
  return jsonResponse(result);
}

function stripeAnnualStatementParameter(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= 320 ? normalized : null;
}

function stripeAnnualStatementLivemode(ctx: ApiRouteContext): boolean | Response {
  try {
    return resolveStripeConfiguration(ctx.env).livemode;
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      return jsonResponse({ error: "stripe_annual_statement_unavailable", message: error.message }, { status: 503 });
    }
    throw error;
  }
}

async function handleStripeAnnualStatementPreview(ctx: ApiRouteContext): Promise<Response> {
  const yearParam = ctx.url.searchParams.get("year");
  let yearError: string | null;
  try {
    yearError = certificateYearError(yearParam, new Date(), stripeUsTimeZone(ctx.env));
  } catch (error) {
    if (error instanceof StripeAnnualStatementConfigurationError) {
      return jsonResponse({ error: "stripe_annual_statement_unavailable", message: error.message }, { status: 503 });
    }
    throw error;
  }
  if (yearError) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_year", message: yearError }, { status: 400 });
  }
  const afterParam = ctx.url.searchParams.get("after");
  if (afterParam !== null && !stripeAnnualStatementParameter(afterParam)) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_cursor" }, { status: 400 });
  }
  const searchParam = ctx.url.searchParams.get("q");
  if (searchParam !== null && !stripeAnnualStatementParameter(searchParam)) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_search" }, { status: 400 });
  }
  const livemode = stripeAnnualStatementLivemode(ctx);
  if (livemode instanceof Response) return livemode;
  try {
    return jsonResponse(await buildStripeAnnualStatementPreview(ctx.env, ctx.repo, Number(yearParam), livemode, afterParam, searchParam));
  } catch (error) {
    if (error instanceof StripeAnnualStatementConfigurationError) {
      return jsonResponse({ error: "stripe_annual_statement_unavailable", message: error.message }, { status: 503 });
    }
    throw error;
  }
}

async function handleStripeAnnualStatementSend(ctx: ApiRouteContext): Promise<Response> {
  const yearParam = ctx.url.searchParams.get("year");
  let yearError: string | null;
  try {
    yearError = certificateYearError(yearParam, new Date(), stripeUsTimeZone(ctx.env));
  } catch (error) {
    if (error instanceof StripeAnnualStatementConfigurationError) {
      return jsonResponse({ error: "stripe_annual_statement_unavailable", message: error.message }, { status: 503 });
    }
    throw error;
  }
  if (yearError) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_year", message: yearError }, { status: 400 });
  }
  const rawBody = (await readBodyText(ctx.request, AUTHENTICATED_JSON_BODY_LIMIT_BYTES)).trim();
  let body: Record<string, unknown> = {};
  if (rawBody) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new InvalidJsonBodyError();
    }
    if (!isRecord(parsed)) {
      return jsonResponse({ error: "invalid_stripe_annual_statement_send_request" }, { status: 400 });
    }
    body = parsed;
  }
  if (Object.keys(body).some((key) => key !== "donor" && key !== "after")) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_send_request" }, { status: 400 });
  }
  const hasDonor = Object.hasOwn(body, "donor");
  const hasAfter = Object.hasOwn(body, "after");
  const donor = hasDonor && typeof body.donor === "string" ? stripeAnnualStatementParameter(body.donor) : null;
  const after = hasAfter && typeof body.after === "string" ? stripeAnnualStatementParameter(body.after) : null;
  if ((hasDonor && !donor) || (hasAfter && !after) || (donor && after)) {
    return jsonResponse({ error: "invalid_stripe_annual_statement_send_request" }, { status: 400 });
  }
  const livemode = stripeAnnualStatementLivemode(ctx);
  if (livemode instanceof Response) return livemode;
  const sendRequest: StripeAnnualStatementSendRequest = donor ? { donor } : after ? { after } : {};
  let result;
  try {
    result = await sendStripeAnnualStatements(ctx.env, ctx.repo, Number(yearParam), livemode, ctx.actor!.id, sendRequest);
  } catch (error) {
    if (error instanceof StripeAnnualStatementSingleDonorError) {
      return jsonResponse({
        error: error.status === 404 ? "stripe_annual_statement_donor_not_found" : "stripe_annual_statement_donor_unavailable",
        message: error.message
      }, { status: error.status });
    }
    if (error instanceof StripeAnnualStatementConfigurationError) {
      return jsonResponse({ error: "stripe_annual_statement_unavailable", message: error.message }, { status: 503 });
    }
    throw error;
  }
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
    action: "STRIPE_ANNUAL_STATEMENTS_RUN",
    entityType: "stripe_annual_statement_run",
    entityId: `${result.year}:${result.livemode ? "live" : "test"}`,
    summary: result.mode === "single"
      ? `Constancia de EE. UU. ${result.year} enviada individualmente: ${result.sent} enviada, ${result.review} en revisión`
      : `Tanda de constancias de EE. UU. ${result.year}: ${result.sent} enviadas, ${result.skipped} omitidas, ${result.failed} fallidas, ${result.review} en revisión`,
    metadata: {
      mode: result.mode,
      livemode: result.livemode,
      processed: result.processed,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      review: result.review,
      hasMore: result.hasMore
    }
  });
  return jsonResponse(result);
}

async function handleAudit(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  const entityType = ctx.url.searchParams.get("entityType");
  const entityId = ctx.url.searchParams.get("entityId");
  if (entityType && entityId) {
    // Entity-scoped history keeps its original (uncapped-page) shape.
    return jsonResponse({ audit: await listAuditForUser(ctx.repo, actor, entityType, entityId), nextCursor: null });
  }
  // General history pages by keyset cursor ("<created_at>|<id>"): the audit trail
  // grows forever, so the old flat LIMIT 100 silently hid everything older.
  const limitParam = Number(ctx.url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), 100) : 50;
  const rawCursor = ctx.url.searchParams.get("cursor");
  let cursor: { createdAt: string; id: string } | null = null;
  if (rawCursor) {
    const split = rawCursor.lastIndexOf("|");
    if (split > 0) {
      cursor = { createdAt: rawCursor.slice(0, split), id: rawCursor.slice(split + 1) };
    }
  }
  const rows = await ctx.repo.listAuditPage(cursor, limit);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1] as { created_at?: string; id?: string } | undefined;
  const nextCursor = rows.length > limit && last?.created_at && last?.id ? `${last.created_at}|${last.id}` : null;
  return jsonResponse({ audit: projectAuditRows(page, actor.role), nextCursor });
}

// GET /api/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&environment=00 — Analítica del
// carril Wompi (solo lectura, rol VIEWER como /api/audit). Devuelve un único objeto
// con todas las secciones. Defaults: los últimos 90 días (El Salvador local) y el
// ambiente de emisión ACTIVO cuando no se especifica environment.
async function handleAnalytics(ctx: ApiRouteContext): Promise<Response> {
  const now = new Date();
  const environment = ambienteValue(ctx.url.searchParams.get("environment")) ?? (await activeEmissionEnvironment(ctx.repo, ctx.env));
  const range = analyticsRange(ctx.url.searchParams.get("from"), ctx.url.searchParams.get("to"), now);
  if (!range) {
    return jsonResponse({ error: "invalid_analytics_range", message: "Use el formato YYYY-MM-DD y verifique que 'desde' no sea posterior a 'hasta'." }, { status: 400 });
  }
  try {
    const analytics = await computeAnalytics(ctx.repo, range, environment, now, {
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

// Solo lectura (historial). La emisión en contingencia del CDE se eliminó: el
// Anexo de validaciones del evento de contingencia (campo 35) no admite el tipo 15,
// así que las rutas de apertura/barrido ya no existen. Ante una caída de MH la
// emisión queda diferida (SIGNED + transmission_deferred_at) y el cron de 15
// minutos la reintenta.
async function handleContingency(ctx: ApiRouteContext): Promise<Response> {
  return jsonResponse({ contingency: await contingencyState(ctx.repo, ctx.actor!) });
}

async function handleTestDte(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  if (!deploymentEnvironmentPolicy(ctx.env).directGenerationAllowed) {
    return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
  }
  const input = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as DirectCdeInput & {
    smokeRunId?: unknown;
  };
  const donorFields = directDonorFields(input);
  if (donorFields instanceof Response) return donorFields;
  const config = getEmisorConfig(ctx.env);
  const environment = await activeEmissionEnvironment(ctx.repo, ctx.env);
  let document: Record<string, unknown>;
  try {
    const sequence = await ctx.repo.nextControlSequence(environment, config.controlPrefix);
    document = buildDirectCdeDocument({ ...input, ...donorFields }, config, { sequence, environment });
  } catch (error) {
    return jsonResponse({ error: "invalid_test_payload", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  const summary = cdeDocumentSummary(document);
  const dte = await ctx.repo.createDteDocument({
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
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "QUICK_CDE_CREATED",
    entityType: "dte_document",
    entityId: dte.id,
    summary: dte.numero_control,
    metadata: { source: "quick_direct_generation" }
  });
  const smokeRunId = stagingSmokeRunId(ctx.env, input.smokeRunId);
  if (smokeRunId) {
    await ctx.repo.createAuditIfAbsent({
      action: "STAGING_SMOKE_RUN",
      entityType: "dte_document",
      entityId: dte.id,
      summary: "CDE creado por la prueba integral de staging",
      metadata: { runId: smokeRunId, path: "admin", source: "staging-smoke" }
    });
  }
  await ctx.env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
  return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
}

async function handleAdvancedTemplate(ctx: ApiRouteContext): Promise<Response> {
  if (!deploymentEnvironmentPolicy(ctx.env).directGenerationAllowed) {
    return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
  }
  const input = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as DirectCdeInput;
  const donorFields = templateDonorFields(input);
  if (donorFields instanceof Response) return donorFields;
  try {
    const environment = await activeEmissionEnvironment(ctx.repo, ctx.env);
    const draft = buildDirectCdeDocument(
      { ...input, ...donorFields, amount: advancedTemplateAmount(input.amount) },
      getEmisorConfig(ctx.env),
      { sequence: 1, environment, templatePreview: true }
    );
    return jsonResponse({ draft, sections: ["identificacion", "emisor", "receptor", "otrosDocumentos", "cuerpoDocumento", "resumen", "apendice"] });
  } catch (error) {
    return jsonResponse({ error: "invalid_advanced_template", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function handleAdvancedDte(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  if (!deploymentEnvironmentPolicy(ctx.env).directGenerationAllowed) {
    return jsonResponse({ error: "test_generation_disabled_in_production" }, { status: 403 });
  }
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { draft?: unknown };
  const config = getEmisorConfig(ctx.env);
  const environment = await activeEmissionEnvironment(ctx.repo, ctx.env);
  let document: Record<string, unknown>;
  try {
    buildAdvancedCdeDocument(body.draft, config, { sequence: 1, environment });
    const sequence = await ctx.repo.nextControlSequence(environment, config.controlPrefix);
    document = buildAdvancedCdeDocument(body.draft, config, { sequence, environment });
  } catch (error) {
    return jsonResponse({ error: "invalid_advanced_cde", message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  const summary = cdeDocumentSummary(document);
  const dte = await ctx.repo.createDteDocument({
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
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "ADVANCED_CDE_CREATED",
    entityType: "dte_document",
    entityId: dte.id,
    summary: dte.numero_control,
    metadata: { source: "admin_advanced_direct_generation" }
  });
  await ctx.env.ISSUANCE_QUEUE.send({ advancedDocumentId: dte.id });
  return jsonResponse({ ok: true, documentId: dte.id, queued: true, numeroControl: dte.numero_control, codigoGeneracion: dte.codigo_generacion }, { status: 202 });
}

async function handleUserList(ctx: ApiRouteContext): Promise<Response> {
  return jsonResponse({ users: await ctx.repo.listUsers() });
}

async function handleUserCreate(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as {
    email?: unknown;
    name?: unknown;
    role?: unknown;
    password?: unknown;
  };
  const input = userCreateInput(body);
  if (input instanceof Response) return input;
  // Only an OWNER may mint another OWNER; otherwise an ADMIN could self-escalate by
  // creating an OWNER account and then using the OWNER-only credential routes.
  if (input.role === "OWNER" && actor.role !== "OWNER") {
    return jsonResponse({ error: "owner_role_required", message: "Solo un propietario puede asignar el rol de propietario" }, { status: 403 });
  }
  let created;
  try {
    created = await ctx.auth.createUser(input);
  } catch (error) {
    if (error instanceof PasswordPolicyError) {
      return jsonResponse({ error: "invalid_user_password", message: error.message }, { status: 400 });
    }
    throw error;
  }
  await ctx.repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_CREATED", entityType: "user", entityId: created.id, summary: created.email });
  return jsonResponse({ user: created }, { status: 201 });
}

async function handleUserPassword(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  const userId = ctx.params[0];
  // Vector inverso de escalación: restablecer la contraseña de un OWNER le daría a
  // un ADMIN esa sesión. Solo un propietario modifica a otro propietario.
  if (actor.role !== "OWNER" && (await ctx.repo.getUserRole(userId)) === "OWNER") {
    return jsonResponse({ error: "owner_target_protected", message: "Solo un propietario puede modificar a otro propietario" }, { status: 403 });
  }
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { password?: unknown };
  if (typeof body.password !== "string" || !body.password) {
    return jsonResponse({ error: "missing_user_password", message: "Ingrese nueva contraseña" }, { status: 400 });
  }
  try {
    await ctx.auth.resetUserPassword(userId, body.password, actor.role === "OWNER");
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
  await ctx.repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_PASSWORD_RESET", entityType: "user", entityId: userId, summary: "Contraseña restablecida por administrador" });
  return jsonResponse({ ok: true });
}

async function handleUserUpdate(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  const userId = ctx.params[0];
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { role?: unknown; disabled?: unknown; name?: unknown; email?: unknown };
  const patch = userPatchInput(body);
  if (patch instanceof Response) return patch;
  // Same escalation guard as user creation: promoting an account to OWNER is
  // reserved for OWNERs.
  if (patch.role === "OWNER" && actor.role !== "OWNER") {
    return jsonResponse({ error: "owner_role_required", message: "Solo un propietario puede asignar el rol de propietario" }, { status: 403 });
  }
  // Y el vector inverso: un ADMIN tampoco modifica (desactiva, renombra, degrada) a
  // un OWNER existente.
  if (actor.role !== "OWNER" && (await ctx.repo.getUserRole(userId)) === "OWNER") {
    return jsonResponse({ error: "owner_target_protected", message: "Solo un propietario puede modificar a otro propietario" }, { status: 403 });
  }
  let updated: Record<string, unknown>;
  try {
    updated = await ctx.repo.updateUser(userId, patch, actor.role === "OWNER");
  } catch (error) {
    if (error instanceof OwnerTargetProtectedError) {
      return jsonResponse({ error: "owner_target_protected", message: error.message }, { status: 403 });
    }
    if (error instanceof UserMutationConflictError) {
      return jsonResponse({ error: "user_update_conflict", message: error.message }, { status: 409 });
    }
    throw error;
  }
  await ctx.repo.createAudit({ actorType: "USER", actorId: actor.id, action: "USER_UPDATED", entityType: "user", entityId: userId, summary: "Usuario actualizado", metadata: patch });
  return jsonResponse({ user: updated });
}

const publicRoutes: Array<Route<ApiRouteContext>> = [
  { pattern: "/api/health", handler: handleHealth },
  { method: "GET", pattern: "/api/auth/bootstrap-status", handler: handleBootstrapStatus },
  { method: "GET", pattern: "/api/branding", handler: handlePublicBranding },
  { method: "GET", pattern: "/api/branding/logo", handler: handleAdminBrandingLogo },
  { method: "GET", pattern: "/api/branding/donor-logo", handler: handleDonorBrandingLogo },
  { method: "POST", pattern: "/api/donations/intent", handler: handleCreateDonationIntent },
  { method: "POST", pattern: /^\/api\/donations\/intent\/([^/]+)\/datos$/, handler: handleDonationIntentDatos },
  { method: "GET", pattern: /^\/api\/donations\/intent\/([^/]+)\/status$/, handler: handleDonationIntentStatus },
  { method: "POST", pattern: "/api/donations/stripe/checkout", handler: handleCreateStripeCheckout },
  { method: "GET", pattern: /^\/api\/donations\/stripe\/session\/([^/]+)$/, handler: handleStripeCheckoutStatus },
  { method: "POST", pattern: "/api/donations/stripe/portal", handler: handleStripePortal }
];

const authRoutes: Array<Route<ApiRouteContext>> = [
  { method: "POST", pattern: "/api/auth/bootstrap-owner", handler: handleBootstrapOwner },
  { method: "POST", pattern: "/api/auth/login", handler: handleLogin },
  { method: "POST", pattern: "/api/auth/logout", handler: handleLogout },
  { method: "POST", pattern: "/api/auth/password-reset/request", handler: handlePasswordResetRequest },
  { method: "POST", pattern: "/api/auth/password-reset/confirm", handler: handlePasswordResetConfirm }
];

const settingsRoutes: Array<Route<ApiRouteContext>> = [
  { pattern: "/api/credentials", role: "OWNER", handler: handleCredentials },
  { pattern: "/api/credentials/writer-token", role: "OWNER", handler: handleCredentialWriterToken },
  { pattern: "/api/settings/stripe", role: "OWNER", handler: handleStripeSettings },
  { pattern: "/api/settings/stripe/webhook-secret/stage", role: "OWNER", handler: handleStripeWebhookSecretStage },
  { pattern: "/api/settings/stripe/webhook-secret/promote", role: "OWNER", handler: handleStripeWebhookSecretPromote },
  { pattern: "/api/settings/stripe/webhook-secret/cancel", role: "OWNER", handler: handleStripeWebhookSecretCancel },
  {
    pattern: "/api/settings/emission-environment",
    role: ({ request }) => request.method === "GET" ? "VIEWER" : request.method === "PUT" ? "OWNER" : null,
    handler: handleEmissionEnvironment
  },
  {
    pattern: "/api/settings/email-templates",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleEmailTemplates
  },
  {
    pattern: "/api/settings/email-sender",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleEmailSender
  },
  {
    pattern: "/api/settings/wompi-notifications",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleWompiNotificationSettings
  },
  {
    pattern: "/api/settings/branding",
    role: ({ request }) => request.method === "PUT" ? "OWNER" : null,
    handler: handleBrandingSettings
  },
  {
    pattern: "/api/settings/branding/logo",
    role: ({ request }) => request.method === "PUT" || request.method === "DELETE" ? "OWNER" : null,
    handler: handleAdminBrandingLogoSettings
  },
  {
    pattern: "/api/settings/branding/donor-logo",
    role: ({ request }) => request.method === "PUT" || request.method === "DELETE" ? "OWNER" : null,
    handler: handleDonorBrandingLogoSettings
  },
  {
    pattern: "/api/settings/alert-email",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleAlertEmailSetting
  }
];

const documentListRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/documents", role: "VIEWER", handler: handleDocumentList },
  { method: "GET", pattern: "/api/donations/intents", role: "VIEWER", handler: handleDonationIntentList },
  { method: "GET", pattern: "/api/donors", role: "ADMIN", handler: handleDonorList }
];

const wompiIssuanceRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/wompi-events/issuance-failures", role: "VIEWER", handler: handleWompiIssuanceFailures },
  { method: "POST", pattern: /^\/api\/wompi-events\/([^/]+)\/retry$/, role: "OPERATOR", handler: handleWompiIssuanceRetry }
];

const correctionRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: /^\/api\/wompi-events\/([^/]+)\/correction-data$/, role: "OPERATOR", handler: handleWompiCorrectionData },
  { method: "POST", pattern: /^\/api\/wompi-events\/([^/]+)\/correct-and-retry$/, role: "OPERATOR", handler: handleWompiCorrectionRetry },
  { method: "GET", pattern: /^\/api\/documents\/([^/]+)\/correction-data$/, role: "OPERATOR", handler: handleDocumentCorrectionData },
  { method: "POST", pattern: /^\/api\/documents\/([^/]+)\/correct-and-retry$/, role: "OPERATOR", handler: handleDocumentCorrectionRetry },
  { method: "POST", pattern: /^\/api\/documents\/([^/]+)\/reissue$/, role: "OPERATOR", handler: handleDocumentReissue }
];

const exportRoutes: Array<Route<ApiRouteContext>> = [
  { method: "POST", pattern: "/api/admin/retention-export", role: "OWNER", handler: handleRetentionExport },
  { method: "GET", pattern: "/api/admin/backups", role: "ADMIN", handler: handleBackupList },
  { method: "POST", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/verify$/, role: "ADMIN", handler: handleBackupVerify },
  { method: "GET", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/download$/, role: "ADMIN", handler: handleBackupDownload },
  { method: "GET", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/download-all$/, role: "ADMIN", handler: handleBackupDownloadAll },
  { method: "GET", pattern: "/api/exports/f960", role: "ADMIN", handler: handleF960Selection },
  { method: "GET", pattern: "/api/exports/f960.csv", role: "ADMIN", handler: handleF960Csv },
  { method: "GET", pattern: "/api/exports/f960.xlsx", role: "ADMIN", handler: handleF960Xlsx },
  { method: "GET", pattern: "/api/exports/contacts", role: "ADMIN", handler: handleContactsExport },
  { method: "GET", pattern: "/api/exports/donors.csv", role: "ADMIN", handler: handleDonorExport },
  { method: "GET", pattern: "/api/certificates/annual", role: "ADMIN", handler: handleAnnualCertificatePreview },
  { method: "POST", pattern: "/api/certificates/annual/send", role: "ADMIN", handler: handleAnnualCertificateSend },
  { method: "GET", pattern: "/api/statements/stripe/annual", role: "ADMIN", handler: handleStripeAnnualStatementPreview },
  { method: "POST", pattern: "/api/statements/stripe/annual/send", role: "ADMIN", handler: handleStripeAnnualStatementSend }
];

const operationsRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/audit", role: "VIEWER", handler: handleAudit },
  { method: "GET", pattern: "/api/analytics", role: "VIEWER", handler: handleAnalytics },
  { method: "GET", pattern: "/api/contingency", role: "VIEWER", handler: handleContingency },
  { method: "POST", pattern: "/api/test/dte", role: "OPERATOR", handler: handleTestDte },
  { method: "POST", pattern: "/api/test/dte/advanced-template", role: "OWNER", handler: handleAdvancedTemplate },
  { method: "POST", pattern: "/api/test/dte/advanced", role: "OWNER", handler: handleAdvancedDte }
];

const userRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/users", role: "ADMIN", handler: handleUserList },
  { method: "POST", pattern: "/api/users", role: "ADMIN", handler: handleUserCreate },
  { method: "POST", pattern: /^\/api\/users\/([^/]+)\/password$/, role: "ADMIN", handler: handleUserPassword },
  { method: "PATCH", pattern: /^\/api\/users\/([^/]+)$/, role: "ADMIN", handler: handleUserUpdate }
];

const genericDocumentRoute: Route<ApiRouteContext> = {
  pattern: /^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/,
  role: documentRouteRole,
  handler: handleGenericDocument
};

const routes: Array<Route<ApiRouteContext>> = [
  ...publicRoutes,
  ...authRoutes,
  ...documentListRoutes,
  ...wompiIssuanceRoutes,
  ...settingsRoutes,
  ...exportRoutes,
  ...correctionRoutes,
  genericDocumentRoute,
  ...operationsRoutes,
  ...userRoutes
];

async function handleApi(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  // Build the actor context ONCE per request and inject it into the Repository, so
  // every downstream repo.createAudit (route handlers reuse this same instance)
  // records the caller's IP and Cloudflare request context without per-call-site wiring.
  const repo = new Repository(env.DB, auditContextFrom(request));
  const auth = new AuthService(env);
  const user = await auth.authenticate(request);

  const apiContext: ApiRouteContext = {
    request,
    pathname: url.pathname,
    user,
    actor: null,
    params: [],
    env,
    repo,
    auth,
    url,
    executionContext: ctx
  };
  return (await dispatchRoutes(routes, apiContext, requireRole)) ?? notFound();
}

// Validates and defaults the analytics date range. `from`/`to` are YYYY-MM-DD in El
// Salvador local time. Absent params default to the last 90 days ending today. Returns
// null on a malformed date, an inverted range, or a range wider than one year.
const MAX_ANALYTICS_RANGE_DAYS = 366;

function analyticsRange(fromParam: string | null, toParam: string | null, now: Date): AnalyticsRange | null {
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  const todayLocal = elSalvadorDateOnly(now.toISOString());
  const to = toParam ?? todayLocal;
  const from = fromParam ?? elSalvadorDateOnly(new Date(now.getTime() - 89 * 86_400_000).toISOString());
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

async function handleEmissionEnvironment(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    return jsonResponse({ emissionEnvironment: await emissionEnvironmentState(ctx.repo, ctx.env) });
  }
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { environment?: unknown };
  const environment = ambienteValue(body.environment);
  if (!environment) {
    return jsonResponse({ error: "invalid_emission_environment", message: "Seleccione Pruebas 00 o Producción 01." }, { status: 400 });
  }
  assertDeploymentAllowsAmbiente(ctx.env, environment);
  await ctx.repo.setSetting(EMISSION_ENVIRONMENT_SETTING, environment, actor.id);
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "EMISSION_ENVIRONMENT_UPDATED",
    entityType: "app_setting",
    entityId: EMISSION_ENVIRONMENT_SETTING,
    summary: environment === "01" ? "Ambiente de emisión cambiado a Producción 01" : "Ambiente de emisión cambiado a Pruebas 00",
    metadata: { environment }
  });
  return jsonResponse({ ok: true, emissionEnvironment: await emissionEnvironmentState(ctx.repo, ctx.env) });
}

async function handleEmailTemplates(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    const settings = parseEmailTemplates(await ctx.repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
    return jsonResponse({ emailTemplates: emailTemplateResponse(settings) });
  }
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { templates?: unknown };
  try {
    const templates = normalizeEmailTemplateSettings(body.templates);
    await ctx.repo.setSetting(EMAIL_TEMPLATES_SETTING_KEY, JSON.stringify(templates), actor.id);
    await ctx.repo.createAudit({
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

async function emailSenderState(ctx: Pick<ApiRouteContext, "env" | "repo">): Promise<{
  senderName: string;
  senderAddress: string;
  replyToAddress: string;
}> {
  const branding = await loadEmailBranding(ctx.repo, ctx.env);
  return {
    senderName: branding.senderName,
    senderAddress: ctx.env.EMAIL_FROM?.trim() ?? "",
    replyToAddress: branding.replyToAddress ?? ""
  };
}

async function handleEmailSender(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    return jsonResponse({ emailSender: await emailSenderState(ctx) });
  }
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, {
    limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES,
    malformed: "empty-object"
  })) as { senderName?: unknown; replyToAddress?: unknown };
  try {
    const senderName = normalizeEmailSenderName(body.senderName);
    const updatesReplyTo = Object.prototype.hasOwnProperty.call(body, "replyToAddress");
    const replyToAddress = updatesReplyTo
      ? normalizeEmailReplyToAddress(body.replyToAddress)
      : resolveEmailReplyToAddress(await ctx.repo.getSetting(EMAIL_REPLY_TO_SETTING_KEY)) ?? "";
    await ctx.repo.setSetting(EMAIL_SENDER_NAME_SETTING_KEY, senderName, actor.id);
    if (updatesReplyTo) {
      await ctx.repo.setSetting(EMAIL_REPLY_TO_SETTING_KEY, replyToAddress, actor.id);
    }
    await ctx.repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "EMAIL_SENDER_UPDATED",
      entityType: "app_setting",
      entityId: "email_sender_identity",
      summary: "Identidad de correo actualizada",
      metadata: { senderName, replyToConfigured: Boolean(replyToAddress) }
    });
    return jsonResponse({ ok: true, emailSender: await emailSenderState(ctx) });
  } catch (error) {
    if (error instanceof EmailSenderValidationError) {
      return jsonResponse({ error: "invalid_email_sender", message: error.message }, { status: 400 });
    }
    throw error;
  }
}

async function handleWompiNotificationSettings(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    return jsonResponse({
      wompiNotifications: await loadWompiNotificationSettings(ctx.repo)
    });
  }
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, {
    limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES,
    malformed: "empty-object"
  })) as {
    emailsNotificacion?: unknown;
    telefonosNotificacion?: unknown;
    notificarTransaccionCliente?: unknown;
  };
  try {
    const wompiNotifications = normalizeWompiNotificationSettings({
      emailsNotificacion: body.emailsNotificacion,
      telefonosNotificacion: body.telefonosNotificacion,
      notificarTransaccionCliente: body.notificarTransaccionCliente
    });
    await ctx.repo.setSetting(
      WOMPI_NOTIFICATION_EMAILS_SETTING_KEY,
      wompiNotifications.emailsNotificacion,
      actor.id
    );
    await ctx.repo.setSetting(
      WOMPI_NOTIFICATION_PHONES_SETTING_KEY,
      wompiNotifications.telefonosNotificacion,
      actor.id
    );
    await ctx.repo.setSetting(
      WOMPI_NOTIFY_DONOR_EMAIL_SETTING_KEY,
      String(wompiNotifications.notificarTransaccionCliente),
      actor.id
    );
    await ctx.repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "WOMPI_NOTIFICATIONS_UPDATED",
      entityType: "app_setting",
      entityId: "wompi_notifications",
      summary: "Notificaciones de Wompi actualizadas",
      // The audit trail is readable by lower roles. Keep recipient addresses and
      // numbers in this OWNER-only setting response, never in audit metadata.
      metadata: {
        emailRecipientCount: wompiNotifications.emailsNotificacion
          ? wompiNotifications.emailsNotificacion.split(",").length
          : 0,
        phoneRecipientCount: wompiNotifications.telefonosNotificacion
          ? wompiNotifications.telefonosNotificacion.split(",").length
          : 0,
        donorEmailEnabled: wompiNotifications.notificarTransaccionCliente
      }
    });
    return jsonResponse({ ok: true, wompiNotifications });
  } catch (error) {
    if (error instanceof WompiNotificationValidationError) {
      return jsonResponse(
        { error: "invalid_wompi_notifications", message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }
}

async function handleAlertEmailSetting(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    return jsonResponse({ alertEmail: (await ctx.repo.getSetting(ALERT_EMAIL_SETTING_KEY)) ?? "" });
  }
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { alertEmail?: unknown };
  const alertEmail = normalizeAlertRecipients(typeof body.alertEmail === "string" ? body.alertEmail : "");
  if (alertEmail === null) {
    return jsonResponse({ error: "invalid_alert_email", message: "Ingrese correos válidos separados por coma." }, { status: 400 });
  }
  await ctx.repo.setSetting(ALERT_EMAIL_SETTING_KEY, alertEmail, actor.id);
  await ctx.repo.createAudit({
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
async function handleBrandingSettings(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { displayName?: unknown; accentColor?: unknown; supportEmail?: unknown };
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
  await ctx.repo.setSetting(BRANDING_DISPLAY_NAME_SETTING_KEY, displayName, actor.id);
  await ctx.repo.setSetting(BRANDING_ACCENT_COLOR_SETTING_KEY, accentColor, actor.id);
  await ctx.repo.setSetting(BRANDING_SUPPORT_EMAIL_SETTING_KEY, supportEmail, actor.id);
  await ctx.repo.createAudit({
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
async function handleAdminBrandingLogoSettings(ctx: ApiRouteContext): Promise<Response> {
  return handleBrandingLogoSettings(ctx, ADMIN_EMAIL_LOGO_SLOT);
}

async function handleDonorBrandingLogoSettings(ctx: ApiRouteContext): Promise<Response> {
  return handleBrandingLogoSettings(ctx, DONOR_LOGO_SLOT);
}

async function handleBrandingLogoSettings(ctx: ApiRouteContext, slot: BrandingLogoSlot): Promise<Response> {
  if (ctx.request.method === "DELETE") {
    const actor = ctx.actor!;
    await ctx.env.ARCHIVE.delete(slot.objectKey);
    await ctx.repo.setSetting(slot.settingKey, "", actor.id);
    await ctx.repo.createAudit({
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
  if (ctx.request.method !== "PUT") {
    return methodNotAllowed();
  }
  const actor = ctx.actor!;
  let contentType: string;
  try {
    contentType = normalizeBrandingLogoContentType(ctx.request.headers.get("Content-Type"));
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return jsonResponse({ error: "invalid_branding_logo", message: error.message }, { status: 400 });
    }
    throw error;
  }
  const bytes = await readBodyBytes(ctx.request, BRANDING_LOGO_MAX_BYTES);
  if (bytes.byteLength === 0) {
    return jsonResponse({ error: "invalid_branding_logo", message: "El archivo del logo está vacío." }, { status: 400 });
  }
  if (bytes.byteLength > BRANDING_LOGO_MAX_BYTES) {
    return jsonResponse({ error: "invalid_branding_logo", message: "El logo no puede superar los 512 KB." }, { status: 400 });
  }
  // crypto.randomUUID gives a cache-busting version without a wall-clock read.
  const version = crypto.randomUUID();
  await ctx.env.ARCHIVE.put(slot.objectKey, bytes, { httpMetadata: { contentType } });
  await ctx.repo.setSetting(
    slot.settingKey,
    JSON.stringify({ contentType, size: bytes.byteLength, version }),
    actor.id
  );
  await ctx.repo.createAudit({
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

function userCreateInput(body: {
  role?: unknown;
  name?: unknown;
  email?: unknown;
  password?: unknown;
}): Response | { role: Role; name: string; email: string; password: string } {
  if (typeof body.name !== "string" || !body.name.trim()) {
    return jsonResponse({ error: "invalid_user_name", message: "Ingrese nombre del usuario" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: "invalid_user_email", message: "Ingrese correo válido" }, { status: 400 });
  }
  if (!isRole(body.role)) {
    return jsonResponse({ error: "invalid_user_role", message: "Seleccione un rol válido" }, { status: 400 });
  }
  if (typeof body.password !== "string" || !body.password) {
    return jsonResponse({ error: "invalid_user_password", message: "Ingrese contraseña inicial" }, { status: 400 });
  }
  return {
    name: body.name.trim(),
    email,
    role: body.role,
    password: body.password
  };
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
  return isValidEmail(email) ? email : null;
}

function normalizeResendRequestId(value: unknown): string | null {
  return normalizeUuidV4(value);
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

async function handleCredentials(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  if (ctx.request.method === "GET") {
    return jsonResponse({ credentials: credentialStatus(ctx.env) });
  }
  if (ctx.request.method !== "POST") {
    return methodNotAllowed();
  }

  const input = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "throw" })) as unknown as CredentialUpdateInput;
  if (input.environment !== "test" && input.environment !== "production") {
    return jsonResponse({ error: "invalid_credential_environment" }, { status: 400 });
  }
  assertDeploymentAllowsAmbiente(ctx.env, input.environment === "production" ? "01" : "00");
  const patch = buildCredentialSecretPatch(input);
  if (Object.keys(patch).length === 0) {
    return jsonResponse({ error: "no_credentials_supplied" }, { status: 400 });
  }
  try {
    const result = await patchCloudflareWorkerSecrets(ctx.env, patch);
    await ctx.repo.createAudit({
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

async function handleStripeSettings(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method === "GET") {
    const status = credentialStatus(ctx.env);
    const latest = await ctx.repo.getLatestStripeWebhookHealth();
    const deploymentLivemode = ctx.env.APP_ENV === "production";
    const webhookHealth = latest ? {
      state: "observed" as const,
      lastReceivedAt: latest.receivedAt,
      eventType: latest.eventType,
      processingStatus: latest.status,
      livemodeMatches: latest.livemode === deploymentLivemode,
      verifiedByProcessedEvent: latest.status === "PROCESSED" && latest.livemode === deploymentLivemode
    } : {
      state: "none" as const,
      label: "Sin eventos recibidos"
    };
    return jsonResponse({
      stripe: {
        credentials: status.groups.stripe,
        operational: status.stripeOperational,
        webhookHealth
      }
    });
  }
  if (ctx.request.method !== "POST") {
    return methodNotAllowed();
  }
  const input = (await readJsonObject(ctx.request, {
    limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES,
    malformed: "throw"
  })) as StripeCredentialUpdateInput;
  try {
    const patch = buildStripeCredentialSecretPatch(input, ctx.env);
    if (Object.keys(patch).length === 0) {
      return jsonResponse({ error: "no_stripe_credentials_supplied" }, { status: 400 });
    }
    const result = await patchCloudflareWorkerSecrets(ctx.env, patch);
    await ctx.repo.createAudit({
      actorType: "USER",
      actorId: ctx.actor!.id,
      action: "STRIPE_CREDENTIALS_UPDATED",
      entityType: "credentials",
      entityId: "stripe",
      summary: "Configuración de Stripe EE. UU. actualizada",
      metadata: { updated: result.updated, deleted: result.deleted }
    });
    return jsonResponse({ ok: true, updated: result.updated, deleted: result.deleted });
  } catch (error) {
    return stripeCredentialMutationError(error);
  }
}

async function handleStripeWebhookSecretStage(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method !== "POST") return methodNotAllowed();
  const body = await readJsonObject(ctx.request, {
    limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES,
    malformed: "throw"
  });
  const value = typeof body.webhookSecretNext === "string" ? body.webhookSecretNext : "";
  try {
    return await applyStripeWebhookSecretAction(
      ctx,
      buildStripeWebhookStagePatch(value),
      "STRIPE_WEBHOOK_SECRET_STAGED",
      "Secreto siguiente del webhook de Stripe preparado",
      "stage"
    );
  } catch (error) {
    return stripeCredentialMutationError(error);
  }
}

async function handleStripeWebhookSecretPromote(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method !== "POST") return methodNotAllowed();
  try {
    return await applyStripeWebhookSecretAction(
      ctx,
      buildStripeWebhookPromotionPatch(ctx.env),
      "STRIPE_WEBHOOK_SECRET_PROMOTED",
      "Secreto siguiente del webhook de Stripe promovido",
      "promote"
    );
  } catch (error) {
    return stripeCredentialMutationError(error);
  }
}

async function handleStripeWebhookSecretCancel(ctx: ApiRouteContext): Promise<Response> {
  if (ctx.request.method !== "POST") return methodNotAllowed();
  try {
    return await applyStripeWebhookSecretAction(
      ctx,
      buildStripeWebhookCancellationPatch(),
      "STRIPE_WEBHOOK_SECRET_CANCELED",
      "Secreto siguiente del webhook de Stripe descartado",
      "cancel"
    );
  } catch (error) {
    return stripeCredentialMutationError(error);
  }
}

async function applyStripeWebhookSecretAction(
  ctx: ApiRouteContext,
  patch: ReturnType<typeof buildStripeWebhookStagePatch>,
  action: string,
  summary: string,
  rotationAction: "stage" | "promote" | "cancel"
): Promise<Response> {
  const result = await patchCloudflareWorkerSecrets(ctx.env, patch);
  await ctx.repo.createAudit({
    actorType: "USER",
    actorId: ctx.actor!.id,
    action,
    entityType: "credentials",
    entityId: "stripe_webhook_secret",
    summary,
    metadata: { action: rotationAction, updated: result.updated, deleted: result.deleted }
  });
  return jsonResponse({ ok: true, updated: result.updated, deleted: result.deleted });
}

function stripeCredentialMutationError(error: unknown): Response {
  if (error instanceof StripeCredentialValidationError) {
    return jsonResponse({ error: error.code }, { status: 400 });
  }
  if (error instanceof CredentialWriterConfigError) {
    return jsonResponse({ error: "credential_writer_not_configured", message: error.message }, { status: 503 });
  }
  return jsonResponse({ error: "stripe_credential_update_failed" }, { status: 502 });
}

async function handleCredentialWriterToken(ctx: ApiRouteContext): Promise<Response> {
  const actor = ctx.actor!;
  if (ctx.request.method !== "POST") {
    return methodNotAllowed();
  }
  const body = (await readJsonObject(ctx.request, { limitBytes: AUTHENTICATED_JSON_BODY_LIMIT_BYTES, malformed: "empty-object" })) as { token?: unknown };
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return jsonResponse({ error: "cloudflare_token_required", message: "Ingrese el token API de Cloudflare." }, { status: 400 });
  }
  try {
    const result = await bootstrapCloudflareWriterToken(ctx.env, token);
    await ctx.repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "CLOUDFLARE_WRITER_ENABLED",
      entityType: "credentials",
      entityId: ctx.env.CLOUDFLARE_SCRIPT_NAME ?? "worker",
      summary: "Edición de secretos desde UI habilitada",
      metadata: { updated: result.updated }
    });
    return jsonResponse({ ok: true, updated: result.updated, credentials: credentialStatus({ ...ctx.env, CLOUDFLARE_API_TOKEN: token }) });
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
  // The Wompi path always parses in "correct" mode, which rejects a body without a
  // receptor — this narrows the optional the reissue mode introduced.
  const correctedReceptor = parsed.receptor;
  if (!correctedReceptor) {
    return jsonResponse(
      { error: "invalid_correction", message: "receptor debe ser un objeto." },
      { status: 400 }
    );
  }
  const requestPayloadSha256 = await fiscalCorrectionRequestDigest(correctedReceptor);

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
    || (
      !["FAILED", "DEAD_LETTERED"].includes(event.issuance_status ?? "")
      && !(
        event.processed_at !== null
        && ["RETRY_QUEUED", "PROCESSING"].includes(event.issuance_status ?? "")
      )
    )
  ) {
    const existing = await existingFiscalCorrectionResponse(
      repo,
      parsed.requestId,
      "WOMPI_EVENT",
      wompiEventId,
      requestPayloadSha256
    );
    if (existing) return existing;
    return fiscalCorrectionConflict(
      "wompi_correction_not_available",
      "El evento Wompi ya no está disponible para una corrección."
    );
  }
  assertDeploymentAllowsAmbiente(env, event.environment);

  const binding = await resolveDonationIntentBinding(repo, payload);
  if (binding.kind === "unbound") {
    return fiscalCorrectionConflict(
      "wompi_intent_binding_unresolved",
      "La intención de donación no coincide con este evento Wompi."
    );
  }
  const beforeData = await effectiveWompiCorrectionData(repo, wompiEventId);
  if (!beforeData) return notFound();
  if (!beforeData.correctable) {
    return fiscalCorrectionNotAllowedResponse(beforeData.guidance);
  }
  const changedFields = fiscalCorrectionChangedFields(
    beforeData.receptor,
    correctedReceptor
  );
  if (changedFields.length === 0) return unchangedFiscalCorrectionResponse();

  const config = getEmisorConfig(env);
  buildCorrectedWompiCandidate({
    payload,
    intent: binding.kind === "bound" ? binding.intent : null,
    correction: correctedReceptor,
    config,
    environment: event.environment,
    sequence: event.control_sequence ?? 1,
    codigoGeneracion: event.reserved_codigo_generacion ?? undefined
  });

  const claim = await repo.claimWompiFiscalCorrection({
    wompiEventId,
    requestId: parsed.requestId,
    requestPayloadSha256,
    environment: event.environment,
    beforeReceptorJson: fiscalCorrectionPayload(beforeData.receptor),
    correctedReceptorJson: fiscalCorrectionPayload(correctedReceptor),
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

// mode "correct": the donor's data caused the rejection, so the operator edits the
// receptor and at least one field must change.
// mode "reissue": the rejection had nothing to do with the receptor (a bad certificate,
// a misconfigured emisor). Nothing to edit — the SAME receptor is re-issued once the
// configuration is fixed. The two are mutually exclusive by design: each refuses the
// other's failures, so a data problem can never be "retried" into another rejection and
// a config problem can never be worked around by rewriting a donor's fiscal address.
// Everything downstream is shared: idempotency, the fiscal claim, the ambiente policy,
// the trusted-source check, and the fresh codigoGeneracion/numeroControl allocation.
async function handleDocumentFiscalCorrection(
  request: Request,
  env: Env,
  repo: Repository,
  actor: AuthUser,
  documentId: string,
  mode: "correct" | "reissue" = "correct"
): Promise<Response> {
  const parsed = await readFiscalCorrectionRequest(request, mode);
  if (parsed instanceof Response) return parsed;

  const document = await repo.getDteDocument(documentId);
  if (!document) return notFound();
  // A reissue carries no receptor: it re-uses the document's own, so the payload it is
  // idempotent over can only be derived once the document is loaded.
  let effectiveReceptor: FiscalReceptorCorrection;
  if (mode === "reissue") {
    try {
      effectiveReceptor = effectiveDocumentCorrectionData(document).receptor;
    } catch {
      return fiscalCorrectionConflict(
        "reissue_source_unreadable",
        "El JSON original del CDE no pudo leerse para reemitirlo."
      );
    }
  } else {
    effectiveReceptor = parsed.receptor!;
  }
  const requestPayloadSha256 = await fiscalCorrectionRequestDigest(effectiveReceptor);
  const existing = await existingFiscalCorrectionResponse(
    repo,
    parsed.requestId,
    "DTE_DOCUMENT",
    documentId,
    requestPayloadSha256
  );
  if (existing) return existing;
  if (document.fiscal_operation_claim_id) {
    return fiscalCorrectionConflict(
      "fiscal_outcome_pending_reconciliation",
      "El resultado fiscal está pendiente de conciliación."
    );
  }
  if (document.status !== "REJECTED") {
    return fiscalCorrectionConflict(
      "document_correction_not_available",
      "Solo un CDE rechazado explícitamente puede corregirse."
    );
  }
  assertDeploymentAllowsAmbiente(env, document.environment);
  if (
    !document.wompi_event_id
    && !deploymentEnvironmentPolicy(env).directGenerationAllowed
  ) {
    return jsonResponse(
      { error: "document_correction_direct_generation_disabled" },
      { status: 403 }
    );
  }

  const beforeData = effectiveDocumentCorrectionData(document);
  // The two modes guard each other. A receptor-correctable failure must NOT be reissued
  // unchanged — MH would reject it again and consume another control number doing so —
  // and a configuration failure must NOT be "corrected", because rewriting a donor's
  // fiscal address would not fix the signature and would falsify the document.
  if (mode === "reissue") {
    if (beforeData.correctable) {
      return fiscalCorrectionConflict(
        "reissue_not_applicable",
        "El rechazo señala datos del receptor: corrija los datos en vez de reemitir."
      );
    }
  } else if (!beforeData.correctable) {
    return fiscalCorrectionNotAllowedResponse(beforeData.guidance);
  }
  const changedFields = fiscalCorrectionChangedFields(
    beforeData.receptor,
    effectiveReceptor
  );
  // A reissue changes nothing by definition; only a correction must actually differ.
  if (mode === "correct" && changedFields.length === 0) {
    return unchangedFiscalCorrectionResponse();
  }

  const config = getEmisorConfig(env);
  try {
    await assertDirectCorrectionSourceTrusted({
      sourceDocument: document,
      config,
      certificateXml: () => getMhCertificateXml(env)
    });
  } catch {
    return fiscalCorrectionNotAllowedResponse(
      "El emisor del CDE original no pudo verificarse."
    );
  }
  buildCorrectedDirectCandidate({
    sourceDocument: document,
    correction: effectiveReceptor,
    config,
    sequence: 1
  });

  const claim = await repo.claimDocumentFiscalCorrection({
    documentId,
    requestId: parsed.requestId,
    requestPayloadSha256,
    environment: document.environment,
    beforeReceptorJson: fiscalCorrectionPayload(beforeData.receptor),
    correctedReceptorJson: fiscalCorrectionPayload(effectiveReceptor),
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
  request: Request,
  mode: "correct" | "reissue" = "correct"
): Promise<{
  requestId: string;
  // Absent in "reissue": the receptor is taken from the document being re-issued, so a
  // caller cannot smuggle receptor edits in through this endpoint.
  receptor?: FiscalReceptorCorrection;
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
  if (mode === "reissue") {
    // Nothing to validate beyond the request id: a reissue must not carry a receptor,
    // and accepting one would let it become an unaudited correction.
    if (body.receptor !== undefined) {
      return jsonResponse(
        {
          error: "protected_field",
          message: "Una reemisión no acepta datos del receptor."
        },
        { status: 400 }
      );
    }
    return { requestId };
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
  return normalizeUuidV4(value);
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
  requestPayloadSha256: string
): Promise<Response | null> {
  const existing = await repo.getFiscalCorrectionByRequestId(requestId);
  if (!existing) return null;
  const existingTargetId = existing.target_kind === "WOMPI_EVENT"
    ? existing.wompi_event_id
    : existing.document_id;
  if (
    existing.target_kind !== targetKind
    || existingTargetId !== targetId
    || existing.request_payload_sha256 !== requestPayloadSha256
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

function wompiCorrectionRequiredResponse(): Response {
  return fiscalCorrectionConflict(
    "correction_required",
    "Corrija los datos del donante antes de reintentar la creación del CDE."
  );
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
  actor: AuthUser,
  documentId: string,
  action?: string
): Promise<Response> {
  const document = await repo.getDteDocument(documentId);
  if (!document) {
    return notFound();
  }

  if (!action && request.method === "GET") {
    // donorDataVerified: this CDE was produced from a completed donation-intent, so
    // the donor's data came from the validated /donar form rather than the raw webhook.
    const [
      completedIntent,
      receiptEmailDelivery,
      fiscalReconciliation,
      audit
    ] = await Promise.all([
      repo.getCompletedIntentForDocument(document.id),
      repo.getLatestReceiptEmailDelivery(document.id),
      repo.getFailedWompiFiscalCorrectionForDocument(document.id),
      listAuditForUser(repo, actor, "dte_document", document.id)
    ]);
    return jsonResponse({
      document,
      donorDataVerified: completedIntent !== null,
      receiptEmailDelivery,
      fiscalReconciliation,
      audit
    });
  }

  if (action === "pdf" && request.method === "GET") {
    const pdf = await renderDtePdf(document, await loadPdfBrandingLogo(env));
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
