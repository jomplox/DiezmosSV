import { describe, expect, it } from "vitest";
import {
  issuanceFailureEvidence,
  OperatorSafeIssuanceError
} from "../../src/worker/services/issuanceFailure";

describe("issuanceFailureEvidence", () => {
  it("keeps and normalizes only an explicit operator-safe projection", () => {
    const error = new OperatorSafeIssuanceError(
      "CDE_SCHEMA",
      "  La validación del esquema CDE\n falló.  "
    );

    expect(issuanceFailureEvidence(error)).toEqual({
      code: "CDE_SCHEMA",
      message: "La validación del esquema CDE falló."
    });
  });

  it("caps even a trusted operator-safe message at 1,000 characters", () => {
    expect(issuanceFailureEvidence(
      new OperatorSafeIssuanceError("CDE_SCHEMA", "x".repeat(1200))
    ).message)
      .toHaveLength(1000);
  });

  it("maps arbitrary Error messages and thrown values to one generic evidence pair", () => {
    const unsafe = new Error(
      "Bearer sk-live-secret donor@example.org $123.45 " +
      "https://internal.example/retry\n    at retryIssuance (worker.ts:1:1)"
    );

    expect(issuanceFailureEvidence(unsafe)).toEqual({
      code: "ISSUANCE_ERROR",
      message: "Fallo de emisión sin detalle"
    });
    expect(issuanceFailureEvidence({ token: "secret" })).toEqual({
      code: "ISSUANCE_ERROR",
      message: "Fallo de emisión sin detalle"
    });
  });

  it("rejects an invalid code even when it comes from the trusted type", () => {
    expect(issuanceFailureEvidence(
      new OperatorSafeIssuanceError("unsafe code", "Mensaje supuestamente seguro")
    )).toEqual({
      code: "ISSUANCE_ERROR",
      message: "Fallo de emisión sin detalle"
    });
  });
});
