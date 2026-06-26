import type { WompiWebhook } from "../types";

export interface TestWompiInput {
  amount?: string | number;
  donorName?: string;
  donorEmail?: string;
  donorDocument?: string;
  donorPhone?: string;
  donorAddress?: string;
}

export function buildTestWompiPayload(input: TestWompiInput = {}): WompiWebhook {
  const amount = normalizeAmount(input.amount);
  const fullName = clean(input.donorName) ?? "Donante de Prueba";
  const { firstName, lastName } = splitName(fullName);
  const now = new Date();
  return {
    IdCuenta: "diezmossv-staging-resource-example",
    FechaTransaccion: now.toISOString(),
    Monto: amount,
    IdTransaccion: `TEST-${crypto.randomUUID()}`,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: "STAGING",
    IdIntentoPago: crypto.randomUUID(),
    Cantidad: 1,
    EsProductiva: false,
    Aplicativo: {
      Nombre: "DiezmosSV Staging",
      Url: "https://example.org/",
      Id: "diezmossv-staging-resource-example"
    },
    EnlacePago: {
      Id: 1,
      IdentificadorEnlaceComercio: "DTE Test",
      NombreProducto: "Donacion de prueba",
      DescripcionProducto: "Prueba controlada de integracion DTE"
    },
    Cliente: {
      DocumentoIdentidad: clean(input.donorDocument) ?? "SIN-DOCUMENTO",
      Nombre: firstName,
      Apellidos: lastName,
      Direccion: clean(input.donorAddress) ?? "Direccion de prueba",
      EMail: clean(input.donorEmail) ?? "donante@example.org",
      Celular: clean(input.donorPhone) ?? "00000000",
      NombreRegion: "San Salvador",
      NombrePais: "El Salvador",
      CodigoPais: "SV",
      CodigoRegion: "SV-SS"
    },
    EsInternacional: false,
    IdExterno: "DTE-TEST"
  };
}

function normalizeAmount(value: string | number | undefined): string {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "1.00");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Test amount must be a positive number");
  }
  return parsed.toFixed(2);
}

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return { firstName: parts[0] ?? "Donante", lastName: "Prueba" };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? "Prueba"
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
