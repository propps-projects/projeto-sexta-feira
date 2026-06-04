/**
 * Claude MCP Apps variant of the lesson-player widget.
 *
 * Uses an HTML5 <video> + hls.js (inlined) instead of an <iframe> because
 * Claude.ai hardcodes `frame-src 'self' blob: data:` and ignores the
 * `_meta.ui.csp.frameDomains` whitelist. This is one experimental path:
 * if Claude's `media-src` happens to include `blob:` (likely, given the
 * defaults we observed), MediaSource Extensions can feed the <video>
 * from hls.js, with the .m3u8 + .ts fetches going through `connect-src`
 * which we DO whitelist via `_meta.ui.csp.connectDomains`.
 *
 * If `media-src` blocks `blob:` we'll see a CSP violation in the console
 * — same wall ChatGPT had. In that case there's no further fix on our
 * side.
 */

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

export function buildPlayerWidgetHtmlVideo(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { margin:0; padding:0; background:#0a0a0a; color:#f5f5f5; font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif; }
  .header { padding:10px 14px; font-size:13px; line-height:1.3; border-bottom:1px solid #1f1f1f; background:#111; }
  .header strong { color:#fff; }
  .header .sub { color:#aaa; font-size:12px; margin-top:2px; }
  /* Classic "intrinsic ratio" pattern: padding-bottom:56.25% reserves 9/16
     of the width as vertical space. Works in every browser, doesn't depend
     on the host honoring preferred-frame-size or aspect-ratio support. */
  .player-wrap { position:relative; width:100%; padding-bottom:56.25%; height:0; background:#000; }
  .player-wrap > video { position:absolute; inset:0; width:100%; height:100%; display:block; }
  .player-wrap > .msg { position:absolute; inset:0; padding:14px; font-size:13px; display:flex; align-items:center; justify-content:center; text-align:center; color:#888; }
  .player-wrap > .msg.err { color:#f88; }
</style>
</head>
<body>
  <div class="header">
    <strong id="title">Carregando aula…</strong>
    <div id="sub" class="sub"></div>
  </div>
  <div class="player-wrap">
    <video id="v" controls playsinline></video>
    <div id="msg" class="msg" style="display:none">Aguardando dados da aula…</div>
  </div>
  <script>${hlsJsSource()}</script>
  <script>
    (function() {
      var v = document.getElementById('v');
      var msg = document.getElementById('msg');
      var titleEl = document.getElementById('title');
      var subEl = document.getElementById('sub');
      var bound = false;

      function show(el, txt, err) {
        el.style.display = 'flex';
        el.textContent = txt;
        if (err) el.classList.add('err');
      }
      function fmtTime(s) {
        s = Math.floor(s || 0);
        var m = Math.floor(s/60), r = s%60;
        return m + ':' + (r < 10 ? '0' : '') + r;
      }

      function render(data) {
        if (bound) return;            // ignore duplicate render events
        if (!data || !data.hlsUrl) return;
        bound = true;
        var lessonLabel = (data.lessonNumber != null ? ('Aula ' + data.lessonNumber + ' — ') : '') + (data.title || '');
        titleEl.textContent = lessonLabel || 'Aula';
        subEl.textContent = data.startSec ? ('Iniciando em ' + fmtTime(data.startSec)) : '';
        msg.style.display = 'none';
        var start = Number(data.startSec) || 0;
        // hls.js path: works inside CSPs that allow blob: in media-src
        // (the .ts/.m3u8 XHR goes through connect-src, which we whitelist).
        if (window.Hls && Hls.isSupported()) {
          var hls = new Hls({ startPosition: start || -1 });
          hls.loadSource(data.hlsUrl);
          hls.attachMedia(v);
          hls.on(Hls.Events.ERROR, function(_, d) {
            if (d && d.fatal) show(msg, 'Erro ao carregar o vídeo: ' + (d.details || d.type), true);
          });
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = data.hlsUrl;
          v.addEventListener('loadedmetadata', function() {
            if (start > 0) { try { v.currentTime = start; } catch(e) {} }
          }, { once: true });
        } else {
          show(msg, 'Seu navegador não suporta HLS playback.', true);
        }
      }

      // Data source 1: ChatGPT Apps SDK (not relevant here, but harmless)
      function tryRender() {
        if (window.openai && window.openai.toolOutput) {
          render(window.openai.toolOutput);
          return true;
        }
        return false;
      }
      if (!tryRender()) {
        var tries = 0;
        var t = setInterval(function() {
          if (tryRender() || ++tries > 20) clearInterval(t);
        }, 100);
      }

      // Data source 2: Claude MCP Apps — adapter dispatches
      //   { type: 'ui-lifecycle-iframe-render-data',
      //     payload: { renderData: { toolOutput: <result>, ... } } }
      window.addEventListener('message', function(event) {
        var msgEv = event.data;
        if (!msgEv || typeof msgEv !== 'object') return;
        if (msgEv.type !== 'ui-lifecycle-iframe-render-data') return;
        var rd = msgEv.payload && msgEv.payload.renderData;
        if (!rd) return;
        var tool = rd.toolOutput;
        if (!tool) return;
        var data = (tool.structuredContent)
                || (tool.result && tool.result.structuredContent)
                || (tool.params && tool.params.structuredContent)
                || tool;
        if (data && data.hlsUrl) render(data);
      }, false);

      // Ask the host to resize the wrapper iframe to fit the widget. Claude's
      // host iframe defaults to a short height that crops the <video>, and
      // the resource _meta preferred-frame-size hint is not honored. Sending
      // ui-size-change here makes the mcp-ui adapter translate it to a
      // ui/notifications/size-changed JSON-RPC notification, which Claude
      // does respect on the iframe wrapper.
      function notifySize() {
        try {
          // measure full content height; falls back to a sane minimum.
          var h = Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0, 460);
          window.parent.postMessage({
            type: 'ui-size-change',
            payload: { height: h, width: window.innerWidth || 600 }
          }, '*');
        } catch (e) {}
      }
      // Notify after initial paint, after render data lands, and on resize.
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(notifySize, 50);
      } else {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(notifySize, 50); });
      }
      window.addEventListener('resize', notifySize);
      // Re-measure each time the player layout could change.
      var sizeTries = 0;
      var sizeInterval = setInterval(function() {
        notifySize();
        if (++sizeTries > 10) clearInterval(sizeInterval);
      }, 250);
    })();
  </script>
</body>
</html>`;
}
