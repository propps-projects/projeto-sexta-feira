import { useEffect, useState } from 'react';

// LGPD opt-in cookie bar. NO third-party tracker loads until the visitor clicks
// "Aceitar". Choice persists in localStorage. The footer's "Gerenciar cookies"
// dispatches `askine:cookie-prefs` to reopen this bar.
const KEY = 'askine_cookie_consent'; // 'accepted' | 'rejected'

// IDs come from the operator (super-admin → app_settings). Sanitize before
// interpolating into an injected <script> so a bad value can't inject code.
const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');

function injectGA4(rawId: string) {
  const id = clean(rawId);
  if (!id || document.getElementById('ga4-src')) return;
  const s = document.createElement('script');
  s.id = 'ga4-src';
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  const init = document.createElement('script');
  init.id = 'ga4-init';
  init.text =
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
    `gtag('js',new Date());gtag('config','${id}',{anonymize_ip:true});`;
  document.head.appendChild(init);
}

function injectMetaPixel(rawId: string) {
  const id = clean(rawId);
  if (!id || document.getElementById('meta-pixel')) return;
  const s = document.createElement('script');
  s.id = 'meta-pixel';
  s.text =
    `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?` +
    `n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;` +
    `n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;` +
    `t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}` +
    `(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
    `fbq('init','${id}');fbq('track','PageView');`;
  document.head.appendChild(s);
}

async function loadAnalytics() {
  try {
    const url = (import.meta.env.PUBLIC_SITE_CONFIG_URL as string | undefined) ?? '/site-config.json';
    const r = await fetch(url);
    if (!r.ok) return;
    const cfg = (await r.json()) as { analytics?: { ga4Id?: string | null; metaPixelId?: string | null } };
    if (cfg.analytics?.ga4Id) injectGA4(cfg.analytics.ga4Id);
    if (cfg.analytics?.metaPixelId) injectMetaPixel(cfg.analytics.metaPixelId);
  } catch {
    /* offline/dev — no analytics, no problem */
  }
}

export default function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let consent: string | null = null;
    try { consent = localStorage.getItem(KEY); } catch { /* private mode */ }
    if (consent === 'accepted') loadAnalytics();
    else if (consent !== 'rejected') setVisible(true);
    const reopen = () => setVisible(true);
    window.addEventListener('askine:cookie-prefs', reopen);
    return () => window.removeEventListener('askine:cookie-prefs', reopen);
  }, []);

  function accept() {
    try { localStorage.setItem(KEY, 'accepted'); } catch { /* ignore */ }
    setVisible(false);
    loadAnalytics();
  }
  function reject() {
    try { localStorage.setItem(KEY, 'rejected'); } catch { /* ignore */ }
    setVisible(false);
  }

  if (!visible) return null;
  return (
    <div role="dialog" aria-label="Consentimento de cookies"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000,
        background: '#ffffff', color: '#262626',
        padding: '18px clamp(16px,4vw,40px)',
        display: 'flex', alignItems: 'center', gap: 'clamp(16px,4vw,40px)',
        flexWrap: 'wrap', justifyContent: 'center',
        borderTop: '1px solid rgba(0,0,0,0.08)',
        boxShadow: '0 -6px 28px rgba(0,0,0,0.10)',
      }}>
      <p style={{ flex: '1 1 380px', margin: 0, fontSize: 14.5, lineHeight: 1.5, color: '#3a3a38' }}>
        Usamos cookies de analytics para entender como você navega no site e melhorar sua experiência.
        Nenhum dado é coletado sem o seu consentimento explícito. Leia nossa{' '}
        <a href="/privacidade" style={{ color: '#ff6a32', fontWeight: 600 }}>Política de Privacidade</a>.
      </p>
      <div style={{ display: 'flex', gap: 12, flex: '0 0 auto' }}>
        <button onClick={reject} aria-label="Recusar cookies"
          style={{
            border: '1px solid rgba(0,0,0,0.18)', background: 'transparent', color: '#444',
            fontWeight: 600, fontSize: 15, padding: '12px 26px', borderRadius: 999, cursor: 'pointer'
          }}>
          Recusar
        </button>
        <button onClick={accept} aria-label="Aceitar cookies"
          style={{
            border: 0, background: '#ff6a32', color: '#fff',
            fontWeight: 700, fontSize: 15, padding: '12px 26px', borderRadius: 999, cursor: 'pointer'
          }}>
          Aceitar cookies
        </button>
      </div>
    </div>
  );
}
