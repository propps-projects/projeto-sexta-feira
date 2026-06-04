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

const PORT = Number(process.env.PORT || 3333);
const ENDPOINT = process.env.MCP_ENDPOINT || "/mcp";
// Optional bearer token to gate the endpoint. Required for any public deploy
// (VPS, Cloudflare, etc.) — Claude.ai sends it via Authorization header.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

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

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
}

const httpServer = http.createServer(async (req, res) => {
  try {
    setCORS(res);
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    // Lightweight health check, no auth.
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, name: "agentclass" }));
      return;
    }

    if (!req.url || !req.url.startsWith(ENDPOINT)) {
      res.writeHead(404).end("not found");
      return;
    }

    if (AUTH_TOKEN) {
      const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (got !== AUTH_TOKEN) return unauthorized(res);
    }

    const sessionId = (req.headers["mcp-session-id"] as string | undefined)?.toString();

    // POST: client sends a JSON-RPC message. New session is created when the
    // first message is `initialize` and no Mcp-Session-Id is present.
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
        const server = buildServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    // GET (SSE stream) and DELETE (terminate) require an existing session.
    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end("missing or invalid Mcp-Session-Id");
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end("method not allowed");
  } catch (err) {
    console.error("Request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, () => {
  const auth = AUTH_TOKEN ? "with bearer auth" : "WITHOUT auth (set MCP_AUTH_TOKEN for public deploys)";
  console.error(`agentclass MCP HTTP server listening on :${PORT}${ENDPOINT} ${auth}`);
});
