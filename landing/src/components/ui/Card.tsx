export default function Card({
  children, tone = 'light', style,
}: { children: React.ReactNode; tone?: 'light' | 'dark' | 'violet'; style?: React.CSSProperties }) {
  const tones: Record<string, React.CSSProperties> = {
    light: { background: 'var(--surface)', border: '1px solid var(--border)' },
    dark: { background: 'var(--dark)', color: '#fff' },
    violet: { background: 'var(--surface)', border: '1.5px solid var(--violet)' },
  };
  return (
    <div style={{ borderRadius: 'var(--radius)', padding: 28, boxShadow: 'var(--shadow-soft)', ...tones[tone], ...style }}>
      {children}
    </div>
  );
}
