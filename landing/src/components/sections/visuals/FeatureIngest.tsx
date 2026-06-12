import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual da 1ª feature (Agente Nativo): pipeline de ingestão.
 * Conteúdo do curso (aulas, material, slides) → núcleo Askine → tutor dentro do
 * ChatGPT e do Claude. As linhas de conexão são MEDIDAS das posições reais dos
 * cards (recalculadas no resize), então sempre batem com os nós.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function SrcIc({ type }: { type: string }) {
  const c = 'rgba(0,0,0,.55)';
  if (type === 'play') return <svg width="13" height="13" viewBox="0 0 24 24" fill={c}><path d="M8 5v14l11-7z" /></svg>;
  if (type === 'doc') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><path d="M6 2h8l4 4v16H6z" /><path d="M9 12h6M9 16h6" strokeLinecap="round" /></svg>;
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2"><rect x="3" y="4" width="18" height="13" rx="1.5" /><path d="M9 21h6" strokeLinecap="round" /></svg>;
}

const SOURCES = [
  { ic: 'play', l: 'Aulas' },
  { ic: 'doc', l: 'Materiais' },
  { ic: 'slides', l: 'Slides' },
];
const DESTS = [
  { logo: <GptLogo />, name: 'ChatGPT', dot: '#10a37f' },
  { logo: <ClaudeLogo />, name: 'Claude', dot: '#d97757' },
];

type Seg = { x1: number; y1: number; x2: number; y2: number };

export default function FeatureIngest() {
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const srcRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dstRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [segs, setSegs] = useState<Seg[]>([]);

  useEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current, core = coreRef.current;
      if (!wrap || !core) return;
      const c = wrap.getBoundingClientRect();
      if (c.width === 0 || c.height === 0) return;
      const px = (x: number, y: number) => ({ x: ((x - c.left) / c.width) * 100, y: ((y - c.top) / c.height) * 100 });
      const cr = core.getBoundingClientRect();
      const coreC = px(cr.left + cr.width / 2, cr.top + cr.height / 2);
      const next: Seg[] = [];
      // fontes: borda direita do card → centro do núcleo
      srcRefs.current.forEach((el) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const p = px(r.right, r.top + r.height / 2);
        next.push({ x1: p.x, y1: p.y, x2: coreC.x, y2: coreC.y });
      });
      // destinos: centro do núcleo → borda esquerda do card
      dstRefs.current.forEach((el) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const p = px(r.left, r.top + r.height / 2);
        next.push({ x1: coreC.x, y1: coreC.y, x2: p.x, y2: p.y });
      });
      setSegs(next);
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
    if (fonts?.ready) fonts.ready.then(measure);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  return (
    <div ref={wrapRef} style={{
      width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
      background: '#ffffff', border: '1px solid var(--border)', borderRadius: 16, fontFamily: SANS,
    }}>
      {/* linhas medidas das posições reais dos cards */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {segs.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="rgba(0,0,0,.18)" strokeWidth="0.35" strokeDasharray="1.2 2" strokeLinecap="round">
            {!reduced && <animate attributeName="stroke-dashoffset" values="0;-3.2" dur="0.9s" repeatCount="indefinite" />}
          </line>
        ))}
      </svg>

      {/* grid: fontes | núcleo | destinos */}
      <div style={{
        position: 'relative', zIndex: 1, height: '100%', display: 'grid',
        gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: 'clamp(14px,3.4vw,28px)', gap: 'clamp(6px,2vw,16px)'
      }}>

        {/* Fontes */}
        <div style={{ display: 'grid', gap: 'clamp(10px,3vh,22px)', justifyItems: 'start' }}>
          {SOURCES.map((s, i) => (
            <motion.div key={s.l} ref={(el) => { srcRefs.current[i] = el; }}
              animate={reduced ? {} : { opacity: [0.6, 1, 0.6] }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.5 }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'clamp(11px,1.4vw,13px)',
                color: 'var(--ink)', background: '#fff', border: '1px solid var(--border)', borderRadius: 10,
                padding: '7px 11px', whiteSpace: 'nowrap'
              }}>
              <SrcIc type={s.ic} />{s.l}
            </motion.div>
          ))}
        </div>

        {/* Núcleo Askine */}
        <motion.div style={{ display: 'grid', justifyItems: 'center' }}
          animate={reduced ? {} : { scale: [1, 1.06, 1] }} transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}>
          <div ref={coreRef} style={{
            position: 'relative', width: 'clamp(56px,11vw,84px)', aspectRatio: '1', borderRadius: '50%',
            background: '#111', display: 'grid', placeItems: 'center'
          }}>
            {!reduced && [0, 1].map((k) => (
              <motion.span key={k}
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: [0.92, 1.75], opacity: [0, 0.3, 0] }}
                transition={{ duration: 2.8, repeat: Infinity, ease: 'easeOut', delay: k * 1.4, times: [0, 0.3, 1] }}
                style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(17,17,17,.45)' }} />
            ))}
            <img src="/askine-icon.svg" alt="Askine" style={{ filter: 'invert(1)', width: '44%', height: '44%' }} />
          </div>
          <div style={{ marginTop: 6, fontSize: 'clamp(10px,1.3vw,12px)', color: 'var(--ink-soft)', fontWeight: 600 }}>Askine™</div>
        </motion.div>

        {/* Destinos: ChatGPT e Claude */}
        <div style={{ display: 'grid', gap: 'clamp(12px,4vh,24px)', justifyItems: 'end' }}>
          {DESTS.map((d, i) => (
            <motion.div key={d.name} ref={(el) => { dstRefs.current[i] = el; }}
              animate={reduced ? {} : { y: [0, -3, 0] }} transition={{ duration: 2.6, repeat: Infinity, delay: i * 0.4, ease: 'easeInOut' }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid var(--border)',
                borderRadius: 12, padding: '7px 11px 7px 8px', whiteSpace: 'nowrap'
              }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(0,0,0,.03)', display: 'grid', placeItems: 'center', flex: 'none' }}>{d.logo}</div>
              <div>
                <div style={{ fontSize: 'clamp(11px,1.4vw,13px)', fontWeight: 600, color: 'var(--ink)' }}>{d.name}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'clamp(9px,1.1vw,10.5px)', color: 'var(--ink-soft)' }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: d.dot, display: 'inline-block' }} />tutor ativo
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
