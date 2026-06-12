import { motion, useReducedMotion } from 'framer-motion';

type Variant = 'dark' | 'violet' | 'light' | 'muted';
const palette: Record<Variant, React.CSSProperties> = {
  dark: { background: '#111', color: '#fff' },
  violet: { background: 'var(--violet)', color: '#fff' },
  light: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--border)' },
  muted: { background: '#e9e7e1', color: 'var(--ink-soft)' },
};
export default function PillButton({
  children, variant = 'dark', href = '#', cta, full = false, onClick,
}: { children: React.ReactNode; variant?: Variant; href?: string; cta?: string; full?: boolean; onClick?: () => void }) {
  const reduced = useReducedMotion();
  const motionProps = {
    'data-cta': cta,
    whileHover: reduced ? undefined : { scale: 1.035, y: -2, boxShadow: '0 10px 22px rgba(0,0,0,0.16)' },
    whileTap: reduced ? undefined : { scale: 0.96, y: 0, boxShadow: '0 3px 8px rgba(0,0,0,0.14)' },
    transition: { type: 'spring' as const, stiffness: 420, damping: 26 },
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center',
      padding: '14px 24px', borderRadius: 999, fontSize: 16, fontWeight: 600,
      cursor: 'pointer', willChange: 'transform', border: 'none',
      width: full ? '100%' : undefined, ...palette[variant],
    } as React.CSSProperties,
  };
  // Sem href de navegação → renderiza <button> (ex.: abrir modal).
  if (onClick) {
    return <motion.button type="button" onClick={onClick} {...motionProps}>{children}</motion.button>;
  }
  return <motion.a href={href} {...motionProps}>{children}</motion.a>;
}
