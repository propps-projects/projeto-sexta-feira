import { motion } from 'framer-motion';
import { reveal, stagger, staggerItem, inViewProps } from '../../lib/motion';
import Card from '../ui/Card';
import ProtectedBuyer from './visuals/ProtectedBuyer';
import ProtectedAccess from './visuals/ProtectedAccess';
import ProtectedScale from './visuals/ProtectedScale';

const cards = [
  {
    title: 'Vendeu na Hotmart? Já sabemos quem comprou.',
    body: 'A integração com a hotmart, nos permite identificar instantaneamente quem comprou, quem está ativo e registrar o e-mail/status para autenticação.',
  },
  {
    title: 'Somente aluno pagante e ativo consegue utilizar',
    body: 'O conector da Askine™ só funciona para alunos que possuem e-mail de compra ativo. Deixou de pagar? O tutor dentro do GPT ou Claude para de funcionar na hora.',
  },
  {
    title: 'Um só conector para múltiplos cursos e alunos',
    body: 'Venda quantos cursos, quantas aulas e para quantos alunos quiser. Nossa tecnologia permite que você tenha quantos tutores quiser fazendo o GPT e o Claude trabalharem para você.',
  },
];

export default function Protected() {
  return (
    <section className="container" style={{ textAlign: 'center' }}>
      <motion.h2 variants={reveal} {...inViewProps} style={{ fontSize: 'clamp(30px,4vw,46px)', fontWeight: 600 }}>
        Acesso autenticado. Seu curso protegido.
      </motion.h2>
      <motion.p variants={reveal} {...inViewProps} style={{ color: 'var(--ink-soft)', maxWidth: '46ch', margin: '14px auto 0' }}>
        Seus alunos só conectam seu curso dentro do ChatGPT ou Claude, depois de autenticar
        o e-mail de compra.
      </motion.p>
      <motion.div variants={stagger} {...inViewProps} className="lp-grid-3"
        style={{ marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, textAlign: 'left' }}>
        {cards.map((c, i) => (
          <motion.div key={c.title} variants={staggerItem} style={{ height: '100%', minWidth: 0 }}>
            <Card style={{ display: 'grid', gap: 18, gridTemplateRows: 'auto auto 1fr', height: '100%', minWidth: 0 }}>
              <div style={{ aspectRatio: '16 / 10', minWidth: 0, overflow: 'hidden' }}>{i === 0 ? <ProtectedBuyer /> : i === 1 ? <ProtectedAccess /> : <ProtectedScale />}</div>
              <h3 style={{ fontSize: 20, fontWeight: 600 }}>{c.title}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 15 }}>{c.body}</p>
            </Card>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
