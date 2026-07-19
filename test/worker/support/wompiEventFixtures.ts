export function wompiEventForReservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wompi_1",
    transaction_id: "transaction_1",
    environment: "00",
    result: "ExitosaAprobada",
    amount_cents: 1000,
    donor_email: "donor@example.org",
    donor_name: "Donante",
    raw_body: "{}",
    headers_json: "{}",
    received_at: "2026-07-13T12:00:00.000Z",
    processed_at: null,
    created_document_id: null,
    issuance_status: null,
    control_prefix: null,
    control_sequence: null,
    reserved_numero_control: null,
    reserved_codigo_generacion: null,
    issuance_attempt_count: 0,
    issuance_error_code: null,
    issuance_error_message: null,
    issuance_last_attempt_at: null,
    issuance_failed_at: null,
    issuance_dead_lettered_at: null,
    ...overrides
  };
}
