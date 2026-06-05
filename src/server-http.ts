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
import { resolveTenantBySlug, type Tenant } from "./lib/tenant.ts";
import { findStudentById, listAccessibleCourseIds } from "./lib/students.ts";
import { validateAccessToken } from "./lib/oauth.ts";
import { matchOAuthRoute, handleOAuthRoute } from "./oauth-router.ts";
import { matchAdminRoute, handleAdminRoute } from "./admin-router.ts";
import { matchSuperAdminRoute, handleSuperAdminRoute } from "./super-admin-router.ts";
import { matchPublicRoute, handlePublicRoute } from "./public-router.ts";
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

// Legacy MCP_AUTH_TOKEN — kept for the legacy /mcp + /mcp-gpt routes so
// the current production MVP deploy on EasyPanel keeps working without an
// OAuth dance. Tenant routes (/t/:slug/) require real OAuth instead.
const LEGACY_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

const transports = new Map<string, StreamableHTTPServerTransport>();

function setCORS(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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
type RouteMatch        = TenantedSuffix | LegacyMcp | HotmartHook | ValidaPayHook | CanonicalDiscovery | SuperAdmin | null;

function matchRoute(url: string): RouteMatch {
  const pathOnly = url.split("?")[0];

  const hotmart = pathOnly.match(/^\/webhooks\/hotmart\/([a-z0-9][a-z0-9-]{0,62})$/i);
  if (hotmart) return { kind: "hotmart", tenantSlug: hotmart[1] };

  // ValidaPay webhook — secret in path acts as bearer (docs don't specify
  // a signature header). Configured once at app.validapay.com.br → fans
  // events across all tenants; matching is by subscription id / document.
  const validapay = pathOnly.match(/^\/webhooks\/validapay\/([A-Za-z0-9_\-]{16,128})$/);
  if (validapay) return { kind: "validapay", secret: validapay[1] };

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
}): Promise<void> {
  const { req, res, adapterMode, tenant, studentId, accessibleCourseIds } = args;
  const sessionId = (req.headers["mcp-session-id"] as string | undefined)?.toString();

  if (req.method === "POST") {
    const body = await readJsonBody(req);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No session — first request must be initialize" }, id: null }));
        return;
      }
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
      });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400).end("missing or invalid Mcp-Session-Id");
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
    setCORS(res);
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, name: "askine" }));
      return;
    }

    if (!req.url) { res.writeHead(404).end("not found"); return; }

    // Public routes (pricing, signup) — match before tenant-scoped path so
    // they don't collide.
    const pubMatch = matchPublicRoute(req.url, req.method ?? "GET");
    if (pubMatch) {
      await handlePublicRoute(pubMatch, req, res);
      return;
    }

    const route = matchRoute(req.url);
    if (!route) { res.writeHead(404).end("not found"); return; }

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

    // ---------- Super admin (platform operator) ----------
    if (route.kind === "super-admin") {
      const m = matchSuperAdminRoute(route.suffix, req.method ?? "GET");
      if (!m) { res.writeHead(404).end("super-admin route not found"); return; }
      await handleSuperAdminRoute(m, req, res);
      return;
    }

    // ---------- Canonical RFC 8414/9728 well-known discovery ----------
    if (route.kind === "discovery") {
      const tenant = await resolveTenantBySlug(route.tenantSlug);
      if (!tenant) { res.writeHead(404).end("tenant not found"); return; }
      const oauthMatch = matchOAuthRoute(route.suffix, req.method ?? "GET");
      if (!oauthMatch) { res.writeHead(404).end("not found"); return; }
      await handleOAuthRoute(oauthMatch, tenant, req, res);
      return;
    }

    // ---------- Tenant routes (OAuth + admin dashboard + MCP) ----------
    if (route.kind === "tenant") {
      const tenant = await resolveTenantBySlug(route.tenantSlug);
      if (!tenant) { res.writeHead(404).end("tenant not found"); return; }

      // Admin dashboard: /t/:slug/admin/*
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
      if (!claims) return unauthorized(res, realm, prmUrl);
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

    // ---------- Legacy single-tenant routes ----------
    if (route.kind === "legacy") {
      if (LEGACY_AUTH_TOKEN) {
        const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (got !== LEGACY_AUTH_TOKEN) return unauthorized(res);
      }
      await handleMcpRequest({
        req, res,
        adapterMode: ENDPOINT_SUFFIXES[route.suffix],
        tenant: null,
        studentId: null,
        accessibleCourseIds: null,
      });
      return;
    }
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  const legacy = LEGACY_AUTH_TOKEN ? "with MCP_AUTH_TOKEN" : "WITHOUT auth";
  const routes = Object.entries(ENDPOINT_SUFFIXES).map(([p, m]) => `${p} (${m})`).join(", ");
  console.error(`askine MCP HTTP server listening on :${PORT}`);
  console.error(`  Legacy single-tenant: ${routes} — ${legacy}`);
  console.error(`  Multi-tenant:         /t/:slug/{mcp,mcp-gpt} — OAuth Bearer required`);
  console.error(`  AS discovery (RFC 8414): /.well-known/oauth-authorization-server/t/:slug`);
  console.error(`  PRM discovery (RFC 9728): /.well-known/oauth-protected-resource/t/:slug/{mcp,mcp-gpt}`);
  console.error(`  Hotmart webhook:      /webhooks/hotmart/:slug`);
  console.error(`  ValidaPay webhook:    /webhooks/validapay/:secret`);
  console.error(`  Admin dashboard:      /t/:slug/admin (login → /t/:slug/admin/login)`);
  console.error(`  Super admin:          /super-admin (whitelist via SUPER_ADMIN_EMAILS)`);
});
