import { describe, expect, it } from "vitest";
import { issuanceFailureEvidence } from "../../src/worker/services/issuanceFailure";

describe("issuanceFailureEvidence", () => {
  it("keeps a valid safe code and normalizes the Error message", () => {
    const error = Object.assign(new Error("  schema\n failed  "), {
      code: "CDE_SCHEMA"
    });

    expect(issuanceFailureEvidence(error)).toEqual({
      code: "CDE_SCHEMA",
      message: "schema failed"
    });
  });

  it("caps the normalized Error message at 1,000 characters", () => {
    expect(issuanceFailureEvidence(new Error("x".repeat(1200))).message)
      .toHaveLength(1000);
  });

  it("does not serialize arbitrary thrown values", () => {
    expect(issuanceFailureEvidence({ token: "secret" })).toEqual({
      code: "ISSUANCE_ERROR",
      message: "Fallo de emisión sin detalle"
    });
  });
});
