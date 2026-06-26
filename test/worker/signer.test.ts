import { describe, expect, it } from "vitest";
import { parseMhCertificate, signMhDocument, verifyMhJws } from "../../src/worker/domain/signer";
import { base64ToBytes, bytesToBase64, hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";

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

  it("parses the bundled MH-shaped XML certificate", async () => {
    const xml = await import("node:fs").then((fs) =>
      fs.readFileSync("DTE/dte-firmador/dockerSinSSL/docker/certificado/Certificado_10000000000001.crt", "utf8")
    );
    const parsed = await parseMhCertificate(xml);

    expect(parsed.nit).toBe("10000000000001");
    expect(parsed.active).toBe(true);
    expect(base64ToBytes(parsed.privateKeyBase64).byteLength).toBeGreaterThan(1000);
  });
});

async function generatedCertificateXml(password: string): Promise<string> {
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
  return `<CertificadoMH><nit>12345678901234</nit><publicKey><encodied>${bytesToBase64(spki)}</encodied></publicKey><privateKey><encodied>${bytesToBase64(pkcs8)}</encodied><clave>${passwordHash}</clave></privateKey><activo>true</activo></CertificadoMH>`;
}
