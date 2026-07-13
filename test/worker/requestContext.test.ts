import { describe, expect, it } from "vitest";
import {
  auditContextFrom,
  normalizeAuditContext,
  normalizeAuditIp,
  serializeAuditContext
} from "../../src/worker/services/requestContext";

const utf8Length = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

// Cloudflare only exposes `request.cf` in the Workers runtime; in tests we attach a
// plain object and the helper reads it defensively via `(request as any).cf`.
function requestWith(init: { headers?: Record<string, string>; cf?: Record<string, unknown> }): Request {
  const request = new Request("https://example.org/api/auth/login", {
    method: "POST",
    headers: init.headers ?? {}
  });
  if (init.cf) {
    Object.defineProperty(request, "cf", { value: init.cf, configurable: true });
  }
  return request;
}

describe("auditContextFrom", () => {
  it("captures the client IP and the plan-included cf fields plus user-agent", () => {
    const request = requestWith({
      headers: {
        "cf-connecting-ip": "190.86.1.2",
        "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36"
      },
      cf: {
        country: "SV",
        city: "San Salvador",
        region: "San Salvador",
        timezone: "America/El_Salvador",
        asn: 27773,
        asOrganization: "Claro El Salvador",
        colo: "SJO",
        httpProtocol: "HTTP/2",
        tlsVersion: "TLSv1.3"
      }
    });

    const { ip, context } = auditContextFrom(request);

    expect(ip).toBe("190.86.1.2");
    expect(context).toEqual({
      country: "SV",
      city: "San Salvador",
      region: "San Salvador",
      timezone: "America/El_Salvador",
      asn: 27773,
      asOrganization: "Claro El Salvador",
      colo: "SJO",
      httpProtocol: "HTTP/2",
      tlsVersion: "TLSv1.3",
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36"
    });
  });

  it("returns a null IP and an empty context when nothing is available", () => {
    const { ip, context } = auditContextFrom(requestWith({}));

    expect(ip).toBeNull();
    expect(context).toEqual({});
  });

  it("drops undefined and empty cf fields instead of storing them", () => {
    const request = requestWith({
      headers: { "cf-connecting-ip": "  10.0.0.1  " },
      cf: { country: "SV", city: "", asn: undefined, asOrganization: "  Tigo  " }
    });

    const { ip, context } = auditContextFrom(request);

    // The IP header is trimmed.
    expect(ip).toBe("10.0.0.1");
    // Only the fields Cloudflare actually populated survive, trimmed.
    expect(context).toEqual({ country: "SV", asOrganization: "Tigo" });
    expect(Object.keys(context)).not.toContain("city");
    expect(Object.keys(context)).not.toContain("asn");
  });

  it("caps every string in UTF-8 bytes and records the truncated fields", () => {
    const normalized = normalizeAuditContext({
      country: "S".repeat(20),
      colo: "SJO".repeat(10),
      city: "á".repeat(100),
      region: "R".repeat(200),
      timezone: "America/El_Salvador".repeat(20),
      asOrganization: "Org".repeat(100),
      httpProtocol: "H".repeat(80),
      tlsVersion: "T".repeat(80),
      userAgent: "🧪".repeat(300),
      ignored: "x".repeat(100_000)
    });

    expect(utf8Length(normalized.country!)).toBeLessThanOrEqual(8);
    expect(utf8Length(normalized.colo!)).toBeLessThanOrEqual(8);
    expect(utf8Length(normalized.city!)).toBeLessThanOrEqual(128);
    expect(utf8Length(normalized.region!)).toBeLessThanOrEqual(128);
    expect(utf8Length(normalized.timezone!)).toBeLessThanOrEqual(128);
    expect(utf8Length(normalized.asOrganization!)).toBeLessThanOrEqual(128);
    expect(utf8Length(normalized.httpProtocol!)).toBeLessThanOrEqual(32);
    expect(utf8Length(normalized.tlsVersion!)).toBeLessThanOrEqual(32);
    expect(utf8Length(normalized.userAgent!)).toBeLessThanOrEqual(512);
    expect(normalized.userAgent).not.toContain("�");
    expect(normalized).not.toHaveProperty("ignored");
    expect(normalized._truncated).toEqual([
      "country",
      "city",
      "region",
      "timezone",
      "asOrganization",
      "colo",
      "httpProtocol",
      "tlsVersion",
      "userAgent"
    ]);
  });

  it("keeps persisted actor fields within their final byte budgets", () => {
    expect(utf8Length(normalizeAuditIp("🧪".repeat(100))!)).toBeLessThanOrEqual(64);
    const serialized = serializeAuditContext({
      userAgent: "🧪".repeat(10_000),
      city: "a".repeat(10_000),
      asn: 27773
    });
    expect(serialized).not.toBeNull();
    expect(utf8Length(serialized!)).toBeLessThanOrEqual(4096);
    expect(JSON.parse(serialized!)).toMatchObject({
      asn: 27773,
      _truncated: expect.arrayContaining(["city", "userAgent"])
    });
  });
});
