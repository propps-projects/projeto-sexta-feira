/**
 * Serve a landing page estática (Astro build) a partir de landing/dist.
 *
 * É um FALLBACK: só é chamado em server-http depois que nenhuma rota de API
 * casa (mcp, mcp-gpt, webhooks, oauth, tenants, etc.). Logo, nunca interfere
 * no conector — apenas ocupa o que hoje é o 404 da raiz.
 *
 * - GET/HEAD apenas.
 * - Arquivo exato (ex.: /_astro/x.js, /favicon.svg) → servido do disco.
 * - Path sem extensão (ex.: "/") → index.html (a LP é single-page).
 * - Arquivo com extensão inexistente → não serve (deixa o caller dar 404).
 * - Guard contra path traversal (resolve precisa ficar dentro de LANDING_DIR).
 */

import { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default: <projectRoot>/landing/dist. No Docker, copiamos o build pra cá.
const LANDING_DIR = process.env.LANDING_DIR
  ? process.env.LANDING_DIR
  : join(__dirname, "..", "landing", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".map": "application/json",
};

async function readWithin(rel: string): Promise<Buffer | null> {
  const base = normalize(LANDING_DIR);
  const target = normalize(join(base, rel));
  // traversal guard: o caminho final precisa ficar dentro de LANDING_DIR
  if (target !== base && !target.startsWith(base + sep)) return null;
  try {
    const s = await stat(target);
    if (!s.isFile()) return null;
    return await readFile(target);
  } catch {
    return null;
  }
}

/**
 * Tenta servir a LP. Retorna true se respondeu; false se a LP não está
 * disponível ou o arquivo pedido não existe (aí o caller responde 404).
 */
export async function tryServeLanding(
  pathOnly: string,
  method: string,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;

  const rel = decodeURIComponent(pathOnly).replace(/^\/+/, "");
  const hasExt = extname(rel) !== "";

  // 1) arquivo exato (assets)
  if (rel !== "") {
    const file = await readWithin(rel);
    if (file) return send(res, file, extname(rel).toLowerCase(), pathOnly, method);
    // pediu um arquivo específico que não existe → 404 do caller
    if (hasExt) return false;
  }

  // 2) rota/raiz sem extensão → index.html (single-page)
  const index = await readWithin("index.html");
  if (!index) return false; // LP não buildada/copiada
  return send(res, index, ".html", pathOnly, method);
}

function send(
  res: ServerResponse,
  body: Buffer,
  ext: string,
  pathOnly: string,
  method: string,
): boolean {
  const type = TYPES[ext] ?? "application/octet-stream";
  // assets com hash do Astro (/_astro/) são imutáveis; html não cacheia forte
  const immutable = pathOnly.startsWith("/_astro/");
  res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=300");
  res.writeHead(200, { "Content-Type": type });
  res.end(method === "HEAD" ? undefined : body);
  return true;
}
