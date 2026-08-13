import type { Server } from "node:http";

export function createStripeApiProxy(upstreamFetch?: typeof fetch): Server;
