import { describe, expect, it } from "vitest";
import { verifyWompiHash } from "../../src/worker/domain/wompi";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";

describe("Wompi webhook security", () => {
  it("verifies HMAC-SHA256 over the raw body", async () => {
    const secret = "wompi-secret";
    const body = JSON.stringify({ IdTransaccion: "abc", ResultadoTransaccion: "ExitosaAprobada" });
    const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = hexFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body))));

    await expect(verifyWompiHash(body, signature, secret)).resolves.toBe(true);
    await expect(verifyWompiHash(`${body}\n`, signature, secret)).resolves.toBe(false);
  });
});
