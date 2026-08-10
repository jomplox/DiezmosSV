import { createHash } from "node:crypto";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

class RuntimeBrandingLogoMismatchError extends Error {
  constructor() {
    super("Runtime PDF-embeddable donor logo does not match the private release artifact");
    this.name = "RuntimeBrandingLogoMismatchError";
  }
}

export async function verifyRuntimeBrandingLogo(config, { fetchImpl = fetch } = {}) {
  const brandingResponse = await publicFetch(
    fetchImpl,
    new URL("/api/branding", config.origin),
    "Runtime donor logo verification unavailable"
  );
  if (!brandingResponse.ok) {
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
    throw new RuntimeBrandingLogoMismatchError();
  }
  if (!logoResponse.ok) {
    throw new Error("Runtime donor logo verification unavailable");
  }
  const contentType = logoResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "image/png" && contentType !== "image/jpeg") {
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
      headers: { Accept: "application/json, image/png, image/jpeg" }
    });
  } catch {
    throw new Error(errorMessage);
  }
}

async function privateFetch(fetchImpl, url, init, errorMessage) {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new Error(errorMessage);
  }
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
