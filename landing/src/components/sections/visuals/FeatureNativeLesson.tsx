import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual da 3ª feature (Aulas Nativas): a aula é assistida dentro do chat e o
 * aluno tira dúvida no mesmo lugar. Player tocando + resposta digitando ao vivo.
 * A caixa é FIXA; só o conteúdo interno anima. A troca GPT↔Claude é por slide.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "'Tiempos Text', Georgia, 'Times New Roman', Times, serif";

const THEME = {
  gpt: { name: 'ChatGPT', font: SANS, Logo: GptLogo, pageBg: '#ffffff', bubble: '#f4f4f4', answer: 'No 03:40 ele mostra: o criativo carrega a mensagem — sem ele, nenhum canal salva.' },
  claude: { name: 'Claude', font: SERIF, Logo: ClaudeLogo, pageBg: '#faf9f5', bubble: '#ffffff', answer: 'Repare aos 03:40: é o criativo que sustenta a mensagem; o canal só distribui.' },
} as const;

function Caret() {
  return <motion.span animate={{ opacity: [1, 0.15, 1] }} transition={{ duration: 0.8, repeat: Infinity }}
    style={{ display: 'inline-block', width: 2, height: '1em', background: 'currentColor', verticalAlign: 'text-bottom', marginLeft: 1 }} />;
}

function Typewriter({ text, delay = 0 }: { text: string; delay?: number }) {
  const reduced = useReducedMotion();
  const [n, setN] = useState(reduced ? text.length : 0);
  useEffect(() => {
    if (reduced) { setN(text.length); return; }
    setN(0);
    let i = 0;
    const start = window.setTimeout(() => {
      const t = window.setInterval(() => { i += 1; setN(i); if (i >= text.length) window.clearInterval(t); }, 26);
    }, delay);
    return () => window.clearTimeout(start);
  }, [text, delay, reduced]);
  return <>{text.slice(0, n)}{n < text.length && <Caret />}</>;
}

export default function FeatureNativeLesson() {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<'gpt' | 'claude'>('gpt');
  const [progress, setProgress] = useState(28);
  const th = THEME[active];

  useEffect(() => {
    if (reduced) return;
    const a = setInterval(() => setActive((x) => (x === 'gpt' ? 'claude' : 'gpt')), 5200);
    const p = setInterval(() => setProgress((v) => (v >= 95 ? 22 : v + 0.5)), 180);
    return () => { clearInterval(a); clearInterval(p); };
  }, [reduced]);

  const container = {
    hidden: { opacity: 0, x: 36 },
    show: { opacity: 1, x: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1], staggerChildren: 0.1, delayChildren: 0.08 } },
    exit: { opacity: 0, x: -36, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
  };
  const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } } };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
      borderRadius: 16, border: '1px solid var(--border)', background: '#eceae4' }}>
      <AnimatePresence>
        <motion.div key={active}
          variants={container} initial="hidden" animate="show" exit="exit"
          style={{ position: 'absolute', inset: 0, overflow: 'hidden', fontFamily: th.font, color: 'var(--ink)',
            background: th.pageBg, display: 'flex', flexDirection: 'column', gap: 'clamp(8px,1.6vw,12px)', padding: 'clamp(14px,3.2vw,24px)' }}>

          {/* quem responde */}
          <motion.div variants={item} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'clamp(11px,1.4vw,13px)', fontWeight: 600 }}>
            <th.Logo s={18} />{th.name}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 4, fontWeight: 500, color: 'var(--ink-soft)', fontSize: 'clamp(10px,1.2vw,11.5px)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />assistindo a aula
            </span>
          </motion.div>

          {/* player */}
          <motion.div variants={item} style={{ position: 'relative', width: '100%', height: 'clamp(118px,21vw,180px)', borderRadius: 12, overflow: 'hidden', flex: 'none',
            background: 'linear-gradient(135deg,#1f2937 0%,#0b1220 60%,#111827 100%)', border: '1px solid rgba(255,255,255,.08)' }}>
            <div style={{ position: 'absolute', inset: 0, opacity: 0.5, background: 'radial-gradient(120% 80% at 80% 10%, rgba(124,58,237,.4), transparent 60%), radial-gradient(90% 70% at 0% 100%, rgba(34,197,94,.28), transparent 55%)' }} />
            <div style={{ position: 'absolute', left: 12, top: 10, color: '#e5e7eb', fontFamily: SANS }}>
              <div style={{ fontSize: 10, opacity: 0.7 }}>Tráfego para SaaS</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Aula 03 — Topo de funil que converte</div>
            </div>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,.25)' }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z" /></svg>
              </div>
            </div>
            <div style={{ position: 'absolute', right: 10, bottom: 9, fontSize: 10, color: '#cbd5e1', fontFamily: SANS }}>
              {`${String(Math.floor((progress / 100) * 12)).padStart(2, '0')}:${String(Math.floor(((progress / 100) * 750) % 60)).padStart(2, '0')}`} / 12:30
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, background: 'rgba(255,255,255,.18)' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: '#10a37f', transition: 'width .18s linear' }} />
            </div>
          </motion.div>

          {/* pergunta do aluno */}
          <motion.div variants={item} style={{ alignSelf: 'flex-end', display: 'flex', gap: 8, alignItems: 'flex-start', maxWidth: '88%' }}>
            <div style={{ background: th.bubble, border: '1px solid var(--border)', borderRadius: 16, padding: '7px 12px', fontSize: 'clamp(11px,1.4vw,13px)', lineHeight: 1.4 }}>
              Por que o criativo importa mais que o canal?
            </div>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#2d2d2d', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600, flex: 'none' }}>A</div>
          </motion.div>

          {/* resposta digitando ao vivo */}
          <motion.div variants={item} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', maxWidth: '94%' }}>
            <div style={{ flex: 'none', marginTop: 1 }}><th.Logo s={20} /></div>
            <div style={{ fontSize: 'clamp(11px,1.4vw,13px)', lineHeight: 1.5 }}>
              <Typewriter text={th.answer} delay={650} />
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
