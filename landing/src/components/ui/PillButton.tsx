type Variant = 'dark' | 'violet' | 'light' | 'muted';
const palette: Record<Variant, React.CSSProperties> = {
  dark: { background: '#111', color: '#fff' },
  violet: { background: 'var(--violet)', color: '#fff' },
  light: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--border)' },
  muted: { background: '#e9e7e1', color: 'var(--ink-soft)' },
};
export default function PillButton({
  children, variant = 'dark', href = '#', cta, full = false,
}: { children: React.ReactNode; variant?: Variant; href?: string; cta?: string; full?: boolean }) {
  return (
    <a
      href={href}
      data-cta={cta}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center',
        padding: '14px 24px', borderRadius: 999, fontSize: 16, fontWeight: 600,
        width: full ? '100%' : undefined, ...palette[variant],
      }}
    >
      {children}
    </a>
  );
}
