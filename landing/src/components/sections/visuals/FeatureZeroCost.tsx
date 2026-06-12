import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual da 4ª feature (Sem Custo Extra): medidor de custo.
 * O uso de IA do aluno sobe (tokens), mas o custo do criador fica travado em
 * R$ 0,00. Sem servidor, sem plataforma própria — a Askine cuida da técnica.
 * A caixa é fixa; só o conteúdo interno anima.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function XIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
function Check() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>;
}

export default function FeatureZeroCost() {
  const reduced = useReducedMotion();
  const [tokens, setTokens] = useState(1284);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setTokens((v) => (v > 9200 ? 1200 + Math.floor(Math.random() * 300) : v + 7 + Math.floor(Math.random() * 38))), 150);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden', fontFamily: SANS, color: 'var(--ink)',
      background: '#ffffff', border: '1px solid var(--border)', borderRadius: 16,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 'clamp(12px,2.6vw,20px)', padding: 'clamp(18px,3.8vw,30px)'
    }}>

      {/* uso de IA do aluno */}
      <div style={{ display: 'grid', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'clamp(11px,1.4vw,13px)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-soft)' }}>
            {!reduced && <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />}
            uso de IA do aluno
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {tokens.toLocaleString('pt-BR')} tokens
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </span>
        </div>
        <div style={{ height: 8, borderRadius: 999, background: 'rgba(0,0,0,.06)', overflow: 'hidden' }}>
          <motion.div
            animate={reduced ? {} : { width: ['52%', '92%', '52%'] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            style={{ height: '100%', width: '72%', borderRadius: 999, background: 'linear-gradient(90deg,#111,#3a3a3a)' }} />
        </div>
      </div>

      {/* mensagem-chave: o aluno não paga por token, e sim o plano que já usa */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'clamp(7px,1.5vw,10px)', flexWrap: 'wrap',
        background: 'rgba(0,0,0,.025)', border: '1px solid var(--border)', borderRadius: 10, padding: 'clamp(8px,1.8vw,11px) clamp(10px,2vw,13px)'
      }}>
        <span style={{ fontSize: 'clamp(11px,1.4vw,13px)', lineHeight: 1.45 }}>
          <strong>O aluno não paga por token</strong> — usa o plano que já assina:
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fff', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 8px', fontSize: 'clamp(10px,1.25vw,12px)', fontWeight: 600 }}><GptLogo s={14} />ChatGPT</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fff', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 8px', fontSize: 'clamp(10px,1.25vw,12px)', fontWeight: 600 }}><ClaudeLogo s={14} />Claude</span>
        </span>
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      {/* seu custo: R$ 0,00 */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 'clamp(11px,1.4vw,13px)', color: 'var(--ink-soft)', marginBottom: 2 }}>seu custo de tokens</div>
          <div style={{ fontSize: 'clamp(30px,5vw,46px)', fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em' }}>R$ 0,00</div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'clamp(10px,1.3vw,12px)', fontWeight: 600,
          color: '#16a34a', background: 'rgba(22,163,74,.1)', border: '1px solid rgba(22,163,74,.25)', borderRadius: 999, padding: '4px 10px'
        }}>
          <Check /> incluso no plano
        </span>
      </div>

      {/* o que você não precisa */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'clamp(8px,1.8vw,14px)', fontSize: 'clamp(10px,1.3vw,12px)', color: 'var(--ink-soft)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><XIcon /> servidor próprio</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><XIcon /> plataforma própria</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Check /> Askine cuida da técnica</span>
      </div>
    </div>
  );
}
