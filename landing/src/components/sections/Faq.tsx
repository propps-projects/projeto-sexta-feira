import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import PillButton from '../ui/PillButton';
import ContactModal from '../ui/ContactModal';

const faqs = [
  { q: 'Preciso entender de tecnologia?', a: 'Não. Você conecta a Hotmart e o PandaVideo de forma simples e a Askine™ faz o resto.' },
  { q: 'Como meus alunos ganham acesso?', a: 'Você pode importar alunos via CSV ou integrar a Hotmart e quem compra é liberado automaticamente.' },
  { q: 'E quem pede reembolso ou cancela?', a: 'Conseguimos identificar pela integração com a Hotmart e o acesso do ChatGPT ou Claude do seu aluno ao seu curso é revogado sozinho, sem você precisar fazer nada.' },
  { q: 'Meus alunos precisam pagar ChatGPT ou Claude?', a: 'Eles usam a conta que já têm (provavelmente eles já pagam algum plano) — não há custo extra de IA pra você.' },
  { q: 'O ChatGPT e o Claude inventam respostas?', a: 'Não. A Askine™ garante que toda a base de conhecimento do seu curso será consultada pelo GPT e Claude, respondendo tudo com base nas suas aulas, não em achismo.' },
  { q: 'Só tem integração com Hotmart e Panda Video?', a: 'Por enquanto sim! Já estamos em tratativas para integrar outros gateways de pagamento e outras hospedagens de vídeos mais comuns em infoprodutos. Se quiser sugerir plataformas, envie sua solicitação para box@askine.cc.' },
  { q: 'Posso ter quantos cursos, aulas e alunos?', a: 'Sim. Só escolher o plano adequado, e se quiser, depois de assinar qualquer plano, você pode adquirir mais recursos para seu plano. Exemplo: você pode adicionar mais cursos, mais horas de transcrição, mais alunos ativos ou mais memória de armazenamento de arquivos com pequenos acréscimos no seu plano.' },
  { q: 'A Askine™ é segura?', a: 'Sim. Seguimos estritamente todas as regras de segurança e privacidade exigidas pelo Claude, OpenAI e LGPD, ou seja, seu conteúdo está seguro.' },
  { q: 'Qualquer pessoa que tenha acesso ao ChatGPT ou Claude podem consumir meu curso?', a: 'Não. O conector Askine™ precisa autenticar o aluno através de um login mágico dentro do ChatGPT ou Claude, ou seja, usamos o e-mail de compra do seu aluno, realizado na Hotmart, para autorizar o GPT e o Claude a acessar o conteúdo do seu curso e interagir com seu aluno.' },
  { q: 'Nenhum plano comporta meu curso, e agora?', a: 'Podemos personalizar um plano para você! Fale com nosso time de vendas em sales@askine.cc com o assunto: Plano Personalizado.' },
];

function Item({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{
          width: '100%', background: 'transparent', border: 'none', padding: '22px 0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', fontSize: 19, fontWeight: 600, color: 'var(--ink)'
        }}>
        {q}
        <motion.span animate={{ rotate: open ? 180 : 0 }} aria-hidden>⌄</motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden' }}>
            <p style={{ color: 'var(--ink-soft)', paddingBottom: 22, maxWidth: '70ch' }}>{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const [contactOpen, setContactOpen] = useState(false);
  return (
    <section className="container" style={{ maxWidth: 920 }}>
      <motion.h2 variants={reveal} {...inViewProps} style={{ fontSize: 'clamp(32px,4.4vw,52px)', fontWeight: 700, textAlign: 'center', marginBottom: 40 }}>
        Perguntas Frequentes
      </motion.h2>
      <div>
        {faqs.map((f, i) => (
          <Item
            key={f.q}
            q={f.q}
            a={f.a}
            open={openIndex === i}
            onToggle={() => setOpenIndex((cur) => (cur === i ? null : i))}
          />
        ))}
      </div>
      <motion.div variants={reveal} {...inViewProps}
        style={{ marginTop: 48, background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-soft)', padding: 40, textAlign: 'center' }}>
        <h3 style={{ fontSize: 26, fontWeight: 600 }}>Ainda com dúvidas?</h3>
        <p style={{ color: 'var(--ink-soft)', margin: '8px 0 22px' }}>Fale com o nosso time agora mesmo.</p>
        <PillButton variant="dark" onClick={() => setContactOpen(true)} cta="falar-com-askine">Falar com Askine™</PillButton>
      </motion.div>
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </section>
  );
}
