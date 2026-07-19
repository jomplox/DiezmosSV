import { describe, expect, it } from "vitest";
import { isRecord, normalizeUuidV4, onlyDigits, UUID_V4_PATTERN } from "../../src/worker/utils/guards";

describe("normalizeUuidV4", () => {
  it("passes a valid lowercase v4 uuid through", () => {
    expect(normalizeUuidV4("9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23")).toBe(
      "9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23"
    );
  });

  it("normalizes an uppercase v4 uuid to lowercase", () => {
    expect(normalizeUuidV4("9B2F8A4E-6D1C-4F3A-8B5E-2A7C9D0E1F23")).toBe(
      "9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23"
    );
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeUuidV4("  9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23 ")).toBe(
      "9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23"
    );
  });

  it("rejects a v1 uuid", () => {
    expect(normalizeUuidV4("9b2f8a4e-6d1c-1f3a-8b5e-2a7c9d0e1f23")).toBeNull();
  });

  it("rejects garbage and non-strings", () => {
    expect(normalizeUuidV4("not-a-uuid")).toBeNull();
    expect(normalizeUuidV4("")).toBeNull();
    expect(normalizeUuidV4(42)).toBeNull();
    expect(normalizeUuidV4(null)).toBeNull();
    expect(normalizeUuidV4(undefined)).toBeNull();
  });
});

describe("UUID_V4_PATTERN", () => {
  it("enforces the version-4 and variant nibbles", () => {
    expect(UUID_V4_PATTERN.test("9b2f8a4e-6d1c-4f3a-8b5e-2a7c9d0e1f23")).toBe(true);
    expect(UUID_V4_PATTERN.test("9b2f8a4e-6d1c-4f3a-cb5e-2a7c9d0e1f23")).toBe(false);
  });
});

describe("onlyDigits", () => {
  it("strips every non-digit character", () => {
    expect(onlyDigits("0614-280390-112-2")).toBe("06142803901122");
  });

  it("returns the empty string for null and undefined", () => {
    expect(onlyDigits(null)).toBe("");
    expect(onlyDigits(undefined)).toBe("");
  });
});

describe("isRecord", () => {
  it("accepts plain objects and rejects arrays, null, and primitives", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});
