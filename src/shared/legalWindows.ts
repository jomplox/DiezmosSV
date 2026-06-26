const EL_SALVADOR_TIME_ZONE = "America/El_Salvador";

export function cdeInvalidationDeadline(acceptedAtIso: string): string {
  const accepted = new Date(acceptedAtIso);
  const year = accepted.getUTCFullYear();
  const month = accepted.getUTCMonth();
  const firstFollowingMonth = new Date(Date.UTC(year, month + 1, 1, 23, 59, 59));
  let businessDays = 0;
  const cursor = new Date(firstFollowingMonth);
  while (businessDays < 10) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      businessDays += 1;
    }
    if (businessDays < 10) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return cursor.toISOString();
}

export function isWithinDeadline(deadlineIso: string, reference: Date = new Date()): boolean {
  return reference.getTime() <= new Date(deadlineIso).getTime();
}

export function formatElSalvadorDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-SV", {
    timeZone: EL_SALVADOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")}/${value("month")}/${value("year")}, ${value("hour")}:${value("minute")}`;
}
