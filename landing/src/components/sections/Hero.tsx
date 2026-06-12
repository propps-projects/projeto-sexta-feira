import { useState } from 'react';
import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import PillButton from '../ui/PillButton';
import HeroChatDemo from './HeroChatDemo';

export default function Hero() {
  // Moldura cinza vira branca quando o demo está no Claude (creme ≈ cinza → contraste).
  const [demoProvider, setDemoProvider] = useState<'gpt' | 'claude'>('gpt');
  return (
    <section className="container" style={{ textAlign: 'center' }}>
      <motion.h1 variants={reveal} {...inViewProps}
        style={{ fontSize: 'clamp(40px, 5.5vw, 70px)', fontWeight: 700, letterSpacing: '-0.02em', maxWidth: '24ch', margin: '0 auto', lineHeight: 1.08 }}>
        Seu curso dentro do ChatGPT e do Claude em 5 minutos
      </motion.h1>
      <motion.p variants={reveal} {...inViewProps}
        style={{ color: 'var(--ink-soft)', fontSize: 'clamp(16px,1.4vw,19px)', maxWidth: '52ch', margin: '28px auto 0' }}>
        Transforme as maiores ferramentas de IA do mundo em um tutor treinado com o seu
        conteúdo sem precisar criar agentes, desenvolver plataformas... nem ter custo de tokens.
      </motion.p>
      <motion.div variants={reveal} {...inViewProps} style={{ marginTop: 36 }}>
        <PillButton variant="dark" href="#planos" cta="integrar-meu-curso">Integrar meu curso →</PillButton>
      </motion.div>
      <motion.div variants={reveal} {...inViewProps} style={{ marginTop: 64 }}>
        <motion.div
          animate={{ backgroundColor: demoProvider === 'claude' ? '#ffffff' : '#f1efe9' }}
          transition={{ duration: 0.5, ease: 'easeInOut' }}
          style={{ borderRadius: 28, padding: 'clamp(16px,3vw,48px)' }}>
          <HeroChatDemo onProvider={setDemoProvider} />
        </motion.div>
      </motion.div>
    </section>
  );
}
