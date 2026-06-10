/**
 * OpenAI-inspired admin shell — clean, minimalist, sidebar + topbar.
 *
 * Used by BOTH the per-tenant admin (admin-router.ts) and the platform
 * super-admin (super-admin-router.ts). The shell is identical; only the
 * sidebar items and the brand label change.
 *
 * Design tokens follow platform.openai.com:
 *   - Light theme by default, white surfaces, very subtle borders
 *   - Black primary buttons; ghost secondaries
 *   - Active nav item: light gray fill, no chevron
 *   - 260px fixed sidebar, sticky topbar, generous content padding
 *
 * Brand: serves /brand/logo-black.svg from the on-disk /assets directory
 * (see brand-router.ts). The wordmark variant is used in the sidebar
 * header; the icon variant could be used for collapsed states later.
 */

export interface NavItem {
  /** Stable id used by activeId match */
  id: string;
  label: string;
  href: string;
  /** Optional inline SVG icon (16x16). When omitted, no icon is rendered. */
  icon?: string;
}

export interface NavGroup {
  /** Optional group header label */
  label?: string;
  items: NavItem[];
}

export interface ShellArgs {
  pageTitle: string;
  /** Window title — defaults to `${pageTitle} — ${brandLabel}` */
  documentTitle?: string;
  /** "Askine" (tenant admin) or "Askine Platform" (super-admin) */
  brandLabel: string;
  /** Optional kicker shown small above the brand (e.g. tenant name) */
  brandSub?: string;
  /** Where the brand-link points (back to dashboard root) */
  brandHref: string;
  /** Sidebar nav groups (rendered in order) */
  nav: NavGroup[];
  /** Currently active item id (highlights the matching nav item) */
  activeId?: string;
  /** Status pill shown in the topbar — e.g. trial/active/suspended */
  statusBadge?: { label: string; tone: "neutral" | "ok" | "warn" | "danger" };
  /** Email shown in sidebar footer; click → logout href */
  userEmail?: string;
  logoutHref?: string;
  /** Optional HTML block rendered in the sidebar above the user email
   *  (Phase 8.2 plan usage box: plan name + usage bars + addons CTA). */
  sidebarFooterBox?: string;
  /** Optional CTAs in the topbar right (e.g. "Novo curso") */
  topbarActions?: string;
  /** Banner above the topbar (suspended/canceled/trial messages) */
  banner?: string;
  /** Main content HTML */
  body: string;
  /** Optional extra <head> tags (e.g. per-page <meta>) */
  extraHead?: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function adminShell(args: ShellArgs): string {
  const docTitle = args.documentTitle ?? `${args.pageTitle} — ${args.brandLabel}`;
  const badge = args.statusBadge ? renderBadge(args.statusBadge) : "";
  const userBlock = args.userEmail
    ? `<div class="ax-user">
         <div class="ax-user-email">${esc(args.userEmail)}</div>
         ${args.logoutHref ? `<a class="ax-user-logout" href="${esc(args.logoutHref)}">Sair</a>` : ""}
       </div>`
    : "";

  const navHtml = args.nav.map((g) => {
    const header = g.label ? `<div class="ax-nav-group-label">${esc(g.label)}</div>` : "";
    const items = g.items.map((it) => {
      const active = it.id === args.activeId ? " ax-active" : "";
      const icon = it.icon ?? "";
      return `<a class="ax-nav-item${active}" href="${esc(it.href)}">
        <span class="ax-nav-icon">${icon}</span>
        <span>${esc(it.label)}</span>
      </a>`;
    }).join("");
    return `<div class="ax-nav-group">${header}${items}</div>`;
  }).join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(docTitle)}</title>
<link rel="icon" type="image/png" href="/brand/favicon.png">
${args.extraHead ?? ""}
<style>${ADMIN_SHELL_CSS}</style>
</head>
<body>
${args.banner ?? ""}
<div class="ax-shell">
  <aside class="ax-sidebar">
    <a class="ax-brand" href="${esc(args.brandHref)}">
      <img src="/brand/logo-black.svg" alt="${esc(args.brandLabel)}" class="ax-brand-mark">
      ${args.brandSub ? `<div class="ax-brand-sub">${esc(args.brandSub)}</div>` : ""}
    </a>
    <nav class="ax-nav">${navHtml}</nav>
    ${args.sidebarFooterBox ?? ""}
    ${userBlock}
  </aside>

  <div class="ax-main">
    <header class="ax-topbar">
      <div class="ax-topbar-title">${esc(args.pageTitle)}</div>
      <div class="ax-topbar-spacer"></div>
      ${badge}
      <div class="ax-topbar-actions">${args.topbarActions ?? ""}</div>
    </header>

    <main class="ax-content">
${args.body}
    </main>
  </div>
</div>
</body>
</html>`;
}

function renderBadge(b: NonNullable<ShellArgs["statusBadge"]>): string {
  const colors: Record<typeof b.tone, string> = {
    neutral: "background:#f4f4f4;color:#5e5e5e;",
    ok:      "background:#e8f5e9;color:#1e6f3e;",
    warn:    "background:#fff4d6;color:#8a5a00;",
    danger:  "background:#ffe5e5;color:#a01818;",
  };
  return `<span class="ax-badge" style="${colors[b.tone]}">${esc(b.label)}</span>`;
}

// ----- Common SVG icons (16x16, stroke=currentColor) -----
// All inline so they inherit color from CSS. Keep these small and uniform.

export const icons = {
  dashboard: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>`,
  courses:   `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12v8H2z"/><path d="M2 4 8 1l6 3"/><path d="M5 12v2M11 12v2"/></svg>`,
  students:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5" r="2.5"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5"/></svg>`,
  plug:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3M10 2v3"/><path d="M4 5h8v3a4 4 0 0 1-8 0V5z"/><path d="M8 12v2"/></svg>`,
  plan:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h12v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 5l2-3h8l2 3"/><path d="M6 9h4"/></svg>`,
  tenants:   `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h12"/><path d="M3 14V6l5-3 5 3v8"/><path d="M6 14V9h4v5"/></svg>`,
  insights:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14h12"/><rect x="3" y="9" width="2" height="5"/><rect x="7" y="6" width="2" height="8"/><rect x="11" y="3" width="2" height="11"/></svg>`,
  logout:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3"/><path d="M10 11l3-3-3-3"/><path d="M13 8H6"/></svg>`,
};

// ----- The shared design system -----
export const ADMIN_SHELL_CSS = `
:root {
  --ax-bg: #ffffff;
  --ax-surface: #ffffff;
  --ax-surface-2: #f7f7f8;
  --ax-border: #e5e5e5;
  --ax-border-strong: #d4d4d4;
  --ax-text: #0d0d0d;
  --ax-text-soft: #5e5e5e;
  --ax-text-mute: #8e8e8e;
  --ax-accent: #0d0d0d;
  --ax-accent-hover: #2e2e2e;
  --ax-link: #0d0d0d;
  --ax-success: #1e6f3e;
  --ax-danger: #a01818;
  --ax-warn: #8a5a00;
  --ax-shadow: 0 1px 2px rgba(0,0,0,0.04);
  --ax-shadow-md: 0 4px 16px rgba(0,0,0,0.06);
  --ax-radius: 8px;
  --ax-radius-lg: 12px;
}
*, *::before, *::after { box-sizing: border-box }
html, body { margin:0; padding:0; height:100% }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.55;
  background: var(--ax-bg);
  color: var(--ax-text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
a { color: inherit; text-decoration: none }

/* ---------- Shell layout ---------- */
.ax-shell {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-height: 100vh;
}
.ax-sidebar {
  background: var(--ax-surface);
  border-right: 1px solid var(--ax-border);
  display: flex; flex-direction: column;
  padding: 16px 12px;
  position: sticky; top: 0; align-self: start;
  height: 100vh; overflow-y: auto;
}
.ax-main { display: flex; flex-direction: column; min-width: 0 }
.ax-topbar {
  position: sticky; top: 0; z-index: 5;
  background: rgba(255,255,255,0.92); backdrop-filter: saturate(150%) blur(6px);
  border-bottom: 1px solid var(--ax-border);
  display: flex; align-items: center; gap: 12px;
  padding: 14px 28px;
  min-height: 56px;
}
.ax-topbar-title { font-size: 15px; font-weight: 600; letter-spacing: -0.005em }
.ax-topbar-spacer { flex: 1 }
.ax-topbar-actions { display: flex; gap: 8px; align-items: center }
.ax-content { padding: 28px; max-width: 1120px; width: 100%; margin: 0 auto }

/* ---------- Brand block ---------- */
.ax-brand { display: block; padding: 6px 8px 18px; border-bottom: 1px solid var(--ax-border); margin-bottom: 12px }
.ax-brand-mark { display: block; height: 22px; width: auto }
.ax-brand-sub { font-size: 12px; color: var(--ax-text-mute); margin-top: 6px; padding-left: 1px }

/* ---------- Sidebar nav ---------- */
.ax-nav { flex: 1; display: flex; flex-direction: column; gap: 16px; padding: 4px 0 }
.ax-nav-group { display: flex; flex-direction: column; gap: 2px }
.ax-nav-group-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--ax-text-mute); padding: 0 10px 4px;
}
.ax-nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px; border-radius: 6px;
  font-size: 13.5px; color: var(--ax-text-soft);
  transition: background 0.08s ease, color 0.08s ease;
}
.ax-nav-item:hover { background: var(--ax-surface-2); color: var(--ax-text) }
.ax-nav-item.ax-active { background: #ececec; color: var(--ax-text); font-weight: 500 }
.ax-nav-icon { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; color:inherit; opacity:0.9 }

/* ---------- Sidebar plan/usage box (Phase 8.2) ---------- */
.ax-usage-box { background: var(--ax-surface-2); border: 1px solid var(--ax-border); border-radius: 10px; padding: 12px 14px; margin-top: 16px }
.ax-usage-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px }
.ax-usage-plan { font-weight: 600; font-size: 13px; color: var(--ax-text); letter-spacing: -0.005em }
.ax-usage-tag { background:#fff; border:1px solid var(--ax-border); border-radius: 99px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ax-text-soft) }
.ax-usage-tag.trial { background:#fff8e6; border-color:#f0dca0; color:#8a5a00 }
.ax-usage-row { font-size: 11.5px; color: var(--ax-text-soft); margin-bottom: 8px }
.ax-usage-row:last-child { margin-bottom: 0 }
.ax-usage-row .lbl { display:flex; justify-content:space-between; margin-bottom: 4px }
.ax-usage-row .lbl strong { color: var(--ax-text); font-weight: 500 }
.ax-usage-row .bar { background:#fff; border:1px solid var(--ax-border); height: 5px; border-radius: 99px; overflow: hidden }
.ax-usage-row .bar > div { height: 100%; background: var(--ax-text); border-radius: 99px; transition: width 0.2s ease }
.ax-usage-row .bar > div.warn { background: #f59e0b }
.ax-usage-row .bar > div.danger { background: #dc2626 }
.ax-usage-cta { display:block; margin-top: 10px; text-align: center; font-size: 12px; padding: 6px 10px; background: var(--ax-text); color: #fff; border-radius: 6px; text-decoration: none }
.ax-usage-cta:hover { background: var(--ax-accent-hover) }

/* ---------- Sidebar user block ---------- */
.ax-user { border-top: 1px solid var(--ax-border); padding-top: 12px; margin-top: 12px; display:flex; align-items:center; gap:8px }
.ax-user-email { flex:1; font-size: 12.5px; color: var(--ax-text-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ax-user-logout { font-size: 12.5px; color: var(--ax-text-mute) }
.ax-user-logout:hover { color: var(--ax-text); text-decoration: underline }

/* ---------- Badges ---------- */
.ax-badge { font-size: 11.5px; padding: 3px 8px; border-radius: 99px; font-weight: 500; letter-spacing: 0.01em }

/* ---------- Typography ---------- */
.ax-content h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px }
.ax-content h2 { font-size: 18px; font-weight: 600; margin: 28px 0 12px }
.ax-content h3 { font-size: 14.5px; font-weight: 600; margin: 18px 0 8px }
.ax-content p  { color: var(--ax-text-soft); margin: 0 0 12px }
.ax-content code { background: var(--ax-surface-2); padding: 1px 5px; border-radius: 4px; font-size: 12.5px }
.ax-content .help { color: var(--ax-text-mute); font-size: 12.5px }

/* ---------- Cards ---------- */
.ax-card {
  background: var(--ax-surface); border: 1px solid var(--ax-border);
  border-radius: var(--ax-radius-lg); padding: 20px 22px;
  margin-bottom: 16px;
}
.ax-card.compact { padding: 14px 16px }
.ax-card h2:first-child, .ax-card h3:first-child { margin-top: 0 }

/* ---------- Stats grid ---------- */
.ax-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0 24px }
.ax-stat { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius); padding: 14px 16px }
.ax-stat-num { font-size: 26px; font-weight: 600; letter-spacing: -0.01em }
.ax-stat-label { font-size: 12px; color: var(--ax-text-mute); margin-top: 4px }

/* ---------- Buttons ---------- */
.ax-btn, button.ax-btn, a.ax-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 7px 14px; border-radius: 6px; font-size: 13.5px; font-weight: 500;
  cursor: pointer; border: 1px solid transparent; transition: background 0.08s ease, border 0.08s ease;
  background: var(--ax-accent); color: #fff;
  text-decoration: none; line-height: 1.4;
}
.ax-btn:hover { background: var(--ax-accent-hover) }
.ax-btn.ghost { background: transparent; color: var(--ax-text); border-color: var(--ax-border-strong) }
.ax-btn.ghost:hover { background: var(--ax-surface-2) }
.ax-btn.danger { background: #d72828 }
.ax-btn.danger:hover { background: #b91c1c }
.ax-btn.sm { padding: 5px 10px; font-size: 12.5px }
.ax-btn[disabled] { opacity: 0.5; cursor: not-allowed }

/* ---------- Forms ---------- */
.ax-form .field { display:flex; flex-direction:column; gap:6px; margin-bottom: 16px }
.ax-form label { font-size: 12.5px; color: var(--ax-text); font-weight: 500 }
.ax-form input[type=text], .ax-form input[type=email], .ax-form input[type=password], .ax-form input[type=number],
.ax-form select, .ax-form textarea {
  width: 100%; padding: 9px 12px; border: 1px solid var(--ax-border-strong);
  border-radius: 6px; font: inherit; font-size: 13.5px; background: var(--ax-surface);
  color: var(--ax-text); transition: border 0.08s ease, box-shadow 0.08s ease;
}
.ax-form input:focus, .ax-form select:focus, .ax-form textarea:focus {
  outline: none; border-color: var(--ax-text); box-shadow: 0 0 0 3px rgba(0,0,0,0.06);
}
.ax-form .help { margin-top: 4px }

/* ---------- Tables ---------- */
.ax-table { width:100%; border-collapse: collapse; background: var(--ax-surface); border:1px solid var(--ax-border); border-radius: var(--ax-radius); overflow: hidden }
.ax-table th, .ax-table td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--ax-border) }
.ax-table th { background: var(--ax-surface-2); color: var(--ax-text-soft); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em }
.ax-table tr:last-child td { border-bottom: 0 }
.ax-table tr:hover td { background: var(--ax-surface-2) }

/* ---------- Messages ---------- */
.ax-msg { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 14px; border:1px solid }
.ax-msg.success { background:#f0faf3; border-color:#cfe9d6; color:#1e6f3e }
.ax-msg.error   { background:#fdf3f3; border-color:#f1c5c5; color:#a01818 }
.ax-msg.warn    { background:#fff8e6; border-color:#f0dca0; color:#8a5a00 }
.ax-msg.info    { background:#f7f7f8; border-color:var(--ax-border); color:var(--ax-text-soft) }

/* ---------- Banner (suspended/trial) ---------- */
.ax-banner { padding: 9px 18px; text-align:center; font-size: 12.5px; border-bottom:1px solid }
.ax-banner.danger { background: #fdf3f3; color:#a01818; border-color:#f1c5c5 }
.ax-banner.warn   { background: #fff8e6; color:#8a5a00; border-color:#f0dca0 }
.ax-banner.muted  { background: #f4f4f4; color: var(--ax-text-soft); border-color: var(--ax-border) }
.ax-banner a { color: inherit; text-decoration: underline }

/* ---------- Responsive ---------- */
@media (max-width: 720px) {
  .ax-shell { grid-template-columns: 1fr }
  .ax-sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--ax-border) }
  .ax-content { padding: 20px }
}

/* ---------- Legacy class aliases (back-compat for old admin templates) ---------- */
/* These let pre-existing page templates render with the new theme without
   touching their HTML. Phase 7 admin redesign — incremental cleanup will
   replace these as templates get rewritten. */
.ax-content .card { background: var(--ax-surface); border: 1px solid var(--ax-border); border-radius: var(--ax-radius-lg); padding: 20px 22px; margin-bottom: 16px }
.ax-content .msg { padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 14px; border: 1px solid }
.ax-content .msg.success { background:#f0faf3; border-color:#cfe9d6; color:#1e6f3e }
.ax-content .msg.error   { background:#fdf3f3; border-color:#f1c5c5; color:#a01818 }
.ax-content .msg.warn    { background:#fff8e6; border-color:#f0dca0; color:#8a5a00 }
.ax-content .msg.info    { background:#f7f7f8; border-color:var(--ax-border); color:var(--ax-text-soft) }
.ax-content .help { color: var(--ax-text-mute); font-size: 12.5px }
.ax-content .copy { background: var(--ax-surface-2); border: 1px solid var(--ax-border); border-radius: 6px; padding: 10px 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; color: var(--ax-text); white-space: pre; overflow-x: auto }
.ax-content button, .ax-content a.btn, .ax-content .btn {
  display:inline-flex; align-items:center; justify-content:center; gap: 6px;
  padding: 7px 14px; border-radius: 6px; font-size: 13.5px; font-weight: 500;
  cursor: pointer; border: 1px solid transparent; line-height: 1.4;
  background: var(--ax-accent); color: #fff; text-decoration: none;
  transition: background 0.08s ease;
}
.ax-content button:hover, .ax-content a.btn:hover, .ax-content .btn:hover { background: var(--ax-accent-hover) }
.ax-content button.secondary { background: transparent; color: var(--ax-text); border-color: var(--ax-border-strong) }
.ax-content button.secondary:hover { background: var(--ax-surface-2) }
.ax-content button.danger { background: #d72828 }
.ax-content button.danger:hover { background: #b91c1c }
.ax-content button[disabled] { opacity: 0.5; cursor: not-allowed }

.ax-content input[type=text], .ax-content input[type=email], .ax-content input[type=password], .ax-content input[type=number], .ax-content input[type=url],
.ax-content select, .ax-content textarea {
  width: 100%; padding: 9px 12px; border: 1px solid var(--ax-border-strong);
  border-radius: 6px; font: inherit; font-size: 13.5px; background: var(--ax-surface); color: var(--ax-text);
  transition: border 0.08s ease, box-shadow 0.08s ease;
}
.ax-content input:focus, .ax-content select:focus, .ax-content textarea:focus {
  outline: none; border-color: var(--ax-text); box-shadow: 0 0 0 3px rgba(0,0,0,0.06);
}
.ax-content label { display: block; font-size: 12.5px; color: var(--ax-text); font-weight: 500; margin: 12px 0 4px }

.ax-content table { width:100%; border-collapse: collapse; background: var(--ax-surface); border:1px solid var(--ax-border); border-radius: var(--ax-radius); overflow: hidden; margin: 12px 0 }
.ax-content table th, .ax-content table td { padding: 10px 14px; text-align: left; font-size: 13px; border-bottom: 1px solid var(--ax-border) }
.ax-content table th { background: var(--ax-surface-2); color: var(--ax-text-soft); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em }
.ax-content table tr:last-child td { border-bottom: 0 }

.ax-content pre { background: var(--ax-surface-2); border: 1px solid var(--ax-border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px }
.ax-content code { background: var(--ax-surface-2); padding: 1px 5px; border-radius: 4px; font-size: 12.5px }
.ax-content hr { border: 0; border-top: 1px solid var(--ax-border); margin: 20px 0 }

/* Auth-card overrides for legacy classes (no .ax-content wrapper there) */
.ax-auth-card h1 { font-size: 20px; margin: 0 0 6px }
.ax-auth-card .help { color: var(--ax-text-mute); font-size: 13px; margin-bottom: 16px }
.ax-auth-card .msg { padding: 9px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; border: 1px solid }
.ax-auth-card .msg.success { background:#f0faf3; border-color:#cfe9d6; color:#1e6f3e }
.ax-auth-card .msg.error   { background:#fdf3f3; border-color:#f1c5c5; color:#a01818 }
.ax-auth-card label { display: block; font-size: 12.5px; color: var(--ax-text); font-weight: 500; margin: 12px 0 4px }
.ax-auth-card input[type=email], .ax-auth-card input[type=text], .ax-auth-card input[type=password] {
  width: 100%; padding: 10px 12px; border: 1px solid var(--ax-border-strong); border-radius: 6px; font: inherit; font-size: 14px;
}
.ax-auth-card input:focus { outline: none; border-color: var(--ax-text); box-shadow: 0 0 0 3px rgba(0,0,0,0.06) }
.ax-auth-card button {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding: 9px 14px; border-radius: 6px; font-size: 14px; font-weight: 500;
  cursor: pointer; border: 0; background: var(--ax-accent); color: #fff;
  width: 100%; margin-top: 8px;
}
.ax-auth-card button:hover { background: var(--ax-accent-hover) }
`;
