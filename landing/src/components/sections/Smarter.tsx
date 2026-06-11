import { motion } from 'framer-motion';
import { reveal, stagger, staggerItem, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';

// Copy literal da referência (inclui o typo "expriências").
const items = [
  'Sem você precisar criar plataforma própria',
  'Sem você precisar ter custo de tokens',
  'Sem você forçar seu aluno usar IA',
  'Sem criar expriências confusas',
];

function CrossIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.18)" stroke="var(--coral)" strokeWidth="1.4" />
      <path d="M9 9l6 6M15 9l-6 6" stroke="var(--coral)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function Smarter() {
  return (
    <section className="container">
      <motion.div variants={reveal} {...inViewProps} className="lp-grid-2"
        style={{
          background: 'var(--dark)', color: '#fff', borderRadius: 28, padding: 'clamp(28px,5vw,56px)',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,56px)', alignItems: 'center'
        }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <div><Badge tone="dark">Sem Complicação</Badge></div>
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,40px)', fontWeight: 600, maxWidth: '21ch' }}>
            Com a Askine™ teu curso fica mais inteligente e autônomo
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', maxWidth: '42ch' }}>
            Fazendo o ChatGPT e o Claude trabalharem para você sem se preocupar em dificultar
            a experiência de aprendizado do seu aluno.
          </p>
          <div><ArrowLink tone="light" cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
        </div>
        <motion.ul variants={stagger} {...inViewProps}
          style={{
            listStyle: 'none', margin: 0, padding: 'clamp(20px,3vw,32px)', display: 'grid', gap: 18,
            background: 'rgba(255,255,255,0.04)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.08)'
          }}>
          {items.map((t) => (
            <motion.li key={t} variants={staggerItem} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <CrossIcon /><span>{t}</span>
            </motion.li>
          ))}
        </motion.ul>
      </motion.div>
    </section>
  );
}
