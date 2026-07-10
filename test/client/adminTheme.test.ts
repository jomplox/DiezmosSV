import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

// The admin reskin funnels the whole UI through ONE Marca color (--accent) plus a
// small derived layer, keeps the semantic ok/danger/warn palettes independent of
// that color, and de-teals every hardcoded surface into either an accent mix or a
// neutral gray. These pins guard that contract so a future edit can't silently
// re-introduce a fixed teal sidebar or a teal-tinted "ACEPTADO" badge.

describe("derived accent theme layer", () => {
  it("defines the accent-derived variables as color-mix off --accent", () => {
    for (const name of [
      "--accent-strong",
      "--accent-tint",
      "--accent-tint-border",
      "--accent-ink",
      "--sidebar-bg"
    ]) {
      const decl = stylesSource.match(new RegExp(`${name}:\\s*color-mix\\([^;]*var\\(--accent\\)[^;]*\\);`));
      expect(decl, `${name} must be a color-mix off var(--accent)`).not.toBeNull();
    }
  });

  it("derives the sidebar family from the accent so black paints an elegant near-black", () => {
    // Sidebar background/hover/active all mix the accent into a dark neutral base,
    // so #000000 collapses to graphite instead of leaving a fixed teal.
    expect(stylesSource).toMatch(/--sidebar-bg:\s*color-mix\(in srgb, var\(--accent\) 25%, #101418\)/);
    expect(stylesSource).toMatch(/--sidebar-hover:\s*color-mix\(in srgb, var\(--accent\)[^;]*#101418\)/);
    expect(stylesSource).toMatch(/--sidebar-active:\s*color-mix\(in srgb, var\(--accent\)[^;]*#101418\)/);
  });
});

describe("semantic palette stays independent of the accent", () => {
  it("defines a neutral-green ok family with no var(--accent) in its values", () => {
    for (const name of ["--ok", "--ok-tint", "--ok-border", "--ok-ink"]) {
      const decl = stylesSource.match(new RegExp(`${name}:\\s*([^;]*);`));
      expect(decl, `${name} must be defined`).not.toBeNull();
      expect(decl?.[1] ?? "", `${name} must not reference the accent`).not.toContain("var(--accent");
    }
  });

  it("promotes danger and warning to accent-independent variables", () => {
    for (const name of ["--danger", "--danger-tint", "--danger-border", "--warn", "--warn-accent", "--warn-tint", "--warn-border"]) {
      const decl = stylesSource.match(new RegExp(`${name}:\\s*([^;]*);`));
      expect(decl, `${name} must be defined`).not.toBeNull();
      expect(decl?.[1] ?? "", `${name} must not reference the accent`).not.toContain("var(--accent");
    }
  });

  it("keeps the historical danger red, readable warning text, and yellow warning accent", () => {
    expect(stylesSource).toMatch(/--danger:\s*#a93530/);
    expect(stylesSource).toMatch(/--warn:\s*#855900/);
    expect(stylesSource).toMatch(/--warn-accent:\s*#f2c94c/);
  });
});

describe("no teal-family literals survive the reskin", () => {
  // Everything an accent should drive is now var(--accent[...]) or an --accent-* / --ok
  // variable; neutral chrome is a small consistent gray scale. None of the old teal
  // surface hexes may remain anywhere in the sheet (donor styles never used them).
  const banned = [
    "#143339",
    "#1b383d",
    "#112327",
    "#edf9f7",
    "#c8ebe7",
    "#eef8f7",
    "#52656c",
    "#61737a"
  ];
  for (const hex of banned) {
    it(`has removed ${hex}`, () => {
      expect(stylesSource).not.toMatch(new RegExp(hex, "i"));
    });
  }
});

describe("component polish adopts the donor visual language", () => {
  it("keeps the reduced-motion guard and never animates admin surfaces longer than 300ms", () => {
    expect(stylesSource).toContain("@media (prefers-reduced-motion: reduce)");
    // Timing budget is scoped to the admin half of the sheet; the donor spinner's
    // 800ms continuous loop (in the untouched .donar-* block) is out of scope.
    const donorStart = stylesSource.indexOf(".donar-screen");
    const adminStyles = donorStart > -1 ? stylesSource.slice(0, donorStart) : stylesSource;
    const durations = adminStyles.match(/(\d+)ms/g) ?? [];
    for (const d of durations) {
      expect(Number.parseInt(d, 10)).toBeLessThanOrEqual(300);
    }
  });
});
