// Extracts actor identity/network context from an incoming Worker Request so the
// audit trail can record WHO acted and from WHERE. Everything here is best-effort:
// Cloudflare populates `request.cf` and the standard headers, but every field may
// be undefined (local dev, unusual edge conditions), so all fields are optional and
// undefineds are dropped before the context is persisted.

import { isRecord } from "../utils/guards";

// The subset of IncomingRequestCfProperties we surface in the audit trail. These are
// plan-included (bot-management scores are enterprise-only and deliberately omitted).
const AUDIT_CONTEXT_MAX_BYTES = 4096;
const AUDIT_IP_MAX_BYTES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const AUDIT_STRING_LIMITS = {
  country: 8,
  city: 128,
  region: 128,
  timezone: 128,
  asOrganization: 128,
  colo: 8,
  httpProtocol: 32,
  tlsVersion: 32,
  userAgent: 512
} as const;

export interface AuditActorContext {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  colo?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  userAgent?: string;
  _truncated?: string[];
}

export interface AuditRequestContext {
  ip: string | null;
  context: AuditActorContext;
}

// Cloudflare types `request.cf` as `IncomingRequestCfProperties | undefined`, but the
// standard `Request` DOM type used in tests has no `cf`, so read it defensively.
type CfLike = Partial<{
  country: unknown;
  city: unknown;
  region: unknown;
  timezone: unknown;
  asn: unknown;
  asOrganization: unknown;
  colo: unknown;
  httpProtocol: unknown;
  tlsVersion: unknown;
}>;


function boundedString(
  value: unknown,
  maxBytes: number
): { value?: string; truncated: boolean } {
  if (typeof value !== "string") return { truncated: false };
  const trimmed = value.trim();
  if (!trimmed) return { truncated: false };
  const bytes = encoder.encode(trimmed);
  if (bytes.byteLength <= maxBytes) {
    return { value: trimmed, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    value: decoder.decode(bytes.subarray(0, end)),
    truncated: true
  };
}

export function normalizeAuditIp(input: unknown): string | null {
  return boundedString(input, AUDIT_IP_MAX_BYTES).value ?? null;
}

export function normalizeAuditContext(input: unknown): AuditActorContext {
  if (!isRecord(input)) return {};
  const normalized: AuditActorContext = {};
  const inherited = Array.isArray(input._truncated)
    ? input._truncated.filter(
        (field): field is string =>
          typeof field === "string" &&
          Object.prototype.hasOwnProperty.call(
            AUDIT_STRING_LIMITS,
            field
          )
      )
    : [];
  const truncated = new Set(inherited);

  for (const field of Object.keys(AUDIT_STRING_LIMITS) as Array<
    keyof typeof AUDIT_STRING_LIMITS
  >) {
    const result = boundedString(input[field], AUDIT_STRING_LIMITS[field]);
    if (result.value !== undefined) normalized[field] = result.value;
    if (result.truncated) truncated.add(field);
  }
  if (typeof input.asn === "number" && Number.isFinite(input.asn)) {
    normalized.asn = Math.trunc(input.asn);
  }
  if (truncated.size > 0) {
    normalized._truncated = [...truncated].slice(
      0,
      Object.keys(AUDIT_STRING_LIMITS).length
    );
  }
  return normalized;
}

export function serializeAuditContext(input: unknown): string | null {
  const normalized = normalizeAuditContext(input);
  if (Object.keys(normalized).length === 0) return null;
  let serialized = JSON.stringify(normalized);
  if (encoder.encode(serialized).byteLength <= AUDIT_CONTEXT_MAX_BYTES) {
    return serialized;
  }

  const reduced: AuditActorContext = { ...normalized };
  const truncated = new Set(normalized._truncated ?? []);
  delete reduced._truncated;
  const fields = Object.keys(AUDIT_STRING_LIMITS) as Array<
    keyof typeof AUDIT_STRING_LIMITS
  >;

  // Remove fields from the end of the fixed allowlist only until the escaped JSON
  // fits. Every omitted field is visible through the bounded, recognized marker list.
  for (const field of fields.reverse()) {
    if (reduced[field] === undefined) continue;
    delete reduced[field];
    truncated.add(field);
    reduced._truncated = [...truncated].slice(0, fields.length);
    serialized = JSON.stringify(reduced);
    if (encoder.encode(serialized).byteLength <= AUDIT_CONTEXT_MAX_BYTES) {
      return serialized;
    }
  }

  // With every capped string removed, only a finite ASN and known field markers
  // remain, which is necessarily below the aggregate byte ceiling.
  return serialized;
}

export function auditContextFrom(request: Request): AuditRequestContext {
  const cf = ((request as unknown as { cf?: CfLike }).cf ?? {}) as CfLike;
  return {
    ip: normalizeAuditIp(request.headers.get("cf-connecting-ip")),
    context: normalizeAuditContext({
      country: cf.country,
      city: cf.city,
      region: cf.region,
      timezone: cf.timezone,
      asn: cf.asn,
      asOrganization: cf.asOrganization,
      colo: cf.colo,
      httpProtocol: cf.httpProtocol,
      tlsVersion: cf.tlsVersion,
      userAgent: request.headers.get("user-agent")
    })
  };
}
