import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useTransform, useReducedMotion, type MotionValue } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import Card from '../ui/Card';

const steps = [
  {
    title: '1- Conecte a hospedagem de vídeos das suas aulas e os materiais do seu curso',
    body: 'Temos integração com o Panda Video que em poucos cliques, conseguimos transcrever todo o conteúdo do seu curso, além de, campos para você anexar materiais complementares.',
  },
  {
    title: '2- A Askine™ trabalha para criar a base de conhecimento com seu tom de voz',
    body: 'Com o conteúdo inserido na plataforma, criamos todas as instruções necessárias para o ChatGPT e Claude responder, orientar, conduzir e ensinar seus alunos exatamente como você faz.',
  },
  {
    title: '3- Importe seus alunos e integra a plataforma de vendas do seu curso',
    body: 'Dentro da plataforma, você consegue importar alunos por turmas e/ou cursos para ceder acesso manual ao tutor ou integrar a Hotmart para continuar vendendo e ceder acesso automático aos alunos.',
  },
  {
    title: '4- Ative o curso dentro da Askine™ e libere o conector para seus alunos utilizarem',
    body: 'Quando a base de conhecimento estiver pronta, ative o curso dentro da Askine™ e automaticamente seus alunos poderão consumir seu conteúdo e o tutor dentro do GPT e do Claude.',
  },
];

// --- Pilha de cards (stacking on scroll) ---
const STACK_TOP = 130; // onde a pilha fixa no topo (abaixo do nav)
const PEEK = 16;       // quanto cada card aparece abaixo do anterior
const GAP_VH = 24;     // scroll entre um card e o próximo (dwell) — escondido pela sobreposição

// No mobile/tablet o efeito de pilha (sticky) é ruim no toque → vira lista simples.
function useIsMobile(maxWidth = 860) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [maxWidth]);
  return mobile;
}

function StackCard({
  s, i, total, start, next, progress, reduced, innerRef,
}: {
  s: { title: string; body: string };
  i: number;
  total: number;
  start: number; // fração de scroll (0..1) em que ESTE card pina (vira o da frente)
  next: number;  // fração em que o PRÓXIMO pina (este fica coberto)
  progress: MotionValue<number>;
  reduced: boolean | null;
  innerRef: (el: HTMLDivElement | null) => void;
}) {
  const depth = total - 1 - i; // quantos cards ainda vão cobrir este
  // alvo apagado quando já passou (mais fundo na pilha = mais apagado)
  const buried = depth === 0 ? 1 : Math.max(0.1, 0.3 - (depth - 1) * 0.07);
  const safeNext = next > start ? next : start + 0.0001;
  // fica cheio a maior parte do "reinado"; só começa a apagar quando o próximo entra cobrindo
  const fadeStart = start + (safeNext - start) * 0.55;
  const opacity = useTransform(progress, [fadeStart, safeNext], [1, buried]);
  const scale = useTransform(progress, [fadeStart, safeNext], [1, 1 - depth * 0.05]);
  const y = useTransform(progress, [fadeStart, safeNext], [0, -depth * 10]);

  if (reduced) {
    return (
      <div ref={innerRef}>
        <Card>
          <h3 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>{s.title}</h3>
          <p style={{ color: 'var(--ink-soft)' }}>{s.body}</p>
        </Card>
      </div>
    );
  }
  return (
    <motion.div
      ref={innerRef}
      style={{
        position: 'sticky',
        top: STACK_TOP + i * PEEK,
        marginTop: i === 0 ? 0 : `${GAP_VH}vh`,
        zIndex: i,
        transformOrigin: 'top center',
        scale, opacity, y,
        willChange: 'transform, opacity',
      }}
    >
      <Card>
        <h3 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>{s.title}</h3>
        <p style={{ color: 'var(--ink-soft)' }}>{s.body}</p>
      </Card>
    </motion.div>
  );
}

export default function HowItWorks() {
  const stackRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef<(HTMLDivElement | null)[]>([]);
  const reduced = useReducedMotion();
  const isMobile = useIsMobile();
  const simple = !!reduced || isMobile; // sem efeito de pilha: lista simples
  const { scrollYProgress } = useScroll({ target: stackRef, offset: ['start start', 'end end'] });
  // fração de scroll (0..1) em que cada card pina — medida do layout real
  const [pins, setPins] = useState<number[]>([]);

  useEffect(() => {
    if (simple) return;
    const measure = () => {
      const cont = stackRef.current;
      if (!cont) return;
      const range = cont.offsetHeight - window.innerHeight;
      if (range <= 0) return;
      setPins(
        cardEls.current.map((el, i) =>
          el ? Math.min(1, Math.max(0, (el.offsetTop - STACK_TOP - i * PEEK) / range)) : 0,
        ),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [simple]);

  return (
    <section className="container lp-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 'clamp(32px,6vw,80px)', alignItems: 'start' }}>
      <motion.div variants={reveal} {...inViewProps} style={{ position: simple ? 'static' : 'sticky', top: 80, display: 'grid', gap: 18 }}>
        <div><Badge>Como Funciona</Badge></div>
        <h2 style={{ fontSize: 'clamp(30px,3.6vw,44px)', fontWeight: 600, maxWidth: '19ch' }}>
          Em 05 minutos seu curso está integrado
        </h2>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '40ch' }}>
          Conecte sua hospedagem de vídeos, suba os materiais do seu curso e integre sua
          plataforma de vendas. Só isso!
        </p>
        <div><ArrowLink cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
      </motion.div>
      <div ref={stackRef} style={simple ? { display: 'grid', gap: 24 } : { position: 'relative' }}>
        {steps.map((s, i) => (
          <StackCard
            key={s.title}
            s={s}
            i={i}
            total={steps.length}
            start={pins[i] ?? 1}
            next={i < steps.length - 1 ? (pins[i + 1] ?? 1) : 1}
            progress={scrollYProgress}
            reduced={simple}
            innerRef={(el) => { cardEls.current[i] = el; }}
          />
        ))}
        {!simple && <div style={{ height: '22vh' }} aria-hidden />}
      </div>
    </section>
  );
}
