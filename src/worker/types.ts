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
  MH_AUTH_URL_PROD?: string;
  MH_RECEPCION_URL_TEST?: string;
  MH_RECEPCION_URL_PROD?: string;
  MH_CONTINGENCIA_URL_TEST?: string;
  MH_CONTINGENCIA_URL_PROD?: string;
  MH_ANULACION_URL_TEST?: string;
  MH_ANULACION_URL_PROD?: string;
  MH_USER_AGENT?: string;
  EMAIL_API_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_ARBITRARY_RECIPIENTS?: string;
  EMAIL_FROM?: string;
  EMISOR_CONFIG_JSON?: string;
}

export interface IssuanceMessage {
  wompiEventId?: string;
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
}

export interface MhResponse {
  accepted: boolean;
  estado: string;
  selloRecibido: string | null;
  observaciones: string[];
  raw: unknown;
}

export interface MhLoteSubmitResponse {
  accepted: boolean;
  estado: string;
  codigoLote: string | null;
  observaciones: string[];
  raw: unknown;
}

export interface MhLoteConsultaResponse {
  estado: string;
  procesados: Array<Record<string, unknown>>;
  rechazados: Array<Record<string, unknown>>;
  observaciones: string[];
  raw: unknown;
}

export interface SignedArtifact {
  plainJson: Record<string, unknown>;
  jws: string;
}
