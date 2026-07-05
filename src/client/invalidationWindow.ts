import { cdeInvalidationDeadline, formatElSalvadorDateTime, isWithinDeadline } from "../shared/legalWindows";
import type { DteDocument } from "./types";

export interface InvalidationWindowInfo {
  canInvalidate: boolean;
  deadlineIso: string | null;
  deadlineLabel: string | null;
  title: string;
  remainingLabel: string;
  tone: "ok" | "warning" | "expired" | "pending";
}

export function invalidationWindowInfo(document: DteDocument, reference: Date = new Date()): InvalidationWindowInfo {
  if (document.status === "INVALIDATED") {
    return {
      canInvalidate: false,
      deadlineIso: null,
      deadlineLabel: null,
      title: "CDE invalidado",
      remainingLabel: "Este CDE ya fue invalidado ante el Ministerio de Hacienda.",
      tone: "pending"
    };
  }

  if (document.status !== "ACCEPTED" || !document.sello_recibido || !document.accepted_at) {
    return {
      canInvalidate: false,
      deadlineIso: null,
      deadlineLabel: null,
      title: "Ventana de invalidación CDE",
      remainingLabel: "Disponible cuando el CDE tenga sello recibido.",
      tone: "pending"
    };
  }

  const deadlineIso = cdeInvalidationDeadline(document.accepted_at);
  const deadlineLabel = formatElSalvadorDateTime(deadlineIso);
  if (!isWithinDeadline(deadlineIso, reference)) {
    return {
      canInvalidate: false,
      deadlineIso,
      deadlineLabel,
      title: "Ventana de invalidación CDE",
      remainingLabel: "La ventana legal de invalidación ya cerró.",
      tone: "expired"
    };
  }

  const remainingMs = Math.max(0, new Date(deadlineIso).getTime() - reference.getTime());
  return {
    canInvalidate: true,
    deadlineIso,
    deadlineLabel,
    title: "Ventana de invalidación CDE",
    remainingLabel: `Quedan ${formatRemainingTime(remainingMs)} para invalidar este CDE.`,
    tone: remainingMs <= 24 * 60 * 60 * 1000 ? "warning" : "ok"
  };
}

function formatRemainingTime(milliseconds: number): string {
  const totalHours = Math.max(0, Math.floor(milliseconds / (60 * 60 * 1000)));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) return `${days} ${plural(days, "día", "días")} y ${hours} ${plural(hours, "hora", "horas")}`;
  if (days > 0) return `${days} ${plural(days, "día", "días")}`;
  if (hours > 0) return `${hours} ${plural(hours, "hora", "horas")}`;
  const minutes = Math.max(1, Math.ceil(milliseconds / (60 * 1000)));
  return `${minutes} ${plural(minutes, "minuto", "minutos")}`;
}

function plural(value: number, singular: string, pluralValue: string): string {
  return value === 1 ? singular : pluralValue;
}
