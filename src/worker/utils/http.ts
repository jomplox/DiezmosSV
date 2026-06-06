export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  const body = await request.text();
  return JSON.parse(body) as T;
}

export function notFound(): Response {
  return jsonResponse({ error: "not_found" }, { status: 404 });
}

export function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, { status: 405 });
}
