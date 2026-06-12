import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GptLogo, ClaudeLogo } from './logos';

/**
 * Visual da 2ª feature (Um Lugar Só): janela de navegador (estilo macOS) com as
 * abas do ChatGPT e do Claude abertas. O tutor Askine vive dentro da aba — o
 * aluno não troca de aba nem de plataforma. A aba ativa alterna GPT↔Claude.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const SERIF = "'Tiempos Text', Georgia, 'Times New Roman', Times, serif";

const TABS = [
  { id: 'gpt', name: 'ChatGPT', url: 'chatgpt.com', Logo: GptLogo },
  { id: 'claude', name: 'Claude', url: 'claude.ai', Logo: ClaudeLogo },
] as const;

// tema da conversa por provider (igual ao Hero): GPT = sans/branco, Claude = serif/quente
const THEME = {
  gpt: { font: SANS, Logo: GptLogo, pageBg: '#ffffff', bubble: '#f4f4f4' },
  claude: { font: SERIF, Logo: ClaudeLogo, pageBg: '#faf9f5', bubble: '#ffffff' },
} as const;

function Chevron({ dir }: { dir: 'l' | 'r' }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,.32)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'l' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

export default function FeatureOnePlace() {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<'gpt' | 'claude'>('gpt');
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setActive((a) => (a === 'gpt' ? 'claude' : 'gpt')), 3600);
    return () => clearInterval(t);
  }, [reduced]);
  const cur = TABS.find((t) => t.id === active)!;
  const th = THEME[active];

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden', fontFamily: SANS, color: 'var(--ink)',
      background: '#eceae4', borderRadius: 14, border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Toolbar: semáforo + navegação + barra de endereço */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(8px,1.6vw,14px)', padding: '11px 14px',
        background: '#f6f6f6', borderBottom: '1px solid rgba(0,0,0,.07)' }}>
        <div style={{ display: 'flex', gap: 7, flex: 'none' }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c }} />)}
        </div>
        <div style={{ display: 'flex', gap: 4, flex: 'none' }}><Chevron dir="l" /><Chevron dir="r" /></div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, background: '#fff',
          border: '1px solid rgba(0,0,0,.08)', borderRadius: 8, padding: '5px 12px', fontSize: 'clamp(10px,1.3vw,12.5px)', color: 'var(--ink-soft)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,.4)" strokeWidth="2"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          <motion.span key={cur.url} initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur.url}</motion.span>
        </div>
      </div>

      {/* Faixa de abas */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, padding: '6px 8px 0', background: '#f6f6f6', borderBottom: '1px solid rgba(0,0,0,.07)' }}>
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <div key={t.id} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '8px 14px', borderRadius: '9px 9px 0 0', fontSize: 'clamp(10px,1.4vw,13px)', fontWeight: on ? 600 : 500,
              color: on ? 'var(--ink)' : 'var(--ink-soft)', background: on ? '#fff' : 'transparent',
              border: on ? '1px solid rgba(0,0,0,.07)' : '1px solid transparent', borderBottom: 'none',
              transition: 'background .25s, color .25s', whiteSpace: 'nowrap' }}>
              <t.Logo s={15} />{t.name}
              {on && <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 2, background: '#fff' }} />}
            </div>
          );
        })}
        <div style={{ display: 'grid', placeItems: 'center', width: 26, height: 26, marginLeft: 4, marginBottom: 4,
          color: 'var(--ink-soft)', fontSize: 18, lineHeight: 1 }}>+</div>
      </div>

      {/* Página: a conversa tem a cara do provider ativo (GPT/Claude), como no Hero */}
      <AnimatePresence mode="wait">
      <motion.div key={active} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: 'easeInOut' }}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14,
          padding: 'clamp(16px,3.4vw,30px)', background: th.pageBg, fontFamily: th.font }}>
        <div style={{ alignSelf: 'flex-end', display: 'flex', gap: 9, alignItems: 'flex-start', maxWidth: '86%' }}>
          <div style={{ background: th.bubble, border: '1px solid var(--border)', borderRadius: 18, padding: '9px 14px', fontSize: 'clamp(12px,1.5vw,14px)', lineHeight: 1.45 }}>
            Posso continuar de onde parei?
          </div>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#2d2d2d', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 600, flex: 'none' }}>A</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', maxWidth: '94%' }}>
          <div style={{ flex: 'none', marginTop: 1 }}><th.Logo s={22} /></div>
          <div style={{ fontSize: 'clamp(12px,1.5vw,14px)', lineHeight: 1.55 }}>
            Claro — você parou na <strong>Aula 03</strong>. Seguimos <strong>aqui mesmo</strong>, sem abrir outra plataforma.
          </div>
        </div>
      </motion.div>
      </AnimatePresence>
    </div>
  );
}
