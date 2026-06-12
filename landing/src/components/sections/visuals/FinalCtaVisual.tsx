import { motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual do CTA final (painel escuro). Fluxo: Askine (topo) → Seu curso (meio)
 * → dentro do ChatGPT e Claude (base). Caixa fixa; só o conteúdo anima.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function ToolBadge({ children, name }: { children: React.ReactNode; name: string }) {
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 5 }}>
      <div style={{ width: 'clamp(34px,8vw,44px)', aspectRatio: '1', borderRadius: 11, background: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 6px 18px rgba(0,0,0,.35)' }}>
        {children}
      </div>
      <span style={{ fontSize: 'clamp(8px,2vw,10px)', color: 'rgba(255,255,255,.55)', fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</span>
    </div>
  );
}

export default function FinalCtaVisual() {
  const reduced = useReducedMotion();
  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative', overflow: 'hidden', fontFamily: SANS, borderRadius: 16,
      background: 'radial-gradient(120% 90% at 50% 12%, #2a2a28 0%, #1b1b1a 55%, #141413 100%)', border: '1px solid rgba(255,255,255,.07)'
    }}>

      {/* linhas: Askine → Seu curso → ChatGPT/Claude */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {['M50 25 L50 47', 'M50 47 C 46 62, 40 70, 33 75', 'M50 47 C 54 62, 60 70, 67 75'].map((d, i) => (
          <path key={i} d={d} fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="0.6" strokeDasharray="1.6 2.4" strokeLinecap="round">
            {!reduced && <animate attributeName="stroke-dashoffset" values="0;-4" dur="0.9s" repeatCount="indefinite" />}
          </path>
        ))}
      </svg>

      {/* Askine (topo) — posição no div estático; scale no motion interno */}
      <div style={{ position: 'absolute', left: '50%', top: '15%', transform: 'translate(-50%,-50%)', zIndex: 1 }}>
        <motion.div
          animate={reduced ? {} : { scale: [1, 1.07, 1] }} transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            width: 'clamp(38px,9vw,50px)', aspectRatio: '1', borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center',
            boxShadow: '0 0 0 6px rgba(255,255,255,.06), 0 10px 30px rgba(0,0,0,.4)'
          }}>
          <img src="/askine-icon.svg" alt="Askine" style={{ width: '46%', height: '46%' }} />
        </motion.div>
      </div>
      {/* rótulo ao lado do ícone (não desloca o ícone → linha continua alinhada) */}
      <div style={{
        position: 'absolute', left: '51.5%', top: '15%', transform: 'translate(30px,-50%)', zIndex: 1,
        fontSize: 'clamp(10px,2.4vw,12.5px)', fontWeight: 600, color: 'rgba(255,255,255,.88)', whiteSpace: 'nowrap'
      }}>Askine™</div>

      {/* Seu curso (meio, com glow) */}
      <motion.div
        animate={reduced ? {} : { boxShadow: ['0 0 18px rgba(217,119,87,.22)', '0 0 30px rgba(217,119,87,.42)', '0 0 18px rgba(217,119,87,.22)'] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        style={{
          position: 'absolute', left: '50%', top: '47%', transform: 'translate(-50%,-50%)', zIndex: 1, maxWidth: '82%',
          display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
          background: 'linear-gradient(180deg,#2e2e2c,#232321)', border: '1px solid rgba(255,255,255,.16)', borderRadius: 12, padding: '9px 14px'
        }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97757" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" /></svg>
        <span style={{ fontSize: 'clamp(12px,3vw,15px)', fontWeight: 600, color: '#fff' }}>Seu curso</span>
      </motion.div>

      {/* ChatGPT + Claude (base) */}
      <div style={{ position: 'absolute', left: '33%', top: '80%', transform: 'translate(-50%,-50%)', zIndex: 1 }}>
        <ToolBadge name="ChatGPT"><GptLogo s={24} /></ToolBadge>
      </div>
      <div style={{ position: 'absolute', left: '67%', top: '80%', transform: 'translate(-50%,-50%)', zIndex: 1 }}>
        <ToolBadge name="Claude"><ClaudeLogo s={24} /></ToolBadge>
      </div>
    </div>
  );
}
