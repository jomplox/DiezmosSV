// Extracts actor identity/network context from an incoming Worker Request so the
// audit trail can record WHO acted and from WHERE. Everything here is best-effort:
// Cloudflare populates `request.cf` and the standard headers, but every field may
// be undefined (local dev, unusual edge conditions), so all fields are optional and
// undefineds are dropped before the context is persisted.

// The subset of IncomingRequestCfProperties we surface in the audit trail. These are
// plan-included (bot-management scores are enterprise-only and deliberately omitted).
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

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Cloudflare uses "T1" for the Tor pseudo-country and other sentinels; keep them,
  // but drop the empty string so absent fields never bloat the stored blob.
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

// Assigns only defined values so the resulting object (and its JSON) omits every
// field Cloudflare did not provide.
function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function auditContextFrom(request: Request): AuditRequestContext {
  const ip = cleanString(request.headers.get("cf-connecting-ip")) ?? null;
  const cf = ((request as unknown as { cf?: CfLike }).cf ?? {}) as CfLike;
  const userAgent = cleanString(request.headers.get("user-agent"));

  const context: AuditActorContext = {};
  assignDefined(context, "country", cleanString(cf.country));
  assignDefined(context, "city", cleanString(cf.city));
  assignDefined(context, "region", cleanString(cf.region));
  assignDefined(context, "timezone", cleanString(cf.timezone));
  assignDefined(context, "asn", cleanNumber(cf.asn));
  assignDefined(context, "asOrganization", cleanString(cf.asOrganization));
  assignDefined(context, "colo", cleanString(cf.colo));
  assignDefined(context, "httpProtocol", cleanString(cf.httpProtocol));
  assignDefined(context, "tlsVersion", cleanString(cf.tlsVersion));
  assignDefined(context, "userAgent", userAgent);

  return { ip, context };
}
