import { motion } from 'framer-motion';
export default function ArrowLink({
  children, href = '#', cta, tone = 'dark',
}: { children: React.ReactNode; href?: string; cta?: string; tone?: 'dark' | 'light' }) {
  return (
    <motion.a
      href={href} data-cta={cta} initial="rest" whileHover="hover"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600,
        color: tone === 'light' ? '#fff' : 'var(--ink)',
      }}
    >
      {children}
      <motion.span variants={{ rest: { x: 0 }, hover: { x: 4 } }} aria-hidden>→</motion.span>
    </motion.a>
  );
}
