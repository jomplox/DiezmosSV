import type { Env } from "../types";
import type { Repository } from "../storage/repository";
import { brandingOrigin, loadEmailBranding } from "./branding";
import { operationalAlertHtml } from "./emailHtml";
import { EmailService } from "./email";

export const ALERT_EMAIL_SETTING_KEY = "alert_email";
const ALERT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALERT_WEBHOOK_TIMEOUT_MS = 10_000;

export interface OperationalAlert {
  kind: string;
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
  incidentId: string;
}

type AlertChannel = "email" | "webhook";

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

  let recipients: string[] = [];
  try {
    recipients = parseAlertRecipients(await repo.getSetting(ALERT_EMAIL_SETTING_KEY)) ?? [];
  } catch (error) {
    await recordChannelResult(repo, alert, incidentId, "email", "FAILED", error);
  }

  if (recipients.length > 0) {
    await dispatchChannel(repo, alert, incidentId, "email", async () => {
      const branding = await loadEmailBranding(repo, env);
      const html = operationalAlertHtml(alert, originUrl(env), branding);
      const email = new EmailService(env, undefined, branding);
      for (const recipient of recipients) {
        await email.sendOperationalAlert({
          to: recipient,
          subject: alert.title,
          text: alert.detail,
          html
        });
      }
    });
  }

  if (env.ALERT_WEBHOOK_URL?.trim()) {
    await dispatchChannel(repo, alert, incidentId, "webhook", async () => {
      await sendAlertWebhook(env, alert);
    });
  }
}

async function dispatchChannel(
  repo: Repository,
  alert: OperationalAlert,
  incidentId: string,
  channel: AlertChannel,
  dispatch: () => Promise<void>
): Promise<void> {
  try {
    const alreadySent = await repo.hasOperationalAlertChannelResult({
      action: `ALERT_SENT:${alert.kind}`,
      entityType: alert.entityType,
      entityId: alert.entityId,
      incidentId,
      channel
    });
    if (alreadySent) {
      return;
    }
    await dispatch();
    await recordChannelResult(repo, alert, incidentId, channel, "SENT");
  } catch (error) {
    await recordChannelResult(repo, alert, incidentId, channel, "FAILED", error);
  }
}

async function recordChannelResult(
  repo: Repository,
  alert: OperationalAlert,
  incidentId: string,
  channel: AlertChannel,
  status: "SENT" | "FAILED",
  error?: unknown
): Promise<void> {
  try {
    await repo.createAudit({
      action: `ALERT_${status}:${alert.kind}`,
      entityType: alert.entityType,
      entityId: alert.entityId,
      summary: status === "SENT" ? alert.title : errorMessage(error),
      metadata: { incidentId, channel }
    });
  } catch {
    // Alerting must never break the operation that triggered it. If D1 is also
    // unavailable there is nowhere durable to record this secondary failure.
  }
}

async function sendAlertWebhook(env: Env, alert: OperationalAlert): Promise<void> {
  let url: URL;
  try {
    url = new URL(env.ALERT_WEBHOOK_URL ?? "");
  } catch {
    throw new Error("ALERT_WEBHOOK_URL no es una URL válida");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("ALERT_WEBHOOK_URL debe ser una URL HTTPS sin credenciales");
  }
  const message = [
    alert.title,
    alert.detail,
    `Tipo de alerta: ${alert.kind}`,
    `Entidad: ${alert.entityType}`,
    `ID: ${alert.entityId}`,
    `Panel: ${originUrl(env)}`
  ].join("\n\n");
  const body =
    env.ALERT_WEBHOOK_KIND === "slack"
      ? { text: message }
      : env.ALERT_WEBHOOK_KIND === "discord"
        ? { content: message }
        : null;
  if (!body) {
    throw new Error("ALERT_WEBHOOK_KIND debe ser slack o discord");
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS)
    });
  } catch {
    throw new Error("No se pudo entregar el webhook de alertas");
  }
  if (!response.ok) {
    throw new Error(`El webhook de alertas respondió HTTP ${response.status}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
