import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeApiProxy } from "../../scripts/stripe-local-api-proxy.mjs";

let server: Server | null = null;

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  }
  server = null;
});

describe("local Stripe API bridge", () => {
  it("forwards only Stripe v1 paths to the fixed HTTPS upstream", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ object: "checkout.session" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Request-Id": "req_fixture" }
    }));
    const runningServer = createStripeApiProxy(upstreamFetch);
    server = runningServer;
    const port = await listenOnLoopback(runningServer);

    const response = await fetch(`http://127.0.0.1:${port}/v1/checkout/sessions?limit=1`, {
      headers: { Authorization: "Bearer rk_test_fixture" }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "checkout.session" });
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
      "https://api.stripe.com/v1/checkout/sessions?limit=1"
    );
    expect(new Headers(upstreamFetch.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer rk_test_fixture");

    const rejected = await fetch(`http://127.0.0.1:${port}/not-stripe`);
    expect(rejected.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});

function listenOnLoopback(target: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      const address = target.address();
      if (!address || typeof address === "string") {
        reject(new Error("loopback listener did not expose a port"));
        return;
      }
      resolve(address.port);
    });
  });
}
