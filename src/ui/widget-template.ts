/**
 * ChatGPT Apps SDK widget template for play_lesson.
 *
 * Strategy: render an <iframe> pointing at Panda's player embed instead of
 * trying to play HLS in a native <video>. This is what Coursera/YouTube/etc
 * do inside Apps SDK. Reason:
 *
 *   - Apps SDK's iframe has a strict `media-src` CSP that doesn't include
 *     external CDNs *or* `blob:` URLs, so MediaSource Extensions can't feed
 *     the <video>. There's no documented widgetCSP key to fix that.
 *   - But `frame-src` IS configurable via widgetCSP.frame_domains, so an
 *     <iframe> to Panda's player domain is allowed.
 *   - Inside that nested iframe Panda's own player runs in its own origin
 *     with its own CSP context — HLS playback works there.
 *
 * The widget reads `structuredContent.embedUrl` from `window.openai.toolOutput`
 * and points the iframe at it.
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
  iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
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
    <iframe id="frame" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
    <div id="msg" class="msg" style="display:none"></div>
  </div>
  <script>
    (function() {
      var frame = document.getElementById('frame');
      var msg = document.getElementById('msg');
      var titleEl = document.getElementById('title');
      var subEl = document.getElementById('sub');

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

      function buildSrc(data) {
        try {
          var u = new URL(data.embedUrl);
          if (data.startSec && data.startSec > 0) {
            var s = Math.floor(data.startSec);
            u.searchParams.set('startTime', String(s));
            u.searchParams.set('t', String(s));
          }
          return u.toString();
        } catch (e) {
          return data.embedUrl;
        }
      }

      function render(data) {
        if (!data || !data.embedUrl) {
          frame.style.display = 'none';
          show(msg, 'Sem dados de aula.', true);
          return;
        }
        var lessonLabel = (data.lessonNumber != null ? ('Aula ' + data.lessonNumber + ' — ') : '') + (data.title || '');
        titleEl.textContent = lessonLabel || 'Aula';
        subEl.textContent = data.startSec ? ('Iniciando em ' + fmtTime(data.startSec)) : '';
        frame.src = buildSrc(data);
      }

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
        window.addEventListener('openai:set_globals', tryRender, false);
        window.addEventListener('openai:tool_response', tryRender, false);
      }
    })();
  </script>
</body>
</html>`;
}
