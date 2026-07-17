import type {
  AnalyticsFunnel,
  AnalyticsHeatmapCell,
  AnalyticsMonthlyPoint,
  AnalyticsResponse,
  AnalyticsYoyPoint
} from "./types";

// Pure client helpers for the Analítica view: formatting + series transforms. No React
// here — these are unit-testable in isolation. Amounts arrive as integer cents.

export type ClientAnalytics = AnalyticsResponse;

export type GiftTypeFilter = "todos" | "diezmo" | "ofrenda";

const SPANISH_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// USD from integer cents with thousands separators, e.g. 123456 -> "$1,234.56".
export function formatCentsUsd(cents: number): string {
  const value = cents / 100;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "2026-07" -> "jul 2026" (usted-form Spanish month abbreviation + year).
export function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const name = SPANISH_MONTHS[(month - 1) % 12] ?? monthKey;
  return `${name} ${year}`;
}

// Monday week key "2026-07-06" -> "06/07" (dd/mm).
export function formatWeekLabel(weekKey: string): string {
  const [, month, day] = weekKey.split("-");
  return `${day}/${month}`;
}

export interface AnalyticsRangePreset {
  id: "mes" | "trimestre" | "anio" | "anio_anterior" | "personalizado";
  label: string;
  from: string;
  to: string;
}

function isoDay(date: Date): string {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${date.getUTCFullYear()}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}

// El Salvador local "today" from a UTC instant (fixed UTC-6). Presets are computed in
// local time so "Este mes" starts on the first of the local month.
function elSalvadorToday(now: Date): Date {
  return new Date(now.getTime() - 6 * 3_600_000);
}

// Date-range presets. "Personalizado" carries the current custom bounds (defaults to
// the last 90 days) and is what the two date inputs edit.
export function analyticsRangePresets(now: Date): AnalyticsRangePreset[] {
  const local = elSalvadorToday(now);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const today = isoDay(local);
  const monthStart = isoDay(new Date(Date.UTC(year, month, 1)));
  const threeMonthsAgo = isoDay(new Date(Date.UTC(year, month - 2, 1)));
  const yearStart = isoDay(new Date(Date.UTC(year, 0, 1)));
  const priorYearStart = isoDay(new Date(Date.UTC(year - 1, 0, 1)));
  const priorYearEnd = isoDay(new Date(Date.UTC(year - 1, 11, 31)));
  const ninetyAgo = isoDay(new Date(local.getTime() - 89 * 86_400_000));
  return [
    { id: "mes", label: "Este mes", from: monthStart, to: today },
    { id: "trimestre", label: "Últimos 3 meses", from: threeMonthsAgo, to: today },
    { id: "anio", label: "Este año", from: yearStart, to: today },
    { id: "anio_anterior", label: "Año anterior", from: priorYearStart, to: priorYearEnd },
    { id: "personalizado", label: "Personalizado", from: ninetyAgo, to: today }
  ];
}

interface MonthlyChartPoint {
  key: string;
  label: string;
  totalCents: number;
  count: number;
  averageCents: number;
  ratio: number; // normalized height in [0,1]
}

export interface MonthlyChartModel {
  points: MonthlyChartPoint[];
  maxCents: number;
}

// Normalizes a monthly series into ratios for a hand-rolled SVG area/line chart.
export function monthlyChartModel(series: AnalyticsMonthlyPoint[]): MonthlyChartModel {
  const maxCents = series.reduce((max, point) => Math.max(max, point.totalCents), 0);
  return {
    maxCents,
    points: series.map((point) => ({
      key: point.key,
      label: formatMonthLabel(point.key),
      totalCents: point.totalCents,
      count: point.count,
      averageCents: point.averageCents,
      ratio: maxCents > 0 ? point.totalCents / maxCents : 0
    }))
  };
}

export interface YoyChartModel {
  months: string[];
  current: number[];
  prior: number[];
  maxCents: number;
}

// Current vs prior-year overlay on a shared scale for the YoY line chart.
export function yoyChartModel(series: AnalyticsYoyPoint[]): YoyChartModel {
  const maxCents = series.reduce((max, point) => Math.max(max, point.currentCents, point.priorCents), 0);
  return {
    months: series.map((point) => point.month),
    current: series.map((point) => point.currentCents),
    prior: series.map((point) => point.priorCents),
    maxCents
  };
}

// The giving series shown for a gift-type filter. "Todos" is the full monthly total;
// "diezmo"/"ofrenda" project the corresponding slice of the monthly gift split onto the
// same MonthlyPoint shape so the chart code is identical for all three.
export function filterGiftType(analytics: ClientAnalytics, filter: GiftTypeFilter): AnalyticsMonthlyPoint[] {
  if (filter === "todos") {
    return analytics.giving.monthly;
  }
  return analytics.giving.giftSplit.map((split) => {
    const cents = filter === "diezmo" ? split.diezmoCents : split.ofrendaCents;
    return { key: split.key, totalCents: cents, count: 0, averageCents: 0 };
  });
}

export interface FunnelStage {
  label: string;
  count: number;
  dropPct: number;
}

// Four labeled funnel stages in usted-form Spanish. The first stage has no drop-off.
export function funnelStages(funnel: AnalyticsFunnel): FunnelStage[] {
  return [
    { label: "Creadas", count: funnel.created, dropPct: 0 },
    { label: "Datos adjuntos", count: funnel.datos, dropPct: funnel.datosDropPct },
    { label: "Pagadas", count: funnel.paid, dropPct: funnel.paidDropPct },
    { label: "Completadas", count: funnel.completed, dropPct: funnel.completedDropPct }
  ];
}

// Peak cell count, used to scale the heatmap color intensity.
export function heatmapMax(cells: AnalyticsHeatmapCell[]): number {
  return cells.reduce((max, cell) => Math.max(max, cell.count), 0);
}

export const DAY_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
