import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { passwordResetConfirmValidationMessage, readPasswordResetLocation } from "../../src/client/passwordReset";

describe("password reset client helpers", () => {
  it("prefers fragment tokens while preserving unrelated URL state during cleanup", () => {
    expect(readPasswordResetLocation("?campaign=summer&reset=legacy", "#reset=fragment&step=confirm")).toEqual({
      token: "fragment",
      cleanSearch: "?campaign=summer",
      cleanHash: "#step=confirm",
      shouldReplace: true
    });
    expect(readPasswordResetLocation("?campaign=summer", "#donar")).toEqual({
      token: null,
      cleanSearch: "?campaign=summer",
      cleanHash: "#donar",
      shouldReplace: false
    });
  });

  it("accepts and immediately scrubs legacy query links issued before deployment", () => {
    expect(readPasswordResetLocation("?reset=legacy-token&utm_source=email", "")).toEqual({
      token: "legacy-token",
      cleanSearch: "?utm_source=email",
      cleanHash: "",
      shouldReplace: true
    });
    expect(readPasswordResetLocation("?reset=legacy-token", "#donar")).toEqual({
      token: "legacy-token",
      cleanSearch: "",
      cleanHash: "#donar",
      shouldReplace: true
    });
    expect(readPasswordResetLocation("?reset=", "#reset=")).toEqual({
      token: null,
      cleanSearch: "",
      cleanHash: "",
      shouldReplace: true
    });
  });

  it("captures and removes reset parameters before React mounts", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/client/main.tsx"), "utf8");
    const capture = source.indexOf("readPasswordResetLocation(window.location.search, window.location.hash)");
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
