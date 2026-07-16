export type Ambiente = "00" | "01";

export interface Env {
  DB: D1Database;
  ISSUANCE_QUEUE: Queue<IssuanceMessage>;
  ASSETS: Fetcher;
  ARCHIVE: R2Bucket;
  EMAIL?: SendEmail;
  APP_ENV?: string;
  APP_ORIGIN?: string;
  MOCK_EXTERNAL_SERVICES?: string;
  BOOTSTRAP_OWNER_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_SCRIPT_NAME?: string;
  CLOUDFLARE_API_BASE_URL?: string;
  WOMPI_API_SECRET?: string;
  WOMPI_CLIENT_ID?: string;
  WOMPI_CLIENT_SECRET?: string;
  MH_CERT_XML?: string;
  MH_CERT_XML_PART_1?: string;
  MH_CERT_XML_PART_2?: string;
  MH_CERT_PASSWORD?: string;
  MH_USER?: string;
  MH_PASSWORD?: string;
  MH_USER_TEST?: string;
  MH_PASSWORD_TEST?: string;
  MH_USER_PROD?: string;
  MH_PASSWORD_PROD?: string;
  MH_AUTH_URL_TEST?: string;
  // Narrow TEST-account fallback to MH's central auth host after codigoMsg 106.
  // This is not a production transmission capability.
  MH_AUTH_URL_TEST_FALLBACK?: string;
  MH_AUTH_URL_PROD?: string;
  MH_RECEPCION_URL_TEST?: string;
  MH_RECEPCION_URL_PROD?: string;
  MH_CONTINGENCIA_URL_TEST?: string;
  MH_CONTINGENCIA_URL_PROD?: string;
  MH_ANULACION_URL_TEST?: string;
  MH_ANULACION_URL_PROD?: string;
  MH_USER_AGENT?: string;
  EMAIL_PROVIDER_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_ARBITRARY_RECIPIENTS?: string;
  EMAIL_FROM?: string;
  EMISOR_CONFIG_JSON?: string;
}

export interface IssuanceMessage {
  wompiEventId?: string;
  issuanceAttemptId?: string;
  advancedDocumentId?: string;
}

export interface WompiWebhook {
  IdCuenta: string;
  FechaTransaccion: string;
  Monto: string;
  IdTransaccion: string;
  ResultadoTransaccion: string;
  CodigoAutorizacion?: string | null;
  IdIntentoPago?: string | null;
  Cantidad?: number | null;
  EsProductiva: boolean;
  Aplicativo?: {
    Nombre?: string;
    Url?: string;
    Id?: string;
  };
  EnlacePago?: {
    Id?: number;
    IdentificadorEnlaceComercio?: string;
    NombreProducto?: string;
    DescripcionProducto?: string;
  };
  Cliente?: {
    DocumentoIdentidad?: string;
    Nombre?: string;
    Apellidos?: string;
    Direccion?: string;
    EMail?: string;
    Celular?: string;
    NombreRegion?: string;
    NombrePais?: string;
    CodigoPais?: string;
    CodigoRegion?: string;
  };
  Tarjeta?: string;
  EsInternacional?: boolean;
  IdExterno?: string;
}

export interface EmisorConfig {
  tipoDocumento: string;
  numDocumento: string;
  nrc: string | null;
  nombre: string;
  codActividad: string;
  descActividad: string;
  nombreComercial: string | null;
  direccion: {
    departamento: string;
    municipio: string;
    distrito: string;
    complemento: string;
  };
  telefono: string;
  correo: string;
  codEstable: string | null;
  codEstableMH: string;
  codPuntoVenta: string | null;
  codPuntoVentaMH: string;
  controlPrefix: string;
  defaultReceptorTipoDocumento: string;
  defaultCodPais: string;
  defaultDonationType: number;
  defaultUnidadMedida: number;
  paymentMethodCode: string | null;
  responsable: {
    nombre: string;
    tipoDocumento: string;
    numeroDocumento: string;
    tipoEstablecimiento: string;
  };
}

export interface DteDocumentRecord {
  id: string;
  wompi_event_id: string | null;
  tipo_dte: "15";
  environment: Ambiente;
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
  // Marcador de transmisión diferida: estado diferido = SIGNED + este timestamp
  // (no hay valor nuevo en el CHECK de status — D1 no puede reconstruir tablas
  // padre de FK). Se conserva tras la resolución como evidencia histórica.
  transmission_deferred_at: string | null;
  fiscal_operation_claim_id?: string | null;
  fiscal_operation_claimed_at?: string | null;
  fiscal_operation_kind?: "TRANSMISSION" | "INVALIDATION" | null;
  fiscal_operation_event_id?: string | null;
  post_accept_finalized_at?: string | null;
  post_accept_finalization_claim_id?: string | null;
  post_accept_finalization_claimed_at?: string | null;
  post_accept_email_dispatch_started_at?: string | null;
  transmission_claim_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContingencyBatchRecord {
  id: string;
  contingency_period_id: string;
  environment: Ambiente;
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

export interface ContingencyBatchLineRecord {
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

export type DonationIntentStatus = "PENDING" | "LINK_CREATED" | "COMPLETED" | "EXPIRED";

// The five CAT-022 receptor document types the public /donar form accepts
// (mirrors the CHECK constraint from migration 0011).
export type DonationIntentDocumentType = "36" | "13" | "37" | "03" | "02";

// Donor-facing "Tipo" on the SV (Wompi/CDE) flow: is the gift a diezmo or an
// ofrenda? Informational only — the legal CDE descripcion stays "DONACIÓN" — but it
// drives the Wompi payment-sheet product name and a CDE apéndice line. Nullable
// everywhere: the US (Givebutter/FMCE) path and legacy rows never carry it
// (mirrors the CHECK constraint from migration 0012).
export type DonationGiftType = "DIEZMO" | "OFRENDA";

export interface DonationIntentRecord {
  id: string;
  status: DonationIntentStatus;
  amount_cents: number;
  // Name and email are no longer collected on the /donar form — the donor types them
  // on Wompi's hosted sheet — so both are nullable. The one exception: NIT (36)
  // intents store the REQUIRED razón social here, because the comprobante must name
  // the empresa, not the Wompi cardholder. The correlated CDE lifts nombre from this
  // field when present, else from the webhook; correo always from the webhook.
  donor_name: string | null;
  donor_document_type: DonationIntentDocumentType;
  donor_document: string;
  donor_email: string | null;
  donor_phone: string | null;
  direccion_departamento: string;
  direccion_municipio: string;
  direccion_distrito: string;
  direccion_complemento: string;
  // Foreign-donor path: CAT-020 country (never "SV") when the direccion carries the
  // 00/00/00 "Otro (Para extranjeros)" geography; null for domestic intents.
  donor_pais: string | null;
  // Diezmo vs Ofrenda (SV/Wompi/CDE flow only). Null for the US path and legacy rows.
  gift_type: DonationGiftType | null;
  wompi_id_enlace: number | null;
  wompi_url_enlace: string | null;
  wompi_url_enlace_largo: string | null;
  document_id: string | null;
  client_ip: string | null;
  // SHA-256 of the one-time draft /datos capability (migration 0017). The raw
  // capability is never stored and this column is cleared by the successful CAS.
  datos_token_hash: string | null;
  // Admission claim that reserved this create in the atomic public-rate-limit ledger.
  // Legacy rows remain null so deployment-overlap activity is still counted.
  rate_limit_claim_id: string | null;
  // Wompi payment marker (migration 0016): stamped by the webhook the moment an
  // approved payment for this intent arrives — independent of status. COMPLETED still
  // means the CDE was accepted by MH; paid_at means the donor paid. The donor-facing
  // "thanks" keys on paid_at, not on MH acceptance. Null until (and unless) paid.
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

// The admin "Donaciones en línea" listing (Task 5): an allowlisted view of a donation
// intent joined with the emitted CDE it produced (present only for COMPLETED intents
// linked via document_id). Deliberately NOT `DonationIntentRecord` — the listing must
// not carry donor PII (donor_document, donor_email), the client IP, or the Wompi
// payment-link URLs. The donante shown in the panel comes from the document's donor_name
// (lifted from the webhook), since the intent no longer stores name/email.
export interface DonationIntentListItem {
  id: string;
  status: DonationIntentStatus;
  amount_cents: number;
  document_id: string | null;
  gift_type: DonationGiftType | null;
  created_at: string;
  numero_control: string | null;
  document_donor_name: string | null;
}

export interface WompiPaymentLink {
  idEnlace: number;
  urlEnlace: string;
  urlEnlaceLargo: string;
}

export type WompiIssuanceStatus =
  | "PROCESSING"
  | "FAILED"
  | "DEAD_LETTERED"
  | "RETRY_QUEUED"
  | "DOCUMENT_CREATED"
  | "IGNORED";

export interface WompiIssuanceFailureItem {
  id: string;
  environment: Ambiente;
  amount_cents: number;
  donor_name: string | null;
  donor_email: string | null;
  received_at: string;
  issuance_status: WompiIssuanceStatus | null;
  issuance_attempt_count: number;
  issuance_error_code: string | null;
  issuance_error_message: string | null;
  issuance_last_attempt_at: string | null;
  issuance_failed_at: string | null;
  issuance_dead_lettered_at: string | null;
  reserved_numero_control: string | null;
}

export interface WompiDocumentIdentifiers {
  sequence: number;
  numeroControl: string;
  codigoGeneracion: string;
}

export interface WompiEventRecord {
  id: string;
  transaction_id: string;
  environment: Ambiente;
  result: string;
  amount_cents: number;
  donor_email: string | null;
  donor_name: string | null;
  raw_body: string;
  headers_json: string;
  received_at: string;
  processed_at: string | null;
  created_document_id: string | null;
  issuance_claim_id?: string | null;
  issuance_claimed_at?: string | null;
  issuance_status: WompiIssuanceStatus | null;
  control_prefix: string | null;
  control_sequence: number | null;
  reserved_numero_control: string | null;
  reserved_codigo_generacion: string | null;
  issuance_attempt_count: number;
  issuance_attempt_id: string | null;
  issuance_error_code: string | null;
  issuance_error_message: string | null;
  issuance_last_attempt_at: string | null;
  issuance_failed_at: string | null;
  issuance_dead_lettered_at: string | null;
}

export interface MhResponse {
  accepted: boolean;
  estado: string;
  selloRecibido: string | null;
  observaciones: string[];
  raw: unknown;
}

export interface SignedArtifact {
  plainJson: Record<string, unknown>;
  jws: string;
}
