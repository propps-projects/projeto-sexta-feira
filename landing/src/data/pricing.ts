export type FeatureKey =
  | 'cursos' | 'transcricao' | 'alunos' | 'arquivos' | 'base' | 'tutor'
  | 'hotmart' | 'panda' | 'relatorios' | 'ferramentas';

export interface Feature { key: FeatureKey; label: string; tooltip: string; }
export interface Plan {
  id: 'start' | 'pro' | 'scale';
  name: string;
  tagline: string;
  popular?: boolean;
  variant: 'light' | 'violet' | 'dark';
  buttonVariant: 'muted' | 'violet' | 'light';
  mensal: { price: string; note: string };
  anual: { installment: string; full: string; note: string };
  features: Feature[];
}

const tip: Record<string, string> = {
  cursos: 'Quantidade de cursos que você pode integrar.',
  transcricao: 'Horas de aula transcritas inclusas por mês.',
  alunos: 'Alunos ativos simultâneos com acesso ao tutor.',
  arquivos: 'Espaço para materiais complementares.',
  base: 'Base de conhecimento gerada a partir do seu conteúdo.',
  tutor: 'Tutor nativo dentro do ChatGPT e do Claude.',
  hotmart: 'Liberação automática de acesso via Hotmart.',
  panda: 'Transcrição automática via Panda Video.',
  relatorios: 'Relatórios de uso e insights (em breve).',
  ferramentas: 'Ferramentas interativas dentro do GPT e Claude (em breve).',
};

const baseFeatures = (over: Partial<Record<FeatureKey, string>>): Feature[] => [
  { key: 'cursos', label: over.cursos!, tooltip: tip.cursos },
  { key: 'transcricao', label: over.transcricao!, tooltip: tip.transcricao },
  { key: 'alunos', label: over.alunos!, tooltip: tip.alunos },
  { key: 'arquivos', label: over.arquivos!, tooltip: tip.arquivos },
  { key: 'base', label: 'Base de conhecimento integrada', tooltip: tip.base },
  { key: 'tutor', label: 'Tutor nativo Askine™', tooltip: tip.tutor },
  { key: 'hotmart', label: 'Integração com Hotmart', tooltip: tip.hotmart },
  { key: 'panda', label: 'Integração com Panda Video', tooltip: tip.panda },
];

const extras: Feature[] = [
  { key: 'relatorios', label: 'Relatórios de insights (em breve)', tooltip: tip.relatorios },
  { key: 'ferramentas', label: 'Ferramentas Interativas dentro do GPT e Claude (em breve)', tooltip: tip.ferramentas },
];

export const plans: Plan[] = [
  {
    id: 'start', name: 'Plano Start', tagline: 'Ideal para Low-tickets',
    variant: 'light', buttonVariant: 'muted',
    mensal: { price: 'R$ 147', note: 'cobrado mensalmente' },
    anual: { installment: '12x de R$ 142', full: 'ou R$ 1.470 à vista', note: 'cobrado anualmente' },
    features: baseFeatures({ cursos: '01 curso', transcricao: '25h de transcrição/mês', alunos: '500 alunos ativos', arquivos: '100 MB de arquivos' }),
  },
  {
    id: 'pro', name: 'Plano Pro', tagline: 'Ideal para quem busca equilibrio', popular: true,
    variant: 'violet', buttonVariant: 'violet',
    mensal: { price: 'R$ 297', note: 'cobrado mensalmente' },
    anual: { installment: '12x de R$ 286', full: 'ou R$ 2.970 à vista', note: 'cobrado anualmente' },
    features: [...baseFeatures({ cursos: '03 cursos', transcricao: '50h de transcrição/mês', alunos: '1.000 alunos ativos', arquivos: '500 MB de arquivos' }), ...extras],
  },
  {
    id: 'scale', name: 'Plano Scale', tagline: 'Ideal para quem está escalando',
    variant: 'dark', buttonVariant: 'light',
    mensal: { price: 'R$ 497', note: 'cobrado mensalmente' },
    anual: { installment: '12x de R$ 478', full: 'ou R$ 4.970 à vista', note: 'cobrado anualmente' },
    features: [...baseFeatures({ cursos: '10 cursos', transcricao: '90h de transcrição/mês', alunos: '2.500 alunos ativos', arquivos: '2 GB de arquivos' }), ...extras],
  },
];
