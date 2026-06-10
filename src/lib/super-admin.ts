/**
 * Super-admin (platform operator) auth — distinct from tenant-admin.
 *
 * Whitelist by env: SUPER_ADMIN_EMAILS=rafael@infosaas.co,outro@infosaas.co
 * Magic-link login reuses the magic_links table with tenant_id=NULL and
 * intent='super_admin_login'. Sessions live in a separate signed cookie
 * (askine_super) so they don't mix with tenant-admin sessions.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "askine_super";
const TTL_SEC = 60 * 60 * 24 * 14; // 14 days — operator role, shorter

export interface SuperAdminSession {
  email: string;
  exp: number;
}

function secret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be set to >= 32 chars");
  }
  return s + ":super"; // domain-separate from tenant-admin sessions
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** True when the email appears in SUPER_ADMIN_EMAILS (CSV). */
export function isSuperAdminEmail(email: string): boolean {
  const list = (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

export function signSuperAdminSession(email: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySuperAdminSession(cookieValue: string | undefined): SuperAdminSession | null {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return null;
  const payload = cookieValue.slice(0, dot);
  const got = cookieValue.slice(dot + 1);
  const want = sign(payload);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SuperAdminSession;
    if (typeof parsed.exp !== "number") return null;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    // Belt-and-suspenders: also re-check whitelist at every request so
    // removing an email from SUPER_ADMIN_EMAILS revokes existing sessions.
    if (!isSuperAdminEmail(parsed.email)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setSuperAdminCookie(email: string): string {
  const value = signSuperAdminSession(email);
  const flags = ["HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${TTL_SEC}`];
  if (process.env.NODE_ENV === "production") flags.push("Secure");
  return `${COOKIE_NAME}=${value}; ${flags.join("; ")}`;
}

export function clearSuperAdminCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function readSuperAdminCookie(cookieHeader: string | undefined): SuperAdminSession | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const c = part.trim();
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    if (c.slice(0, eq) === COOKIE_NAME) return verifySuperAdminSession(c.slice(eq + 1));
  }
  return null;
}
