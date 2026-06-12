import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Modal de contato "Falar com Askine™". Coleta nome, e-mail, assunto e mensagem
 * e envia para o backend (POST /contato), que dispara o e-mail via Brevo.
 * Overlay fixo cobre a viewport; fecha com Esc, clique no backdrop ou no X.
 */

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

type Status = 'idle' | 'sending' | 'ok' | 'error';

const field: React.CSSProperties = {
  width: '100%', fontFamily: SANS, fontSize: 15, padding: '11px 13px',
  border: '1px solid var(--border)', borderRadius: 12, background: '#fff', color: 'var(--ink)',
  outline: 'none', transition: 'border-color .15s',
};
const labelStyle: React.CSSProperties = { display: 'block', fontFamily: SANS, fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', margin: '0 0 6px' };

export default function ContactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<Status>('idle');
  const [errMsg, setErrMsg] = useState('');
  const firstRef = useRef<HTMLInputElement>(null);

  // Esc fecha; trava o scroll do body enquanto aberto; foca o 1º campo.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => firstRef.current?.focus(), 60);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; clearTimeout(t); };
  }, [open, onClose]);

  // Reseta o estado ao reabrir.
  useEffect(() => { if (open) { setStatus('idle'); setErrMsg(''); } }, [open]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'sending') return;
    const fd = new FormData(e.currentTarget);
    const payload = {
      nome: String(fd.get('nome') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      assunto: String(fd.get('assunto') ?? '').trim(),
      mensagem: String(fd.get('mensagem') ?? '').trim(),
    };
    setStatus('sending'); setErrMsg('');
    try {
      const res = await fetch('/contato', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Falha no envio');
      setStatus('ok');
    } catch (err) {
      setStatus('error');
      setErrMsg(err instanceof Error ? err.message : 'Algo deu errado');
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 20,
            background: 'rgba(20,18,14,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
          }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }}
            role="dialog" aria-modal="true" aria-label="Falar com Askine"
            style={{
              width: '100%', maxWidth: 460, background: 'var(--surface)', borderRadius: 22,
              boxShadow: '0 24px 60px rgba(0,0,0,0.28)', padding: 'clamp(24px,4vw,34px)', position: 'relative',
            }}>

            <button onClick={onClose} aria-label="Fechar"
              style={{
                position: 'absolute', top: 16, right: 16, width: 34, height: 34, borderRadius: '50%',
                border: 'none', background: 'rgba(0,0,0,.04)', display: 'grid', placeItems: 'center', color: 'var(--ink-soft)',
              }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>

            {status === 'ok' ? (
              <div style={{ textAlign: 'center', padding: '12px 0' }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--green-bg)', display: 'grid', placeItems: 'center', margin: '0 auto 18px' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--green-ink)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </div>
                <h3 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Mensagem enviada!</h3>
                <p style={{ fontFamily: SANS, color: 'var(--ink-soft)', fontSize: 15, marginBottom: 22 }}>
                  Recebemos seu contato e respondemos em breve no e‑mail informado.
                </p>
                <button onClick={onClose}
                  style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, padding: '11px 22px', border: 'none', borderRadius: 999, background: '#111', color: '#fff', cursor: 'pointer' }}>
                  Fechar
                </button>
              </div>
            ) : (
              <>
                <h3 style={{ fontSize: 'clamp(22px,3vw,26px)', fontWeight: 700, marginBottom: 6 }}>Falar com Askine™</h3>
                <p style={{ fontFamily: SANS, color: 'var(--ink-soft)', fontSize: 14.5, marginBottom: 22 }}>
                  Conte sua dúvida que nosso time responde no seu e‑mail.
                </p>

                {status === 'error' && (
                  <div style={{ fontFamily: SANS, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 13, padding: '10px 12px', borderRadius: 10, marginBottom: 16 }}>
                    Não foi possível enviar agora{errMsg ? `: ${errMsg}` : ''}. Tente novamente.
                  </div>
                )}

                <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }}>
                  <div>
                    <label style={labelStyle} htmlFor="cm-nome">Nome</label>
                    <input ref={firstRef} id="cm-nome" name="nome" required maxLength={120} placeholder="Seu nome" style={field} />
                  </div>
                  <div>
                    <label style={labelStyle} htmlFor="cm-email">E‑mail</label>
                    <input id="cm-email" name="email" type="email" required maxLength={160} placeholder="voce@exemplo.com" autoComplete="email" style={field} />
                  </div>
                  <div>
                    <label style={labelStyle} htmlFor="cm-assunto">Assunto</label>
                    <input id="cm-assunto" name="assunto" required maxLength={140} placeholder="Sobre o que você quer falar?" style={field} />
                  </div>
                  <div>
                    <label style={labelStyle} htmlFor="cm-mensagem">Mensagem</label>
                    <textarea id="cm-mensagem" name="mensagem" required maxLength={2000} rows={4} placeholder="Escreva sua mensagem..." style={{ ...field, resize: 'vertical', minHeight: 96 }} />
                  </div>
                  <motion.button type="submit" disabled={status === 'sending'}
                    whileHover={status === 'sending' ? undefined : { scale: 1.02 }} whileTap={status === 'sending' ? undefined : { scale: 0.97 }}
                    style={{
                      fontFamily: SANS, fontSize: 16, fontWeight: 700, marginTop: 4, padding: '13px 22px', border: 'none',
                      borderRadius: 999, background: '#111', color: '#fff', cursor: status === 'sending' ? 'wait' : 'pointer',
                      opacity: status === 'sending' ? 0.7 : 1,
                    }}>
                    {status === 'sending' ? 'Enviando...' : 'Enviar mensagem'}
                  </motion.button>
                </form>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
