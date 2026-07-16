import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDeploymentCanCollectPayments,
  assertDeploymentAllowsAmbiente,
  deploymentEnvironmentPolicy,
  EnvironmentNotAllowedError,
  PaymentCollectionDisabledError
} from "../../src/worker/services/environmentPolicy";
import type { Env } from "../../src/worker/types";

const wranglerToml = readFileSync(resolve(import.meta.dirname, "../../wrangler.toml"), "utf8");

describe("deployment environment policy", () => {
  it.each([
    ["local", "local", "00", true],
    [" staging ", "staging", "00", true],
    ["PRODUCTION", "production", "01", false],
    [undefined, "unknown", null, false],
    ["preview", "unknown", null, false]
  ] as const)("maps %s to an issuance capability", (input, appEnv, allowedAmbiente, directGenerationAllowed) => {
    expect(deploymentEnvironmentPolicy({ APP_ENV: input } as Env)).toEqual({
      appEnv,
      allowedAmbiente,
      directGenerationAllowed
    });
  });

  it("allows only the deployment's exact ambiente and fails unknown deployments closed", () => {
    expect(() => assertDeploymentAllowsAmbiente({ APP_ENV: "staging" } as Env, "00")).not.toThrow();
    expect(() => assertDeploymentAllowsAmbiente({ APP_ENV: "production" } as Env, "01")).not.toThrow();
    expect(() => assertDeploymentAllowsAmbiente({ APP_ENV: "staging" } as Env, "01")).toThrow(EnvironmentNotAllowedError);
    expect(() => assertDeploymentAllowsAmbiente({ APP_ENV: "production" } as Env, "00")).toThrow(EnvironmentNotAllowedError);
    expect(() => assertDeploymentAllowsAmbiente({} as Env, "00")).toThrow(EnvironmentNotAllowedError);
  });

  it.each(["local", "staging", "production"] as const)(
    "allows payment collection in recognized %s deployments",
    (appEnv) => {
      expect(assertDeploymentCanCollectPayments({ APP_ENV: appEnv } as Env)).toBe(
        appEnv === "production" ? "01" : "00"
      );
    }
  );

  it.each([undefined, "", "preview"] as const)("rejects payment collection for %s", (appEnv) => {
    expect(() => assertDeploymentCanCollectPayments({ APP_ENV: appEnv } as Env)).toThrow(
      PaymentCollectionDisabledError
    );
  });

  it("rejects a non-string runtime APP_ENV as an unknown deployment", () => {
    const malformedEnv = { APP_ENV: 42 } as unknown as Env;

    expect(deploymentEnvironmentPolicy(malformedEnv)).toEqual({
      appEnv: "unknown",
      allowedAmbiente: null,
      directGenerationAllowed: false
    });
    expect(() => assertDeploymentCanCollectPayments(malformedEnv)).toThrow(
      PaymentCollectionDisabledError
    );
  });
});

describe("deployment endpoint availability", () => {
  it("makes only TEST endpoints available to local and staging deployments", () => {
    for (const header of ["vars", "env.staging.vars"]) {
      const block = tomlBlock(header);
      expect(block).toContain("MH_AUTH_URL_TEST");
      expect(block).toContain("MH_RECEPCION_URL_TEST");
      expect(block).not.toMatch(/MH_(?:AUTH|RECEPCION|CONTINGENCIA|ANULACION)_URL_PROD/);
    }
  });

  it("makes only PROD endpoints available to production", () => {
    const block = tomlBlock("env.production.vars");
    expect(block).toContain("MH_AUTH_URL_PROD");
    expect(block).toContain("MH_RECEPCION_URL_PROD");
    expect(block).not.toMatch(/MH_(?:AUTH|RECEPCION|CONTINGENCIA|ANULACION)_URL_TEST/);
  });
});

function tomlBlock(header: string): string {
  const marker = `[${header}]`;
  const start = wranglerToml.indexOf(marker);
  if (start < 0) return "";
  const rest = wranglerToml.slice(start + marker.length);
  const next = rest.search(/\n\[/);
  return next < 0 ? rest : rest.slice(0, next);
}
