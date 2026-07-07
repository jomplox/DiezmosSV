export interface DteDocument {
  id: string;
  wompi_event_id: string | null;
  tipo_dte: "15";
  environment: "00" | "01";
  codigo_generacion: string;
  numero_control: string;
  status: string;
  plain_json: string;
  signed_jws: string | null;
  sello_recibido: string | null;
  mh_estado: string | null;
  mh_observaciones_json: string;
  donor_email: string | null;
  donor_name: string | null;
  amount_cents: number;
  issued_at: string;
  accepted_at: string | null;
  contingency_period_id: string | null;
  // Deferred-transmission marker: deferred = SIGNED + this timestamp (kept after
  // resolution as historical evidence). The UI renders it as "En trámite".
  transmission_deferred_at: string | null;
  created_at: string;
  updated_at: string;
  // Set by the document detail fetch when a completed donation intent produced this
  // CDE (donor data came from the validated /donar form, not the raw webhook).
  donorDataVerified?: boolean;
}

export type DonationIntentStatus = "PENDING" | "LINK_CREATED" | "COMPLETED" | "EXPIRED";

export interface DonationIntentListItem {
  id: string;
  status: DonationIntentStatus;
  amount_cents: number;
  // The donante shown in the panel comes from the emitted CDE's donor_name (joined via
  // document_id for COMPLETED intents); the intent itself no longer stores name/email.
  document_donor_name: string | null;
  document_id: string | null;
  numero_control: string | null;
  // Diezmo vs Ofrenda (SV flow); null for legacy and US-path intents. Drives the
  // admin "Tipo" column.
  gift_type: "DIEZMO" | "OFRENDA" | null;
  created_at: string;
}

export interface DocumentListPage {
  documents: DteDocument[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";
  disabled_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AuditRow {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata_json: string;
  created_at: string;
  // Actor identity resolved server-side via LEFT JOIN users ON actor_id. NULL for
  // SYSTEM rows and for USER rows whose account was later deleted.
  actor_name?: string | null;
  actor_email?: string | null;
  // Request context captured at audit time (predates migration 0013 => NULL on old rows).
  actor_ip?: string | null;
  // JSON blob: { country, city, region, timezone, asn, asOrganization, colo, httpProtocol, tlsVersion, userAgent }.
  actor_context?: string | null;
}

export interface AuditActorContext {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  userAgent?: string;
}

export interface ContingencyPeriod {
  id: string;
  environment: "00" | "01";
  status: string;
  reason: string;
  tipo_contingencia: number;
  started_at: string;
  ended_at: string | null;
  event_id: string | null;
  event_sello: string | null;
  transmit_deadline_at: string | null;
  event_deadline_at: string | null;
  created_at: string;
}

export interface ContingencyEvent {
  id: string;
  document_id: string | null;
  event_type: "CONTINGENCIA";
  environment: "00" | "01";
  codigo_generacion: string;
  status: string;
  sello_recibido: string | null;
  mh_estado: string | null;
  mh_observaciones_json: string;
  legal_deadline_at: string | null;
  created_by: string | null;
  created_at: string;
  accepted_at: string | null;
}

export interface ContingencyBatch {
  id: string;
  contingency_period_id: string;
  environment: "00" | "01";
  id_envio: string;
  status: string;
  codigo_lote: string | null;
  request_json: string;
  response_json: string;
  last_error: string | null;
  line_count: number;
  accepted_count: number;
  rejected_count: number;
  pending_count: number;
  created_at: string;
  submitted_at: string | null;
  last_polled_at: string | null;
  updated_at: string;
}

export interface ContingencyBatchLine {
  id: string;
  batch_id: string;
  contingency_period_id: string;
  document_id: string;
  line_no: number;
  status: string;
  codigo_generacion: string;
  tipo_dte: "15";
  signed_jws: string | null;
  sello_recibido: string | null;
  mh_estado: string | null;
  mh_observaciones_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContingencySummary {
  pending: number;
  open: number;
  eventAccepted: number;
  closed: number;
  failed: number;
  eventsAccepted: number;
  eventsRejected: number;
  batches: number;
  batchAccepted: number;
  batchPending: number;
  batchRejected: number;
}

export interface ContingencyState {
  active: ContingencyPeriod | null;
  pendingDocuments: DteDocument[];
  batches: ContingencyBatch[];
  batchLines: ContingencyBatchLine[];
  periods: ContingencyPeriod[];
  events: ContingencyEvent[];
  audit: AuditRow[];
  summary: ContingencySummary;
}

export interface CredentialStatusItem {
  name: string;
  label: string;
  configured: boolean;
  displayValue?: string;
  protected?: boolean;
}

export interface CredentialStatusGroup {
  label: string;
  ready: boolean;
  items: CredentialStatusItem[];
}

export interface CredentialStatus {
  target: {
    appEnv: string;
    scriptName: string | null;
    writerConfigured: boolean;
    writerMissing: string[];
  };
  groups: Record<string, CredentialStatusGroup>;
  certificateExpiresAt: string | null;
}

export interface EmissionEnvironmentState {
  environment: "00" | "01";
  source: "setting" | "deployment_default";
  appEnv: string;
}

export interface EmailTemplateValue {
  subject: string;
  body: string;
}

export interface EmailTemplateDefinition {
  type: string;
  label: string;
  description: string;
  defaultSubject: string;
  defaultBody: string;
}

export interface EmailTemplateSettings {
  definitions: EmailTemplateDefinition[];
  placeholders: string[];
  templates: Record<string, EmailTemplateValue>;
}

export interface AlertEmailState {
  alertEmail: string;
}

export type BackupMonthStatus = "archivado" | "faltante" | "en_curso";

export interface BackupMonth {
  month: string;
  status: BackupMonthStatus;
  exportedAt: string | null;
  totalRows: number | null;
  tables: string[];
}

export interface BackupsGrid {
  months: BackupMonth[];
}

export interface BackupVerifyFile {
  table: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface BackupVerifyResult {
  ok: boolean;
  files: BackupVerifyFile[];
}

// ----- Analítica (carril Wompi) -----
// Mirror of the /api/analytics response. Amounts are integer cents; the client formats.

export interface AnalyticsMonthlyPoint {
  key: string;
  totalCents: number;
  count: number;
  averageCents: number;
}

export interface AnalyticsWeeklyPoint {
  key: string;
  totalCents: number;
  count: number;
}

export interface AnalyticsGiftSplitPoint {
  key: string;
  diezmoCents: number;
  ofrendaCents: number;
  otherCents: number;
}

export interface AnalyticsDonorMixPoint {
  key: string;
  newDonors: number;
  returningDonors: number;
}

export interface AnalyticsYoyPoint {
  month: string;
  currentCents: number;
  priorCents: number;
}

export interface AnalyticsTopDonor {
  donorName: string;
  donorEmail: string | null;
  count: number;
  totalCents: number;
}

export interface AnalyticsGeoBucket {
  code: string;
  label: string;
  count: number;
  totalCents: number;
}

export interface AnalyticsFunnel {
  created: number;
  datos: number;
  paid: number;
  completed: number;
  datosDropPct: number;
  paidDropPct: number;
  completedDropPct: number;
  medianMinutesToPay: number;
}

export interface AnalyticsMhHealth {
  medianLatencySeconds: number;
  p90LatencySeconds: number;
  weeklyRejections: Array<{ key: string; count: number }>;
  weeklyDeferred: Array<{ key: string; count: number }>;
}

export interface AnalyticsEmailWeeklyPoint {
  key: string;
  sent: number;
  failed: number;
}

export interface AnalyticsCohortRow {
  cohort: string;
  size: number;
  retention: number[];
}

export interface AnalyticsLapsedDonor {
  donorName: string;
  donorEmail: string | null;
  totalCents: number;
  lastGiftAt: string;
}

export interface AnalyticsHeatmapCell {
  day: number;
  hour: number;
  count: number;
}

export interface AnalyticsProjection {
  currentMonthKey: string;
  currentMonthCents: number;
  movingAverageCents: number;
  runRateCents: number;
}

export interface AnalyticsResponse {
  range: { from: string; to: string };
  environment: "00" | "01" | null;
  hasData: boolean;
  giving: {
    monthly: AnalyticsMonthlyPoint[];
    weekly: AnalyticsWeeklyPoint[];
    giftSplit: AnalyticsGiftSplitPoint[];
    donorMix: AnalyticsDonorMixPoint[];
    yoy: AnalyticsYoyPoint[];
    topDonors: AnalyticsTopDonor[];
  };
  geography: {
    departments: AnalyticsGeoBucket[];
    foreign: AnalyticsGeoBucket[];
  };
  funnel: AnalyticsFunnel;
  mhHealth: AnalyticsMhHealth;
  email: { weekly: AnalyticsEmailWeeklyPoint[] };
  cohorts: AnalyticsCohortRow[];
  lapsed: { count: number; donors: AnalyticsLapsedDonor[] };
  heatmap: AnalyticsHeatmapCell[];
  projection: AnalyticsProjection;
}
