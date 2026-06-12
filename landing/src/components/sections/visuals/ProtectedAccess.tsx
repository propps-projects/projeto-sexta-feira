import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual do card 2 da seção Protected ("Somente aluno pagante e ativo consegue
 * utilizar"). Um interruptor de pagamento liga/desliga o tutor: ativo → tutor
 * liberado; inadimplente → bloqueado na hora (logos do GPT/Claude apagam).
 * Caixa fixa; só o conteúdo anima.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function Lock({ open, c }: { open: boolean; c: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      {open ? <path d="M8 11V8a4 4 0 0 1 7-2.6" /> : <path d="M8 11V8a4 4 0 0 1 8 0v3" />}
    </svg>
  );
}

export default function ProtectedAccess() {
  const reduced = useReducedMotion();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setOn((o) => !o), 2700);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden', fontFamily: SANS, color: 'var(--ink)',
      background: '#eceae4', border: '1px solid var(--border)', borderRadius: 14,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 'clamp(9px,2.6vh,14px)', padding: 'clamp(12px,5%,20px)'
    }}>

      {/* aluno + status do pagamento */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#0891b2', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, flex: 'none' }}>AC</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 'clamp(11px,3vw,13px)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Ana Costa</div>
          <div style={{ fontSize: 'clamp(9px,2.6vw,11px)', color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>ana@email.com</div>
        </div>
        {/* interruptor de pagamento */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
          <span style={{ fontSize: 'clamp(9px,2.5vw,11px)', fontWeight: 600, color: on ? '#16a34a' : '#ef4444' }}>{on ? 'pagamento ativo' : 'inadimplente'}</span>
          <div style={{ width: 36, height: 21, borderRadius: 999, padding: 2, background: on ? '#16a34a' : 'rgba(0,0,0,.2)', transition: 'background .3s', flex: 'none' }}>
            <motion.div animate={{ x: on ? 15 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              style={{ width: 17, height: 17, borderRadius: '50%', background: '#fff' }} />
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: 'var(--border)' }} />

      {/* estado do tutor no GPT/Claude */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', filter: on ? 'none' : 'grayscale(1)', opacity: on ? 1 : 0.4, transition: 'opacity .3s, filter .3s' }}>
          <GptLogo s={20} /><ClaudeLogo s={20} />
        </span>
        <span style={{ fontSize: 'clamp(10px,2.7vw,11px)', color: 'var(--ink-soft)', flex: 1, minWidth: 0 }}>Seu curso no ChatGPT e Claude</span>
        <AnimatePresence mode="wait">
          <motion.span key={on ? 'on' : 'off'}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.25 }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'clamp(9px,2.6vw,11px)', fontWeight: 600, flex: 'none',
              color: on ? '#16a34a' : '#ef4444', background: on ? 'rgba(22,163,74,.1)' : 'rgba(239,68,68,.1)',
              border: `1px solid ${on ? 'rgba(22,163,74,.28)' : 'rgba(239,68,68,.28)'}`, borderRadius: 999, padding: '3px 9px'
            }}>
            <Lock open={on} c={on ? '#16a34a' : '#ef4444'} />{on ? 'Liberado' : 'Bloqueado'}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
