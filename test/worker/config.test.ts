import { describe, expect, it } from "vitest";
import { getMhCertificateXml } from "../../src/worker/config";
import type { Env } from "../../src/worker/types";

describe("worker config", () => {
  it("uses the single MH certificate secret when present", () => {
    expect(getMhCertificateXml(env({ MH_CERT_XML: "full-cert" }))).toBe("full-cert");
  });

  it("assembles the MH certificate from split Cloudflare secrets", () => {
    expect(getMhCertificateXml(env({ MH_CERT_XML_PART_1: "first-", MH_CERT_XML_PART_2: "second" }))).toBe("first-second");
  });

  it("requires both split certificate parts", () => {
    expect(() => getMhCertificateXml(env({ MH_CERT_XML_PART_1: "first" }))).toThrow(/PART_1 and MH_CERT_XML_PART_2/);
  });
});

function env(values: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ...values
  };
}
