import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rejectionDetailForDocument } from "../../src/client/rejectionDetail";

const rejected = (overrides: Partial<{ status: string; mh_observaciones_json: string; mh_estado: string | null }> = {}) => ({
  status: "REJECTED",
  mh_observaciones_json: JSON.stringify(["El número de control no coincide"]),
  mh_estado: "RECHAZADO",
  ...overrides
});

describe("rejectionDetailForDocument", () => {
  it("reloads audit evidence after a same-document mutation", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
    const actionBlock = appSource.match(
      /async function documentAction[\s\S]*?\n  async function saveDocumentEmail/
    )?.[0] ?? "";

    expect(actionBlock).toMatch(
      /await refresh\(\);\s*setSelectedDocumentDetailVersion\(\(current\) => current \+ 1\);/
    );
  });

  it("keeps direct observations and removes duplicates", () => {
    const detail = rejectionDetailForDocument(
      rejected({ mh_observaciones_json: JSON.stringify(["Documento inválido", "Documento inválido", "Receptor incompleto"]) }),
      []
    );
    expect(detail?.reasons).toEqual(["Documento inválido", "Receptor incompleto"]);
  });

  it("extracts code, description, and observations from a stringified MH error", () => {
    const raw = {
      codigoMsg: "020",
      descripcionMsg: "DOCUMENTO INVALIDO",
      observaciones: ["DOCUMENTO INVALIDO", "[identificacion.numeroControl] valor inválido"]
    };
    const detail = rejectionDetailForDocument(rejected({ mh_observaciones_json: JSON.stringify([JSON.stringify(raw)]) }), []);
    expect(detail?.reasons).toEqual(["020: DOCUMENTO INVALIDO", "[identificacion.numeroControl] valor inválido"]);
    expect(detail?.reasons.join(" ")).not.toContain("codigoMsg");
  });

  it("uses the newest relevant audit row with a valid timestamp", () => {
    const detail = rejectionDetailForDocument(rejected(), [
      { action: "DOCUMENT_EMAIL_UPDATED", created_at: "2026-07-11T22:00:00.000Z" },
      { action: "DTE_RETRIED", created_at: "2026-07-11T22:11:00.000Z" },
      { action: "DTE_REJECTED", created_at: "2026-07-05T18:00:00.000Z" }
    ]);
    expect(detail?.rejectedAt).toBe("2026-07-11T22:11:00.000Z");
  });

  it("skips invalid relevant timestamps and never uses updated_at", () => {
    const documentWithLaterUpdate = { ...rejected(), updated_at: "2026-07-11T23:00:00.000Z" };
    const detail = rejectionDetailForDocument(
      documentWithLaterUpdate,
      [{ action: "DTE_REJECTED", created_at: "not-a-date" }]
    );
    expect(detail?.rejectedAt).toBeNull();
  });

  it("falls back safely for malformed or missing evidence", () => {
    expect(rejectionDetailForDocument(rejected({ mh_observaciones_json: "not-json", mh_estado: "HTTP_400" }), [])?.reasons).toEqual(["HTTP_400"]);
    expect(rejectionDetailForDocument(rejected({ mh_observaciones_json: "[]", mh_estado: null }), [])?.reasons).toEqual(["Motivo no disponible"]);
  });

  it("returns null for a document that is not rejected", () => {
    expect(rejectionDetailForDocument(rejected({ status: "FAILED" }), [])).toBeNull();
  });
});
