import { useReducedMotion } from 'framer-motion';

/**
 * Visual do card 3 da seção Protected ("Um só conector para múltiplos cursos e
 * alunos"). Uma ramificação sai da Askine para vários cursos. Caixa fixa.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const COURSES = ['Marketing para SaaS', 'Inglês Facilitado', 'Tráfego Direto', '+ Múltiplos cursos'];
const Y = [15, 38, 62, 85]; // posição vertical (%) de cada nó-curso

export default function ProtectedScale() {
  const reduced = useReducedMotion();

  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative', overflow: 'hidden', fontFamily: SANS, color: 'var(--ink)',
      background: '#eceae4', border: '1px solid var(--border)', borderRadius: 14
    }}>

      {/* ramificações Askine → cursos */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        {/* chips alinhados pela esquerda (50%) → toda linha conecta no centro-esquerda do chip */}
        {Y.map((y, i) => (
          <path key={i} d={`M22 50 C 40 50, 45 ${y}, 49 ${y}`} fill="none" stroke="rgba(0,0,0,.2)" strokeWidth="0.5" strokeDasharray="1.4 2.2" strokeLinecap="round">
            {!reduced && <animate attributeName="stroke-dashoffset" values="0;-3.6" dur="0.9s" repeatCount="indefinite" />}
          </path>
        ))}
      </svg>

      {/* nó Askine */}
      <div style={{ position: 'absolute', left: '15%', top: '55%', transform: 'translate(-50%,-50%)', display: 'grid', justifyItems: 'center', gap: 5, zIndex: 1 }}>
        <div style={{ width: 'clamp(38px,11vw,50px)', aspectRatio: '1', borderRadius: '30%', background: '#111', display: 'grid', placeItems: 'center' }}>
          <img src="/askine-icon.svg" alt="Askine" style={{ filter: 'invert(1)', width: '46%', height: '46%' }} />
        </div>
        <span style={{ fontSize: 'clamp(8px,2.2vw,10px)', color: 'var(--ink-soft)', fontWeight: 600, whiteSpace: 'nowrap' }}>1 conector</span>
      </div>

      {/* nós-curso */}
      {COURSES.map((c, i) => {
        const more = i === COURSES.length - 1;
        return (
          <div key={c} style={{ position: 'absolute', left: '50%', top: `${Y[i]}%`, transform: 'translateY(-50%)', zIndex: 1, maxWidth: '46%' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'clamp(9px,2.4vw,12px)', fontWeight: more ? 600 : 500,
              color: more ? 'var(--ink-soft)' : 'var(--ink)', background: more ? 'rgba(0,0,0,.04)' : '#fff',
              border: more ? '1px dashed var(--border)' : '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden'
            }}>
              {!more && <span style={{ width: 6, height: 6, borderRadius: 2, background: '#111', flex: 'none' }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
