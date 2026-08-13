import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8791;
const MAX_BODY_BYTES = 1_048_576;
const UPSTREAM = "https://api.stripe.com";
const ALLOWED_METHODS = new Set(["DELETE", "GET", "POST"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function createStripeApiProxy(upstreamFetch = fetch) {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${HOST}`);
      if (!requestUrl.pathname.startsWith("/v1/") || requestUrl.origin !== `http://${HOST}`) {
        respondJson(response, 404, { error: "not_found" });
        return;
      }
      if (!request.method || !ALLOWED_METHODS.has(request.method)) {
        respondJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      const body = await readBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const upstream = await upstreamFetch(
        new URL(`${requestUrl.pathname}${requestUrl.search}`, UPSTREAM),
        {
          method: request.method,
          headers,
          body: body.length ? body : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000)
        }
      );
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          response.setHeader(name, value);
        }
      }
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "request_too_large";
      respondJson(response, tooLarge ? 413 : 502, {
        error: tooLarge ? "request_too_large" : "stripe_proxy_failed"
      });
    }
  });
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("request_too_large"));
        return;
      }
      resolveBody(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function respondJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  createStripeApiProxy().listen(PORT, HOST, () => {
    console.log(`Stripe sandbox API bridge ready on http://${HOST}:${PORT}`);
  });
}
