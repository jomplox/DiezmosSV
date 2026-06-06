import { describe, expect, it } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildCdeDocument, buildContingenciaEvent } from "../../src/worker/domain/dteBuilder";
import type { WompiWebhook } from "../../src/worker/types";
import { emisorConfig } from "./fixtures";

describe("DTE builders", () => {
  it("builds a schema-valid CDE from the Wompi webhook sample", () => {
    const document = buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
    }) as Record<string, any>;

    expect(document.identificacion.tipoDte).toBe("15");
    expect(document.identificacion.ambiente).toBe("00");
    expect(document.identificacion.numeroControl).toBe("DTE-15-00010001-000000000000001");
    expect(document.receptor.nombre).toBe("Donante Demo");
    expect(document.resumen.valorTotal).toBe(10);
  });

  it("builds a schema-valid contingency event for queued CDEs", () => {
    const event = buildContingenciaEvent(emisorConfig, {
      ambiente: "00",
      documents: [{ tipoDoc: "15", codigoGeneracion: "11111111-1111-4111-8111-111111111111" }],
      startedAt: new Date("2026-06-02T10:00:00-06:00"),
      endedAt: new Date("2026-06-02T11:00:00-06:00"),
      tipoContingencia: 1,
      motivoContingencia: "MH no disponible"
    }) as Record<string, any>;

    expect(event.identificacion.version).toBe(4);
    expect(event.detalleDTE).toHaveLength(1);
  });
});
