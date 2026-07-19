export type RepositoryHost<TRepository, TMethod extends keyof TRepository> =
  Pick<TRepository, TMethod>;

// The alert-email setting is OWNER-only, but its ALERT_EMAIL_UPDATED audit rows are
// readable by lower roles through the audit trail. Newer writes never record the
// address, but rows written before that fix still carry it in the summary/metadata, so
// the read path scrubs those columns for the app_setting/alert_email entity regardless
// of role. It keeps that an update happened; it only drops the address value.
export function redactSensitiveAuditRows(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    if (row.entity_type !== "app_setting" || row.entity_id !== "alert_email") {
      return row;
    }
    return {
      ...row,
      summary: row.action === "ALERT_EMAIL_UPDATED" ? "Correo de alertas actualizado" : row.summary,
      metadata_json: "{}"
    };
  });
}
