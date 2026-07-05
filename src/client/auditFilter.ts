import { auditActionLabel } from "./displayText";
import type { AuditRow } from "./types";

export function filterAuditEntries(entries: AuditRow[], query: string): AuditRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => {
    const haystack = [auditActionLabel(entry.action), entry.action, entry.summary, entry.entity_type, entry.entity_id, entry.actor_id ?? ""]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
