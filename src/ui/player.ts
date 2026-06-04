import { createUIResource } from "@mcp-ui/server";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Lesson } from "../lib/lessons.ts";
import { formatTimestamp } from "../lib/lessons.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HLS_JS_PATH = resolve(__dirname, "../../node_modules/hls.js/dist/hls.min.js");

let _hlsJsSource: string | null = null;
function hlsJsSource(): string {
  if (!_hlsJsSource) _hlsJsSource = readFileSync(HLS_JS_PATH, "utf8");
  return _hlsJsSource;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Builds an HTML5 video player using hls.js + Panda's HLS stream directly.
 * Why not iframe the Panda embed? Claude Desktop's MCP UI sandbox blocks nested
 * cross-origin iframes (CSP frame-src). A native <video> + HLS via XHR doesn't
 * cross frame boundaries and works inside the sandbox.
 */
function buildHtml(lesson: Lesson, startSec?: number): string {
  const start = startSec && startSec > 0 ? Math.floor(startSec) : 0;
  const title = `Aula ${lesson.lessonNumber} — ${lesson.title}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { margin:0; padding:0; height:100%; background:#0a0a0a; color:#f5f5f5; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; }
  body { display:flex; flex-direction:column; min-height:420px; }
  .header { flex:0 0 auto; padding:10px 14px; font-size:13px; line-height:1.3; border-bottom:1px solid #1f1f1f; background:#111; }
  .header strong { color:#fff; }
  .header .sub { color:#aaa; font-size:12px; margin-top:2px; }
  .player { flex:1 1 auto; position:relative; min-height:360px; background:#000; }
  video { position:absolute; inset:0; width:100%; height:100%; }
  .err { position:absolute; inset:0; padding:14px; color:#f88; font-size:13px; display:flex; align-items:center; justify-content:center; text-align:center; }
</style>
</head>
<body>
  <div class="header">
    <strong>${escapeHtml(title)}</strong>
    ${start ? `<div class="sub">Iniciando em ${formatTimestamp(start)}</div>` : ""}
  </div>
  <div class="player">
    <video id="v" controls playsinline></video>
    <div id="err" class="err" style="display:none"></div>
  </div>
  <script>${hlsJsSource()}</script>
  <script>
    (function() {
      var v = document.getElementById('v');
      var errBox = document.getElementById('err');
      var src = ${JSON.stringify(lesson.hlsUrl)};
      var start = ${start};
      function fail(msg) { v.style.display='none'; errBox.style.display='flex'; errBox.textContent = msg; }
      function seekStart() { if (start > 0) { try { v.currentTime = start; } catch(e) {} } }
      // Safari plays HLS natively
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        v.addEventListener('loadedmetadata', seekStart, { once: true });
      } else if (window.Hls && Hls.isSupported()) {
        var hls = new Hls({ startPosition: start || -1 });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, function(_, data) {
          if (data && data.fatal) fail('Erro ao carregar o vídeo: ' + (data.details || data.type));
        });
      } else {
        fail('Seu navegador não suporta HLS playback.');
      }
    })();
  </script>
</body>
</html>`;
}

export function playerResource(lesson: Lesson, startSec?: number) {
  const t = startSec ? `?t=${Math.floor(startSec)}` : "";
  return createUIResource({
    uri: `ui://lesson/${lesson.id}${t}`,
    content: { type: "rawHtml", htmlString: buildHtml(lesson, startSec) },
    encoding: "text",
    // Emits MIME `text/html;profile=mcp-app` (the only one Claude Desktop declares
    // in its `io.modelcontextprotocol/ui` capability) + injects the mcp-apps adapter.
    adapters: { mcpApps: { enabled: true } },
    // Tell the host how much vertical space to allocate.
    uiMetadata: { "preferred-frame-size": ["100%", "420px"] },
  });
}
