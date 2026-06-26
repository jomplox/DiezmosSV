import { describe, expect, it } from "vitest";
import { buildTestWompiPayload } from "../../src/worker/domain/testWompi";
import { ambienteFromWompi, amountCents, donorName, isApprovedDonation } from "../../src/worker/domain/wompi";

describe("admin test Wompi payload", () => {
  it("builds an approved ambiente 00 donation for staging issuance", () => {
    const payload = buildTestWompiPayload({
      amount: "12.34",
      donorName: "Example Person",
      donorEmail: "donor@example.org",
      donorDocument: "100000035",
      donorPhone: "22223333"
    });

    expect(payload.IdTransaccion).toMatch(/^TEST-/);
    expect(payload.EsProductiva).toBe(false);
    expect(ambienteFromWompi(payload)).toBe("00");
    expect(isApprovedDonation(payload)).toBe(true);
    expect(amountCents(payload)).toBe(1234);
    expect(donorName(payload)).toBe("Example Person");
    expect(payload.Cliente?.DocumentoIdentidad).toBe("100000035");
    expect(payload.Cliente?.EMail).toBe("donor@example.org");
  });

  it("rejects non-positive test amounts before queueing", () => {
    expect(() => buildTestWompiPayload({ amount: "0", donorDocument: "100000035" })).toThrow(/positive number/);
  });
});
