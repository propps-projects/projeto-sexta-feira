import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import PillButton from '../ui/PillButton';
import Placeholder from '../ui/Placeholder';

export default function Hero() {
  return (
    <section className="container" style={{ textAlign: 'center' }}>
      <motion.h1 variants={reveal} {...inViewProps}
        style={{ fontSize: 'clamp(40px, 5.5vw, 76px)', fontWeight: 700, letterSpacing: '-0.02em', maxWidth: '24ch', margin: '0 auto', lineHeight: 1.08 }}>
        Seu curso dentro do ChatGPT e do Claude em 5 minutos
      </motion.h1>
      <motion.p variants={reveal} {...inViewProps}
        style={{ color: 'var(--ink-soft)', fontSize: 'clamp(16px,1.4vw,19px)', maxWidth: '52ch', margin: '28px auto 0' }}>
        Transforme as maiores ferramentas de IA do mundo em um tutor treinado com o seu
        conteúdo sem precisar criar agentes, desenvolver plataformas... nem ter custo de tokens.
      </motion.p>
      <motion.div variants={reveal} {...inViewProps} style={{ marginTop: 36 }}>
        <PillButton variant="dark" cta="integrar-meu-curso">Integrar meu curso →</PillButton>
      </motion.div>
      <motion.div variants={reveal} {...inViewProps}
        style={{ marginTop: 64, background: '#f1efe9', borderRadius: 28, padding: 'clamp(20px,4vw,64px)' }}>
        <Placeholder style={{ minHeight: 'clamp(220px, 48vw, 460px)', borderRadius: 18, background: 'var(--surface)' }} />
      </motion.div>
    </section>
  );
}
