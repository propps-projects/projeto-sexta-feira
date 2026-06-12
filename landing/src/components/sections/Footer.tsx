const nav = [
  { label: 'Recursos', href: '#recursos' },
  { label: 'Planos', href: '#planos' },
  { label: 'Entrar', href: '/entrar', strong: true },
];
const legal = [
  { label: 'Política de Privacidade', href: '#' },
  { label: 'Termos de Uso', href: '#' },
  { label: 'Coockies', href: '#' }, // typo fiel à referência
];

export default function Footer() {
  return (
    <footer className="container" style={{ paddingBlock: 64 }}>
      <div style={{ textAlign: 'center', display: 'grid', gap: 24, justifyItems: 'center' }}>
        <a href="#" aria-label="Askine" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <img src="/logo-black.svg" alt="Askine" style={{ height: 20, width: 'auto', display: 'block' }} />
        </a>
        <div style={{ display: 'flex', gap: 28, color: 'var(--ink-soft)' }}>
          {nav.map((l) => <a key={l.label} href={l.href} style={{ fontWeight: l.strong ? 700 : 400, color: l.strong ? 'var(--ink)' : 'var(--ink-soft)' }}>{l.label}</a>)}
        </div>
      </div>
      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '36px 0' }} />
      <div className="footer-bottom" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, color: 'var(--ink-soft)', fontSize: 14 }}>
        <span>Copyright © 2026 — Askine LLC. Todos os direitos reservados.</span>
        <div style={{ display: 'flex', gap: 24 }}>
          {legal.map((l) => <a key={l.label} href={l.href}>{l.label}</a>)}
        </div>
      </div>
    </footer>
  );
}
