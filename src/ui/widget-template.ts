import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HLS_JS_PATH = resolve(__dirname, "../../node_modules/hls.js/dist/hls.min.js");

let _hlsJsSource: string | null = null;
function hlsJsSource(): string {
  if (!_hlsJsSource) _hlsJsSource = readFileSync(HLS_JS_PATH, "utf8");
  return _hlsJsSource;
}

/**
 * Single HTML template registered as the ChatGPT Apps SDK widget for
 * play_lesson. ChatGPT renders this once per tool call into a sandboxed
 * iframe and injects the tool's `structuredContent` at
 * `window.openai.toolOutput`. The script below reads from there and
 * drives an <video> + hls.js player.
 *
 * Reference: https://developers.openai.com/apps-sdk/build/custom-ux
 */
export function buildPlayerWidgetHtml(): string {
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
  .msg { position:absolute; inset:0; padding:14px; font-size:13px; display:flex; align-items:center; justify-content:center; text-align:center; color:#888; }
  .msg.err { color:#f88; }
</style>
</head>
<body>
  <div class="header">
    <strong id="title">Carregando aula…</strong>
    <div id="sub" class="sub"></div>
  </div>
  <div class="player">
    <video id="v" controls playsinline></video>
    <div id="msg" class="msg" style="display:none"></div>
  </div>
  <script>${hlsJsSource()}</script>
  <script>
    (function() {
      var v = document.getElementById('v');
      var msg = document.getElementById('msg');
      var titleEl = document.getElementById('title');
      var subEl = document.getElementById('sub');

      function show(el, txt, err) {
        el.style.display = 'flex';
        el.textContent = txt;
        if (err) el.classList.add('err');
      }
      function hide(el) { el.style.display = 'none'; }

      function fmtTime(s) {
        s = Math.floor(s || 0);
        var m = Math.floor(s/60), r = s%60;
        return m + ':' + (r < 10 ? '0' : '') + r;
      }

      function render(data) {
        if (!data || !data.hlsUrl) {
          show(msg, 'Sem dados de aula pra tocar.', true);
          v.style.display = 'none';
          return;
        }
        hide(msg);
        v.style.display = 'block';
        var lessonLabel = (data.lessonNumber != null ? ('Aula ' + data.lessonNumber + ' — ') : '') + (data.title || '');
        titleEl.textContent = lessonLabel || 'Aula';
        subEl.textContent = data.startSec ? ('Iniciando em ' + fmtTime(data.startSec)) : '';
        var start = Number(data.startSec) || 0;
        function seekStart() { if (start > 0) { try { v.currentTime = start; } catch (e) {} } }
        if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = data.hlsUrl;
          v.addEventListener('loadedmetadata', seekStart, { once: true });
        } else if (window.Hls && Hls.isSupported()) {
          var hls = new Hls({ startPosition: start || -1 });
          hls.loadSource(data.hlsUrl);
          hls.attachMedia(v);
          hls.on(Hls.Events.ERROR, function(_, d) {
            if (d && d.fatal) show(msg, 'Erro ao carregar o vídeo: ' + (d.details || d.type), true);
          });
        } else {
          show(msg, 'Seu navegador não suporta HLS playback.', true);
        }
      }

      // Apps SDK API: render with the data ChatGPT injects.
      // First try the synchronous handle, then listen for late updates.
      function tryRender() {
        if (window.openai && window.openai.toolOutput) {
          render(window.openai.toolOutput);
          return true;
        }
        return false;
      }
      if (!tryRender()) {
        // Some hosts inject data after a tick — poll briefly and listen for events.
        var tries = 0;
        var t = setInterval(function() {
          if (tryRender() || ++tries > 20) clearInterval(t);
        }, 100);
        window.addEventListener('openai:set_globals', tryRender, false);
        window.addEventListener('openai:tool_response', tryRender, false);
      }
    })();
  </script>
</body>
</html>`;
}
