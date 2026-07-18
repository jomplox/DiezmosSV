import type { Env } from "../types";
import type { Repository } from "../storage/repository";
import { brandingOrigin, loadEmailBranding } from "./branding";
import { operationalAlertHtml } from "./emailHtml";
import { classifyEmailDispatchError, EmailService } from "./email";
import { logOperationalAlert } from "./observability";

export const ALERT_EMAIL_SETTING_KEY = "alert_email";
const ALERT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OperationalAlert {
  kind: string;
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
  incidentId: string;
}

type AlertChannel = "email";
type AlertTargetResult = {
  channel: AlertChannel;
  executed: boolean;
  status: "SENT" | "FAILED" | "UNRESOLVED";
};

export function normalizeAlertRecipients(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim();
  if (!raw) {
    return "";
  }
  const recipients = parseAlertRecipients(raw);
  return recipients ? recipients.join(", ") : null;
}

export async function sendOperationalAlert(env: Env, repo: Repository, alert: OperationalAlert): Promise<void> {
  const incidentId = alert.incidentId.trim();
  if (!incidentId) {
    return;
  }
  logOperationalAlert(env, alert.kind, alert.entityType);
  const safeAlert = sanitizeOperationalAlert(alert);
  const displayAlert = sanitizeOperationalAlertIdentity(safeAlert);

  let recipients: string[] = [];
  try {
    recipients = parseAlertRecipients(await repo.getSetting(ALERT_EMAIL_SETTING_KEY)) ?? [];
  } catch {
    await recordChannelResult(repo, safeAlert, incidentId, "email", "FAILED");
  }

  const targets: Array<Promise<AlertTargetResult>> = [];
  if (recipients.length > 0) {
    const emailContext = (async () => {
      const branding = await loadEmailBranding(repo, env);
      return {
        html: operationalAlertHtml(displayAlert, originUrl(env), branding),
        email: new EmailService(env, undefined, branding)
      };
    })();
    for (const recipient of recipients) {
      targets.push(dispatchTarget(
        repo,
        safeAlert,
        incidentId,
        "email",
        `email:${recipient.toLowerCase()}`,
        async (beforeProviderDispatch) => {
          const context = await emailContext;
          await context.email.sendOperationalAlert({
            to: recipient,
            subject: safeAlert.title,
            text: safeAlert.detail,
            html: context.html
          }, beforeProviderDispatch);
        }
      ));
    }
  }

  const settled = await Promise.allSettled(targets);
  const results = settled.map<AlertTargetResult>((result) =>
    result.status === "fulfilled"
      ? result.value
      : { channel: "email", executed: false, status: "FAILED" }
  );
  if (results.some((result) => result.executed)) {
    const status = results.every((result) => result.status === "SENT")
      ? "SENT"
      : "FAILED";
    await recordChannelResult(repo, safeAlert, incidentId, "email", status);
  }
}

async function dispatchTarget(
  repo: Repository,
  alert: OperationalAlert,
  incidentId: string,
  channel: AlertChannel,
  targetKey: string,
  dispatch: (beforeProviderDispatch: () => Promise<void>) => Promise<void>
): Promise<AlertTargetResult> {
  let claim;
  try {
    claim = await repo.claimOperationalAlertDelivery({
      kind: alert.kind,
      entityType: alert.entityType,
      entityId: alert.entityId,
      incidentId,
      channel,
      targetKey
    });
  } catch {
    return { channel, executed: false, status: "FAILED" };
  }
  if (claim.kind === "already_sent") {
    return { channel, executed: false, status: "SENT" };
  }
  if (claim.kind !== "claimed") {
    return { channel, executed: false, status: "UNRESOLVED" };
  }

  let providerDispatchStarted = false;
  try {
    await dispatch(async () => {
      const marked = await repo.markOperationalAlertDispatchStarted(
        claim.id,
        claim.claimToken
      );
      if (!marked) {
        throw new Error("La reserva de alerta perdió propiedad antes del envío");
      }
      providerDispatchStarted = true;
    });
    await repo.finalizeOperationalAlertDelivery(claim.id, claim.claimToken, {
      status: "SENT"
    });
    return { channel, executed: true, status: "SENT" };
  } catch (error) {
    const failure = classifyEmailDispatchError(error, providerDispatchStarted);
    try {
      await repo.finalizeOperationalAlertDelivery(claim.id, claim.claimToken, {
        status: "FAILED",
        outcomeClass: failure.outcomeClass,
        failureCode: failure.code,
        retrySafe: failure.retrySafe
      });
    } catch {
      // A post-dispatch PENDING claim is intentionally fail-closed. Its durable
      // dispatch marker prevents a duplicate alert if finalization also failed.
    }
    return { channel, executed: true, status: "FAILED" };
  }
}

async function recordChannelResult(
  repo: Repository,
  alert: OperationalAlert,
  incidentId: string,
  channel: AlertChannel,
  status: "SENT" | "FAILED"
): Promise<void> {
  try {
    await repo.createAudit({
      action: `ALERT_${status}:${alert.kind}`,
      entityType: alert.entityType,
      entityId: alert.entityId,
      summary: status === "SENT"
        ? alert.title
        : `No se pudo entregar la alerta por ${channel}.`,
      metadata: { incidentId, channel }
    });
  } catch {
    // Alerting must never break the operation that triggered it. If D1 is also
    // unavailable there is nowhere durable to record this secondary failure.
  }
}

function sanitizeOperationalAlert(alert: OperationalAlert): OperationalAlert {
  return {
    ...alert,
    title: sanitizeAlertText(alert.title, "Alerta operativa", 180),
    detail: sanitizeAlertText(
      alert.detail,
      "Revise el panel de administración para consultar el incidente.",
      1_000
    )
  };
}

function sanitizeOperationalAlertIdentity(alert: OperationalAlert): OperationalAlert {
  return {
    ...alert,
    entityType: sanitizeAlertText(alert.entityType, "entidad", 80),
    entityId: sanitizeAlertText(alert.entityId, "identificador protegido", 180)
  };
}

function sanitizeAlertText(value: string, fallback: string, maxChars: number): string {
  const redacted = value
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, "Authorization: [REDACTADO]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTADO]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[CORREO]")
    .replace(/\b(?:sk|pk|api|token)[-_][A-Za-z0-9_-]{8,}\b/gi, "[SECRETO]")
    .trim();
  return (redacted || fallback).slice(0, maxChars);
}

// The alert body links back to the admin panel with a trailing slash (historical form);
// brandingOrigin returns the same origin without one, so re-add it here.
function originUrl(env: Env): string {
  return `${brandingOrigin(env).replace(/\/+$/, "")}/`;
}

function parseAlertRecipients(value: string | null | undefined): string[] | null {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return [];
  }
  const parts = raw.split(",");
  const recipients = parts.map((part) => part.trim());
  if (recipients.some((recipient) => !recipient || !ALERT_EMAIL_PATTERN.test(recipient))) {
    return null;
  }
  return recipients;
}
