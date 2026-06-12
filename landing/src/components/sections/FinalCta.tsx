import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import FinalCtaVisual from './visuals/FinalCtaVisual';

export default function FinalCta() {
  return (
    <section className="container">
      <motion.div variants={reveal} {...inViewProps} className="lp-grid-2"
        style={{
          background: '#f1efe9', borderRadius: 28, padding: 'clamp(28px,5vw,64px)',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,56px)', alignItems: 'center'
        }}>
        <div style={{ display: 'grid', gap: 22 }}>
          <div><Badge>Experimente Grátis</Badge></div>
          <h2 style={{ fontSize: 'clamp(28px,3.0vw,42px)', fontWeight: 600, maxWidth: '20ch' }}>
            Transforme o ChatGPT e o Claude no Tutor do seu curso.
          </h2>
          <div><ArrowLink cta="comecar-agora">Começar agora</ArrowLink></div>
        </div>
        <div style={{ aspectRatio: '16 / 10' }}>
          <FinalCtaVisual />
        </div>
      </motion.div>
    </section>
  );
}
