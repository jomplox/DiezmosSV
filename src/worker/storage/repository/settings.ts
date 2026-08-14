import { nowIso } from "../../utils/dates";
import { newId } from "../../utils/ids";
import {
  normalizeAuditIp,
  serializeAuditContext,
  type AuditRequestContext
} from "../../services/requestContext";
import type {
  EmailTemplateScope,
  EmailTemplateSettings
} from "../../services/emailTemplates";

export class EmailTemplateSnapshotConflictError extends Error {
  constructor(readonly currentRaw: string | null) {
    super("email template settings snapshot changed");
  }
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string, updatedBy?: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .bind(key, value, updatedBy ?? null, nowIso())
    .run();
}

export async function saveScopedEmailTemplates(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  input: {
    key: string;
    scope: EmailTemplateScope;
    patch: Partial<EmailTemplateSettings>;
    initialTemplates: EmailTemplateSettings;
    actorId: string;
    expectedRaw: string | null;
  }
): Promise<string> {
  const updatedAt = nowIso();
  const patchJson = JSON.stringify(input.patch);
  const templateTypes = Object.keys(input.patch);
  const settingsMutation = db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE
           WHEN app_settings.value = ? THEN json_patch(app_settings.value, ?)
           ELSE NULL
         END,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(
      input.key,
      JSON.stringify(input.initialTemplates),
      input.actorId,
      updatedAt,
      input.expectedRaw,
      patchJson
    );
  const auditInsert = db
    .prepare(
      `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, entity_type, entity_id, summary,
         metadata_json, actor_ip, actor_context, rate_limit_claim_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId("audit"),
      "USER",
      input.actorId,
      "EMAIL_TEMPLATES_UPDATED",
      "app_setting",
      input.key,
      "Plantillas de correo actualizadas",
      JSON.stringify({ types: templateTypes, scope: input.scope }),
      normalizeAuditIp(auditContext?.ip ?? null),
      serializeAuditContext(auditContext?.context),
      null
    );

  try {
    await db.batch([settingsMutation, auditInsert]);
  } catch (error) {
    const currentRaw = await getSetting(db, input.key);
    if (currentRaw !== input.expectedRaw) {
      throw new EmailTemplateSnapshotConflictError(currentRaw);
    }
    throw error;
  }
  const stored = await getSetting(db, input.key);
  if (stored === null) {
    throw new Error("scoped email template setting missing after save");
  }
  return stored;
}
