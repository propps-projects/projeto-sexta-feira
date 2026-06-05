/**
 * PostgREST-based DB client. Drop-in replacement for the postgres-js pooler
 * connection, used at runtime because the pooler endpoint for the Askine
 * project (sa-east-1) was rejecting our user lookup. The REST API works over
 * HTTPS via Cloudflare and doesn't have that problem.
 *
 * Three primitives:
 *   - sb.select<T>(table, query)        — GET rows
 *   - sb.insert<T>(table, body, opts)   — POST rows, optional upsert
 *   - sb.update<T>(table, query, body)  — PATCH matching rows
 *   - sb.delete(table, query)           — DELETE matching rows
 *   - sb.rpc<T>(fn, body)               — POST RPC (Postgres function)
 *
 * `query` is a PostgREST-style query string starting after the `?` (e.g.
 * `id=eq.${uuid}&select=*`). Keep it simple and explicit — building it
 * dynamically gets ugly fast.
 *
 * Vector columns: pass `embedding` as the literal string `[n1,n2,...]` and
 * Postgres parses it.
 *
 * Inserting JSONB: just pass the object as-is, PostgREST handles encoding.
 */

// Read env lazily — ESM hoists imports before server-http.ts's
// `dotenv.config()` runs, so module-load reads would see undefined.
function ensureEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  }
  return { url, key };
}

const BASE_HEADERS = (): Record<string, string> => {
  const { key } = ensureEnv();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
};

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const { url } = ensureEnv();
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: { ...BASE_HEADERS(), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const sb = {
  async select<T>(table: string, query = ""): Promise<T[]> {
    const sep = query ? "?" : "";
    return req<T[]>("GET", `/${table}${sep}${query}`);
  },

  async selectOne<T>(table: string, query: string): Promise<T | null> {
    const rows = await req<T[]>("GET", `/${table}?${query}`);
    return rows[0] ?? null;
  },

  async insert<T>(
    table: string,
    body: Record<string, unknown> | Record<string, unknown>[],
    opts: { returning?: "minimal" | "representation"; onConflict?: string } = {},
  ): Promise<T[]> {
    const prefer: string[] = [];
    if (opts.onConflict) prefer.push("resolution=merge-duplicates");
    prefer.push(`return=${opts.returning ?? "representation"}`);
    const qp = opts.onConflict ? `?on_conflict=${encodeURIComponent(opts.onConflict)}` : "";
    return req<T[]>("POST", `/${table}${qp}`, Array.isArray(body) ? body : [body], {
      Prefer: prefer.join(","),
    });
  },

  async update<T>(
    table: string,
    query: string,
    body: Record<string, unknown>,
    opts: { returning?: "minimal" | "representation" } = {},
  ): Promise<T[]> {
    return req<T[]>("PATCH", `/${table}?${query}`, body, {
      Prefer: `return=${opts.returning ?? "minimal"}`,
    });
  },

  async delete(table: string, query: string): Promise<void> {
    await req<void>("DELETE", `/${table}?${query}`);
  },

  async rpc<T>(fn: string, body: Record<string, unknown> = {}): Promise<T> {
    return req<T>("POST", `/rpc/${fn}`, body);
  },
};
