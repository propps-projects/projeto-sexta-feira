/**
 * Stateless widget URI encoder/decoder (Phase 10).
 *
 * The player widget URI used to be static (`ui://widget/lesson-player-v2.html`),
 * which forced Claude/ChatGPT to ALWAYS rely on a postMessage from the host to
 * hydrate the iframe with the lesson data. After a server restart (deploy), the
 * in-memory MCP `transports` map is empty, the host's old Mcp-Session-Id no
 * longer resolves, and the widget can fail to receive its render data — the
 * video appears to "disappear" from old conversations until the user triggers
 * a new tool call.
 *
 * Phase 10 fix: each play_lesson call returns a UNIQUE URI per call that
 * carries the render data inline as base64url. The resource read callback
 * decodes the data from the URI and injects it into the HTML as a
 * `window._playerData` literal — no postMessage required. The widget is now
 * stateless: even if the MCP session that originally generated the URI is
 * long gone, the new session resolves the URI and gets the same HTML because
 * the data travels WITH the URI.
 */

const URI_TEMPLATE = "ui://widget/lesson-player-v3/{data}.html";

export interface PlayerData {
  hlsUrl: string;
  embedUrl: string;
  title: string;
  id: string;
  lessonNumber: number | null;
  startSec?: number;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  // Restore standard base64 alphabet + padding before decoding
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(
    input.replace(/-/g, "+").replace(/_/g, "/") + pad,
    "base64",
  ).toString("utf8");
}

/** Build a per-call resource URI with player data embedded inline. */
export function buildPlayerWidgetUri(data: PlayerData): string {
  const json = JSON.stringify(data);
  const payload = base64urlEncode(json);
  return URI_TEMPLATE.replace("{data}", payload);
}

/** Extract & decode the player data from a v3 URI, or null if not a v3 URI. */
export function parsePlayerDataFromUri(uri: string): PlayerData | null {
  // Accept both the canonical form and any with trailing query/fragment
  const m = uri.match(/^ui:\/\/widget\/lesson-player-v3\/([^.]+)\.html/);
  if (!m) return null;
  try {
    const json = base64urlDecode(m[1]);
    const parsed = JSON.parse(json) as PlayerData;
    if (!parsed.hlsUrl && !parsed.embedUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

export const PLAYER_WIDGET_URI_TEMPLATE = URI_TEMPLATE;
export const PLAYER_WIDGET_URI_LEGACY = "ui://widget/lesson-player-v2.html";
