import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certificateExpiry, parseMhCertificate, signMhDocument, verifyMhJws } from "../../src/worker/domain/signer";
import { base64ToBytes, bytesToBase64, hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";

// El certificado demo del firmador de MH vive en DTE/dte-firmador/, que está
// deliberadamente fuera de git (distribución de MH con material de llaves).
// La prueba corre donde exista la distribución local y se omite en CI; las
// demás pruebas del firmador usan certificados generados y cubren CI.
const MH_DEMO_CERT_PATH = "DTE/dte-firmador/dockerSinSSL/docker/certificado/Certificado_10000000000001.crt";

describe("native MH signer", () => {
  it("emits an official-style RS512 JWS that verifies with the certificate public key", async () => {
    const password = "correct horse battery staple";
    const certXml = await generatedCertificateXml(password);
    const payload = { identificacion: { tipoDte: "15" }, resumen: { valorTotal: 10 } };

    const jws = await signMhDocument(payload, certXml, password);
    const [, encodedPayload] = jws.split(".");

    expect(jws.split(".")).toHaveLength(3);
    expect(Buffer.from(encodedPayload, "base64url").toString("utf8")).toBe(JSON.stringify(payload, null, 2));
    expect(await verifyMhJws(jws, certXml)).toBe(true);
  });

  it.skipIf(!existsSync(MH_DEMO_CERT_PATH))("parses the bundled MH-shaped XML certificate", async () => {
    const xml = await import("node:fs").then((fs) => fs.readFileSync(MH_DEMO_CERT_PATH, "utf8"));
    const parsed = await parseMhCertificate(xml);

    expect(parsed.nit).toBe("10000000000001");
    expect(parsed.active).toBe(true);
    expect(base64ToBytes(parsed.privateKeyBase64).byteLength).toBeGreaterThan(1000);
  });

  it("spells out the tax authority in signer validation errors", async () => {
    const password = "correct horse battery staple";
    const payload = { identificacion: { tipoDte: "15" }, resumen: { valorTotal: 10 } };

    await expect(signMhDocument(payload, await generatedCertificateXml(password, false), password)).rejects.toThrow(
      "El certificado del Ministerio de Hacienda no está activo"
    );
    await expect(signMhDocument(payload, await generatedCertificateXml(password), "wrong-password")).rejects.toThrow(
      "La contraseña de la llave privada del Ministerio de Hacienda no coincide"
    );
  });
});

describe("certificate expiry", () => {
  it("reads notAfter from the nested epochSecond validity shape (real MH .crt format)", async () => {
    const expirySeconds = 1794097629; // 2026-11-08T00:27:09.000Z, matches a real MH demo cert
    const xml = await generatedCertificateXml("pw", true, {
      validity: `<validity><notBefore><nano>287000000</nano><epochSecond>1636417629</epochSecond></notBefore><notAfter><nano>287000000</nano><epochSecond>${expirySeconds}</epochSecond></notAfter></validity>`
    });

    const result = certificateExpiry(xml);

    expect(result.expiresAt).toBe(new Date(expirySeconds * 1000).toISOString());
  });

  it("reads notAfter from the flat decimal-epoch validity shape (other real MH .crt format)", async () => {
    const xml = await generatedCertificateXml("pw", true, {
      validity: "<validity><notBefore>1725561566.611000000</notBefore><notAfter>1883241566.611000000</notAfter></validity>"
    });

    const result = certificateExpiry(xml);

    expect(result.expiresAt).toBe(new Date(1883241566611).toISOString());
  });

  it("returns a null expiresAt without throwing when the certificate has no validity block", async () => {
    const xml = await generatedCertificateXml("pw");

    const result = certificateExpiry(xml);

    expect(result).toEqual({ expiresAt: null });
  });

  it("returns a null expiresAt without throwing when the XML is empty or malformed", () => {
    expect(certificateExpiry("")).toEqual({ expiresAt: null });
    expect(certificateExpiry("<not-xml")).toEqual({ expiresAt: null });
  });
});

async function generatedCertificateXml(
  password: string,
  active = true,
  options: { validity?: string } = {}
): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const passwordHash = hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-512", utf8Bytes(password))));
  const certificado = options.validity ? `<certificado><basicEstructure>${options.validity}</basicEstructure></certificado>` : "";
  return `<CertificadoMH><nit>12345678901234</nit><publicKey><encodied>${bytesToBase64(spki)}</encodied></publicKey><privateKey><encodied>${bytesToBase64(pkcs8)}</encodied><clave>${passwordHash}</clave></privateKey><activo>${active ? "true" : "false"}</activo>${certificado}</CertificadoMH>`;
}
