const EL_SALVADOR_TIME_ZONE = "America/El_Salvador";
const EL_SALVADOR_UTC_OFFSET_HOURS = 6;

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export function cdeInvalidationDeadline(acceptedAtIso: string): string {
  const acceptedDate = localDateParts(new Date(acceptedAtIso));
  const deadlineDate = new Date(Date.UTC(acceptedDate.year, acceptedDate.month - 1, acceptedDate.day + 4, 12, 0, 0));
  return endOfElSalvadorDayIso({
    year: deadlineDate.getUTCFullYear(),
    month: deadlineDate.getUTCMonth() + 1,
    day: deadlineDate.getUTCDate()
  });
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

function endOfElSalvadorDayIso(date: LocalDateParts): string {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 23 + EL_SALVADOR_UTC_OFFSET_HOURS, 59, 59)).toISOString();
}

function localDateParts(input: Date): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EL_SALVADOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(input);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day") };
}
