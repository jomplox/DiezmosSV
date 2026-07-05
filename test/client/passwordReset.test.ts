import { describe, expect, it } from "vitest";
import { passwordResetConfirmValidationMessage, resetTokenFromSearch } from "../../src/client/passwordReset";

describe("password reset client helpers", () => {
  it("extracts the reset token from the URL query", () => {
    expect(resetTokenFromSearch("?reset=abc123_-XYZ")).toBe("abc123_-XYZ");
    expect(resetTokenFromSearch("?foo=1&reset=tok")).toBe("tok");
    expect(resetTokenFromSearch("")).toBeNull();
    expect(resetTokenFromSearch("?reset=")).toBeNull();
  });

  it("validates the new password against the shared policy and confirmation", () => {
    expect(passwordResetConfirmValidationMessage("Fresh#Pass2026", "Fresh#Pass2026")).toBe("");
    expect(passwordResetConfirmValidationMessage("Fresh#Pass2026", "distinta")).toMatch(/no coinciden/);
    expect(passwordResetConfirmValidationMessage("corta", "corta")).not.toBe("");
  });
});
