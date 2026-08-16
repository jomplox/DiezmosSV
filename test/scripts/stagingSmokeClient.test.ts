import { describe, expect, it, vi } from "vitest";
import {
  assertStagingSmokeTarget,
  stagingSmokeFetch
} from "../../scripts/staging-smoke-client.mjs";

describe("staging smoke network target", () => {
  it("verifies the exact staging Worker identity with redirects disabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      appEnv: "staging",
      workerName: "diezmos-sv-staging"
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(assertStagingSmokeTarget({
      baseUrl: "https://staging.example.invalid",
      workerName: "diezmos-sv-staging",
      fetchImpl
    })).resolves.toMatchObject({ appEnv: "staging", workerName: "diezmos-sv-staging" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://staging.example.invalid/api/health",
      expect.objectContaining({ method: "GET", redirect: "error" })
    );
  });

  it("rejects a self-reported staging response from a different Worker", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      appEnv: "staging",
      workerName: "attacker-worker"
    }), { headers: { "Content-Type": "application/json" } }));

    await expect(assertStagingSmokeTarget({
      baseUrl: "https://staging.example.invalid",
      workerName: "diezmos-sv-staging",
      fetchImpl
    })).rejects.toThrow(/identity/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects on credential-bearing requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await stagingSmokeFetch({
      baseUrl: "https://staging.example.invalid",
      path: "/api/auth/login",
      options: {
        method: "POST",
        headers: { Authorization: "Bearer private-token" },
        body: "{}"
      },
      fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://staging.example.invalid/api/auth/login",
      expect.objectContaining({ redirect: "error" })
    );
  });
});
