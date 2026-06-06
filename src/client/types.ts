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
