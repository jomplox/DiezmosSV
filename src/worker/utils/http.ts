export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

export async function readBodyBytes(request: Request, limitBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > limitBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBodyText(request: Request, limitBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(request, limitBytes));
}

export async function readJsonObject(
  request: Request,
  options: { limitBytes: number; malformed: "throw" | "empty-object" }
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readBodyText(request, options.limitBytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (options.malformed === "empty-object") return {};
    throw new InvalidJsonBodyError();
  }
}

export function notFound(): Response {
  return jsonResponse({ error: "not_found" }, { status: 404 });
}

export function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
}
