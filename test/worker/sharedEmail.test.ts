import { describe, expect, it } from "vitest";
import { EMAIL_PATTERN, isValidEmail } from "../../src/shared/email";

describe("isValidEmail", () => {
  it("accepts a minimal well-formed address", () => {
    expect(isValidEmail("legacy-email-101@example.com")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects addresses containing spaces", () => {
    expect(isValidEmail("a b@example.org")).toBe(false);
    expect(isValidEmail("a@examp le.org")).toBe(false);
  });

  it("rejects addresses missing the @", () => {
    expect(isValidEmail("a.example.org")).toBe(false);
  });

  it("rejects addresses whose domain has no dot", () => {
    expect(isValidEmail("a@example")).toBe(false);
  });
});

describe("EMAIL_PATTERN", () => {
  it("matches the same inputs as isValidEmail", () => {
    expect(EMAIL_PATTERN.test("legacy-email-101@example.com")).toBe(true);
    expect(EMAIL_PATTERN.test("a@example")).toBe(false);
  });
});
