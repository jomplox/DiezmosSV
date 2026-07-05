import type { EmisorConfig } from "../../src/worker/types";

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
