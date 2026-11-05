import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Every dollar amount a person reads goes through the shared formatters in
// src/shared/money.ts, so it carries a thousands separator ("$152,410.00").
// Raw decimals stay only where a machine reads them (CSV/XLSX files, MH/Wompi payloads).
const clientDir = resolve(import.meta.dirname, "../../src/client");
const read = (relative: string) => readFileSync(resolve(import.meta.dirname, "../..", relative), "utf8");

describe("dollar amounts on screen carry thousands separators", () => {
  it("formats the F960 summary count, total and each row amount", () => {
    const source = read("src/client/exportsPanel.tsx");
    expect(source).toContain("<strong>{formatCount(preview.rowCount)}</strong>");
    expect(source).toContain("<strong>{formatUsdAmount(preview.amountTotal)}</strong>");
    expect(source).toContain('<td className="numeric">{formatUsdAmount(row.monto)}</td>');
  });

  it("formats the advanced CDE review total", () => {
    expect(read("src/client/App.tsx")).toContain("<dd>{formatUsdAmount(form.valorTotal)}</dd>");
  });

  it("formats the amount on the /donar thank-you screen", () => {
    expect(read("src/client/donarPage.tsx")).toContain("Monto: {formatUsdAmount(monto)}");
  });

  it("formats the Stripe acknowledgment net amount", () => {
    expect(read("src/client/credentialsPanel.tsx")).toContain("neto {formatCents(acknowledgment.netAmountCents)} USD");
  });

  it("formats the donation-intent audit summary", () => {
    const source = read("src/worker/services/donations.ts");
    expect(source).toContain("summary: `Intención de donación por ${formatCents(intent.amount_cents)} USD`");
    expect(source).not.toContain("(intent.amount_cents / 100).toFixed(2)} USD");
  });

  it("never prints a hand-rolled dollar amount in client markup", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(clientDir).filter((name) => name.endsWith(".tsx"))) {
      readFileSync(join(clientDir, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          // JSX text that prints a literal "$" before an expression (">Total ${amount}"), or a
          // cents/100 toFixed(2) amount, bypasses the shared formatter.
          const rawDollar = /(?<!`)>[^<>{}`]*\$\{/.test(line);
          const toFixedDollar = /\$\{?\(?[\w.]+ \/ 100\)\.toFixed\(2\)/.test(line);
          if (rawDollar || toFixedDollar) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
