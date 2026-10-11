import { isMockMode, requireSecret } from "../config";
import type { DonationIntentRecord, Env } from "../types";
import { assertFiscalCollectionReady, deploymentEnvironmentPolicy } from "./environmentPolicy";

// CheckoutLink API. The deployment, not a separate setting, selects the n1co
// environment: production talks to n1co production and every other deployment to
// the sandbox, so a staging Worker can never mint a link that takes real money.
const API_BASE = {
  production: "https://api-pay.n1co.shop/api",
  sandbox: "https://api-pay-sandbox.n1co.shop/api"
} as const;
const PAY_HOST = {
  production: "pay.n1co.shop",
  sandbox: "pay-sandbox.n1co.shop"
} as const;
// Shown to the donor on n1co's hosted page; mirrors the Wompi sheet and the /donar
// brand title rather than naming a product.
const ORDER_NAME = "Diezmos y Ofrendas";
const ORDER_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_LINK_MINUTES = 5;
const MAX_LINK_MINUTES = 60;

export class N1coApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "N1coApiError";
  }
}

export interface N1coCheckoutLink {
  orderId: number;
  orderCode: string;
  paymentLinkUrl: string;
}

type N1coEnvironment = keyof typeof API_BASE;

export function n1coEnvironment(env: Pick<Env, "APP_ENV">): N1coEnvironment {
  return deploymentEnvironmentPolicy(env).appEnv === "production" ? "production" : "sandbox";
}

// The alternative is offered only when the Worker can both mint links and
// authenticate n1co's webhook. Mock mode stands in for both in local dev and CI.
export function isN1coAvailable(env: Env): boolean {
  if (isMockMode(env)) {
    return true;
  }
  return Boolean(env.N1CO_CHECKOUT_SECRET_KEY?.trim() && env.N1CO_WEBHOOK_SECRET?.trim());
}

export class N1coApiService {
  constructor(private readonly env: Env) {}

  get production(): boolean {
    return n1coEnvironment(this.env) === "production";
  }

  async createCheckoutLink(
    intent: Pick<DonationIntentRecord, "id" | "amount_cents" | "expires_at">,
    origin: string
  ): Promise<N1coCheckoutLink> {
    if (isMockMode(this.env)) {
      const orderCode = `mock-${intent.id.replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
      return {
        orderId: mockOrderId(intent.id),
        orderCode,
        paymentLinkUrl: `https://${PAY_HOST.sandbox}/${orderCode}`
      };
    }
    // Same preflight as Wompi: a misconfigured issuer must fail before a donor can
    // complete an entrega that would then have no CDE.
    await assertFiscalCollectionReady(this.env);

    const amount = (intent.amount_cents / 100).toFixed(2);
    const successUrl = new URL("/donar/gracias", origin);
    successUrl.searchParams.set("identificadorEnlaceComercio", intent.id);
    successUrl.searchParams.set("monto", amount);
    const cancelUrl = new URL("/donar", origin);
    cancelUrl.searchParams.set("ruta", "sv");

    const response = await this.request("/paymentlink/checkout", "POST", {
      orderReference: intent.id,
      orderName: ORDER_NAME,
      amount: Number(amount),
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      metadata: [{ name: "intentId", value: intent.id }],
      expirationMinutes: linkMinutes(intent.expires_at)
    });
    if (!response.ok) {
      throw new N1coApiError(`n1co rechazó la creación del enlace: ${response.status}`);
    }
    return this.parseCheckoutLink(await response.json());
  }

  // Authenticated order lookup by code: the only source of truth for payment.
  async getOrder(orderCode: string): Promise<unknown> {
    if (!ORDER_CODE_PATTERN.test(orderCode)) {
      throw new N1coApiError("Código de orden n1co inválido");
    }
    if (isMockMode(this.env)) {
      return { orderCode, orderStatus: "PENDING" };
    }
    const response = await this.request(`/paymentlink/order/${encodeURIComponent(orderCode)}`, "GET");
    if (!response.ok) {
      throw new N1coApiError(`n1co rechazó la consulta de la orden: ${response.status}`);
    }
    return response.json();
  }

  private request(path: string, method: "GET" | "POST", body?: unknown): Promise<Response> {
    return fetch(`${API_BASE[n1coEnvironment(this.env)]}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${requireSecret(this.env, "N1CO_CHECKOUT_SECRET_KEY")}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  private parseCheckoutLink(value: unknown): N1coCheckoutLink {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new N1coApiError("n1co devolvió un enlace inválido");
    }
    const { orderId, orderCode, paymentLinkUrl } = value as Record<string, unknown>;
    if (
      typeof orderId !== "number"
      || !Number.isSafeInteger(orderId)
      || orderId <= 0
      || typeof orderCode !== "string"
      || !ORDER_CODE_PATTERN.test(orderCode)
      || typeof paymentLinkUrl !== "string"
      || !isN1coPayLink(paymentLinkUrl, PAY_HOST[n1coEnvironment(this.env)], orderCode)
    ) {
      throw new N1coApiError("n1co devolvió un enlace inválido");
    }
    return { orderId, orderCode, paymentLinkUrl };
  }
}

function isN1coPayLink(value: string, host: string, orderCode: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === host
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.pathname === `/${orderCode}`;
  } catch {
    return false;
  }
}

// The n1co link never outlives the intent, so a payment always lands while the
// intent can still bind it.
function linkMinutes(expiresAt: string): number {
  const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 60_000);
  return Math.min(MAX_LINK_MINUTES, Math.max(MIN_LINK_MINUTES, Number.isFinite(remaining) ? remaining : MIN_LINK_MINUTES));
}

function mockOrderId(intentId: string): number {
  let hash = 0;
  for (let i = 0; i < intentId.length; i += 1) {
    hash = (hash * 31 + intentId.charCodeAt(i)) % 1_000_000_007;
  }
  return hash + 1;
}
