import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
// A stalled origin must fail the release gate with a message, not hang it silently.
const REQUEST_TIMEOUT_MS = 15_000;

class RuntimeBrandingLogoMismatchError extends Error {
  constructor() {
    super("Runtime PDF-embeddable donor logo does not match the private release artifact");
    this.name = "RuntimeBrandingLogoMismatchError";
  }
}

export async function verifyRuntimeBrandingLogo(config, { fetchImpl = fetch } = {}) {
  await assertPrivateBrandingLogoEmbeddable(config);
  const healthResponse = await publicFetch(
    fetchImpl,
    new URL("/api/health", config.origin),
    "Runtime deployment target verification unavailable"
  );
  if (!healthResponse.ok) {
    discardBody(healthResponse);
    throw new Error("Runtime deployment target verification unavailable");
  }
  let health;
  try {
    health = await healthResponse.json();
  } catch {
    throw new Error("Runtime deployment target verification unavailable");
  }
  if (
    health?.appEnv !== config.target ||
    health?.workerName !== config.workerName
  ) {
    throw new Error("Runtime deployment target does not match the selected release target");
  }

  const brandingResponse = await publicFetch(
    fetchImpl,
    new URL("/api/branding", config.origin),
    "Runtime donor logo verification unavailable"
  );
  if (!brandingResponse.ok) {
    discardBody(brandingResponse);
    throw new Error("Runtime donor logo verification unavailable");
  }
  let branding;
  try {
    branding = await brandingResponse.json();
  } catch {
    throw new Error("Runtime donor logo verification unavailable");
  }
  const version = typeof branding?.donorLogoVersion === "string"
    ? branding.donorLogoVersion.trim()
    : "";
  if (!version) {
    throw new RuntimeBrandingLogoMismatchError();
  }

  const logoUrl = new URL("/api/branding/donor-logo", config.origin);
  logoUrl.searchParams.set("v", version);
  const logoResponse = await publicFetch(
    fetchImpl,
    logoUrl,
    "Runtime donor logo verification unavailable"
  );
  if (logoResponse.status === 404) {
    discardBody(logoResponse);
    throw new RuntimeBrandingLogoMismatchError();
  }
  if (!logoResponse.ok) {
    discardBody(logoResponse);
    throw new Error("Runtime donor logo verification unavailable");
  }
  const contentType = logoResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "image/png" && contentType !== "image/jpeg") {
    discardBody(logoResponse);
    throw new RuntimeBrandingLogoMismatchError();
  }
  let bytes;
  try {
    bytes = Buffer.from(await logoResponse.arrayBuffer());
  } catch {
    throw new Error("Runtime donor logo verification unavailable");
  }
  if (sniffRaster(bytes) !== contentType) {
    throw new RuntimeBrandingLogoMismatchError();
  }
  const remoteDigest = createHash("sha256").update(bytes).digest("hex");
  if (remoteDigest !== config.donorLogo.sha256) {
    throw new RuntimeBrandingLogoMismatchError();
  }
  return { matched: true };
}

export async function assertPrivateBrandingLogoEmbeddable(config) {
  try {
    const pdf = await PDFDocument.create();
    const bytes = Uint8Array.from(config.donorLogo.bytes);
    const image = config.donorLogo.contentType === "image/png"
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);
    const page = pdf.addPage([Math.max(1, image.width), Math.max(1, image.height)]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: Math.max(1, image.width),
      height: Math.max(1, image.height)
    });
    await pdf.save();
  } catch {
    throw new Error("Private donor logo is not PDF-embeddable");
  }
}

export async function migrateRuntimeBrandingLogo(
  config,
  credentials,
  { fetchImpl = fetch } = {}
) {
  try {
    await verifyRuntimeBrandingLogo(config, { fetchImpl });
    return { changed: false };
  } catch (error) {
    if (!(error instanceof RuntimeBrandingLogoMismatchError)) {
      throw error;
    }
  }

  const loginResponse = await privateFetch(
    fetchImpl,
    new URL("/api/auth/login", config.origin),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials)
    },
    "Runtime donor logo authentication failed"
  );
  if (!loginResponse.ok) {
    discardBody(loginResponse);
    throw new Error("Runtime donor logo authentication failed");
  }
  let token;
  try {
    const login = await loginResponse.json();
    token = typeof login?.token === "string" ? login.token.trim() : "";
  } catch {
    throw new Error("Runtime donor logo authentication failed");
  }
  if (!token) {
    throw new Error("Runtime donor logo authentication failed");
  }

  const uploadResponse = await privateFetch(
    fetchImpl,
    new URL("/api/settings/branding/donor-logo", config.origin),
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": config.donorLogo.contentType
      },
      body: config.donorLogo.bytes
    },
    "Runtime donor logo upload failed"
  );
  // The upload acknowledgement is never read; the mandatory postflight below is what
  // decides whether the write landed.
  discardBody(uploadResponse);
  if (!uploadResponse.ok) {
    throw new Error("Runtime donor logo upload failed");
  }
  await verifyRuntimeBrandingLogo(config, { fetchImpl });
  return { changed: true };
}

async function publicFetch(fetchImpl, url, errorMessage) {
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json, image/png, image/jpeg" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw requestError(errorMessage, error);
  }
}

async function privateFetch(fetchImpl, url, init, errorMessage) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw requestError(errorMessage, error);
  }
}

// Only this module's own sanitized text is surfaced: the rejected cause can carry the
// origin, path, or credential material, so it is inspected but never interpolated.
function requestError(errorMessage, error) {
  return new Error(timedOut(error) ? `${errorMessage}: the request timed out` : errorMessage);
}

function timedOut(error) {
  return error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
}

// Release an unread body so the process does not linger on a keep-alive socket after
// the gate has already decided to fail.
function discardBody(response) {
  response.body?.cancel().catch(() => {});
}

function sniffRaster(bytes) {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  return null;
}
