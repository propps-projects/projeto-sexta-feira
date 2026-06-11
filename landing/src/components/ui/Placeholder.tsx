export default function Placeholder({
  tone = 'light', radius = 'var(--radius)', style,
}: { tone?: 'light' | 'dark'; radius?: string | number; style?: React.CSSProperties }) {
  const bg = tone === 'dark' ? 'var(--dark)' : 'var(--placeholder)';
  const icon = tone === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
  return (
    <div style={{ background: bg, borderRadius: radius, display: 'grid', placeItems: 'center', width: '100%', height: '100%', minHeight: 200, ...style }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={icon} strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="1.6" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </div>
  );
}
