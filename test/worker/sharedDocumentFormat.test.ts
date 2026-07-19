import { describe, expect, it } from "vitest";
import { formatDocument } from "../../src/shared/documentFormat";

describe("formatDocument", () => {
  it("formats a 14-digit NIT with NIT dashes", () => {
    expect(formatDocument("06142803901122")).toBe("0614-280390-112-2");
  });

  it("formats an already-dashed NIT from its digits", () => {
    expect(formatDocument("0614-280390-112-2")).toBe("0614-280390-112-2");
  });

  it("formats a 9-digit DUI as ########-#", () => {
    expect(formatDocument("100000027")).toBe("10000002-7");
  });

  it("passes values containing letters through unchanged", () => {
    expect(formatDocument("PASAPORTE-AB123456")).toBe("PASAPORTE-AB123456");
  });

  it("passes the empty string through", () => {
    expect(formatDocument("")).toBe("");
  });

  it("returns the empty string for null and undefined", () => {
    expect(formatDocument(null)).toBe("");
    expect(formatDocument(undefined)).toBe("");
  });

  it("passes other digit lengths through unchanged", () => {
    expect(formatDocument("12345")).toBe("12345");
  });
});
