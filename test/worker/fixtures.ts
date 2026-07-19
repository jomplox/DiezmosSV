import type { DonationIntentRecord, DteDocumentRecord, EmisorConfig } from "../../src/worker/types";

export function makeDocument(overrides: Partial<DteDocumentRecord> = {}): DteDocumentRecord {
  return {
    id: "doc_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: JSON.stringify({
      emisor: { nombre: "ExamplePerson1" },
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
    }),
    signed_jws: null,
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "legacy-contact-2@example.com",
    donor_name: "Example Person",
    amount_cents: 10000,
    issued_at: "2026-06-26T01:46:47.015Z",
    accepted_at: "2026-06-26T01:46:48.000Z",
    contingency_period_id: null,
    transmission_deferred_at: null,
    post_accept_finalized_at: "2026-06-26T01:46:49.000Z",
    transmission_claim_id: null,
    created_at: "2026-06-26T01:46:47.015Z",
    updated_at: "2026-06-26T01:46:48.000Z",
    ...overrides
  };
}

export function makeIntent(overrides: Partial<DonationIntentRecord> = {}): DonationIntentRecord {
  return {
    id: "di_seed",
    status: "LINK_CREATED",
    amount_cents: 2550,
    donor_name: null,
    donor_document_type: "13",
    donor_document: "000000000",
    donor_email: null,
    donor_phone: null,
    direccion_departamento: "06",
    direccion_municipio: "22",
    direccion_distrito: "01",
    direccion_complemento: "San Salvador",
    donor_pais: null,
    gift_type: null,
    wompi_id_enlace: null,
    wompi_url_enlace: null,
    wompi_url_enlace_largo: null,
    document_id: null,
    client_ip: null,
    datos_token_hash: null,
    rate_limit_claim_id: null,
    paid_at: null,
    created_at: "2026-07-05T12:00:00.000Z",
    updated_at: "2026-07-05T12:00:00.000Z",
    expires_at: "2026-07-05T13:00:00.000Z",
    ...overrides
  };
}

export const emisorConfig: EmisorConfig = {
  tipoDocumento: "36",
  numDocumento: "10000000000001",
  nrc: null,
  nombre: "Iglesia Demo",
  codActividad: "94910",
  descActividad: "Actividades de organizaciones religiosas",
  nombreComercial: "Iglesia Demo",
  direccion: {
    departamento: "06",
    municipio: "22",
    distrito: "01",
    complemento: "San Salvador, El Salvador"
  },
  telefono: "70000003",
  correo: "dte@example.org",
  codEstable: "0001",
  codEstableMH: "0001",
  codPuntoVenta: "01",
  codPuntoVentaMH: "0001",
  controlPrefix: "00010001",
  defaultReceptorTipoDocumento: "13",
  defaultCodPais: "SV",
  defaultDonationType: 1,
  defaultUnidadMedida: 99,
  paymentMethodCode: null,
  responsable: {
    nombre: "Responsable Legal",
    tipoDocumento: "13",
    numeroDocumento: "000000000",
    tipoEstablecimiento: "02"
  }
};
