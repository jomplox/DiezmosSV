import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../../src/worker/services/auth";
import { dispatchRoutes, type RoutableContext } from "../../src/worker/routes/router";

const user: AuthUser = {
  id: "user-1",
  email: "user@example.org",
  name: "User",
  role: "OWNER"
};

function context(input: { method?: string; pathname?: string } = {}): RoutableContext {
  return {
    request: new Request(`https://example.org${input.pathname ?? "/api/example"}`, {
      method: input.method ?? "GET"
    }),
    pathname: input.pathname ?? "/api/example",
    user,
    actor: null,
    params: []
  };
}

describe("dispatchRoutes", () => {
  it("dispatches an exact string pathname", async () => {
    const response = await dispatchRoutes(
      [{ pattern: "/api/example", handler: async () => new Response("matched") }],
      context(),
      vi.fn()
    );

    await expect(response?.text()).resolves.toBe("matched");
  });

  it("exposes regular expression capture groups as params", async () => {
    const response = await dispatchRoutes(
      [{
        pattern: /^\/api\/documents\/([^/]+)\/(\d+)$/,
        handler: async (ctx) => new Response(ctx.params.join(":"))
      }],
      context({ pathname: "/api/documents/invoice/42" }),
      vi.fn()
    );

    await expect(response?.text()).resolves.toBe("invoice:42");
  });

  it("uses the first matching route in declaration order", async () => {
    const response = await dispatchRoutes(
      [
        { pattern: "/api/example", handler: async () => new Response("first") },
        { pattern: "/api/example", handler: async () => new Response("second") }
      ],
      context(),
      vi.fn()
    );

    await expect(response?.text()).resolves.toBe("first");
  });

  it("continues after a method mismatch instead of manufacturing 405", async () => {
    const response = await dispatchRoutes(
      [{
        method: "POST",
        pattern: "/api/example",
        handler: async () => new Response("unexpected")
      }],
      context({ method: "GET", pathname: "/api/example" }),
      vi.fn()
    );
    expect(response).toBeNull();
  });

  it("dispatches a method-agnostic route after a path match", async () => {
    const response = await dispatchRoutes(
      [
        { method: "POST", pattern: "/api/example", handler: async () => new Response("post") },
        { pattern: "/api/example", handler: async () => new Response("any-method") }
      ],
      context({ method: "GET" }),
      vi.fn()
    );

    await expect(response?.text()).resolves.toBe("any-method");
  });

  it("authorizes fixed, callback, and null roles before handlers and exposes the actor", async () => {
    const actor = { ...user, id: "actor-1" };
    const authorize = vi.fn(() => actor);
    const fixedContext = context();
    const callbackContext = context();
    const nullRoleContext = context();
    const fixedHandler = vi.fn(async (ctx: RoutableContext) => new Response(ctx.actor?.id));
    const callbackHandler = vi.fn(async (ctx: RoutableContext) => new Response(ctx.actor?.id));
    const nullRoleHandler = vi.fn(async (ctx: RoutableContext) => new Response(String(ctx.actor)));

    await expect(dispatchRoutes(
      [{ pattern: "/api/example", role: "ADMIN", handler: fixedHandler }],
      fixedContext,
      authorize
    ).then((response) => response?.text())).resolves.toBe("actor-1");
    await expect(dispatchRoutes(
      [{ pattern: "/api/example", role: () => "OPERATOR", handler: callbackHandler }],
      callbackContext,
      authorize
    ).then((response) => response?.text())).resolves.toBe("actor-1");
    await expect(dispatchRoutes(
      [{ pattern: "/api/example", role: () => null, handler: nullRoleHandler }],
      nullRoleContext,
      authorize
    ).then((response) => response?.text())).resolves.toBe("null");

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenNthCalledWith(1, user, "ADMIN");
    expect(authorize).toHaveBeenNthCalledWith(2, user, "OPERATOR");
    expect(fixedHandler).toHaveBeenCalledAfter(authorize);
    expect(callbackHandler).toHaveBeenCalledAfter(authorize);
    expect(nullRoleHandler).toHaveBeenCalledWith(expect.objectContaining({ actor: null }));
  });
});
