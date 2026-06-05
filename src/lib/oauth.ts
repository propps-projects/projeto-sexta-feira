/**
 * OAuth 2.1 primitives for the Askine MCP server. We act as both the
 * Authorization Server (issuing tokens to MCP clients like Claude.ai and
 * ChatGPT) and the Resource Server (validating Bearer tokens on tool calls).
 *
 * Crypto choices:
 *   - tokens are random 32-byte URL-safe base64 strings
 *   - only the SHA-256 hash is stored, never the raw token
 *   - PKCE: S256 only (OAuth 2.1 forbids plain)
 *   - access tokens live 1h, refresh tokens 30 days, auth codes 10min
 *
 * MCP-specific:
 *   - audience binding: tokens carry their tenant + resource URL so a token
 *     issued for /t/foo/mcp can't be replayed against /t/bar/mcp
 *   - DCR (RFC 7591) supported for `claude.ai` and similar clients that
 *     register themselves on first connect
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sb } from "./db-api.ts";

export const ACCESS_TOKEN_TTL_SEC = 3600;          // 1h
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30d
export const AUTH_CODE_TTL_SEC = 600;              // 10min
export const MAGIC_LINK_TTL_SEC = 900;             // 15min

// ---------- Random + hashing ----------

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

/** PKCE S256 verification, constant-time. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  const expected = Buffer.from(sha256(codeVerifier));
  const actual = Buffer.from(codeChallenge);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------- OAuth Clients (DCR) ----------

export interface OAuthClient {
  id: string;
  tenantId: string | null;
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  metadata: Record<string, unknown>;
}

interface OAuthClientRow {
  id: string;
  tenant_id: string | null;
  client_id: string;
  client_secret_hash: string;
  redirect_uris: string[];
  scopes: string[];
  metadata: Record<string, unknown>;
}

function mapClient(r: OAuthClientRow): OAuthClient {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    clientId: r.client_id,
    redirectUris: r.redirect_uris,
    scopes: r.scopes,
    metadata: r.metadata,
  };
}

export async function findClientByClientId(clientId: string): Promise<OAuthClient | null> {
  const row = await sb.selectOne<OAuthClientRow>(
    "oauth_clients",
    `client_id=eq.${encodeURIComponent(clientId)}&select=*`,
  );
  return row ? mapClient(row) : null;
}

/** Register a new dynamic client (RFC 7591). Public clients get a placeholder
 *  hash because MCP browsers don't typically use a client_secret. */
export async function registerClient(args: {
  tenantId?: string | null;
  clientName?: string;
  redirectUris: string[];
  scopes?: string[];
  metadata?: Record<string, unknown>;
}): Promise<{ client: OAuthClient; clientSecret: string | null }> {
  const clientId = `askine_${randomToken(12)}`;
  const clientSecret = randomToken(24);
  const inserted = await sb.insert<OAuthClientRow>("oauth_clients", {
    tenant_id: args.tenantId ?? null,
    client_id: clientId,
    client_secret_hash: sha256(clientSecret),
    redirect_uris: args.redirectUris,
    scopes: args.scopes ?? ["mcp"],
    metadata: { ...(args.metadata ?? {}), clientName: args.clientName ?? null },
  });
  return { client: mapClient(inserted[0]), clientSecret };
}

// ---------- Authorization codes ----------

export interface IssueCodeArgs {
  clientId: string;
  studentId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export async function issueAuthorizationCode(args: IssueCodeArgs): Promise<string> {
  const code = randomToken();
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000).toISOString();
  await sb.insert("oauth_authorization_codes", {
    code_hash: sha256(code),
    client_id: args.clientId,
    student_id: args.studentId,
    redirect_uri: args.redirectUri,
    scopes: args.scopes,
    code_challenge: args.codeChallenge,
    code_challenge_method: args.codeChallengeMethod,
    expires_at: expiresAt,
  }, { returning: "minimal" });
  return code;
}

interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  student_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string | null;
  code_challenge_method: string | null;
  expires_at: string;
  consumed_at: string | null;
}

/** Single-use code consumption. Returns the code's claims or null on
 *  expiry / already-consumed / not found. Caller must verify PKCE. */
export async function consumeAuthorizationCode(code: string): Promise<{
  clientId: string;
  studentId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string | null;
} | null> {
  const hash = sha256(code);
  const row = await sb.selectOne<AuthCodeRow>(
    "oauth_authorization_codes",
    `code_hash=eq.${encodeURIComponent(hash)}&select=*`,
  );
  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  await sb.update("oauth_authorization_codes", `code_hash=eq.${encodeURIComponent(hash)}`, {
    consumed_at: new Date().toISOString(),
  });
  return {
    clientId: row.client_id,
    studentId: row.student_id,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    codeChallenge: row.code_challenge,
  };
}

// ---------- Access + Refresh tokens ----------

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function issueTokens(args: {
  clientId: string;
  studentId: string;
  scopes: string[];
}): Promise<IssuedTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const issuedAt = new Date().toISOString();
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString();
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000).toISOString();

  await sb.insert("oauth_access_tokens", {
    token_hash: sha256(accessToken),
    client_id: args.clientId,
    student_id: args.studentId,
    scopes: args.scopes,
    issued_at: issuedAt,
    expires_at: accessExpires,
  }, { returning: "minimal" });

  await sb.insert("oauth_refresh_tokens", {
    token_hash: sha256(refreshToken),
    client_id: args.clientId,
    student_id: args.studentId,
    issued_at: issuedAt,
    expires_at: refreshExpires,
  }, { returning: "minimal" });

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SEC };
}

interface AccessTokenRow {
  token_hash: string;
  client_id: string;
  student_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
}

/** Validates a Bearer access token. Returns claims or null. */
export async function validateAccessToken(token: string): Promise<{
  clientId: string;
  studentId: string;
  scopes: string[];
} | null> {
  const row = await sb.selectOne<AccessTokenRow>(
    "oauth_access_tokens",
    `token_hash=eq.${encodeURIComponent(sha256(token))}&select=*`,
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return {
    clientId: row.client_id,
    studentId: row.student_id,
    scopes: row.scopes,
  };
}

interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  student_id: string;
  expires_at: string;
  revoked_at: string | null;
}

/** Rotates a refresh token. Marks the old one consumed (rotated_to), issues
 *  a fresh pair. Per OAuth 2.1, a refresh token can be used exactly once. */
export async function rotateRefreshToken(refreshToken: string): Promise<IssuedTokens | null> {
  const oldHash = sha256(refreshToken);
  const row = await sb.selectOne<RefreshTokenRow>(
    "oauth_refresh_tokens",
    `token_hash=eq.${encodeURIComponent(oldHash)}&select=*`,
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;

  const tokens = await issueTokens({
    clientId: row.client_id,
    studentId: row.student_id,
    scopes: [],
  });
  await sb.update("oauth_refresh_tokens", `token_hash=eq.${encodeURIComponent(oldHash)}`, {
    revoked_at: new Date().toISOString(),
    rotated_to: sha256(tokens.refreshToken),
  });
  return tokens;
}

export async function revokeAccessToken(token: string): Promise<void> {
  await sb.update("oauth_access_tokens", `token_hash=eq.${encodeURIComponent(sha256(token))}`, {
    revoked_at: new Date().toISOString(),
  });
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await sb.update("oauth_refresh_tokens", `token_hash=eq.${encodeURIComponent(sha256(token))}`, {
    revoked_at: new Date().toISOString(),
  });
}
