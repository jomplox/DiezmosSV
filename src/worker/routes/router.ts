import type { AuthUser, Role } from "../services/auth";

export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RoutableContext {
  request: Request;
  pathname: string;
  user: AuthUser | null;
  actor: AuthUser | null;
  params: readonly string[];
}

export interface Route<TContext extends RoutableContext> {
  method?: RouteMethod;
  pattern: RegExp | string;
  role?: Role | ((ctx: TContext) => Role | null);
  handler: (ctx: TContext) => Promise<Response>;
}

export type AuthorizeRoute = (user: AuthUser | null, role: Role) => AuthUser;

function matchParams(pattern: RegExp | string, pathname: string): readonly string[] | null {
  if (typeof pattern === "string") return pathname === pattern ? [] : null;
  const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(pathname);
  return match ? match.slice(1) : null;
}

export async function dispatchRoutes<TContext extends RoutableContext>(
  routes: readonly Route<TContext>[],
  context: TContext,
  authorize: AuthorizeRoute
): Promise<Response | null> {
  for (const route of routes) {
    const params = matchParams(route.pattern, context.pathname);
    if (!params || (route.method && route.method !== context.request.method)) continue;

    context.params = params;
    const role = typeof route.role === "function" ? route.role(context) : route.role;
    context.actor = role ? authorize(context.user, role) : null;
    return route.handler(context);
  }

  return null;
}
