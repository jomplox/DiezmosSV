import type { DteDocumentRecord } from "../../../src/worker/types";
import { bytesToBase64, hexFromBytes, utf8Bytes } from "../../../src/worker/utils/encoding";
import { makeDocument as testDocument } from "../fixtures";

export function advancedFailingDocument(id: string): DteDocumentRecord {
  return {
    ...testDocument(),
    id,
    wompi_event_id: null,
    status: "PENDING",
    signed_jws: null,
    sello_recibido: null,
    accepted_at: null,
    plain_json: JSON.stringify({
      emisor: advancedCdeDraft().emisor,
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: {
        fecEmi: "2026-06-26",
        horEmi: "19:50:00",
        ambiente: "00",
        codigoGeneracion: "11111111-1111-4111-8111-111111111111",
        numeroControl: "DTE-15-M001P004-000000000000999"
      }
    })
  };
}

export function advancedCdeDraft(): Record<string, unknown> {
  return {
    identificacion: {
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000999",
      codigoGeneracion: "11111111-1111-4111-8111-111111111111",
      tipoModelo: 1,
      tipoOperacion: 1,
      fecEmi: "2026-06-26",
      horEmi: "09:00:00",
      tipoMoneda: "USD"
    },
    emisor: {
      tipoDocumento: "36",
      numDocumento: "10000003520015",
      nrc: "2400001",
      nombre: "MISION EXAMPLEORGANIZATION",
      codActividad: "94910",
      descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
      nombreComercial: "MISION EXAMPLEORGANIZATION",
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
      },
      telefono: "70000002",
      correo: "legacy-contact-4@example.com",
      codEstable: "0002",
      codPuntoVenta: "0002"
    },
    receptor: {
      tipoDocumento: "13",
      numDocumento: "100000001",
      nrc: null,
      nombre: "Example Person Advanced",
      codActividad: null,
      descActividad: null,
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "SAN SALVADOR"
      },
      telefono: "70000001",
      correo: "advanced@example.org",
      codDomiciliado: 1,
      codPais: "SV"
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Referencia avanzada",
        detalleDocumento: "ADVANCED-TEST"
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: 1,
        cantidad: 1,
        codigo: "DIEZMO",
        uniMedida: 99,
        descripcion: "Diezmo avanzado",
        tipoDepreciacion: 0,
        valorUni: 123.45,
        valor: 123.45
      }
    ],
    resumen: {
      valorTotal: 123.45,
      totalLetras: null,
      pagos: [
        {
          codigo: "01",
          montoPago: 123.45,
          referencia: "ADVANCED"
        }
      ]
    },
    apendice: [
      { campo: "Origen", etiqueta: "Origen", valor: "DTE avanzado" }
    ]
  };
}

export async function generatedCertificateXml(
  password: string,
  nit = "10000003520015"
): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const passwordHash = hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-512", utf8Bytes(password))));
  return `<CertificadoMH><nit>${nit}</nit><publicKey><encodied>${bytesToBase64(spki)}</encodied></publicKey><privateKey><encodied>${bytesToBase64(pkcs8)}</encodied><clave>${passwordHash}</clave></privateKey><activo>true</activo></CertificadoMH>`;
}

export function emisorConfig() {
  return {
    tipoDocumento: "36",
    numDocumento: "10000003520015",
    nrc: "2400001",
    nombre: "MISION EXAMPLEORGANIZATION",
    codActividad: "94910",
    descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
    nombreComercial: "MISION EXAMPLEORGANIZATION",
    direccion: {
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
    },
    telefono: "70000002",
    correo: "legacy-contact-4@example.com",
    codEstable: "0002",
    codEstableMH: "M001",
    codPuntoVenta: "0002",
    codPuntoVentaMH: "P004",
    controlPrefix: "M001P004",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: 1,
    defaultUnidadMedida: 99,
    paymentMethodCode: "01",
    responsable: {
      nombre: "Example Person",
      tipoDocumento: "13",
      numeroDocumento: "100000001",
      tipoEstablecimiento: "02"
    }
  };
}
