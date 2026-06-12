import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/**
 * Visual do card 1 da seção Protected ("Vendeu na Hotmart? Já sabemos quem
 * comprou"). Sequência em loop: 1) notificação de venda da Hotmart →
 * 2) e-mail validado → 3) acesso liberado. Caixa fixa; só o conteúdo anima.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function HotmartMark({ s = 18, color = '#fff' }: { s?: number; color?: string }) {
  return (
    <svg width={s} height={s} viewBox="0 0 150 150" aria-hidden>
      <path fill={color} d="M109.02,37.91c-.26-.41-.73-.25-.61,.18,.66,2.4,.82,6.73-2.99,6.47-6.76-.45,.23-14.91-14.61-24.93-.3-.2-.65,.07-.49,.39,1.02,1.94,1.62,7.96-.73,10.02-1.88,1.65-5.35,1.21-8.67-4.22-5.54-9.05-3.44-18.72,.33-24.76,.28-.45-.1-.64-.43-.53-20.41,6.73-24.48,30.78-28.82,39.56-.73,1.46-1.36,2.23-2.61,2.15-3.72-.25-1.04-8.18,.25-10.96,.09-.14,.07-.33-.08-.42-.14-.1-.33-.07-.42,.07-10.49,10.94-19.99,29.62-21.82,46.98,0,0-.18,1.64-.28,2.85-.04,.53-.08,1.06-.11,1.59,0,.64-.06,1.27-.07,1.91,.02,26.36,21.41,47.71,47.77,47.68,26.01-.02,47.22-20.88,47.68-46.9,.02-.12,.01-.27,.01-.41,.6-11.76-3.43-31-13.3-46.74Zm-34.6,68.91h0c-12.23-.09-22.06-10.09-21.95-22.31,.1-12.23,10.09-22.06,22.32-21.95,12.23,.1,22.06,10.09,21.95,22.32-.1,12.23-10.1,22.05-22.33,21.95Z" />
    </svg>
  );
}
function Check({ c = '#16a34a' }: { c?: string }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>;
}

const stepStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, background: '#fff', border: '1px solid var(--border)',
  borderRadius: 10, padding: '8px 11px',
};

export default function ProtectedBuyer() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(reduced ? 2 : 0);

  useEffect(() => {
    if (reduced) { setStep(2); return; }
    const t = setInterval(() => setStep((s) => (s + 1) % 3), 2500);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden', fontFamily: SANS, color: 'var(--ink)',
      background: '#eceae4', border: '1px solid var(--border)', borderRadius: 14,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 'clamp(12px,5%,20px)'
    }}>
      <AnimatePresence mode="wait">
        <motion.div key={step}
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          style={{ width: '100%' }}>

          {/* 1 — notificação Hotmart (estilo push) */}
          {step === 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, background: 'linear-gradient(180deg,#262624,#1b1b1a)',
              borderRadius: 12, padding: '10px 12px', color: '#fff'
            }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: '#f04e23', display: 'grid', placeItems: 'center', flex: 'none' }}><HotmartMark s={24} /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 'clamp(11px,3.1vw,13px)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Venda realizada com Pix</div>
                <div style={{ fontSize: 'clamp(9px,2.6vw,11px)', color: 'rgba(255,255,255,.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sua comissão: R$ 397,00 · HP00000009</div>
              </div>
              <span style={{ fontSize: 'clamp(8px,2.4vw,10px)', color: 'rgba(255,255,255,.45)', flex: 'none' }}>agora</span>
            </div>
          )}

          {/* 2 — e-mail validado */}
          {step === 1 && (
            <div style={stepStyle}>
              <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: '50%', background: 'rgba(22,163,74,.12)', flex: 'none' }}><Check /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 'clamp(11px,3vw,12.5px)', fontWeight: 600 }}>E-mail validado</div>
                <div style={{ fontSize: 'clamp(9px,2.6vw,11px)', color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>joao@email.com</div>
              </div>
            </div>
          )}

          {/* 3 — acesso liberado */}
          {step === 2 && (
            <div style={{ ...stepStyle, borderColor: 'rgba(22,163,74,.4)', background: 'rgba(255, 255, 255, 0.86)' }}>
              <span style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: '30%', background: '#111', flex: 'none' }}>
                <img src="/askine-icon.svg" alt="Askine" style={{ filter: 'invert(1)', width: '45%', height: '45%' }} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 'clamp(11px,3vw,12.5px)', fontWeight: 600 }}>Acesso liberado</div>
                <div style={{ fontSize: 'clamp(9px,2.6vw,11px)', color: 'var(--ink-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Curso no ChatGPT e Claude ativo</div>
              </div>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
