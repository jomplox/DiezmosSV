import type { Env } from "../types";

const TOKEN_MAX_LENGTH = 64;
const APP_ENVIRONMENTS = new Set(["local", "staging", "production"]);
const ERROR_NAMES = new Set([
  "aggregateerror",
  "emaildispatcherror",
  "error",
  "evalerror",
  "mhpredispatcherror",
  "rangeerror",
  "referenceerror",
  "stripeconfigurationerror",
  "stripedonationvalidationerror",
  "stripegiftconflicterror",
  "stripewebhookeventerror",
  "stripewebhooksignatureerror",
  "syntaxerror",
  "typeerror",
  "urierror"
]);
const ERROR_CODES = new Set([
  "analytics_range_too_large",
  "checkout_identity_mismatch",
  "checkout_not_found",
  "checkout_update_failed",
  "email_dispatch_unknown",
  "email_pre_dispatch_failed",
  "environment_not_allowed",
  "event_claim_lost",
  "event_mode_mismatch",
  "event_object_invalid",
  "invalid_app_environment",
  "invalid_app_origin",
  "invalid_billing_portal_configuration",
  "invalid_ein",
  "invalid_legal_name",
  "invalid_organization_name",
  "invalid_payment_method_configuration",
  "invalid_webhook_secret",
  "invoice_amount_invalid",
  "invoice_amount_mismatch",
  "invoice_checkout_conflict",
  "invoice_gift_not_found",
  "invoice_metadata_invalid",
  "invoice_payment_amount_mismatch",
  "invoice_payment_conflict",
  "invoice_payment_type_invalid",
  "key_environment_mismatch",
  "missing_billing_portal_configuration",
  "missing_ein",
  "missing_legal_name",
  "missing_payment_method_configuration",
  "missing_restricted_key",
  "missing_webhook_secret",
  "mock_mode_forbidden",
  "monthly_checkout_not_found",
  "payment_collection_disabled",
  "payment_intent_missing",
  "refund_gift_not_found",
  "refund_amount_invalid",
  "refund_payment_intent_missing",
  "restricted_key_required",
  "stripe_identifier_invalid",
  "subscription_checkout_conflict",
  "subscription_metadata_invalid",
  "subscription_update_failed",
  "wompi_intent_quarantined"
]);
const ERROR_EVENTS = new Set([
  "accepted_wompi_finalization_failed",
  "accepted_wompi_finalization_retry_failed",
  "certificate_expiry_check_failed",
  "deferred_transmission_retry_failed",
  "deferred_transmission_retry_sweep_failed",
  "donation_intent_expiry_sweep_failed",
  "issuance_message_failed",
  "manual_receipt_resend_audit_failed",
  "mark_intent_paid_from_webhook_failed",
  "password_reset_request_failed",
  "post_accept_finalization_failed",
  "post_accept_finalization_sweep_failed",
  "queue_handler_failed",
  "receipt_delivery_audit_failed",
  "retention_export_failed",
  "retention_partial_object_cleanup_failed",
  "retention_temp_object_cleanup_failed",
  "scheduled_handler_failed",
  "stalled_wompi_event_sweep_failed",
  "stripe_acknowledgment_delivery_failed",
  "stripe_annual_statement_audit_failed",
  "stripe_acknowledgment_sweep_failed",
  "stripe_checkout_create_failed",
  "stripe_portal_create_failed",
  "stripe_webhook_processing_failed",
  "unhandled_worker_request_error",
  "wompi_issuance_failure_list_failed",
  "wompi_issuance_retry_failed",
  "wompi_link_deactivation_failed",
  "wompi_payment_link_reconciliation_failed"
]);
const ALERT_KINDS = new Set([
  "advanced_cde_failed",
  "branding_logo_fallback",
  "cert_expiring",
  "dte_failed",
  "email_failed",
  "issuance_dead_lettered",
  "mh_unavailable",
  "retention_export_failed",
  "retention_verify_failed",
  "wompi_event_stalled"
]);
const ALERT_ENTITY_TYPES = new Set([
  "credentials",
  "dte_document",
  "retention_export",
  "wompi_event"
]);

type ErrorEvent = {
  event: string;
  app_env: string;
  error_name: string;
  error_code: string;
};

type OperationalAlertEvent = {
  event: "operational_alert";
  app_env: string;
  alert_kind: string;
  entity_type: string;
};

export function logWorkerError(env: Env, event: string, error: unknown): void {
  const output: ErrorEvent = {
    event: allowlistedToken(event, ERROR_EVENTS),
    app_env: allowlistedToken(safeProperty(env, "APP_ENV"), APP_ENVIRONMENTS),
    error_name: allowlistedToken(safeErrorProperty(error, "name"), ERROR_NAMES),
    error_code: allowlistedToken(safeErrorProperty(error, "code"), ERROR_CODES)
  };
  console.error(output);
}

export function logOperationalAlert(env: Env, alertKind: string, entityType: string): void {
  const output: OperationalAlertEvent = {
    event: "operational_alert",
    app_env: allowlistedToken(safeProperty(env, "APP_ENV"), APP_ENVIRONMENTS),
    alert_kind: allowlistedToken(alertKind, ALERT_KINDS),
    entity_type: allowlistedToken(entityType, ALERT_ENTITY_TYPES)
  };
  console.error(output);
}

function allowlistedToken(value: unknown, allowed: ReadonlySet<string>): string {
  const normalized = normalizedToken(value);
  return allowed.has(normalized) ? normalized : "unknown";
}

function normalizedToken(value: unknown): string {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TOKEN_MAX_LENGTH);
  return normalized || "unknown";
}

function safeErrorProperty(error: unknown, key: "name" | "code"): unknown {
  try {
    return error instanceof Error ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}
