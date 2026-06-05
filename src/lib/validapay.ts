/**
 * ValidaPay API client. OAuth2 client_credentials → cached Bearer token →
 * subscription product/price/checkout endpoints.
 *
 * Docs (sometimes incomplete): https://docs.validapay.com.br/documentacao-validapay2
 *
 * Env vars (per user convention — Portuguese):
 *   VALIDA_CLIENTE_ID
 *   VALIDA_CLIENTE_SECRET
 *   VALIDA_ENV         = sandbox | prod    (default: sandbox)
 *   VALIDA_WEBHOOK_SECRET = path-segment auth for /webhooks/validapay/:secret
 */

const SANDBOX = {
  oauth: "https://oauth2-sandbox.validapay.com.br/auth/token",
  api: "https://sandbox.validapay.com.br",
};
const PROD = {
  oauth: "https://oauth2.validapay.com.br/auth/token",
  api: "https://api.validapay.com.br",
};

function endpoints() {
  return (process.env.VALIDA_ENV ?? "sandbox") === "prod" ? PROD : SANDBOX;
}

function clientCreds(): { id: string; secret: string } {
  const id = process.env.VALIDA_CLIENTE_ID;
  const secret = process.env.VALIDA_CLIENTE_SECRET;
  if (!id || !secret) throw new Error("VALIDA_CLIENTE_ID / VALIDA_CLIENTE_SECRET not set");
  return { id, secret };
}

// ----- Token cache ---------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // ms epoch, with 30s safety margin already applied
}
let cache: TokenCache | null = null;

async function fetchToken(scope: string): Promise<TokenCache> {
  const { id, secret } = clientCreds();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
    scope,
  });
  const res = await fetch(endpoints().oauth, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ValidaPay /auth/token ${res.status}: ${text}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number; token_type: string };
  return {
    token: data.access_token,
    expiresAt: Date.now() + (Math.max(60, data.expires_in - 30) * 1000),
  };
}

/** Returns a valid Bearer token, fetching/refreshing as needed. We request a
 *  broad scope once since the docs aren't crystal clear which sub-scopes are
 *  needed at each endpoint. */
async function getToken(): Promise<string> {
  if (cache && cache.expiresAt > Date.now()) return cache.token;
  cache = await fetchToken("products/write checkouts/write subscriptions/write subscriptions/read");
  return cache.token;
}

// ----- API wrapper ---------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${endpoints().api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    cache = null; // force re-auth on next call
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ValidaPay ${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ----- Product + price -----------------------------------------------------

export interface CreatedProduct {
  productId: string;
  prices: Array<{
    priceId: string;
    recurrenceType: string;
    amount: number;
    trialDays?: number;
    isActive: boolean;
  }>;
}

export async function createProductWithMonthlyPrice(args: {
  name: string;
  description: string;
  statementDescriptor: string;
  amountBrl: number;
  trialDays?: number;
  externalId?: string;
}): Promise<CreatedProduct> {
  return api<CreatedProduct>("POST", "/v1/products", {
    name: args.name,
    description: args.description,
    statementDescriptor: args.statementDescriptor,
    metadata: args.externalId ? { externalId: args.externalId } : undefined,
    prices: [{
      title: `${args.name} mensal`,
      description: args.name,
      recurrenceType: "MONTHLY",
      amount: args.amountBrl,
      ...(args.trialDays ? { trialDays: args.trialDays } : {}),
    }],
  });
}

// ----- Checkout ------------------------------------------------------------

export interface CheckoutSession {
  id: string;
  url: string;
  priceId: string;
}

/** Creates a hosted checkout URL for the given price + customer. */
export async function createCheckoutSession(args: {
  priceId: string;
  customer: { email: string; documentNumber: string };
  allowedPaymentMethods?: Array<"pix" | "creditcard" | "boleto">;
}): Promise<CheckoutSession> {
  return api<CheckoutSession>("POST", "/v1/checkouts/session", {
    priceId: args.priceId,
    allowedPaymentMethods: args.allowedPaymentMethods ?? ["pix", "creditcard"],
    customer: args.customer,
  });
}
