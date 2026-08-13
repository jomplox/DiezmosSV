import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateRuntimeBrandingLogo,
  verifyRuntimeBrandingLogo
} from "../../scripts/runtime-branding-logo.mjs";
import {
  corruptJpegBytes,
  pngBytes as generatePngBytes
} from "../worker/support/rasterFixtures";

const localRasterBytes = Buffer.from(
  generatePngBytes(2, 2, { red: 20, green: 60, blue: 200 })
);
const validJpegBytes = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64"
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime donor logo verification", () => {
  it("accepts only the exact advertised PDF-embeddable raster", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "fixture-version" });
      }
      if (request.url === "/api/branding/donor-logo?v=fixture-version") {
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(localRasterBytes);
      }
      response.writeHead(404).end();
    });

    try {
      const config = runtimeConfig(server.origin);
      await expect(verifyRuntimeBrandingLogo(config, { fetchImpl: fetch })).resolves.toEqual({
        matched: true
      });
      await expect(
        migrateRuntimeBrandingLogo(config, credentials(), { fetchImpl: fetch })
      ).resolves.toEqual({ changed: false });
      expect(requests).toEqual([
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=fixture-version",
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=fixture-version"
      ]);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["legacy SVG", "image/svg+xml", Buffer.from("<svg>private-fixture-bytes</svg>")],
    ["different PNG", "image/png", Buffer.concat([localRasterBytes, Buffer.from([0x01])])],
    ["lying content type", "image/jpeg", localRasterBytes]
  ])("rejects %s as a PDF-embeddable donor logo mismatch", async (_name, contentType, bytes) => {
    const server = await localServer(async (request, response) => {
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "fixture-version" });
      }
      response.writeHead(200, { "Content-Type": contentType });
      response.end(bytes);
    });

    try {
      await expect(
        verifyRuntimeBrandingLogo(runtimeConfig(server.origin), { fetchImpl: fetch })
      ).rejects.toThrow(/PDF-embeddable donor logo/i);
    } finally {
      await server.close();
    }
  });

  it("accepts an exact valid JPEG through the production decoder path", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "jpeg-version" });
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(validJpegBytes);
    });

    try {
      await expect(
        verifyRuntimeBrandingLogo(runtimeConfig(server.origin, {
          bytes: validJpegBytes,
          contentType: "image/jpeg"
        }), { fetchImpl: fetch })
      ).resolves.toEqual({ matched: true });
      expect(requests).toEqual([
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=jpeg-version"
      ]);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["absent", {}],
    ["blank", { donorLogoVersion: "   " }],
    ["null", { donorLogoVersion: null }]
  ])("treats a %s runtime logo version as a mismatch before requesting the stream", async (
    _name,
    body
  ) => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, body);
      }
      response.writeHead(404).end();
    });

    try {
      await expect(
        verifyRuntimeBrandingLogo(runtimeConfig(server.origin), { fetchImpl: fetch })
      ).rejects.toThrow(/PDF-embeddable donor logo/i);
      expect(requests).toEqual(["GET /api/health", "GET /api/branding"]);
    } finally {
      await server.close();
    }
  });

  it("treats a missing runtime logo stream as a mismatch", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "fixture-version" });
      }
      response.writeHead(404).end();
    });

    try {
      await expect(
        verifyRuntimeBrandingLogo(runtimeConfig(server.origin), { fetchImpl: fetch })
      ).rejects.toThrow(/PDF-embeddable donor logo/i);
      expect(requests).toEqual([
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=fixture-version"
      ]);
    } finally {
      await server.close();
    }
  });

  it("bounds every request with an abort signal that is not already spent", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let remoteBytes: Buffer<ArrayBufferLike> = Buffer.from("<svg>legacy</svg>");
    let remoteContentType = "image/svg+xml";
    let version = "legacy-version";
    const server = await localServer(async (request, response) => {
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: version });
      }
      if (request.url?.startsWith("/api/branding/donor-logo")) {
        response.writeHead(200, { "Content-Type": remoteContentType });
        return response.end(remoteBytes);
      }
      if (request.url === "/api/auth/login") {
        return json(response, 200, { token: "fixture-token" });
      }
      if (request.url === "/api/settings/branding/donor-logo") {
        remoteBytes = await requestBody(request);
        remoteContentType = request.headers["content-type"] ?? "";
        version = "raster-version";
        return json(response, 200, { ok: true });
      }
      response.writeHead(404).end();
    });
    const fetchImpl: typeof fetch = (input, init) => {
      signals.push(init?.signal ?? undefined);
      return fetch(input, init);
    };

    try {
      await expect(
        migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), { fetchImpl })
      ).resolves.toEqual({ changed: true });
      expect(signals.length).toBe(8);
      for (const signal of signals) {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      }
    } finally {
      await server.close();
    }
  });

  it("fails closed with a sanitized message when a request times out", async () => {
    const origin = "https://runtime-fixture.example.invalid";
    const timingOutFetch = (() =>
      Promise.reject(
        Object.assign(new Error(`connect timeout on ${origin}`), { name: "TimeoutError" })
      )) as unknown as typeof fetch;

    let message = "";
    try {
      await verifyRuntimeBrandingLogo(runtimeConfig(origin), { fetchImpl: timingOutFetch });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/deployment target verification unavailable: the request timed out/i);
    expect(message).not.toContain(origin);
  });

  it("does not authenticate when the public branding check is unavailable", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      response.writeHead(503).end();
    });

    try {
      await expect(
        migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), {
          fetchImpl: fetch
        })
      ).rejects.toThrow(/verification unavailable/i);
      expect(requests).toEqual(["GET /api/health", "GET /api/branding"]);
    } finally {
      await server.close();
    }
  });

  it("rejects a deployment whose public health target differs before branding or authentication", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/api/health") {
        return json(response, 200, { appEnv: "production" });
      }
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "fixture-version" });
      }
      if (request.url === "/api/branding/donor-logo?v=fixture-version") {
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(localRasterBytes);
      }
      response.writeHead(404).end();
    });

    try {
      await expect(
        migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), {
          fetchImpl: fetch
        })
      ).rejects.toThrow(/deployment target/i);
      expect(requests).toEqual(["GET /api/health"]);
    } finally {
      await server.close();
    }
  });

  it("rejects an exact signature-valid corrupt local and remote raster before any request", async () => {
    const requests: string[] = [];
    const corruptBytes = Buffer.from(corruptJpegBytes());
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: "fixture-version" });
      }
      response.writeHead(200, { "Content-Type": "image/jpeg" });
      response.end(corruptBytes);
    });
    const config = runtimeConfig(server.origin, {
      bytes: corruptBytes,
      contentType: "image/jpeg"
    });

    try {
      await expect(
        verifyRuntimeBrandingLogo(config, { fetchImpl: fetch })
      ).rejects.toThrow(/private donor logo.*PDF-embeddable/i);
      await expect(
        migrateRuntimeBrandingLogo(config, credentials(), { fetchImpl: fetch })
      ).rejects.toThrow(/private donor logo.*PDF-embeddable/i);
      expect(requests).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("runtime donor logo migration", () => {
  it("authenticates, uploads the exact donor slot bytes, and verifies the write", async () => {
    const requests: string[] = [];
    let remoteBytes: Buffer<ArrayBufferLike> = Buffer.from("<svg>legacy</svg>");
    let remoteContentType = "image/svg+xml";
    let version = "legacy-version";
    let upload: { method?: string; path?: string; contentType?: string | undefined; body?: Buffer; authorization?: string | undefined } = {};
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: version });
      }
      if (request.url?.startsWith("/api/branding/donor-logo")) {
        response.writeHead(200, { "Content-Type": remoteContentType });
        return response.end(remoteBytes);
      }
      if (request.url === "/api/auth/login") {
        expect(await requestBody(request)).toEqual(
          Buffer.from(JSON.stringify(credentials()))
        );
        return json(response, 200, { token: "fixture-token", user: { role: "OWNER" } });
      }
      if (request.url === "/api/settings/branding/donor-logo") {
        const body = await requestBody(request);
        upload = {
          method: request.method,
          path: request.url,
          contentType: request.headers["content-type"],
          authorization: request.headers.authorization,
          body
        };
        remoteBytes = body;
        remoteContentType = request.headers["content-type"] ?? "";
        version = "raster-version";
        return json(response, 200, { ok: true, donorLogoVersion: version });
      }
      response.writeHead(404).end();
    });

    try {
      await expect(
        migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), {
          fetchImpl: fetch
        })
      ).resolves.toEqual({ changed: true });
      expect(upload).toMatchObject({
        method: "PUT",
        path: "/api/settings/branding/donor-logo",
        contentType: "image/png",
        authorization: "Bearer fixture-token"
      });
      expect(upload.body).toEqual(localRasterBytes);
      expect(requests).toEqual([
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=legacy-version",
        "POST /api/auth/login",
        "PUT /api/settings/branding/donor-logo",
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=raster-version"
      ]);
    } finally {
      await server.close();
    }
  });

  it("restores the donor slot when the runtime advertises no logo at all", async () => {
    const requests: string[] = [];
    let remoteBytes: Buffer<ArrayBufferLike> | null = null;
    let version: string | null = null;
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: version });
      }
      if (request.url?.startsWith("/api/branding/donor-logo")) {
        if (!remoteBytes) return response.writeHead(404).end();
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(remoteBytes);
      }
      if (request.url === "/api/auth/login") {
        return json(response, 200, { token: "fixture-token" });
      }
      if (request.url === "/api/settings/branding/donor-logo") {
        remoteBytes = await requestBody(request);
        version = "restored-version";
        return json(response, 200, { ok: true, donorLogoVersion: version });
      }
      response.writeHead(404).end();
    });

    try {
      await expect(
        migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), {
          fetchImpl: fetch
        })
      ).resolves.toEqual({ changed: true });
      expect(remoteBytes).toEqual(localRasterBytes);
      expect(requests).toEqual([
        "GET /api/health",
        "GET /api/branding",
        "POST /api/auth/login",
        "PUT /api/settings/branding/donor-logo",
        "GET /api/health",
        "GET /api/branding",
        "GET /api/branding/donor-logo?v=restored-version"
      ]);
    } finally {
      await server.close();
    }
  });

  it("fails when authentication, upload, or mandatory postflight fails", async () => {
    for (const failure of ["auth", "upload", "postflight"] as const) {
      let uploaded = false;
      const server = await localServer(async (request, response) => {
        if (respondToHealth(request, response)) return;
        if (request.url === "/api/branding") {
          if (failure === "postflight" && uploaded) {
            return response.writeHead(503).end();
          }
          return json(response, 200, { donorLogoVersion: uploaded ? "new" : "old" });
        }
        if (request.url?.startsWith("/api/branding/donor-logo")) {
          response.writeHead(200, { "Content-Type": "image/png" });
          return response.end(Buffer.concat([localRasterBytes, Buffer.from([0x01])]));
        }
        if (request.url === "/api/auth/login") {
          return failure === "auth"
            ? response.writeHead(401).end()
            : json(response, 200, { token: "fixture-token" });
        }
        if (request.url === "/api/settings/branding/donor-logo") {
          uploaded = true;
          return failure === "upload"
            ? response.writeHead(500).end()
            : json(response, 200, { ok: true, donorLogoVersion: "new" });
        }
        response.writeHead(404).end();
      });

      try {
        await expect(
          migrateRuntimeBrandingLogo(runtimeConfig(server.origin), credentials(), {
            fetchImpl: fetch
          })
        ).rejects.toThrow();
      } finally {
        await server.close();
      }
    }
  });
});

describe("runtime logo command-line guards", () => {
  it("validates locally without --apply and sends no request", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(500).end();
    });
    const fixture = cliFixture(server.origin);

    try {
      const result = await runCli("scripts/migrate-runtime-branding-logo.mjs", ["--env", "staging"], fixture);
      expect(result).toMatchObject({ code: 0 });
      expect(requests).toEqual([]);
      expectSanitizedOutput(result, fixture);
    } finally {
      await server.close();
    }
  });

  it("rejects a corrupt local raster without --apply and sends no request", async () => {
    const requests: string[] = [];
    const server = await localServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(500).end();
    });
    const fixture = cliFixture(server.origin, {
      logoName: "private-logo-fixture.jpeg",
      logoBytes: Buffer.from(corruptJpegBytes())
    });

    try {
      const result = await runCli(
        "scripts/migrate-runtime-branding-logo.mjs",
        ["--env", "staging"],
        fixture
      );
      expect(result.code).toBe(1);
      expect(requests).toEqual([]);
      expectSanitizedOutput(result, fixture);
    } finally {
      await server.close();
    }
  });

  it("runs read-only assertion and explicit migration with sanitized output", async () => {
    let remoteBytes: Buffer<ArrayBufferLike> = Buffer.from(localRasterBytes);
    let version = "fixture-version";
    const server = await localServer(async (request, response) => {
      if (respondToHealth(request, response)) return;
      if (request.url === "/api/branding") {
        return json(response, 200, { donorLogoVersion: version });
      }
      if (request.url?.startsWith("/api/branding/donor-logo")) {
        response.writeHead(200, { "Content-Type": "image/png" });
        return response.end(remoteBytes);
      }
      if (request.url === "/api/auth/login") {
        return json(response, 200, { token: "fixture-token" });
      }
      if (request.url === "/api/settings/branding/donor-logo") {
        remoteBytes = await requestBody(request);
        version = "new-version";
        return json(response, 200, { ok: true, donorLogoVersion: version });
      }
      response.writeHead(404).end();
    });
    const fixture = cliFixture(server.origin);

    try {
      const assertion = await runCli(
        "scripts/assert-runtime-branding-logo.mjs",
        ["--env", "staging"],
        fixture
      );
      expect(assertion.code).toBe(0);
      expectSanitizedOutput(assertion, fixture);

      remoteBytes = Buffer.concat([localRasterBytes, Buffer.from([0x01])]);
      const migration = await runCli(
        "scripts/migrate-runtime-branding-logo.mjs",
        ["--env", "staging", "--apply"],
        fixture
      );
      expect(migration.code).toBe(0);
      expectSanitizedOutput(migration, fixture);
    } finally {
      await server.close();
    }
  });

  it("sanitizes command failures", async () => {
    const server = await localServer(async (_request, response) => {
      if (respondToHealth(_request, response)) return;
      response.writeHead(503).end();
    });
    const fixture = cliFixture(server.origin);

    try {
      const result = await runCli(
        "scripts/assert-runtime-branding-logo.mjs",
        ["--env", "staging"],
        fixture
      );
      expect(result.code).toBe(1);
      expectSanitizedOutput(result, fixture);
    } finally {
      await server.close();
    }
  });
});

function runtimeConfig(origin: string, options: {
  bytes?: Buffer<ArrayBufferLike>;
  contentType?: "image/png" | "image/jpeg";
} = {}) {
  const bytes = options.bytes ?? localRasterBytes;
  return {
    target: "staging" as const,
    campaign: "campaign-fixture",
    origin,
    donorLogo: {
      path: "/private-fixture/logo.png",
      bytes,
      contentType: options.contentType ?? "image/png" as const,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}

function credentials() {
  return { email: "operator@example.invalid", password: "password-fixture" };
}

function cliFixture(origin: string, options: {
  logoName?: string;
  logoBytes?: Buffer<ArrayBufferLike>;
} = {}) {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const privateRoot = temporaryRoot("diezmos-runtime-private-");
  const logoPath = join(privateRoot, options.logoName ?? "private-logo-fixture.png");
  const configPath = join(privateRoot, "staging.env");
  const operatorPath = join(privateRoot, "operator.env");
  const logoBytes = options.logoBytes ?? localRasterBytes;
  writeFileSync(logoPath, logoBytes, { mode: 0o600 });
  writeFileSync(configPath, [
    "DIEZMOSSV_DEPLOY_TARGET=staging",
    "VITE_GIVEBUTTER_CAMPAIGN=campaign-fixture",
    `DIEZMOSSV_APP_ORIGIN=${origin}`,
    `DIEZMOSSV_DONOR_LOGO_FILE=${logoPath}`,
    ""
  ].join("\n"), { mode: 0o600 });
  writeFileSync(operatorPath, [
    "STAGING_EMAIL=operator@example.invalid",
    "STAGING_PASSWORD=password-fixture",
    ""
  ].join("\n"), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  chmodSync(operatorPath, 0o600);
  return { repositoryRoot, privateRoot, logoPath, logoBytes, configPath, operatorPath, origin };
}

async function runCli(
  script: string,
  args: string[],
  fixture: ReturnType<typeof cliFixture>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [resolve(fixture.repositoryRoot, script), ...args], {
    cwd: fixture.repositoryRoot,
    env: {
      ...process.env,
      DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath,
      DIEZMOSSV_OPERATOR_ENV_FILE: fixture.operatorPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  return { code, stdout, stderr };
}

function expectSanitizedOutput(
  result: { stdout: string; stderr: string },
  fixture: ReturnType<typeof cliFixture>
): void {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const privateValue of [
    "operator@example.invalid",
    "password-fixture",
    fixture.logoPath,
    fixture.configPath,
    fixture.operatorPath,
    fixture.origin,
    createHash("sha256").update(fixture.logoBytes).digest("hex"),
    fixture.logoBytes.toString("hex")
  ]) {
    expect(output).not.toContain(privateValue);
  }
}

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown> | unknown
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    })
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function respondToHealth(
  request: IncomingMessage,
  response: ServerResponse,
  appEnv = "staging"
): boolean {
  if (request.url !== "/api/health") return false;
  json(response, 200, { appEnv });
  return true;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
