/**
 * Operator-editable key-value settings (app_settings table, migration 023).
 * Small bits of the public site the super-admin can change without a deploy —
 * e.g. the landing's annual-toggle badge text. Served to the landing via
 * /pricing.json.
 */

import { sb } from "./db-api.ts";

interface SettingRow {
  key: string;
  value: string | null;
}

export async function getSetting(key: string): Promise<string | null> {
  const r = await sb.selectOne<SettingRow>(
    "app_settings",
    `key=eq.${encodeURIComponent(key)}&select=value`,
  );
  return r?.value ?? null;
}

/** Batch read — one query for several keys. Returns a key→value map. */
export async function getSettings(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;
  const rows = await sb.select<SettingRow>(
    "app_settings",
    `key=in.(${keys.map((k) => encodeURIComponent(k)).join(",")})&select=key,value`,
  );
  for (const r of rows) if (r.value != null) out.set(r.key, r.value);
  return out;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sb.insert(
    "app_settings",
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key", returning: "minimal" },
  );
}
