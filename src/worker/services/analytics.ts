import { RETENTION_PAGE_SIZE, type Repository } from "../storage/repository";
import type { Ambiente, DonationGiftType } from "../types";

// Analítica: tendencias del carril Wompi EXCLUSIVAMENTE (documentos con
// wompi_event_id NOT NULL + sus donation_intents). Los CDE emitidos a mano
// (rápido/avanzado) quedan fuera POR DISEÑO — nunca llevan wompi_event_id.
//
// Todo el bucketing de fechas usa America/El_Salvador como offset fijo UTC-6 (sin
// horario de verano en El Salvador), reflejando el helper de certificate.ts.
const EL_SALVADOR_UTC_OFFSET_HOURS = 6;

// Filas planas leídas por SELECTs paginados (una tabla por lector). Las funciones
// puras de agregación consumen estas filas y devuelven métricas; se prueban
// exhaustivamente con fixtures sin tocar D1.
export interface AnalyticsDocumentRow {
  id: string;
  wompi_event_id: string | null;
  environment: Ambiente;
  status: string;
  donor_email: string | null;
  donor_name: string | null;
  amount_cents: number;
  issued_at: string;
  accepted_at: string | null;
  transmission_deferred_at: string | null;
  // Correlacionados desde donation_intents por el LEFT JOIN del lector (pueden ser
  // null cuando el documento del carril Wompi no tiene intent asociado — legado).
  direccion_departamento: string | null;
  donor_pais: string | null;
  gift_type: DonationGiftType | null;
}

export interface AnalyticsIntentRow {
  id: string;
  status: string;
  document_id: string | null;
  donor_document: string | null;
  gift_type: DonationGiftType | null;
  created_at: string;
  paid_at: string | null;
}

export interface AnalyticsEmailRow {
  document_id: string;
  status: string;
  created_at: string;
}

export interface AnalyticsRange {
  from: string; // YYYY-MM-DD (inclusive, El Salvador local)
  to: string; // YYYY-MM-DD (inclusive, El Salvador local)
}

// ----- El Salvador local time helpers (fixed UTC-6) -----

// Shift a UTC instant back by the El Salvador offset so the calendar fields of the
// resulting Date (read in UTC) equal the El Salvador local wall-clock fields.
function elSalvadorLocalDate(iso: string): Date {
  const instant = new Date(iso);
  return new Date(instant.getTime() - EL_SALVADOR_UTC_OFFSET_HOURS * 3_600_000);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function elSalvadorMonthKey(iso: string): string {
  const local = elSalvadorLocalDate(iso);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}`;
}

export function elSalvadorDayKey(iso: string): string {
  const local = elSalvadorLocalDate(iso);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
}

// Monday-of-week key (ISO week start) in El Salvador local time. getUTCDay is
// 0=Sun..6=Sat on the shifted date; we re-base to 0=Mon..6=Sun and step back.
export function elSalvadorWeekKey(iso: string): string {
  const local = elSalvadorLocalDate(iso);
  const dayMon0 = (local.getUTCDay() + 6) % 7;
  const monday = new Date(local.getTime() - dayMon0 * 86_400_000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

// day: 0=Mon..6=Sun, hour: 0..23 in El Salvador local time.
export function elSalvadorHourOfWeek(iso: string): { day: number; hour: number } {
  const local = elSalvadorLocalDate(iso);
  return { day: (local.getUTCDay() + 6) % 7, hour: local.getUTCHours() };
}

// Difference in whole months between two YYYY-MM keys (right - left).
function monthDiff(fromKey: string, toKey: string): number {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// Add `count` months to a YYYY-MM key.
function addMonthKey(key: string, count: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + count;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
}

// Donor identity key: donor_email when present, else donor_name (same convention as
// certificate.ts aggregateAnnualDonors). Trimmed; empty falls through to the fallback.
function donorKey(email: string | null, name: string | null): string {
  const e = (email ?? "").trim();
  if (e) return e.toLowerCase();
  const n = (name ?? "").trim();
  return n ? n.toLowerCase() : "(sin identificar)";
}

function displayName(email: string | null, name: string | null): string {
  const n = (name ?? "").trim();
  if (n) return n;
  const e = (email ?? "").trim();
  return e || "(sin identificar)";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

// ----- Public metric shapes -----

export interface MonthlyPoint {
  key: string; // YYYY-MM
  totalCents: number;
  count: number;
  averageCents: number;
}

export interface WeeklyPoint {
  key: string; // Monday YYYY-MM-DD
  totalCents: number;
  count: number;
}

export interface GiftSplitPoint {
  key: string;
  diezmoCents: number;
  ofrendaCents: number;
  otherCents: number;
}

export interface DonorMixPoint {
  key: string;
  newDonors: number;
  returningDonors: number;
}

export interface YoyPoint {
  // month-of-year label (01..12) with current-year and prior-year totals overlaid.
  month: string; // MM
  currentCents: number;
  priorCents: number;
}

export interface TopDonor {
  donorName: string;
  donorEmail: string | null;
  count: number;
  totalCents: number;
}

export interface GeoBucket {
  code: string;
  label: string;
  count: number;
  totalCents: number;
}

export interface FunnelMetrics {
  created: number;
  datos: number;
  paid: number;
  completed: number;
  // Drop-off percentage relative to the previous stage (0 when the prior is 0).
  datosDropPct: number;
  paidDropPct: number;
  completedDropPct: number;
  medianMinutesToPay: number;
}

export interface MhHealthMetrics {
  medianLatencySeconds: number;
  p90LatencySeconds: number;
  weeklyRejections: Array<{ key: string; count: number }>;
  weeklyDeferred: Array<{ key: string; count: number }>;
}

export interface EmailWeeklyPoint {
  key: string;
  sent: number;
  failed: number;
}

export interface CohortRow {
  cohort: string; // first-gift month YYYY-MM
  size: number;
  // retention[i] = % of the cohort that gave again i months after the first gift.
  retention: number[];
}

export interface LapsedDonor {
  donorName: string;
  donorEmail: string | null;
  totalCents: number;
  lastGiftAt: string;
}

export interface HeatmapCell {
  day: number; // 0=Mon..6=Sun
  hour: number; // 0..23
  count: number;
}

export interface ProjectionMetrics {
  currentMonthKey: string;
  currentMonthCents: number;
  movingAverageCents: number;
  runRateCents: number;
}

export interface AnalyticsResult {
  range: AnalyticsRange;
  environment: Ambiente | null;
  hasData: boolean;
  giving: {
    monthly: MonthlyPoint[];
    weekly: WeeklyPoint[];
    giftSplit: GiftSplitPoint[];
    donorMix: DonorMixPoint[];
    yoy: YoyPoint[];
    topDonors: TopDonor[];
  };
  geography: {
    departments: GeoBucket[];
    foreign: GeoBucket[];
  };
  funnel: FunnelMetrics;
  mhHealth: MhHealthMetrics;
  email: { weekly: EmailWeeklyPoint[] };
  cohorts: CohortRow[];
  lapsed: { count: number; donors: LapsedDonor[] };
  heatmap: HeatmapCell[];
  projection: ProjectionMetrics;
}

// CAT-012 / CAT-020 label resolution is passed in so the pure function stays
// dependency-free; the endpoint injects the real catalog lookups.
export interface LabelResolvers {
  department: (code: string) => string;
  country: (code: string) => string;
}

const DEFAULT_LABELS: LabelResolvers = {
  department: (code) => code,
  country: (code) => code
};

export interface BuildAnalyticsInput {
  documents: AnalyticsDocumentRow[];
  intents: AnalyticsIntentRow[];
  emails: AnalyticsEmailRow[];
  range: AnalyticsRange;
  now: Date;
  environment?: Ambiente | null;
  labels?: LabelResolvers;
}

// Pure aggregation: rows in -> metrics out. Every date bucket is El Salvador local.
export function buildAnalytics(input: BuildAnalyticsInput): AnalyticsResult {
  const labels = input.labels ?? DEFAULT_LABELS;
  const accepted = input.documents.filter((doc) => doc.status === "ACCEPTED");
  const nowIso = input.now.toISOString();

  // Correlate each accepted doc to its intent (for gift_type / geography), keyed by id.
  const intentByDoc = new Map<string, AnalyticsIntentRow>();
  for (const intent of input.intents) {
    if (intent.document_id) intentByDoc.set(intent.document_id, intent);
  }

  const giftTypeOf = (doc: AnalyticsDocumentRow): DonationGiftType | null =>
    doc.gift_type ?? intentByDoc.get(doc.id)?.gift_type ?? null;

  return {
    range: input.range,
    environment: input.environment ?? null,
    hasData: accepted.length > 0 || input.intents.length > 0 || input.emails.length > 0,
    giving: {
      monthly: monthlySeries(accepted),
      weekly: weeklySeries(accepted),
      giftSplit: giftSplitSeries(accepted, giftTypeOf),
      donorMix: donorMixSeries(accepted),
      yoy: yoySeries(accepted, input.now),
      topDonors: topDonors(accepted)
    },
    geography: geography(accepted, intentByDoc, labels),
    funnel: funnel(input.intents),
    mhHealth: mhHealth(accepted, input.documents),
    email: { weekly: emailWeekly(input.emails, accepted) },
    cohorts: cohorts(accepted),
    lapsed: lapsedDonors(accepted, input.now),
    heatmap: heatmap(accepted),
    projection: projection(accepted, input.now)
  };
}

// ----- Giving series -----

function monthlySeries(accepted: AnalyticsDocumentRow[]): MonthlyPoint[] {
  const buckets = new Map<string, { total: number; count: number }>();
  for (const doc of accepted) {
    const key = elSalvadorMonthKey(doc.issued_at);
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    bucket.total += doc.amount_cents;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, { total, count }]) => ({
      key,
      totalCents: total,
      count,
      averageCents: count > 0 ? Math.round(total / count) : 0
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function weeklySeries(accepted: AnalyticsDocumentRow[]): WeeklyPoint[] {
  const buckets = new Map<string, { total: number; count: number }>();
  for (const doc of accepted) {
    const key = elSalvadorWeekKey(doc.issued_at);
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    bucket.total += doc.amount_cents;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, { total, count }]) => ({ key, totalCents: total, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function giftSplitSeries(
  accepted: AnalyticsDocumentRow[],
  giftTypeOf: (doc: AnalyticsDocumentRow) => DonationGiftType | null
): GiftSplitPoint[] {
  const buckets = new Map<string, { diezmo: number; ofrenda: number; other: number }>();
  for (const doc of accepted) {
    const key = elSalvadorMonthKey(doc.issued_at);
    const bucket = buckets.get(key) ?? { diezmo: 0, ofrenda: 0, other: 0 };
    const gift = giftTypeOf(doc);
    if (gift === "DIEZMO") bucket.diezmo += doc.amount_cents;
    else if (gift === "OFRENDA") bucket.ofrenda += doc.amount_cents;
    else bucket.other += doc.amount_cents;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, { diezmo, ofrenda, other }]) => ({ key, diezmoCents: diezmo, ofrendaCents: ofrenda, otherCents: other }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function donorMixSeries(accepted: AnalyticsDocumentRow[]): DonorMixPoint[] {
  // Sort chronologically so a donor's first-ever gift month is the one where they
  // count as "new"; every later month they gave is "returning".
  const ordered = [...accepted].sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  const firstSeenMonth = new Map<string, string>();
  const monthDonors = new Map<string, Set<string>>();
  for (const doc of ordered) {
    const month = elSalvadorMonthKey(doc.issued_at);
    const key = donorKey(doc.donor_email, doc.donor_name);
    if (!firstSeenMonth.has(key)) firstSeenMonth.set(key, month);
    const set = monthDonors.get(month) ?? new Set<string>();
    set.add(key);
    monthDonors.set(month, set);
  }
  return [...monthDonors.entries()]
    .map(([month, donors]) => {
      let newDonors = 0;
      let returningDonors = 0;
      for (const donor of donors) {
        if (firstSeenMonth.get(donor) === month) newDonors += 1;
        else returningDonors += 1;
      }
      return { key: month, newDonors, returningDonors };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function yoySeries(accepted: AnalyticsDocumentRow[], now: Date): YoyPoint[] {
  const currentYear = elSalvadorLocalDate(now.toISOString()).getUTCFullYear();
  const priorYear = currentYear - 1;
  const current = new Array(12).fill(0);
  const prior = new Array(12).fill(0);
  for (const doc of accepted) {
    const local = elSalvadorLocalDate(doc.issued_at);
    const year = local.getUTCFullYear();
    const monthIndex = local.getUTCMonth();
    if (year === currentYear) current[monthIndex] += doc.amount_cents;
    else if (year === priorYear) prior[monthIndex] += doc.amount_cents;
  }
  return current.map((value, index) => ({
    month: pad2(index + 1),
    currentCents: value,
    priorCents: prior[index]
  }));
}

function topDonors(accepted: AnalyticsDocumentRow[]): TopDonor[] {
  const byDonor = new Map<string, { name: string; email: string | null; count: number; total: number }>();
  for (const doc of accepted) {
    const key = donorKey(doc.donor_email, doc.donor_name);
    const entry = byDonor.get(key) ?? { name: displayName(doc.donor_email, doc.donor_name), email: (doc.donor_email ?? "").trim() || null, count: 0, total: 0 };
    entry.count += 1;
    entry.total += doc.amount_cents;
    if (!entry.email && (doc.donor_email ?? "").trim()) entry.email = doc.donor_email!.trim();
    byDonor.set(key, entry);
  }
  return [...byDonor.values()]
    .map((entry) => ({ donorName: entry.name, donorEmail: entry.email, count: entry.count, totalCents: entry.total }))
    .sort((a, b) => b.count - a.count || b.totalCents - a.totalCents || a.donorName.localeCompare(b.donorName, "es"))
    .slice(0, 10);
}

// ----- Geography -----

function geography(
  accepted: AnalyticsDocumentRow[],
  intentByDoc: Map<string, AnalyticsIntentRow>,
  labels: LabelResolvers
): { departments: GeoBucket[]; foreign: GeoBucket[] } {
  const departments = new Map<string, { count: number; total: number }>();
  const foreign = new Map<string, { count: number; total: number }>();
  for (const doc of accepted) {
    // direccion_departamento / donor_pais are LEFT JOINed onto the doc row from the
    // correlated intent by the reader; intentByDoc is a same-request fallback for
    // fixtures that attach geography to the intent rather than the projected column.
    const intent = intentByDoc.get(doc.id);
    const dep = (doc.direccion_departamento ?? (intent as unknown as { direccion_departamento?: string | null } | undefined)?.direccion_departamento ?? "") || "";
    const pais = doc.donor_pais ?? (intent ? intentPais(intent) : null);
    // Foreign path: department 00 with a donor_pais, else domestic by department.
    const isForeign = (dep === "00" || dep === "") && !!pais;
    if (isForeign && pais) {
      const bucket = foreign.get(pais) ?? { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += doc.amount_cents;
      foreign.set(pais, bucket);
    } else if (dep) {
      const bucket = departments.get(dep) ?? { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += doc.amount_cents;
      departments.set(dep, bucket);
    }
  }
  return {
    departments: [...departments.entries()]
      .map(([code, { count, total }]) => ({ code, label: labels.department(code), count, totalCents: total }))
      .sort((a, b) => b.totalCents - a.totalCents),
    foreign: [...foreign.entries()]
      .map(([code, { count, total }]) => ({ code, label: labels.country(code), count, totalCents: total }))
      .sort((a, b) => b.totalCents - a.totalCents)
  };
}

function intentPais(intent: AnalyticsIntentRow): string | null {
  // AnalyticsIntentRow does not carry donor_pais by default in fixtures; the endpoint
  // projects it onto the document row, so this returns null when absent.
  return (intent as unknown as { donor_pais?: string | null }).donor_pais ?? null;
}

// ----- Funnel -----

function funnel(intents: AnalyticsIntentRow[]): FunnelMetrics {
  const created = intents.length;
  const datos = intents.filter((intent) => (intent.donor_document ?? "").trim().length > 0).length;
  const paid = intents.filter((intent) => intent.paid_at != null).length;
  const completed = intents.filter((intent) => intent.status === "COMPLETED").length;
  const minutesToPay = intents
    .filter((intent) => intent.paid_at != null)
    .map((intent) => (new Date(intent.paid_at!).getTime() - new Date(intent.created_at).getTime()) / 60_000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
  const dropPct = (current: number, prior: number) => (prior > 0 ? Math.round(((prior - current) / prior) * 1000) / 10 : 0);
  return {
    created,
    datos,
    paid,
    completed,
    datosDropPct: dropPct(datos, created),
    paidDropPct: dropPct(paid, datos),
    completedDropPct: dropPct(completed, paid),
    medianMinutesToPay: Math.round(median(minutesToPay))
  };
}

// ----- MH health -----

function mhHealth(accepted: AnalyticsDocumentRow[], allDocuments: AnalyticsDocumentRow[]): MhHealthMetrics {
  const latencies = accepted
    .filter((doc) => doc.accepted_at)
    .map((doc) => (new Date(doc.accepted_at!).getTime() - new Date(doc.issued_at).getTime()) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);

  const rejections = new Map<string, number>();
  for (const doc of allDocuments.filter((doc) => doc.status === "REJECTED")) {
    const key = elSalvadorWeekKey(doc.issued_at);
    rejections.set(key, (rejections.get(key) ?? 0) + 1);
  }
  const deferred = new Map<string, number>();
  for (const doc of allDocuments.filter((doc) => doc.transmission_deferred_at != null)) {
    const key = elSalvadorWeekKey(doc.transmission_deferred_at!);
    deferred.set(key, (deferred.get(key) ?? 0) + 1);
  }
  return {
    medianLatencySeconds: Math.round(median(latencies)),
    p90LatencySeconds: Math.round(percentile(latencies, 90)),
    weeklyRejections: [...rejections.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key)),
    weeklyDeferred: [...deferred.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key))
  };
}

// ----- Email deliverability -----

function emailWeekly(emails: AnalyticsEmailRow[], accepted: AnalyticsDocumentRow[]): EmailWeeklyPoint[] {
  // Joined to Wompi-lane docs: only deliveries whose document is in the (accepted,
  // Wompi-lane) set are counted. The reader already restricts to the lane; this is the
  // pure-function guard so a stray delivery for a non-lane doc never leaks in.
  const laneDocs = new Set(accepted.map((doc) => doc.id));
  const buckets = new Map<string, { sent: number; failed: number }>();
  for (const email of emails) {
    if (!laneDocs.has(email.document_id)) continue;
    const key = elSalvadorWeekKey(email.created_at);
    const bucket = buckets.get(key) ?? { sent: 0, failed: 0 };
    if (email.status === "SENT") bucket.sent += 1;
    else if (email.status === "FAILED") bucket.failed += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, { sent, failed }]) => ({ key, sent, failed }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ----- Retention cohorts -----

function cohorts(accepted: AnalyticsDocumentRow[]): CohortRow[] {
  // Group each donor's gift months; the cohort is their first-gift month. retention[i]
  // is the % of the cohort that gave again exactly i months after the first gift.
  const donorMonths = new Map<string, Set<string>>();
  for (const doc of accepted) {
    const key = donorKey(doc.donor_email, doc.donor_name);
    const month = elSalvadorMonthKey(doc.issued_at);
    const set = donorMonths.get(key) ?? new Set<string>();
    set.add(month);
    donorMonths.set(key, set);
  }
  const cohortMembers = new Map<string, string[]>(); // cohortMonth -> donorKeys
  const donorFirstMonth = new Map<string, string>();
  for (const [key, months] of donorMonths.entries()) {
    const first = [...months].sort()[0];
    donorFirstMonth.set(key, first);
    const members = cohortMembers.get(first) ?? [];
    members.push(key);
    cohortMembers.set(first, members);
  }
  const maxOffset = 12;
  return [...cohortMembers.entries()]
    .map(([cohort, members]) => {
      const retention = new Array(maxOffset + 1).fill(0);
      const counts = new Array(maxOffset + 1).fill(0);
      for (const donor of members) {
        const months = donorMonths.get(donor)!;
        for (const month of months) {
          const offset = monthDiff(cohort, month);
          if (offset >= 0 && offset <= maxOffset) counts[offset] += 1;
        }
      }
      for (let i = 0; i <= maxOffset; i += 1) {
        retention[i] = members.length > 0 ? Math.round((counts[i] / members.length) * 1000) / 10 : 0;
      }
      return { cohort, size: members.length, retention };
    })
    .sort((a, b) => a.cohort.localeCompare(b.cohort));
}

// ----- Lapsed donors -----

function lapsedDonors(accepted: AnalyticsDocumentRow[], now: Date): { count: number; donors: LapsedDonor[] } {
  const nowMs = now.getTime();
  const last30Start = nowMs - 30 * 86_400_000;
  const prior90Start = nowMs - 90 * 86_400_000;
  const byDonor = new Map<string, { name: string; email: string | null; total: number; lastGiftMs: number; lastGiftIso: string; gavePrior90: boolean; gaveLast30: boolean }>();
  for (const doc of accepted) {
    const key = donorKey(doc.donor_email, doc.donor_name);
    const giftMs = new Date(doc.issued_at).getTime();
    const entry =
      byDonor.get(key) ??
      { name: displayName(doc.donor_email, doc.donor_name), email: (doc.donor_email ?? "").trim() || null, total: 0, lastGiftMs: 0, lastGiftIso: doc.issued_at, gavePrior90: false, gaveLast30: false };
    entry.total += doc.amount_cents;
    if (giftMs > entry.lastGiftMs) {
      entry.lastGiftMs = giftMs;
      entry.lastGiftIso = doc.issued_at;
    }
    if (giftMs >= prior90Start && giftMs < last30Start) entry.gavePrior90 = true;
    if (giftMs >= last30Start && giftMs <= nowMs) entry.gaveLast30 = true;
    byDonor.set(key, entry);
  }
  const lapsed = [...byDonor.values()]
    .filter((entry) => entry.gavePrior90 && !entry.gaveLast30)
    .map((entry) => ({ donorName: entry.name, donorEmail: entry.email, totalCents: entry.total, lastGiftAt: entry.lastGiftIso }))
    .sort((a, b) => b.totalCents - a.totalCents)
    .slice(0, 20);
  return { count: lapsed.length, donors: lapsed };
}

// ----- Heatmap -----

function heatmap(accepted: AnalyticsDocumentRow[]): HeatmapCell[] {
  const grid = new Map<string, number>();
  for (const doc of accepted) {
    const { day, hour } = elSalvadorHourOfWeek(doc.issued_at);
    const key = `${day}:${hour}`;
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }
  const cells: HeatmapCell[] = [];
  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const count = grid.get(`${day}:${hour}`) ?? 0;
      if (count > 0) cells.push({ day, hour, count });
    }
  }
  return cells;
}

// ----- Projection -----

function projection(accepted: AnalyticsDocumentRow[], now: Date): ProjectionMetrics {
  const monthly = monthlySeries(accepted);
  const currentMonthKey = elSalvadorMonthKey(now.toISOString());
  const currentMonthCents = monthly.find((point) => point.key === currentMonthKey)?.totalCents ?? 0;

  // 3-month moving average of the three COMPLETE months immediately before the current
  // month (partial current month excluded so it never depresses the baseline).
  const priorKeys = [1, 2, 3].map((offset) => addMonthKey(currentMonthKey, -offset));
  const priorTotals = priorKeys.map((key) => monthly.find((point) => point.key === key)?.totalCents ?? 0);
  const movingAverageCents = Math.round(priorTotals.reduce((sum, value) => sum + value, 0) / 3);

  // Simple run-rate: current-month total scaled by days-in-month / elapsed-days.
  const local = elSalvadorLocalDate(now.toISOString());
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  const dayOfMonth = local.getUTCDate();
  const elapsedFraction = Math.max(dayOfMonth, 0.5) / daysInMonth;
  const runRateCents = elapsedFraction > 0 ? Math.round(currentMonthCents / elapsedFraction) : currentMonthCents;

  return { currentMonthKey, currentMonthCents, movingAverageCents, runRateCents };
}

// ----- Repository readers (thin paged SELECTs feeding the pure functions) -----

// [startIso, endIso) UTC bounds for a YYYY-MM-DD..YYYY-MM-DD inclusive range as
// observed in El Salvador local time (fixed UTC-6). The `to` day is made exclusive
// by advancing one day, so the whole `to` day is included.
// D1 returns gift_type as a raw string; the CHECK constraint restricts it to
// DIEZMO/OFRENDA/null so this narrowing is a no-op guard, not real validation.
function coerceGiftType(value: string | null): DonationGiftType | null {
  return value === "DIEZMO" || value === "OFRENDA" ? value : null;
}

export function elSalvadorRangeWindow(range: AnalyticsRange): { startIso: string; endIso: string } {
  const [fy, fm, fd] = range.from.split("-").map(Number);
  const [ty, tm, td] = range.to.split("-").map(Number);
  const start = new Date(Date.UTC(fy, fm - 1, fd, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  const end = new Date(Date.UTC(ty, tm - 1, td + 1, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// Reads the whole analytics dataset for one environment and date range, then folds it
// through buildAnalytics. Each reader is keyset-paged (mirrors aggregateAnnualDonors)
// so a busy range is read in fixed chunks rather than one unpaged scan.
export async function computeAnalytics(
  repo: Repository,
  range: AnalyticsRange,
  environment: Ambiente,
  now: Date,
  labels: LabelResolvers
): Promise<AnalyticsResult> {
  const window = elSalvadorRangeWindow(range);
  const [documents, intents, emails] = await Promise.all([
    readAnalyticsDocuments(repo, window, environment),
    readAnalyticsIntents(repo, window, environment),
    readAnalyticsEmails(repo, window, environment)
  ]);
  return buildAnalytics({ documents, intents, emails, range, now, environment, labels });
}

async function readAnalyticsDocuments(
  repo: Repository,
  window: { startIso: string; endIso: string },
  environment: Ambiente
): Promise<AnalyticsDocumentRow[]> {
  const rows: AnalyticsDocumentRow[] = [];
  let cursor: { issuedAt: string; id: string } | null = null;
  for (;;) {
    const page = await repo.listWompiLaneDocumentsForAnalytics(window, environment, cursor, RETENTION_PAGE_SIZE);
    // gift_type comes back as a raw string from D1; the CHECK constraint guarantees it
    // is DIEZMO/OFRENDA/null, so the narrowing cast is safe.
    rows.push(...page.map((row) => ({ ...row, gift_type: coerceGiftType(row.gift_type) })));
    if (page.length < RETENTION_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { issuedAt: last.issued_at, id: last.id };
  }
  return rows;
}

async function readAnalyticsIntents(
  repo: Repository,
  window: { startIso: string; endIso: string },
  environment: Ambiente
): Promise<AnalyticsIntentRow[]> {
  const rows: AnalyticsIntentRow[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await repo.listDonationIntentsForAnalytics(window, environment, cursor, RETENTION_PAGE_SIZE);
    rows.push(...page.map((row) => ({ ...row, gift_type: coerceGiftType(row.gift_type) })));
    if (page.length < RETENTION_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
  return rows;
}

async function readAnalyticsEmails(
  repo: Repository,
  window: { startIso: string; endIso: string },
  environment: Ambiente
): Promise<AnalyticsEmailRow[]> {
  const rows: AnalyticsEmailRow[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    const page = await repo.listEmailDeliveriesForAnalytics(window, environment, cursor, RETENTION_PAGE_SIZE);
    rows.push(...page);
    if (page.length < RETENTION_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
  return rows;
}
