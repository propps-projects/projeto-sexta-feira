// Anchor cwd + .env to the project root.
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import dotenv from "dotenv";
const __projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(__projectRoot);
dotenv.config({ path: resolvePath(__projectRoot, ".env") });

import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./build-server.ts";
import { resolveTenantBySlug, isMcpAccessible, type Tenant } from "./lib/tenant.ts";
import { findStudentById, listAccessibleCourseIds } from "./lib/students.ts";
import { validateAccessToken } from "./lib/oauth.ts";
import { matchOAuthRoute, handleOAuthRoute } from "./oauth-router.ts";
import { matchGlobalOAuthRoute, handleGlobalOAuthRoute } from "./global-oauth-router.ts";
import { findMcpUserById, listAccessibleCoursesGlobal } from "./lib/mcp-users.ts";
import { matchAdminRoute, handleAdminRoute } from "./admin-router.ts";
import { matchSuperAdminRoute, handleSuperAdminRoute } from "./super-admin-router.ts";
import { matchPublicRoute, handlePublicRoute } from "./public-router.ts";
import { isBrandRoute, handleBrandRoute } from "./brand-router.ts";
import { tryServeLanding } from "./landing-router.ts";
import { matchEntrarRoute, handleEntrarRoute } from "./entrar-router.ts";
import { matchContatoRoute, handleContatoRoute } from "./contato-router.ts";
import { initObservability, captureError } from "./lib/observability.ts";

// Init Sentry before the server starts handling requests so that
// boot-time errors are also captured.
initObservability();
import { processHotmartEvent, verifyHottok, getHotmartHottok } from "./lib/hotmart.ts";
import { processValidapayEvent } from "./lib/billing.ts";
import { verifyWebhookSignature } from "./lib/validapay.ts";
import type { AdapterMode } from "./ui/player.ts";

const PORT = Number(process.env.PORT || 3333);

// Path → adapter mode map. Each session lives at one of these paths; the
// adapter determines MCP-UI MIME type emitted by play_lesson.
//
//   /mcp           → mcpApps  (Claude)         — legacy single-tenant
//   /mcp-gpt       → appsSdk  (ChatGPT)        — legacy single-tenant
//   /t/:slug/mcp     → mcpApps + resolved tenant
//   /t/:slug/mcp-gpt → appsSdk + resolved tenant
const ENDPOINT_SUFFIXES = {
  "/mcp": "mcpApps" as AdapterMode,
  "/mcp-gpt": "appsSdk" as AdapterMode,
};

const transports = new Map<string, StreamableHTTPServerTransport>();

// CORS strategy (Phase 9.1 hardening):
//   - /mcp + /mcp-gpt + /.well-known/* + /oauth/* + /auth/verify: open to
//     known MCP clients (Claude.ai, ChatGPT). These endpoints don't use
//     cookies — they auth via Authorization: Bearer, so opening Origin
//     doesn't expose anything that wasn't already public via the token.
//   - everything else (admin, super-admin, webhooks, public site): no
//     CORS headers. Browser cross-origin reads blocked by SOP; form
//     POSTs still go through but CSRF is mitigated by HttpOnly cookies
//     + SameSite=Lax and require valid sessions.
const MCP_CLIENT_ORIGINS = new Set<string>([
  "https://claude.ai", "https://www.claude.ai",
  "https://chatgpt.com", "https://www.chatgpt.com",
  "https://chat.openai.com",
]);

function isMcpClientPath(path: string): boolean {
  return path === "/mcp" || path === "/mcp-gpt"
    || path.startsWith("/.well-known/")
    || path.startsWith("/oauth/")
    || path === "/auth/verify";
}

function setCORS(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "").split("?")[0];
  if (!isMcpClientPath(path)) return; // no CORS for admin/site/webhooks
  const origin = req.headers.origin;
  if (origin && MCP_CLIENT_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // For requests without an Origin (server-to-server, curl) we don't
    // need to set CORS headers at all — they're not subject to SOP.
    res.setHeader("Access-Control-Allow-Origin", "https://claude.ai");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, MCP-Protocol-Version, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function unauthorized(res: ServerResponse, realm?: string, resourceMetadataUrl?: string) {
  if (realm) {
    const parts = [`Bearer realm="${realm}"`];
    if (resourceMetadataUrl) parts.push(`resource_metadata="${resourceMetadataUrl}"`);
    res.setHeader("WWW-Authenticate", parts.join(", "));
  }
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

// ----- Route shapes -------------------------------------------------------

type TenantedSuffix    = { kind: "tenant"; tenantSlug: string; suffix: string };
type LegacyMcp         = { kind: "legacy"; suffix: keyof typeof ENDPOINT_SUFFIXES };
type HotmartHook       = { kind: "hotmart"; tenantSlug: string };
type ValidaPayHook     = { kind: "validapay"; secret: string };
type CanonicalDiscovery = { kind: "discovery"; tenantSlug: string; suffix: string };
type SuperAdmin        = { kind: "super-admin"; suffix: string };
type GlobalOAuthHit    = { kind: "global-oauth"; path: string };
type RouteMatch        = TenantedSuffix | LegacyMcp | HotmartHook | ValidaPayHook | CanonicalDiscovery | SuperAdmin | GlobalOAuthHit | null;

function matchRoute(url: string): RouteMatch {
  const pathOnly = url.split("?")[0];

  const hotmart = pathOnly.match(/^\/webhooks\/hotmart\/([a-z0-9][a-z0-9-]{0,62})$/i);
  if (hotmart) return { kind: "hotmart", tenantSlug: hotmart[1] };

  // ValidaPay webhook — secret in path acts as bearer (docs don't specify
  // a signature header). Configured once at app.validapay.com.br → fans
  // events across all tenants; matching is by subscription id / document.
  const validapay = pathOnly.match(/^\/webhooks\/validapay\/([A-Za-z0-9_\-]{16,128})$/);
  if (validapay) return { kind: "validapay", secret: validapay[1] };

  // Global OAuth (Phase 5+): root-level discovery + endpoints
  if (
    pathOnly === "/.well-known/oauth-authorization-server" ||
    pathOnly === "/.well-known/oauth-protected-resource" ||
    pathOnly === "/oauth/register" ||
    pathOnly === "/oauth/authorize" ||
    pathOnly === "/oauth/token" ||
    pathOnly === "/oauth/revoke" ||
    pathOnly === "/auth/verify"
  ) {
    return { kind: "global-oauth", path: pathOnly };
  }

  // Platform super-admin lives at /super-admin/*
  if (pathOnly === "/super-admin" || pathOnly.startsWith("/super-admin/")) {
    const suffix = pathOnly === "/super-admin" ? "" : pathOnly.slice("/super-admin".length);
    return { kind: "super-admin", suffix };
  }

  // Canonical RFC 8414 / RFC 9728 well-known URLs put the issuer/resource
  // path AFTER the well-known segment. We serve both these and the legacy
  // /t/:slug/.well-known/* aliases (the latter are handled in the tenant
  // branch below).
  //
  //   /.well-known/oauth-authorization-server/t/:slug         (AS metadata)
  //   /.well-known/oauth-protected-resource/t/:slug/mcp       (PRM)
  //   /.well-known/oauth-protected-resource/t/:slug/mcp-gpt   (PRM gpt)
  const wkAs = pathOnly.match(/^\/\.well-known\/oauth-authorization-server\/t\/([a-z0-9][a-z0-9-]{0,62})\/?$/i);
  if (wkAs) return { kind: "discovery", tenantSlug: wkAs[1], suffix: "/.well-known/oauth-authorization-server" };
  const wkPrm = pathOnly.match(/^\/\.well-known\/oauth-protected-resource\/t\/([a-z0-9][a-z0-9-]{0,62})\/(mcp|mcp-gpt)\/?$/i);
  if (wkPrm) return { kind: "discovery", tenantSlug: wkPrm[1], suffix: "/.well-known/oauth-protected-resource" };

  const tenantMatch = pathOnly.match(/^\/t\/([a-z0-9][a-z0-9-]{0,62})(\/.*)$/i);
  if (tenantMatch) return { kind: "tenant", tenantSlug: tenantMatch[1], suffix: tenantMatch[2] };

  if (pathOnly in ENDPOINT_SUFFIXES) {
    return { kind: "legacy", suffix: pathOnly as keyof typeof ENDPOINT_SUFFIXES };
  }
  return null;
}

// ----- MCP session handler (shared between legacy + tenant) --------------

async function handleMcpRequest(args: {
  req: IncomingMessage;
  res: ServerResponse;
  adapterMode: AdapterMode;
  tenant: Tenant | null;
  studentId: string | null;
  accessibleCourseIds: string[] | null;
  /** Global Bearer (Phase 5+). When set, the MCP server runs in cross-tenant mode. */
  mcpUser?: import("./lib/mcp-users.ts").McpUser | null;
  accessibleCourses?: import("./lib/mcp-users.ts").AccessibleCourse[] | null;
}): Promise<void> {
  const { req, res, adapterMode, tenant, studentId, accessibleCourseIds, mcpUser, accessibleCourses } = args;
  const sessionId = (req.headers["mcp-session-id"] as string | undefined)?.toString();

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (isInitializeRequest(body)) {
        // Normal initialize flow: stateful transport with a fresh session-id.
        // Subsequent POST/GET/DELETE on this session can be served from the
        // cache (enables SSE streaming, server-initiated notifications).
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport!); },
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        const server = buildServer(adapterMode, tenant, {
          studentId,
          accessibleCourseIds,
          mcpUser: mcpUser ?? null,
          accessibleCourses: accessibleCourses ?? null,
        });
        await server.connect(transport);
      } else {
        // Phase 10.2 — stateless revive.
        //
        // Client sent a Mcp-Session-Id we don't recognise (server restart
        // wiped our in-memory `transports` Map) but they're not asking to
        // initialize. Phase 10.1 returned 404 here expecting the client
        // SDK to auto-reinitialize; in practice Claude.ai's SDK surfaces
        // the 404 as a hard error ("MCP session has been terminated or no
        // longer exists on the server") and the user has to refresh / reconnect.
        //
        // Fix: serve this request in STATELESS mode using a one-shot transport
        // that doesn't validate the incoming session-id. The bearer was already
        // OAuth-checked upstream, so the request is fully authorized. We build a
        // server from the bearer's mcpUser/tenant context, connect a fresh
        // stateless transport, handle the request, and let GC drop it.
        //
        // Trade-off: stateless mode means no SSE / server-initiated notifications
        // FOR THIS REQUEST. Our tools are all request/response so we don't lose
        // anything. The next initialize call from the client will still create a
        // proper stateful session (cached path above).
        const oneShot = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: skip session-id validation
        });
        const server = buildServer(adapterMode, tenant, {
          studentId,
          accessibleCourseIds,
          mcpUser: mcpUser ?? null,
          accessibleCourses: accessibleCourses ?? null,
        });
        await server.connect(oneShot);
        await oneShot.handleRequest(req, res, body);
        return;
      }
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    // SSE streams (GET) and explicit close (DELETE) require a live session
    // by spec — we can't fake those with a stateless transport because the
    // server might want to push notifications, which has nowhere to land.
    if (!sessionId) {
      res.writeHead(400).end("missing Mcp-Session-Id");
      return;
    }
    if (!transports.has(sessionId)) {
      // Old session-id no longer in our Map. Returning 404 here is fine:
      // hosts treat a missing SSE stream as "no notifications available"
      // and don't surface it as a user-facing error like they do for POST.
      res.writeHead(404).end("session expired");
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  res.writeHead(405).end("method not allowed");
}

// ----- Main server --------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  try {
    setCORS(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, name: "askine" }));
      return;
    }

    if (!req.url) { res.writeHead(404).end("not found"); return; }

    // Brand assets (/brand/*) — served from on-disk /assets dir
    const pathOnlyEarly = req.url.split("?")[0];
    if (req.method === "GET" && isBrandRoute(pathOnlyEarly)) {
      await handleBrandRoute(pathOnlyEarly, res);
      return;
    }

    // Public routes (pricing, signup) — match before tenant-scoped path so
    // they don't collide.
    const pubMatch = matchPublicRoute(req.url, req.method ?? "GET");
    if (pubMatch) {
      await handlePublicRoute(pubMatch, req, res);
      return;
    }

    // Login único por e-mail (/entrar, /entrar/verify) — antes do fallback da LP.
    const entrarMatch = matchEntrarRoute(pathOnlyEarly, req.method ?? "GET");
    if (entrarMatch) {
      await handleEntrarRoute(entrarMatch, req, res);
      return;
    }

    // Formulário de contato da LP (POST /contato → Brevo).
    const contatoMatch = matchContatoRoute(pathOnlyEarly, req.method ?? "GET");
    if (contatoMatch) {
      await handleContatoRoute(contatoMatch, req, res);
      return;
    }

    const route = matchRoute(req.url);
    if (!route) {
      // Nenhuma rota de API casou → tenta servir a landing page estática.
      // (mcp / mcp-gpt / webhooks / oauth / tenants já foram tratados acima.)
      if (await tryServeLanding(pathOnlyEarly, req.method ?? "GET", res)) return;
      res.writeHead(404).end("not found");
      return;
    }

    // ---------- Hotmart webhook ----------
    if (route.kind === "hotmart") {
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      const tenant = await resolveTenantBySlug(route.tenantSlug);
      if (!tenant) { res.writeHead(404).end("tenant not found"); return; }

      const provided = (req.headers["x-hotmart-hottok"] as string | undefined) ?? "";
      const expected = await getHotmartHottok(tenant.id);
      if (!expected || !verifyHottok(provided, expected)) {
        res.writeHead(401).end("invalid hottok");
        return;
      }

      const raw = await readRawBody(req);
      let event;
      try { event = JSON.parse(raw); }
      catch { res.writeHead(400).end("invalid json"); return; }

      const result = await processHotmartEvent(tenant, event);
      if (!result.ok) {
        res.writeHead(result.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, action: result.action, reason: result.reason ?? null }));
      return;
    }

    // ---------- ValidaPay webhook ----------
    //
    // Defense in depth — TWO checks must pass:
    //   1. Path-segment secret matches VALIDA_WEBHOOK_SECRET env
    //      (gate to drop random scanners early; we control this value)
    //   2. HMAC-SHA256 signature in x-webhook-signature header matches
    //      VALIDA_WEBHOOK_SIGNING_SECRET env (ValidaPay's secret —
    //      shown in their webhook config UI; this is real auth +
    //      tamper detection + replay protection within 5 min)
    if (route.kind === "validapay") {
      if (req.method !== "POST") { res.writeHead(405).end("method not allowed"); return; }
      const pathExpected = process.env.VALIDA_WEBHOOK_SECRET ?? "";
      if (!pathExpected) { res.writeHead(500).end("VALIDA_WEBHOOK_SECRET not configured"); return; }
      const a = Buffer.from(route.secret); const b = Buffer.from(pathExpected);
      const pathOk = a.length === b.length && a.equals(b);
      if (!pathOk) { res.writeHead(401).end("invalid path secret"); return; }

      // Read the RAW body bytes for HMAC computation, then JSON-parse.
      const raw = await readRawBody(req);
      const sigHeader = req.headers["x-webhook-signature"] as string | undefined;
      const verdict = verifyWebhookSignature(raw, sigHeader);
      if (!verdict.ok) {
        console.warn(`[validapay] webhook rejected: ${verdict.reason}`);
        res.writeHead(401).end(`invalid signature: ${verdict.reason}`);
        return;
      }

      let event;
      try { event = JSON.parse(raw); }
      catch { res.writeHead(400).end("invalid json"); return; }

      const result = await processValidapayEvent(event as Parameters<typeof processValidapayEvent>[0]);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      return;
    }

    // ---------- Global OAuth (Phase 5+) ----------
    if (route.kind === "global-oauth") {
      const m = matchGlobalOAuthRoute(route.path, req.method ?? "GET");
      if (!m) { res.writeHead(404).end("not found"); return; }
      await handleGlobalOAuthRoute(m, req, res);
      return;
    }

    // ---------- Super admin (platform operator) ----------
    if (route.kind === "super-admin") {
      const m = matchSuperAdminRoute(route.suffix, req.method ?? "GET");
      if (!m) { res.writeHead(404).end("super-admin route not found"); return; }
      await handleSuperAdminRoute(m, req, res);
      return;
    }

    // ---------- Canonical RFC 8414/9728 well-known discovery (deprecated) ----------
    // Phase 5.3: redirect the tenant-scoped canonical URLs to global root.
    if (route.kind === "discovery") {
      res.writeHead(301, { Location: route.suffix }).end();
      return;
    }

    // ---------- Tenant routes (OAuth + admin dashboard + MCP) ----------
    if (route.kind === "tenant") {
      // Phase 5.3: deprecate per-tenant MCP + OAuth URLs. Admin dashboard
      // stays tenant-scoped (each infoprodutor manages their own). MCP and
      // OAuth redirect to global with 301 so existing connectors migrate
      // on the next request.
      if (
        route.suffix === "/mcp" ||
        route.suffix === "/mcp-gpt"
      ) {
        const target = route.suffix; // identical path at root
        res.writeHead(301, { Location: target }).end();
        return;
      }
      // Tenant-scoped OAuth → global OAuth
      if (
        route.suffix === "/.well-known/oauth-authorization-server" ||
        route.suffix === "/.well-known/oauth-protected-resource"
      ) {
        res.writeHead(301, { Location: route.suffix }).end();
        return;
      }
      if (
        route.suffix === "/oauth/register" ||
        route.suffix === "/oauth/authorize" ||
        route.suffix === "/oauth/token" ||
        route.suffix === "/oauth/revoke" ||
        route.suffix === "/auth/verify"
      ) {
        // Forward query string so /authorize?client_id=... still works
        const qs = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
        res.writeHead(301, { Location: `${route.suffix}${qs}` }).end();
        return;
      }

      const tenant = await resolveTenantBySlug(route.tenantSlug);
      if (!tenant) { res.writeHead(404).end("tenant not found"); return; }

      // Admin dashboard: /t/:slug/admin/*
      // ALWAYS allow — even suspended/canceled tenants need to log in to
      // re-pay or see what's wrong. The dashboard renders a banner with
      // the current status.
      if (route.suffix === "/admin" || route.suffix.startsWith("/admin/")) {
        const adminSuffix = route.suffix === "/admin" ? "" : route.suffix.slice("/admin".length);
        const adminMatch = matchAdminRoute(adminSuffix, req.method ?? "GET");
        if (adminMatch) {
          await handleAdminRoute(adminMatch, tenant, req, res);
          return;
        }
        res.writeHead(404).end("admin route not found");
        return;
      }

      // Everything below is consumer-facing — block if tenant is suspended.
      if (!isMcpAccessible(tenant)) {
        res.writeHead(404).end("tenant unavailable");
        return;
      }

      // OAuth + magic-link routes scoped under /t/:slug/
      const oauthMatch = matchOAuthRoute(route.suffix, req.method ?? "GET");
      if (oauthMatch) {
        await handleOAuthRoute(oauthMatch, tenant, req, res);
        return;
      }

      // MCP routes /t/:slug/mcp + /t/:slug/mcp-gpt — require Bearer
      const adapterMode = ENDPOINT_SUFFIXES[route.suffix as keyof typeof ENDPOINT_SUFFIXES];
      if (!adapterMode) { res.writeHead(404).end("not found"); return; }

      // PRM URL for this resource — clients dereference it per RFC 9728 § 5
      // to discover the AS metadata URL.
      const publicUrl = (process.env.PUBLIC_URL || "http://localhost:3333").replace(/\/+$/, "");
      const prmUrl = `${publicUrl}/.well-known/oauth-protected-resource/t/${tenant.slug}${route.suffix}`;
      const realm = `Askine ${tenant.slug}`;

      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!bearer) return unauthorized(res, realm, prmUrl);
      const claims = await validateAccessToken(bearer);
      if (!claims || !claims.studentId) return unauthorized(res, realm, prmUrl);
      const student = await findStudentById(claims.studentId);
      if (!student || student.tenantId !== tenant.id) {
        return unauthorized(res, realm, prmUrl);
      }
      const accessibleCourseIds = await listAccessibleCourseIds(student.id, tenant.id);

      await handleMcpRequest({
        req, res,
        adapterMode,
        tenant,
        studentId: student.id,
        accessibleCourseIds,
      });
      return;
    }

    // ---------- /mcp + /mcp-gpt — global (Phase 5+) OR legacy ----------
    if (route.kind === "legacy") {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const adapterMode = ENDPOINT_SUFFIXES[route.suffix];
      const publicUrl = (process.env.PUBLIC_URL || "http://localhost:3333").replace(/\/+$/, "");
      const prmUrl = `${publicUrl}/.well-known/oauth-protected-resource`;

      // Phase 9.1: only global OAuth Bearer is accepted. The legacy
      // MCP_AUTH_TOKEN single-tenant fallback (which granted full read
      // access with no tenant scoping, no studentId, and no rate
      // limiting) has been removed entirely.
      if (!bearer) return unauthorized(res, "Askine", prmUrl);
      const claims = await validateAccessToken(bearer);
      if (!claims || !claims.mcpUserId) {
        return unauthorized(res, "Askine", prmUrl);
      }
      const mcpUser = await findMcpUserById(claims.mcpUserId);
      if (!mcpUser) return unauthorized(res, "Askine", prmUrl);
      const accessibleCourses = await listAccessibleCoursesGlobal(mcpUser.email);
      await handleMcpRequest({
        req, res,
        adapterMode,
        tenant: null,
        studentId: null,
        accessibleCourseIds: null,
        mcpUser,
        accessibleCourses,
      });
      return;
    }
  } catch (err) {
    console.error("Request error:", err);
    captureError(err, { url: req.url, method: req.method });
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  const routes = Object.entries(ENDPOINT_SUFFIXES).map(([p, m]) => `${p} (${m})`).join(", ");
  console.error(`askine MCP HTTP server listening on :${PORT}`);
  console.error(`  Global MCP: ${routes} — OAuth Bearer required (no legacy fallback)`);
  console.error(`  Multi-tenant:         /t/:slug/{mcp,mcp-gpt} — OAuth Bearer required`);
  console.error(`  AS discovery (RFC 8414): /.well-known/oauth-authorization-server/t/:slug`);
  console.error(`  PRM discovery (RFC 9728): /.well-known/oauth-protected-resource/t/:slug/{mcp,mcp-gpt}`);
  console.error(`  Hotmart webhook:      /webhooks/hotmart/:slug`);
  console.error(`  ValidaPay webhook:    /webhooks/validapay/:secret`);
  console.error(`  Admin dashboard:      /t/:slug/admin (login → /t/:slug/admin/login)`);
  console.error(`  Super admin:          /super-admin (whitelist via SUPER_ADMIN_EMAILS)`);
});
