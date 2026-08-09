import { describe, expect, it } from "vitest";
import { amountCents, ambienteFromWompi, donorName, normalizeWompiWebhook, verifyWompiHash } from "../../src/worker/domain/wompi";
import * as wompiDomain from "../../src/worker/domain/wompi";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";

describe("Wompi webhook security", () => {
  it("verifies HMAC-SHA256 over the raw body", async () => {
    const secret = "wompi-secret";
    const body = JSON.stringify({ IdTransaccion: "abc", ResultadoTransaccion: "ExitosaAprobada" });
    const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hexFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body))));

    await expect(verifyWompiHash(body, signature, secret)).resolves.toBe(true);
    await expect(verifyWompiHash(`${body}\n`, signature, secret)).resolves.toBe(false);
  });

  it("normalizes the official webhook field shape before DTE processing", () => {
    const payload = normalizeWompiWebhook({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "12.34",
      IdTransaccion: "wompi_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      CodigoAutorizacion: "AUTH-1",
      IdIntentoPago: "attempt_1",
      Cantidad: 1,
      EsProductiva: false,
      aplicativo: {
        Nombre: "Wompi",
        Url: "https://wompi.sv",
        Id: "app_1"
      },
      enlacePago: {
        Id: 123,
        IdentificadorEnlaceComercio: "DONACION-123",
        NombreProducto: "Donacion",
        DescripcionProducto: "Diezmo"
      },
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        Direccion: "San Salvador",
        EMail: "donor@example.org",
        Celular: "70000005",
        NombreRegion: "San Salvador",
        NombrePais: "El Salvador",
        CodigoPais: "SV",
        CodigoRegion: "06"
      },
      Tarjeta: "411111******1111",
      EsInternacional: false,
      IdExterno: "donation-123"
    });

    expect(payload.IdTransaccion).toBe("wompi_tx_1");
    expect(payload.Cliente?.EMail).toBe("donor@example.org");
    expect(payload.EnlacePago?.IdentificadorEnlaceComercio).toBe("DONACION-123");
    expect(ambienteFromWompi(payload)).toBe("00");
    expect(donorName(payload)).toBe("Example Person");
    expect(amountCents(payload)).toBe(1234);
  });

  it("rejects signed webhooks that are missing Wompi transaction identity", () => {
    expect(() => normalizeWompiWebhook({
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "12.34",
      EsProductiva: false
    })).toThrow("IdTransaccion");
  });
});

describe("Wompi API reconciliation", () => {
  const intent = {
    id: "di_recover",
    wompi_id_enlace: 9000001,
    amount_cents: 12500
  };

  function approvedLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      idEnlace: 9000001,
      nombreEnlace: "di_recover",
      nombreProducto: "Diezmos y Ofrendas",
      transacciones: [{
        datosAdicionales: {
          Nombre: "DONANTE",
          Apellidos: "EJEMPLO",
          EMail: "donante@example.org",
          Celular: "70000000",
          Direccion: "San Salvador",
          NombreRegion: "San Salvador",
          NombrePais: "El Salvador",
          CodigoPais: "SV",
          CodigoRegion: "06"
        },
        fechaTransaccion: "2026-01-15T10:00:00-06:00",
        idTransaccion: "TEST-TXN-0000000001",
        esReal: true,
        esAprobada: true,
        codigoAutorizacion: "000001",
        monto: 125,
        idExterno: null
      }],
      ...overrides
    };
  }

  it("rebuilds the webhook contract from an approved payment-link transaction", () => {
    type Reconciler = {
      wompiWebhookFromPaymentLink(
        intent: { id: string; wompi_id_enlace: number | null; amount_cents: number },
        link: Record<string, unknown>
      ): ReturnType<typeof normalizeWompiWebhook> | null;
    };
    const recovered = (wompiDomain as unknown as Reconciler).wompiWebhookFromPaymentLink(
      { id: "di_recover", wompi_id_enlace: 9000001, amount_cents: 12500 },
      {
        idAplicativo: "app-1",
        nombreEnlace: "di_recover",
        monto: 125,
        nombreProducto: "Diezmos y Ofrendas",
        usable: false,
        transaccionCompra: null,
        cantidadIntentoPagoFallidos: 0,
        formaPago: {
          permitirTarjetaCreditoDebido: true,
          permitirPagoConPuntoAgricola: false,
          permitirPagoEnCuotasAgricola: false,
          permitirPagoEnBitcoin: false,
          permitePagoQuickPay: false,
          permitePagoNequi: false
        },
        infoProducto: { descripcionProducto: null, urlImagenProducto: null },
        configuracion: {
          urlRedirect: "https://donations.example.invalid/donar/gracias",
          esMontoEditable: false,
          esCantidadEditable: false,
          cantidadPorDefecto: 1,
          duracionInterfazIntentoMinutos: 60,
          urlRetorno: null,
          emailsNotificacion: null,
          urlWebhook: "https://donations.example.invalid/webhooks/wompi",
          telefonosNotificacion: null,
          notificarTransaccionCliente: false
        },
        cantidadMaximaCuotas: null,
        transacciones: [{
          datosAdicionales: {
            Nombre: "DONANTE",
            Apellidos: "EJEMPLO",
            EMail: "donante@example.org",
            Celular: "70000000",
            Direccion: "San Salvador",
            NombreRegion: "San Salvador",
            NombrePais: "El Salvador",
            CodigoPais: "SV",
            CodigoRegion: "06"
          },
          resultadoTransaccion: 0,
          fechaTransaccion: "2026-01-15T10:00:00-06:00",
          montoOriginal: 125,
          idTransaccion: "TEST-TXN-0000000001",
          esReal: true,
          esAprobada: true,
          codigoAutorizacion: "000001",
          mensaje: null,
          formaPago: 0,
          monto: 125,
          idExterno: null
        }],
        nombreAplicativo: "Misión ExampleOrganization",
        cantidadPagosExitosos: 1,
        imagenes: [],
        vigencia: {
          fechaInicio: "2026-01-15T09:00:00-06:00",
          fechaFin: "2026-01-15T11:00:00-06:00"
        },
        limitesDeUso: {
          cantidadMaximaPagosExitosos: 1,
          cantidadMaximaPagosFallidos: null
        },
        datosAdicionales: null,
        idGrupoTarjetas: null,
        idEnlace: 9000001,
        urlQrCodeEnlace: "https://api.wompi.sv/EnlacePago/9000001/qr",
        urlEnlace: "https://s.wompi.sv/9000001",
        estaProductivo: true,
        urlEnlaceLargo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=9000001"
      }
    );

    expect(recovered).toEqual({
      IdCuenta: "",
      FechaTransaccion: "2026-01-15T10:00:00-06:00",
      Monto: "125",
      IdTransaccion: "TEST-TXN-0000000001",
      ResultadoTransaccion: "ExitosaAprobada",
      CodigoAutorizacion: "000001",
      IdIntentoPago: null,
      Cantidad: 1,
      EsProductiva: true,
      Tarjeta: undefined,
      EsInternacional: undefined,
      IdExterno: undefined,
      EnlacePago: {
        Id: 9000001,
        IdentificadorEnlaceComercio: "di_recover",
        NombreProducto: "Diezmos y Ofrendas",
        DescripcionProducto: undefined
      },
      Cliente: {
        DocumentoIdentidad: undefined,
        Nombre: "DONANTE",
        Apellidos: "EJEMPLO",
        Direccion: "San Salvador",
        EMail: "donante@example.org",
        Celular: "70000000",
        NombreRegion: "San Salvador",
        NombrePais: "El Salvador",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });
  });

  it("rejects a payment-link response that does not belong to the exact intent and link", () => {
    expect(() => wompiDomain.wompiWebhookFromPaymentLink(
      intent,
      approvedLink({ idEnlace: 999 })
    )).toThrow(/enlace/i);

    expect(() => wompiDomain.wompiWebhookFromPaymentLink(
      intent,
      approvedLink({ nombreEnlace: "di_other" })
    )).toThrow(/intención/i);
  });

  it("rejects an approved transaction whose amount differs from the immutable intent", () => {
    const link = approvedLink();
    const [transaction] = link.transacciones as Array<Record<string, unknown>>;
    transaction.monto = 124.99;

    expect(() => wompiDomain.wompiWebhookFromPaymentLink(intent, link)).toThrow(/monto/i);
  });

  it("rejects ambiguous links with more than one approved transaction", () => {
    const link = approvedLink();
    const [transaction] = link.transacciones as Array<Record<string, unknown>>;
    link.transacciones = [
      transaction,
      { ...transaction, idTransaccion: "second-approved" }
    ];

    expect(() => wompiDomain.wompiWebhookFromPaymentLink(intent, link)).toThrow(/aprobada/i);
  });
});
