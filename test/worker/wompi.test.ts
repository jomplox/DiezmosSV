import { describe, expect, it } from "vitest";
import { amountCents, ambienteFromWompi, donorName, normalizeWompiWebhook, verifyWompiHash } from "../../src/worker/domain/wompi";
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
