export interface DteDocument {
  id: string;
  wompi_event_id: string;
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
  created_at: string;
  updated_at: string;
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
}

export interface EmissionEnvironmentState {
  environment: "00" | "01";
  source: "setting" | "deployment_default";
  appEnv: string;
}
