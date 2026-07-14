import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { passwordResetConfirmValidationMessage, resetTokenFromHash } from "../../src/client/passwordReset";

describe("password reset client helpers", () => {
  it("extracts the reset token only from a URL fragment", () => {
    expect(resetTokenFromHash("#reset=abc123_-XYZ")).toBe("abc123_-XYZ");
    expect(resetTokenFromHash("#foo=1&reset=tok")).toBe("tok");
    expect(resetTokenFromHash("")).toBeNull();
    expect(resetTokenFromHash("#reset=")).toBeNull();
  });

  it("captures and removes the fragment before React mounts", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/client/main.tsx"), "utf8");
    const capture = source.indexOf("resetTokenFromHash(window.location.hash)");
    const cleanup = source.indexOf("window.history.replaceState");
    const mount = source.indexOf("createRoot(");

    expect(capture).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(capture);
    expect(cleanup).toBeLessThan(mount);
  });

  it("validates the new password against the shared policy and confirmation", () => {
    expect(passwordResetConfirmValidationMessage("Fresh#Pass2026", "Fresh#Pass2026")).toBe("");
    expect(passwordResetConfirmValidationMessage("Fresh#Pass2026", "distinta")).toMatch(/no coinciden/);
    expect(passwordResetConfirmValidationMessage("corta", "corta")).not.toBe("");
  });
});
