import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import type { Env, IssuanceMessage } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("Worker fetch error handling", () => {
  it("converts async API auth errors into JSON responses", async () => {
    const response = await worker.fetch(new Request("https://example.org/api/documents"), {
      DB: {} as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher
    } as Env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "auth_error" });
  });

  it("logs unexpected failures without returning their raw message", async () => {
    const sensitiveMessage = "D1 credential sentinel must stay server-side";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env({
        prepare: () => {
          throw new Error(sensitiveMessage);
        }
      } as unknown as InMemoryD1)
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: "internal_error", message: "Ocurrió un error interno." });
    expect(JSON.stringify(payload)).not.toContain(sensitiveMessage);
    expect(errorSpy).toHaveBeenCalledWith({
      event: "unhandled_worker_request_error",
      app_env: "local",
      error_name: "error",
      error_code: "unknown"
    });
  });
});

describe("Worker non-fetch handler error containment", () => {
  it("contains a DLQ failure and retries every unresolved message", async () => {
    const sensitiveMessage = "DLQ failed for ana@example.org at https://private.example/dte_123";
    const ack = vi.fn();
    const retry = vi.fn();
    const retryAll = vi.fn();
    const batch = {
      queue: "diezmossv-staging-example-issuance-dlq",
      messages: [{
        id: "msg_private",
        timestamp: new Date(),
        body: { advancedDocumentId: "dte_123" },
        attempts: 1,
        ack,
        retry
      }],
      ackAll: vi.fn(),
      retryAll
    } as unknown as MessageBatch<IssuanceMessage>;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      worker.queue(batch, {
        DB: {
          prepare() {
            throw new Error(sensitiveMessage);
          }
        } as unknown as D1Database,
        APP_ENV: "staging"
      } as Env)
    ).resolves.toBeUndefined();

    expect(ack).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(retryAll).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      event: "queue_handler_failed",
      app_env: "staging",
      error_name: "error",
      error_code: "unknown"
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveMessage);
  });

  it("contains a scheduled prerequisite failure and aborts later sweeps", async () => {
    const sensitiveMessage = "D1 credential sk_live_private for owner@example.org";
    const preparedSql: string[] = [];
    const retryDeferred = vi.spyOn(
      IssuancePipeline.prototype,
      "retryDeferredTransmissions"
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        {
          DB: {
            prepare(sql: string) {
              preparedSql.push(sql);
              return {
                bind() {
                  return this;
                },
                async run() {
                  throw new Error(sensitiveMessage);
                }
              };
            }
          } as unknown as D1Database,
          APP_ENV: "production"
        } as Env
      )
    ).resolves.toBeUndefined();

    expect(preparedSql).toEqual(["DELETE FROM login_rate_limits WHERE expires_at <= ?"]);
    expect(retryDeferred).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith({
      event: "scheduled_handler_failed",
      app_env: "production",
      error_name: "error",
      error_code: "unknown"
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveMessage);
  });
});

describe("static document security policy", () => {
  it("serves blank donor documents during an emergency shutdown without touching admin or webhook routes", async () => {
    const db = new InMemoryD1();
    const assetFetch = vi.fn((request: Request) =>
      Promise.resolve(new Response(`asset:${new URL(request.url).pathname}`))
    );
    const testEnv = env(db, {
      APP_ENV: "production",
      DONATION_INTAKE_DISABLED: "true",
      WOMPI_API_SECRET: "test-wompi-secret",
      ASSETS: { fetch: assetFetch } as unknown as Fetcher
    });

    for (const pathname of ["/", "/donar", "/donar/", "/donar/gracias", "/donar/gracias/"]) {
      const response = await worker.fetch(
        new Request(`https://donations.example.invalid${pathname}?intent=old`),
        testEnv
      );
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get("Content-Type"), pathname).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control"), pathname).toBe("no-store");
      await expect(response.text(), pathname).resolves.toBe("");
    }

    const stripeResult = await worker.fetch(
      new Request("https://donations.example.invalid/donar/stripe/resultado?session_id=cs_live_existing_fixture"),
      testEnv
    );
    expect(stripeResult.status).toBe(200);
    await expect(stripeResult.text()).resolves.toBe("asset:/donar/stripe/resultado");

    const admin = await worker.fetch(
      new Request("https://donations.example.invalid/admin"),
      testEnv
    );
    expect(admin.status).toBe(200);
    await expect(admin.text()).resolves.toBe("asset:/admin");

    const webhook = await worker.fetch(
      new Request("https://donations.example.invalid/webhooks/wompi", {
        method: "POST",
        body: "{}"
      }),
      testEnv
    );
    expect(webhook.status).toBe(401);
    await expect(webhook.json()).resolves.toEqual({ error: "invalid_wompi_hash" });
    expect(assetFetch).toHaveBeenCalledTimes(2);
  });

  it("serves only the donor, admin, callback, and asset paths while redirecting other documents", async () => {
    const db = new InMemoryD1();
    const assetFetch = vi.fn((request: Request) =>
      Promise.resolve(new Response(`asset:${new URL(request.url).pathname}`))
    );
    const testEnv = env(db, {
      APP_ENV: "production",
      APP_ORIGIN: "https://donations.example.invalid",
      ASSETS: { fetch: assetFetch } as unknown as Fetcher
    });
    const cases = [
      { url: "https://donations.example.invalid/", status: 200, location: null },
      { url: "https://donations.example.invalid/admin", status: 200, location: null },
      { url: "https://donations.example.invalid/admin/users", status: 200, location: null },
      { url: "https://donations.example.invalid/donar/gracias?intent=abc", status: 200, location: null },
      { url: "https://donations.example.invalid/assets/app.js", status: 200, location: null },
      {
        url: "https://donations.example.invalid/donar?ruta=sv",
        status: 302,
        location: "https://donations.example.invalid/?ruta=sv"
      },
      {
        url: "https://donations.example.invalid/documents?stale=1",
        status: 302,
        location: "https://donations.example.invalid/"
      },
      {
        url: "https://worker.example.invalid/donar?ruta=us",
        status: 302,
        location: "https://donations.example.invalid/?ruta=us"
      },
      {
        url: "https://worker.example.invalid/donar/gracias?intent=legacy",
        status: 302,
        location: "https://donations.example.invalid/donar/gracias?intent=legacy"
      },
      {
        url: "https://worker.example.invalid/admin",
        status: 302,
        location: "https://donations.example.invalid/admin"
      }
    ] as const;

    for (const testCase of cases) {
      const response = await worker.fetch(new Request(testCase.url), testEnv);
      expect(
        { status: response.status, location: response.headers.get("Location") },
        testCase.url
      ).toEqual({ status: testCase.status, location: testCase.location });
    }

    expect(assetFetch).toHaveBeenCalledTimes(5);
  });

  it("adds anti-framing and no-referrer headers without changing the asset response", async () => {
    const db = new InMemoryD1();
    const assetResponse = new Response("<!doctype html><title>DiezmosSV</title>", {
      status: 202,
      statusText: "Asset response",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        ETag: '"asset-v1"',
        "Content-Security-Policy": "default-src 'self'; frame-ancestors https://legacy.example; script-src 'self'"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/admin"),
      env(db, {
        ASSETS: { fetch: () => Promise.resolve(assetResponse) } as unknown as Fetcher
      })
    );

    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Asset response");
    await expect(response.text()).resolves.toBe("<!doctype html><title>DiezmosSV</title>");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("ETag")).toBe('"asset-v1"');
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp.match(/frame-ancestors/gi)).toHaveLength(1);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("legacy.example");
  });

  it("leaves non-document asset responses unchanged", async () => {
    const db = new InMemoryD1();
    const assetResponse = new Response("console.log('ok')", {
      headers: { "Content-Type": "application/javascript", ETag: '"script-v1"' }
    });

    const response = await worker.fetch(
      new Request("https://example.org/assets/app.js"),
      env(db, {
        ASSETS: { fetch: () => Promise.resolve(assetResponse) } as unknown as Fetcher
      })
    );

    expect(response).toBe(assetResponse);
    expect(response.headers.has("X-Frame-Options")).toBe(false);
    expect(response.headers.get("ETag")).toBe('"script-v1"');
  });
});
