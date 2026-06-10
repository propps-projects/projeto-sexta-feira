/**
 * Magic-link issuance + verification. Used during the OAuth /authorize step
 * to authenticate the student via email instead of a password.
 *
 * Flow:
 *   1. Student hits /oauth/authorize, enters email
 *   2. Server creates a magic_links row, sends email via Resend
 *   3. Email contains /auth/verify?token=xxx
 *   4. Click → server verifies, marks consumed, resumes the OAuth flow
 *      with the saved oauth_state (clientId, redirect_uri, scopes, etc.)
 */

import { sb } from "./db-api.ts";
import { randomToken, sha256, MAGIC_LINK_TTL_SEC } from "./oauth.ts";

export interface MagicLinkClaims {
  /** Null for super-admin (platform-scoped) magic links. */
  tenantId: string | null;
  email: string;
  intent: "oauth_login" | "admin_login" | "super_admin_login" | "dashboard";
  /** Resumes the OAuth /authorize flow after click. JSON-encoded; opaque to
   *  the magic-links subsystem. */
  oauthState: string | null;
}

export async function issueMagicLink(args: MagicLinkClaims): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_SEC * 1000).toISOString();
  await sb.insert("magic_links", {
    token_hash: sha256(token),
    tenant_id: args.tenantId,
    email: args.email.toLowerCase(),
    intent: args.intent,
    oauth_state: args.oauthState,
    expires_at: expiresAt,
  }, { returning: "minimal" });
  return token;
}

interface MagicLinkRow {
  token_hash: string;
  tenant_id: string;
  email: string;
  intent: string;
  oauth_state: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/** Consume a magic link, returning its claims (or null on expiry / already
 *  consumed). Single-use. */
export async function consumeMagicLink(token: string): Promise<MagicLinkClaims | null> {
  const hash = sha256(token);
  const row = await sb.selectOne<MagicLinkRow>(
    "magic_links",
    `token_hash=eq.${encodeURIComponent(hash)}&select=*`,
  );
  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  await sb.update("magic_links", `token_hash=eq.${encodeURIComponent(hash)}`, {
    consumed_at: new Date().toISOString(),
  });
  return {
    tenantId: row.tenant_id,
    email: row.email,
    intent: row.intent as MagicLinkClaims["intent"],
    oauthState: row.oauth_state,
  };
}

// ---------- Email send via Resend ----------

export async function sendMagicLinkEmail(args: {
  to: string;
  url: string;
  tenantName: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "Askine <login@askine.cc>";
  if (!apiKey) {
    console.warn(`[magic-link] No RESEND_API_KEY set — link for ${args.to}:`);
    console.warn(`  ${args.url}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: args.to,
      subject: `Seu acesso ao ${args.tenantName}`,
      html: emailHtml(args),
      text: emailText(args),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

function emailHtml(args: { url: string; tenantName: string }): string {
  return `<!doctype html><html><body style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:24px auto;color:#111">
<h2>Entrar em ${escapeHtml(args.tenantName)}</h2>
<p>Clique no link abaixo pra concluir seu login. Esse link expira em 15 minutos e só pode ser usado uma vez.</p>
<p style="margin:24px 0"><a href="${escapeHtml(args.url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px">Entrar agora</a></p>
<p style="font-size:13px;color:#666">Se você não pediu esse acesso, pode ignorar este email.</p>
<p style="font-size:13px;color:#666">— Askine</p>
</body></html>`;
}

function emailText(args: { url: string; tenantName: string }): string {
  return `Entrar em ${args.tenantName}

Clique no link abaixo pra concluir seu login (expira em 15 minutos, único uso):

${args.url}

Se você não pediu esse acesso, pode ignorar este email.

— Askine`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]!);
}
