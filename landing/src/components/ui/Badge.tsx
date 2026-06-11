export default function Badge({ children, tone = 'light' }: { children: React.ReactNode; tone?: 'light' | 'dark' }) {
  const styles: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 13,
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    color: tone === 'dark' ? 'rgba(255,255,255,0.85)' : 'var(--ink)',
    background: tone === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.02)',
  };
  return <span style={styles}>{children}</span>;
}
