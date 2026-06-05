/**
 * OAuth 2.1 + magic-link router for the Askine MCP server.
 *
 * Routes (all per-tenant, scoped under /t/:slug/):
 *   GET  /t/:slug/.well-known/oauth-authorization-server  — RFC 8414
 *   GET  /t/:slug/.well-known/oauth-protected-resource    — RFC 9728
 *   POST /t/:slug/oauth/register                          — RFC 7591 DCR
 *   GET  /t/:slug/oauth/authorize                         — HTML form
 *   POST /t/:slug/oauth/authorize                         — send magic link
 *   GET  /t/:slug/auth/verify?token=xxx                   — magic link callback
 *   POST /t/:slug/oauth/token                             — code/refresh exchange
 *   POST /t/:slug/oauth/revoke                            — RFC 7009
 *
 * The MCP server URL itself is /t/:slug/mcp (resource), and the AS metadata
 * points back at /t/:slug/oauth/* as the authorization server.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import type { Tenant } from "./lib/tenant.ts";
import {
  registerClient,
  findClientByClientId,
  issueAuthorizationCode,
  consumeAuthorizationCode,
  issueTokens,
  rotateRefreshToken,
  revokeAccessToken,
  revokeRefreshToken,
  verifyPkceS256,
} from "./lib/oauth.ts";
import { issueMagicLink, consumeMagicLink, sendMagicLinkEmail } from "./lib/magic-links.ts";
import { upsertStudent, listAccessibleCourseIds } from "./lib/students.ts";

// Read PUBLIC_URL lazily — ESM hoisting would lock in the value before
// server-http.ts's dotenv.config() runs.
function publicUrl(): string {
  return process.env.PUBLIC_URL ?? "http://localhost:3333";
}

type OAuthState = {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

function tenantBase(tenant: Tenant): string {
  return `${publicUrl()}/t/${tenant.slug}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const text = await readBody(req);
  return JSON.parse(text) as T;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const text = await readBody(req);
  return new URLSearchParams(text);
}

function getQuery(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://x");
  return url.searchParams;
}

// ---------- Route handlers ----------

async function discoveryAS(tenant: Tenant, res: ServerResponse): Promise<void> {
  const base = tenantBase(tenant);
  json(res, 200, {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
  });
}

async function discoveryPRM(tenant: Tenant, res: ServerResponse): Promise<void> {
  const base = tenantBase(tenant);
  json(res, 200, {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  });
}

async function register(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson<{
      client_name?: string;
      redirect_uris?: string[];
      scope?: string;
      grant_types?: string[];
      response_types?: string[];
      token_endpoint_auth_method?: string;
      application_type?: string;
    }>(req);
    const redirectUris = body.redirect_uris ?? [];
    if (!redirectUris.length) {
      return json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris required" });
    }

    // Public clients (MCP browsers / PKCE) ask for `none`; confidential
    // clients omit it and we default to client_secret_basic. We persist
    // a secret either way (it's a hash, harmless) but only return it
    // when the client is confidential — public clients ignore it and
    // some validators reject responses that include it.
    const authMethod = body.token_endpoint_auth_method ?? "none";
    const isPublic = authMethod === "none";

    const { client, clientSecret } = await registerClient({
      tenantId: tenant.id,
      clientName: body.client_name,
      redirectUris,
      scopes: body.scope ? body.scope.split(/\s+/) : ["mcp"],
    });

    const issuedAt = Math.floor(Date.now() / 1000);
    const response: Record<string, unknown> = {
      client_id: client.clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: client.redirectUris,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: body.response_types ?? ["code"],
      token_endpoint_auth_method: authMethod,
      scope: client.scopes.join(" "),
    };
    if (body.client_name) response.client_name = body.client_name;
    if (body.application_type) response.application_type = body.application_type;
    if (!isPublic) {
      response.client_secret = clientSecret;
      response.client_secret_expires_at = 0;  // never expires
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    json(res, 201, response);
  } catch (err) {
    console.error("DCR error:", err);
    json(res, 400, { error: "invalid_request", error_description: String(err) });
  }
}

async function authorizeGet(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const scope = q.get("scope") ?? "mcp";
  const state = q.get("state") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";
  const codeChallengeMethod = q.get("code_challenge_method") ?? "";
  const responseType = q.get("response_type") ?? "";

  if (responseType !== "code") {
    return json(res, 400, { error: "unsupported_response_type" });
  }
  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    return json(res, 400, { error: "invalid_request", error_description: "PKCE S256 required" });
  }
  const client = await findClientByClientId(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    return json(res, 400, { error: "invalid_client", error_description: "Unknown client or redirect_uri" });
  }

  const oauthState: OAuthState = {
    clientId,
    redirectUri,
    scopes: scope.split(/\s+/),
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
  const encoded = Buffer.from(JSON.stringify(oauthState)).toString("base64url");

  html(res, 200, loginPageHtml({
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    clientName: (client.metadata.clientName as string | null) ?? clientId,
    oauthState: encoded,
  }));
}

async function authorizePost(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const email = (form.get("email") ?? "").trim().toLowerCase();
  const oauthState = form.get("oauth_state") ?? "";

  if (!email || !email.includes("@")) {
    return html(res, 400, loginPageHtml({
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      clientName: "",
      oauthState,
      error: "Email inválido.",
    }));
  }

  const token = await issueMagicLink({
    tenantId: tenant.id,
    email,
    intent: "oauth_login",
    oauthState,
  });
  const url = `${tenantBase(tenant)}/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendMagicLinkEmail({ to: email, url, tenantName: tenant.name });
  } catch (err) {
    console.error("Magic link send failed:", err);
    return html(res, 500, `<p>Não foi possível enviar o email agora. Tente de novo.</p>`);
  }
  html(res, 200, magicLinkSentHtml({ email, tenantName: tenant.name }));
}

async function verify(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const q = getQuery(req);
  const token = q.get("token") ?? "";
  const claims = await consumeMagicLink(token);
  if (!claims) {
    return html(res, 400, `<p>Esse link expirou ou já foi usado. <a href="/t/${tenant.slug}/oauth/authorize">Tentar novamente</a>.</p>`);
  }
  if (claims.tenantId !== tenant.id) {
    return html(res, 400, `<p>Esse link não pertence a este tenant.</p>`);
  }
  if (!claims.oauthState) {
    return html(res, 200, `<p>Login confirmado, ${claims.email}. Você pode fechar esta janela.</p>`);
  }

  const oauthState: OAuthState = JSON.parse(Buffer.from(claims.oauthState, "base64url").toString("utf8"));
  const student = await upsertStudent({ tenantId: tenant.id, email: claims.email });

  const code = await issueAuthorizationCode({
    clientId: oauthState.clientId,
    studentId: student.id,
    redirectUri: oauthState.redirectUri,
    scopes: oauthState.scopes,
    codeChallenge: oauthState.codeChallenge,
    codeChallengeMethod: "S256",
  });

  const target = new URL(oauthState.redirectUri);
  target.searchParams.set("code", code);
  if (oauthState.state) target.searchParams.set("state", oauthState.state);
  res.writeHead(302, { Location: target.toString() }).end();
}

async function token(tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const grantType = form.get("grant_type") ?? "";

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    if (!code || !codeVerifier) {
      return json(res, 400, { error: "invalid_request" });
    }
    const claims = await consumeAuthorizationCode(code);
    if (!claims) return json(res, 400, { error: "invalid_grant" });
    if (claims.clientId !== clientId) return json(res, 400, { error: "invalid_client" });
    if (claims.redirectUri !== redirectUri) return json(res, 400, { error: "invalid_grant" });
    if (!claims.codeChallenge || !verifyPkceS256(codeVerifier, claims.codeChallenge)) {
      return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }
    const tokens = await issueTokens({
      clientId: claims.clientId,
      studentId: claims.studentId,
      scopes: claims.scopes,
    });
    return json(res, 200, {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
      scope: claims.scopes.join(" "),
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken) return json(res, 400, { error: "invalid_request" });
    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) return json(res, 400, { error: "invalid_grant" });
    return json(res, 200, {
      access_token: rotated.accessToken,
      refresh_token: rotated.refreshToken,
      token_type: "Bearer",
      expires_in: rotated.expiresIn,
    });
  }

  // Suppress unused-warning for tenant in this branch — kept for symmetry with
  // tenant-scoped logging once we wire metrics in Phase 4.
  void tenant;
  json(res, 400, { error: "unsupported_grant_type" });
}

async function revoke(_tenant: Tenant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readForm(req);
  const token = form.get("token") ?? "";
  const hint = form.get("token_type_hint") ?? "";
  if (!token) return json(res, 200, {}); // RFC 7009: always 200
  if (hint === "refresh_token") {
    await revokeRefreshToken(token);
  } else {
    await revokeAccessToken(token);
    await revokeRefreshToken(token);
  }
  json(res, 200, {});
}

// ---------- HTML templates ----------

function loginPageHtml(args: {
  tenantName: string;
  tenantSlug: string;
  clientName: string;
  oauthState: string;
  error?: string;
}): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Entrar — ${esc(args.tenantName)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#fafafa; color:#111; max-width:480px; margin:60px auto; padding:0 16px }
  h1 { font-size: 22px; margin: 0 0 8px }
  p { color:#444; line-height:1.5 }
  form { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:24px; margin-top:24px }
  label { display:block; font-size:13px; color:#666; margin-bottom:6px }
  input[type=email] { width:100%; box-sizing:border-box; padding:12px; border:1px solid #ddd; border-radius:8px; font-size:15px }
  button { width:100%; margin-top:16px; padding:12px; background:#111; color:#fff; border:0; border-radius:8px; font-size:15px; cursor:pointer }
  button:hover { background:#000 }
  .err { background:#fee; color:#900; padding:10px; border-radius:8px; margin-bottom:12px; font-size:14px }
  footer { margin-top:24px; color:#999; font-size:12px; text-align:center }
</style>
<h1>${esc(args.tenantName)}</h1>
<p>${args.clientName ? `<strong>${esc(args.clientName)}</strong> quer acessar seu curso. ` : ""}Entre com seu email para receber um link de acesso.</p>
<form method="POST" action="/t/${esc(args.tenantSlug)}/oauth/authorize">
  ${args.error ? `<div class="err">${esc(args.error)}</div>` : ""}
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autofocus placeholder="voce@exemplo.com">
  <input type="hidden" name="oauth_state" value="${esc(args.oauthState)}">
  <button type="submit">Receber link de acesso</button>
</form>
<footer>Powered by Askine</footer>`;
}

function magicLinkSentHtml(args: { email: string; tenantName: string }): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Verifique seu email</title>
<style>
  body { font-family: system-ui, sans-serif; background:#fafafa; color:#111; max-width:480px; margin:80px auto; padding:0 16px; text-align:center }
  .card { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:32px }
  h1 { font-size: 22px }
  code { background:#f3f3f3; padding:2px 6px; border-radius:4px; font-size:13px }
</style>
<div class="card">
  <h1>📬 Confira seu email</h1>
  <p>Mandamos um link de acesso pra <code>${esc(args.email)}</code>.</p>
  <p>O link é válido por 15 minutos e só pode ser usado uma vez.</p>
</div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]!);
}

// ---------- Public: match + dispatch ----------

export interface OAuthRouteMatch {
  type:
    | "discovery-as"
    | "discovery-prm"
    | "register"
    | "authorize-get"
    | "authorize-post"
    | "verify"
    | "token"
    | "revoke";
}

/** Match the URL+method against an OAuth route. Returns null if the URL isn't
 *  an OAuth route. Routes are already scoped under /t/:slug/. */
export function matchOAuthRoute(suffix: string, method: string): OAuthRouteMatch | null {
  const path = suffix.split("?")[0];
  if (method === "GET" && path === "/.well-known/oauth-authorization-server") return { type: "discovery-as" };
  if (method === "GET" && path === "/.well-known/oauth-protected-resource")    return { type: "discovery-prm" };
  if (method === "POST" && path === "/oauth/register")  return { type: "register" };
  if (method === "GET"  && path === "/oauth/authorize") return { type: "authorize-get" };
  if (method === "POST" && path === "/oauth/authorize") return { type: "authorize-post" };
  if (method === "GET"  && path === "/auth/verify")     return { type: "verify" };
  if (method === "POST" && path === "/oauth/token")     return { type: "token" };
  if (method === "POST" && path === "/oauth/revoke")    return { type: "revoke" };
  return null;
}

export async function handleOAuthRoute(
  match: OAuthRouteMatch,
  tenant: Tenant,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (match.type) {
    case "discovery-as":   return discoveryAS(tenant, res);
    case "discovery-prm":  return discoveryPRM(tenant, res);
    case "register":       return register(tenant, req, res);
    case "authorize-get":  return authorizeGet(tenant, req, res);
    case "authorize-post": return authorizePost(tenant, req, res);
    case "verify":         return verify(tenant, req, res);
    case "token":          return token(tenant, req, res);
    case "revoke":         return revoke(tenant, req, res);
  }
}

// Suppress unused — listAccessibleCourseIds is used by access enforcement
// (1.4), exporting via re-export here keeps the import graph tidy.
export { listAccessibleCourseIds };
