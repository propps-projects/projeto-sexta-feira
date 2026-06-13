const links = [
  { label: 'Recursos', href: '#recursos', cta: 'nav-recursos' },
  { label: 'Planos', href: '#planos', cta: 'nav-planos' },
  { label: 'Entrar', href: '/entrar', cta: 'entrar', strong: true },
];
export default function Nav() {
  return (
    <nav style={{ display: 'flex', justifyContent: 'center', paddingTop: 28, paddingInline: 18 }}>
      <div className="nav-pill" style={{
        display: 'flex', alignItems: 'center', gap: 120, padding: '12px 40px', maxWidth: '100%',
        borderRadius: 999, background: 'rgba(255,255,255,0.55)',
        backdropFilter: 'saturate(60%) blur(14px)', WebkitBackdropFilter: 'saturate(180%) blur(14px)',
        border: '1px solid rgba(0,0,0,0.07)', boxShadow: 'var(--shadow-soft)',
      }}>
        <a href="/" aria-label="Askine" style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>
          <img src="/logo-black.svg" alt="Askine" style={{ height: 17, width: 'auto', display: 'block' }} />
        </a>
        <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: 26, fontSize: 16, lineHeight: 1 }}>
          {links.map((l) => (
            <a key={l.label} href={l.href} data-cta={l.cta} className={l.strong ? undefined : 'nav-anchor'}
              style={{ fontWeight: l.strong ? 700 : 500, color: 'var(--ink)' }}>
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
