import type { Env } from "../types";
import type { Repository } from "../storage/repository";
import { brandingOrigin, loadEmailBranding } from "./branding";
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
    const branding = await loadEmailBranding(repo, env);
    const html = operationalAlertHtml(alert, originUrl(env), branding);
    await new EmailService(env, undefined, branding).sendOperationalAlert({
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

// The alert body links back to the admin panel with a trailing slash (historical form);
// brandingOrigin returns the same origin without one, so re-add it here.
function originUrl(env: Env): string {
  return `${brandingOrigin(env).replace(/\/+$/, "")}/`;
}
