import { describe, expect, it } from "vitest";
import {
  InvalidJsonBodyError,
  readBodyBytes,
  readJsonObject,
  RequestBodyTooLargeError
} from "../../src/worker/utils/http";

describe("bounded request readers", () => {
  it("accepts a body exactly at the configured byte limit", async () => {
    const body = "x".repeat(16);

    const bytes = await readBodyBytes(new Request("https://example.org", { method: "POST", body }), 16);

    expect(new TextDecoder().decode(bytes)).toBe(body);
  });

  it("rejects a streamed body that exceeds a false declared Content-Length", async () => {
    const request = new Request("https://example.org", {
      method: "POST",
      headers: { "Content-Length": "1" },
      body: "x".repeat(17)
    });

    await expect(readBodyBytes(request, 16)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("rejects an oversized body when Content-Length is absent", async () => {
    const request = new Request("https://example.org", { method: "POST", body: "x".repeat(17) });

    await expect(readBodyBytes(request, 16)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it("distinguishes strict and tolerant malformed JSON", async () => {
    await expect(
      readJsonObject(new Request("https://example.org", { method: "POST", body: "{" }), {
        limitBytes: 16,
        malformed: "throw"
      })
    ).rejects.toBeInstanceOf(InvalidJsonBodyError);

    await expect(
      readJsonObject(new Request("https://example.org", { method: "POST", body: "{" }), {
        limitBytes: 16,
        malformed: "empty-object"
      })
    ).resolves.toEqual({});
  });
});
