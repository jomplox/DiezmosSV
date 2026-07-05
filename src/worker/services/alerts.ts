import type { Env } from "../types";
import type { Repository } from "../storage/repository";
import { operationalAlertHtml } from "./emailHtml";
import { EmailService } from "./email";

export const ALERT_EMAIL_SETTING_KEY = "alert_email";

export interface OperationalAlert {
  kind: string;
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
}

export async function sendOperationalAlert(env: Env, repo: Repository, alert: OperationalAlert): Promise<void> {
  try {
    const recipient = (await repo.getSetting(ALERT_EMAIL_SETTING_KEY))?.trim();
    if (!recipient) {
      return;
    }
    const dedupeAction = `ALERT_SENT:${alert.kind}`;
    const alreadySent = await repo.countAuditEntries(dedupeAction, alert.entityId);
    if (alreadySent > 0) {
      return;
    }
    const html = operationalAlertHtml(alert, originUrl(env));
    await new EmailService(env).sendOperationalAlert({
      to: recipient,
      subject: alert.title,
      text: alert.detail,
      html
    });
    await repo.createAudit({
      action: dedupeAction,
      entityType: alert.entityType,
      entityId: alert.entityId,
      summary: alert.title
    });
  } catch (error) {
    try {
      await repo.createAudit({
        action: `ALERT_FAILED:${alert.kind}`,
        entityType: alert.entityType,
        entityId: alert.entityId,
        summary: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Auditing the alert failure itself failed (e.g. DB unavailable). Swallow it:
      // this helper must never break the flow that triggered the alert.
    }
  }
}

function originUrl(env: Env): string {
  const appOrigin = env.APP_ORIGIN?.trim();
  if (appOrigin) {
    return appOrigin;
  }
  const scriptName = env.CLOUDFLARE_SCRIPT_NAME?.trim();
  return scriptName ? `https://${scriptName}.workers.dev/` : "https://diezmos.example.org/";
}
