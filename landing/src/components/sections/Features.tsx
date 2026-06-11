import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import Placeholder from '../ui/Placeholder';

const rows = [
  {
    badge: 'Agente Nativo',
    title: 'Um tutor que conhece cada aula e material do seu curso.',
    body: 'A Askine™ transcreve todas suas aulas e cria todas as instruções necessárias para responder, orientar, conduzir e ensinar com base no seu conteúdo.',
  },
  {
    badge: 'Um Lugar Só',
    title: 'Seu aluno não troca de aba. Nem de plataforma.',
    body: 'O tutor vive nativo dentro do ChatGPT e do Claude — as ferramentas que seus alunos já usam todo dia. Nada de login novo, plataforma nova ou tutorial.',
  },
  {
    badge: 'Aulas Nativas',
    title: 'Suas aulas são assistidas dentro do ChatGPT e Claude',
    body: 'Mais que conversar: a Askine™ traz a aula para ser assistido dentro do ChatGPT e do Claude. Seu aluno assiste e tira dúvidas no mesmo lugar.',
  },
  {
    badge: 'Sem Custo Extra',
    title: 'Sem tokens. Sem servidor. Sem plataforma própria.',
    body: 'Você não gasta em infraestruturas caras, nem paga IA usada pelo seu aluno. A Askine™ cuida da parte técnica — você cuida do conteúdo.',
  },
];

export default function Features() {
  return (
    <section id="recursos" className="container" style={{ display: 'grid', gap: 'clamp(48px,8vw,110px)' }}>
      {rows.map((r, i) => {
        const imageLeft = i % 2 === 0;
        const text = (
          <motion.div variants={reveal} {...inViewProps} style={{ display: 'grid', gap: 18, alignContent: 'center' }}>
            <div><Badge>{r.badge}</Badge></div>
            <h2 style={{ fontSize: 'clamp(28px,3.2vw,38px)', fontWeight: 600, maxWidth: '21ch' }}>{r.title}</h2>
            <p style={{ color: 'var(--ink-soft)', maxWidth: '46ch' }}>{r.body}</p>
            <div><ArrowLink cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
          </motion.div>
        );
        const image = (
          <motion.div variants={reveal} {...inViewProps} className="lp-feat-media" style={{ aspectRatio: '4 / 3' }}>
            <Placeholder />
          </motion.div>
        );
        return (
          <div key={r.badge} className="lp-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,72px)' }}>
            {imageLeft ? <>{image}{text}</> : <>{text}{image}</>}
          </div>
        );
      })}
    </section>
  );
}
