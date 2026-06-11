import { useState } from 'react';
import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import { plans } from '../../data/pricing';
import PillButton from '../ui/PillButton';

function Check({ light }: { light?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={light ? '#fff' : 'var(--ink)'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function Info({ light }: { light?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={light ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)'} strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}

export default function Pricing() {
  const [annual, setAnnual] = useState(false);
  return (
    <section id="planos" className="container" style={{ textAlign: 'center' }}>
      <motion.h2 variants={reveal} {...inViewProps} style={{ fontSize: 'clamp(30px,4vw,46px)', fontWeight: 600 }}>
        Simples como deve ser
      </motion.h2>
      <motion.p variants={reveal} {...inViewProps} style={{ color: 'var(--ink-soft)', marginTop: 10 }}>
        Sem pegadinhas. Cancele quando quiser.
      </motion.p>

      {/* Toggle Mensal / Anual */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: 5, marginTop: 32,
        background: 'rgba(0,0,0,0.04)', borderRadius: 999, border: '1px solid var(--border)' }}>
        {([['Mensal', false], ['Anual', true]] as const).map(([label, val]) => (
          <button key={label} onClick={() => setAnnual(val)}
            style={{ position: 'relative', border: 'none', background: 'transparent', padding: '8px 18px', borderRadius: 999,
              display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, color: annual === val ? 'var(--ink)' : 'var(--ink-soft)' }}>
            {annual === val && <motion.span layoutId="toggle-pill" style={{ position: 'absolute', inset: 0, background: '#fff', borderRadius: 999, boxShadow: 'var(--shadow-soft)', zIndex: 0 }} />}
            <span style={{ position: 'relative', zIndex: 1 }}>{label}</span>
            {label === 'Anual' && (
              <span style={{ position: 'relative', zIndex: 1, fontSize: 12, fontWeight: 700, color: 'var(--green-ink)', background: 'var(--green-bg)', padding: '2px 8px', borderRadius: 999 }}>17% OFF</span>
            )}
          </button>
        ))}
      </div>

      {/* Cards */}
      <div className="lp-grid-3" style={{ marginTop: 48, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, textAlign: 'left', alignItems: 'start' }}>
        {plans.map((p) => {
          const dark = p.variant === 'dark';
          const ink = dark ? '#fff' : 'var(--ink)';
          const soft = dark ? 'rgba(255,255,255,0.6)' : 'var(--ink-soft)';
          return (
            <motion.div key={p.id} variants={reveal} {...inViewProps}
              style={{ position: 'relative', borderRadius: 'var(--radius)', padding: 28, color: ink,
                background: dark ? 'var(--dark)' : 'var(--surface)',
                border: p.variant === 'violet' ? '1.5px solid var(--violet)' : '1px solid var(--border)',
                boxShadow: 'var(--shadow-soft)' }}>
              {p.popular && (
                <span style={{ position: 'absolute', top: 22, right: 22, fontSize: 12, fontWeight: 700,
                  color: 'var(--violet)', background: 'var(--violet-soft)', padding: '4px 10px', borderRadius: 999, border: '1px solid var(--violet)' }}>
                  Mais Popular
                </span>
              )}
              <h3 style={{ fontSize: 20, fontWeight: 600 }}>{p.name}</h3>
              <p style={{ color: soft, fontSize: 14, marginTop: 4 }}>{p.tagline}</p>

              <div style={{ marginTop: 24, minHeight: 92 }}>
                {annual ? (
                  <>
                    <p style={{ color: soft, fontSize: 14 }}>12x de</p>
                    <p style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>{p.anual.installment.replace('12x de ', '')}</p>
                    <p style={{ color: soft, fontSize: 14, marginTop: 6 }}>{p.anual.full}</p>
                    <p style={{ color: soft, fontSize: 13, marginTop: 8 }}>{p.anual.note}</p>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>
                      {p.mensal.price}<span style={{ fontSize: 16, fontWeight: 400, color: soft }}>/mês</span>
                    </p>
                    <p style={{ color: soft, fontSize: 13, marginTop: 10 }}>{p.mensal.note}</p>
                  </>
                )}
              </div>

              <p style={{ fontWeight: 600, margin: '20px 0 12px' }}>Incluso no plano:</p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
                {p.features.map((f) => (
                  <li key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14.5, color: ink }}>
                    <Check light={dark} />
                    <span style={{ flex: 1 }}>{f.label}</span>
                    <span title={f.tooltip}><Info light={dark} /></span>
                  </li>
                ))}
              </ul>

              <div style={{ marginTop: 24 }}>
                <PillButton variant={p.buttonVariant} cta={`experimente-7-dias-${p.id}`} full>
                  Experimente 7 dias grátis
                </PillButton>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
