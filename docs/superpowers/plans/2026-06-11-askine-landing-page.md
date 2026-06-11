# Askine.cc Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a landing page estática da Askine.cc, fiel às imagens em `base-lp/`, usando Astro + React (islands) + Framer Motion + fonte Aleo, com uma seção por arquivo em `landing/`.

**Architecture:** Astro gera site estático (`output: 'static'`). Cada seção é um componente React hidratado como island (`client:load` no Nav, `client:visible` nas seções animadas, estático no Footer). Framer Motion faz reveals/stagger/toggle/accordion, respeitando `prefers-reduced-motion`. Primitivos de UI e dados de pricing são compartilhados; copy literal das imagens centralizada nos próprios componentes.

**Tech Stack:** Astro 5, @astrojs/react, React 18, framer-motion, @fontsource/aleo, TypeScript, CSS custom properties.

---

## Nota sobre verificação (ler antes de executar)

Este é um projeto de **UI visual**. Não há lógica de domínio para TDD por teste unitário — escrever testes de asserção sobre markup seria teatro. O **critério de verdade de cada task** é:

1. **`npm run build`** passa (Astro compila + typecheck das islands sem erro).
2. **`npm run dev`** roda e a seção renderiza **fiel à imagem de referência** (`base-lp/section-NN.png`), conferida visualmente.
3. **Commit** após cada seção verde.

Onde houver lógica real (toggle mensal/anual trocando preços; accordion abrindo/fechando), há um passo de verificação comportamental explícito no navegador.

A referência visual de cada seção está em `base-lp/`. Recortes auxiliares de seções densas podem ser gerados com System.Drawing (PowerShell) se necessário.

---

## File Structure

```
landing/
  package.json                 # deps + scripts (dev/build/preview)
  astro.config.mjs             # integração React, output static
  tsconfig.json                # strict, jsx react
  public/favicon.svg           # ícone Askine (⬤)
  src/
    pages/index.astro          # monta seções 01→09 na ordem
    layouts/Base.astro         # <head>, import Aleo, tokens, <slot/>
    styles/tokens.css          # design tokens (CSS vars) + reset leve
    lib/motion.ts              # variantes Framer + hook reduced-motion
    data/pricing.ts            # planos × {mensal, anual} + features
    components/
      ui/
        Badge.tsx
        PillButton.tsx
        ArrowLink.tsx
        Placeholder.tsx
        Card.tsx
      sections/
        Nav.tsx
        Hero.tsx
        Features.tsx
        HowItWorks.tsx
        Protected.tsx
        Smarter.tsx
        Pricing.tsx
        Faq.tsx
        FinalCta.tsx
        Footer.tsx
```

---

### Task 1: Scaffold do projeto Astro + React em `landing/`

**Files:**
- Create: `landing/package.json`
- Create: `landing/astro.config.mjs`
- Create: `landing/tsconfig.json`

- [ ] **Step 1: Criar `landing/package.json`**

```json
{
  "name": "askine-landing",
  "type": "module",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "astro": "astro"
  },
  "dependencies": {
    "@astrojs/react": "^4.2.0",
    "@fontsource/aleo": "^5.0.0",
    "astro": "^5.5.0",
    "framer-motion": "^11.15.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Criar `landing/astro.config.mjs`**

```js
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  output: 'static',
  integrations: [react()],
});
```

- [ ] **Step 3: Criar `landing/tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src", ".astro/types.d.ts"],
  "exclude": ["dist"]
}
```

- [ ] **Step 4: Instalar dependências**

Run (a partir da raiz do repo):
```bash
cd landing && npm install
```
Expected: `node_modules/` criado, sem erros de resolução. `framer-motion`, `@fontsource/aleo`, `@astrojs/react` presentes.

- [ ] **Step 5: Commit**

```bash
git add landing/package.json landing/astro.config.mjs landing/tsconfig.json landing/package-lock.json
git commit -m "chore(lp): scaffold Astro + React em landing/"
```

> Nota: `landing/node_modules/` deve ser ignorado. Confirmar que a regra `node_modules` no `.gitignore` da raiz cobre subpastas (cobre por padrão: `node_modules` sem barra casa em qualquer nível). Se não cobrir, adicionar `landing/node_modules/`.

---

### Task 2: Design tokens, fonte Aleo e layout base

**Files:**
- Create: `landing/src/styles/tokens.css`
- Create: `landing/src/layouts/Base.astro`
- Create: `landing/public/favicon.svg`

- [ ] **Step 1: Criar `landing/src/styles/tokens.css`**

```css
:root {
  --bg: #faf8f2;
  --ink: #1a1a1a;
  --ink-soft: #6b6b66;
  --surface: #ffffff;
  --placeholder: #eceae4;
  --dark: #1e1e1e;
  --dark-soft: #2a2a2a;
  --violet: #7c3aed;
  --violet-soft: #ede9fe;
  --green-bg: #dcfce7;
  --green-ink: #15803d;
  --coral: #ef4444;
  --border: rgba(26, 26, 26, 0.1);
  --shadow-soft: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05);
  --radius: 24px;
  --radius-sm: 14px;
  --maxw: 1200px;
  --font: 'Aleo', Georgia, serif;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-weight: 400;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { font-family: var(--font); margin: 0; line-height: 1.1; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }
button { font-family: inherit; cursor: pointer; }
img, svg { display: block; max-width: 100%; }
.container { max-width: var(--maxw); margin: 0 auto; padding: 0 24px; }
section { padding-block: clamp(56px, 9vw, 120px); }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
```

- [ ] **Step 2: Criar `landing/public/favicon.svg`** (marca ⬤ Askine simplificada)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 4a12 12 0 1 0 0 24 12 12 0 0 0 0-24Z" fill="#1a1a1a"/>
  <path d="M11 27c1.5 1 3.2 1.6 5 1.6V22l-5 5Z" fill="#1a1a1a"/>
</svg>
```

- [ ] **Step 3: Criar `landing/src/layouts/Base.astro`**

```astro
---
import '@fontsource/aleo/400.css';
import '@fontsource/aleo/600.css';
import '@fontsource/aleo/700.css';
import '../styles/tokens.css';

interface Props { title?: string; description?: string; }
const {
  title = 'Askine — Seu curso dentro do ChatGPT e do Claude em 5 minutos',
  description = 'Transforme as maiores ferramentas de IA do mundo em um tutor treinado com o seu conteúdo. Sem criar plataforma, sem custo de tokens.',
} = Astro.props;
---
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="website" />
  </head>
  <body>
    <slot />
  </body>
</html>
```

- [ ] **Step 4: Criar página mínima temporária para validar o build**

Create `landing/src/pages/index.astro`:
```astro
---
import Base from '../layouts/Base.astro';
---
<Base>
  <main class="container">
    <h1>Askine</h1>
  </main>
</Base>
```

- [ ] **Step 5: Verificar build**

Run:
```bash
cd landing && npm run build
```
Expected: build conclui sem erro; `dist/index.html` gerado com Aleo embutido via @fontsource.

- [ ] **Step 6: Commit**

```bash
git add landing/src landing/public
git commit -m "feat(lp): layout base, tokens de design e fonte Aleo"
```

---

### Task 3: Variantes de animação Framer (`lib/motion.ts`)

**Files:**
- Create: `landing/src/lib/motion.ts`

- [ ] **Step 1: Criar `landing/src/lib/motion.ts`**

```ts
import type { Variants } from 'framer-motion';

// Reveal padrão: fade + subida. Usado com whileInView.
export const reveal: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};

// Container que escalona os filhos.
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.05 } },
};

// Item filho do stagger.
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
};

// Props comuns para um bloco que revela ao entrar na viewport.
export const inViewProps = {
  initial: 'hidden' as const,
  whileInView: 'show' as const,
  viewport: { once: true, amount: 0.3 },
};
```

- [ ] **Step 2: Verificar typecheck**

Run:
```bash
cd landing && npx astro check 2>/dev/null || npm run build
```
Expected: sem erros de tipo no arquivo. (`framer-motion` já instala seus próprios tipos.)

- [ ] **Step 3: Commit**

```bash
git add landing/src/lib/motion.ts
git commit -m "feat(lp): variantes de animação Framer reutilizáveis"
```

---

### Task 4: Primitivos de UI (`components/ui/`)

**Files:**
- Create: `landing/src/components/ui/Badge.tsx`
- Create: `landing/src/components/ui/PillButton.tsx`
- Create: `landing/src/components/ui/ArrowLink.tsx`
- Create: `landing/src/components/ui/Placeholder.tsx`
- Create: `landing/src/components/ui/Card.tsx`

- [ ] **Step 1: `Badge.tsx`** — rótulo curto pill

```tsx
export default function Badge({ children, tone = 'light' }: { children: React.ReactNode; tone?: 'light' | 'dark' }) {
  const styles: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 13,
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    color: tone === 'dark' ? 'rgba(255,255,255,0.85)' : 'var(--ink)',
    background: tone === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.02)',
  };
  return <span style={styles}>{children}</span>;
}
```

- [ ] **Step 2: `PillButton.tsx`** — botão-pill com 4 variantes

```tsx
type Variant = 'dark' | 'violet' | 'light' | 'muted';
const palette: Record<Variant, React.CSSProperties> = {
  dark: { background: '#111', color: '#fff' },
  violet: { background: 'var(--violet)', color: '#fff' },
  light: { background: '#fff', color: 'var(--ink)', border: '1px solid var(--border)' },
  muted: { background: '#e9e7e1', color: 'var(--ink-soft)' },
};
export default function PillButton({
  children, variant = 'dark', href = '#', cta, full = false,
}: { children: React.ReactNode; variant?: Variant; href?: string; cta?: string; full?: boolean }) {
  return (
    <a
      href={href}
      data-cta={cta}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center',
        padding: '14px 24px', borderRadius: 999, fontSize: 16, fontWeight: 600,
        width: full ? '100%' : undefined, ...palette[variant],
      }}
    >
      {children}
    </a>
  );
}
```

- [ ] **Step 3: `ArrowLink.tsx`** — link texto + seta com hover

```tsx
import { motion } from 'framer-motion';
export default function ArrowLink({
  children, href = '#', cta, tone = 'dark',
}: { children: React.ReactNode; href?: string; cta?: string; tone?: 'dark' | 'light' }) {
  return (
    <motion.a
      href={href} data-cta={cta} initial="rest" whileHover="hover"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600,
        color: tone === 'light' ? '#fff' : 'var(--ink)',
      }}
    >
      {children}
      <motion.span variants={{ rest: { x: 0 }, hover: { x: 4 } }} aria-hidden>→</motion.span>
    </motion.a>
  );
}
```

- [ ] **Step 4: `Placeholder.tsx`** — área de imagem com ícone

```tsx
export default function Placeholder({
  tone = 'light', radius = 'var(--radius)', style,
}: { tone?: 'light' | 'dark'; radius?: string | number; style?: React.CSSProperties }) {
  const bg = tone === 'dark' ? 'var(--dark)' : 'var(--placeholder)';
  const icon = tone === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)';
  return (
    <div style={{ background: bg, borderRadius: radius, display: 'grid', placeItems: 'center', width: '100%', height: '100%', minHeight: 200, ...style }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={icon} strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="1.6" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </div>
  );
}
```

- [ ] **Step 5: `Card.tsx`** — card arredondado

```tsx
export default function Card({
  children, tone = 'light', style,
}: { children: React.ReactNode; tone?: 'light' | 'dark' | 'violet'; style?: React.CSSProperties }) {
  const tones: Record<string, React.CSSProperties> = {
    light: { background: 'var(--surface)', border: '1px solid var(--border)' },
    dark: { background: 'var(--dark)', color: '#fff' },
    violet: { background: 'var(--surface)', border: '1.5px solid var(--violet)' },
  };
  return (
    <div style={{ borderRadius: 'var(--radius)', padding: 28, boxShadow: 'var(--shadow-soft)', ...tones[tone], ...style }}>
      {children}
    </div>
  );
}
```

- [ ] **Step 6: Verificar build**

Run: `cd landing && npm run build`
Expected: compila sem erro de tipos.

- [ ] **Step 7: Commit**

```bash
git add landing/src/components/ui
git commit -m "feat(lp): primitivos de UI (Badge, PillButton, ArrowLink, Placeholder, Card)"
```

---

### Task 5: Nav (`components/sections/Nav.tsx`)

**Reference:** topo de `base-lp/section-01.png` e `base-lp/section-09.png`.

**Files:**
- Create: `landing/src/components/sections/Nav.tsx`

- [ ] **Step 1: Criar `Nav.tsx`**

```tsx
const links = [
  { label: 'Recursos', href: '#recursos', cta: 'nav-recursos' },
  { label: 'Planos', href: '#planos', cta: 'nav-planos' },
  { label: 'Entrar', href: '#', cta: 'entrar', strong: true },
];
export default function Nav() {
  return (
    <nav style={{ display: 'flex', justifyContent: 'center', paddingTop: 28 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 32, padding: '12px 22px',
        borderRadius: 999, background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)',
      }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 20 }}>
          <span style={{ width: 18, height: 18, borderRadius: '50% 50% 50% 2px', background: '#111', display: 'inline-block' }} />
          Askine
        </a>
        <div style={{ display: 'flex', gap: 26, fontSize: 16 }}>
          {links.map((l) => (
            <a key={l.label} href={l.href} data-cta={l.cta} style={{ fontWeight: l.strong ? 700 : 400, color: l.strong ? 'var(--ink)' : 'var(--ink-soft)' }}>
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Montar no `index.astro` e verificar visual**

Substituir o conteúdo de `landing/src/pages/index.astro`:
```astro
---
import Base from '../layouts/Base.astro';
import Nav from '../components/sections/Nav.tsx';
---
<Base>
  <Nav client:load />
</Base>
```

Run: `cd landing && npm run dev` → abrir `http://localhost:4321`.
Expected: pill de navegação centralizada com logo ⬤ Askine + Recursos/Planos/Entrar (Entrar em negrito), fiel ao topo da section-01.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Nav.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção Nav"
```

---

### Task 6: Hero (`components/sections/Hero.tsx`) — seção 01

**Reference:** `base-lp/section-01.png`.

**Files:**
- Create: `landing/src/components/sections/Hero.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Hero.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import PillButton from '../ui/PillButton';
import Placeholder from '../ui/Placeholder';

export default function Hero() {
  return (
    <section className="container" style={{ textAlign: 'center', paddingTop: 64 }}>
      <motion.h1 variants={reveal} {...inViewProps}
        style={{ fontSize: 'clamp(40px, 6vw, 76px)', fontWeight: 700, letterSpacing: '-0.02em', maxWidth: 14 + 'ch', margin: '0 auto', lineHeight: 1.08 }}>
        Seu curso dentro do ChatGPT e do Claude em 5 minutos
      </motion.h1>
      <motion.p variants={reveal} {...inViewProps}
        style={{ color: 'var(--ink-soft)', fontSize: 'clamp(16px,1.4vw,19px)', maxWidth: '52ch', margin: '28px auto 0' }}>
        Transforme as maiores ferramentas de IA do mundo em um tutor treinado com o seu
        conteúdo sem precisar criar agentes, desenvolver plataformas... nem ter custo de tokens.
      </motion.p>
      <motion.div variants={reveal} {...inViewProps} style={{ marginTop: 36 }}>
        <PillButton variant="dark" cta="integrar-meu-curso">Integrar meu curso →</PillButton>
      </motion.div>
      <motion.div variants={reveal} {...inViewProps}
        style={{ marginTop: 64, background: '#f1efe9', borderRadius: 28, padding: 'clamp(20px,4vw,64px)' }}>
        <Placeholder style={{ minHeight: 460, borderRadius: 18, background: 'var(--surface)' }} />
      </motion.div>
    </section>
  );
}
```

> Nota visual: o hero tem um "frame" externo cinza-claro envolvendo um mockup branco interno — replica a moldura de browser da imagem.

- [ ] **Step 2: Montar e verificar visual**

Em `index.astro`, importar e renderizar após o Nav:
```astro
import Hero from '../components/sections/Hero.tsx';
```
```astro
<Hero client:visible />
```
Run dev → conferir: H1 grande em Aleo, subtítulo cinza, botão preto "Integrar meu curso →", moldura com placeholder. Reveal suave ao carregar.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Hero.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 01 Hero"
```

---

### Task 7: Features bento (`components/sections/Features.tsx`) — seção 02

**Reference:** `base-lp/section-02.png` (4 linhas alternadas img/texto).

**Files:**
- Create: `landing/src/components/sections/Features.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Features.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import Placeholder from '../ui/Placeholder';

const rows = [
  {
    badge: 'Agente Nativo',
    title: 'Um tutor que conhece cada aula e material do seu curso.',
    body: 'A Askine™ transcreve todas suas aulas e cria todas as instruções necessárias para responder, orientar, conduzir e ensinar com base no seu conteúdo.',
  },
  {
    badge: 'Um Lugar Só',
    title: 'Seu aluno não troca de aba. Nem de plataforma.',
    body: 'O tutor vive nativo dentro do ChatGPT e do Claude — as ferramentas que seus alunos já usam todo dia. Nada de login novo, plataforma nova ou tutorial.',
  },
  {
    badge: 'Aulas Nativas',
    title: 'Suas aulas são assistidas dentro do ChatGPT e Claude',
    body: 'Mais que conversar: a Askine™ traz a aula para ser assistido dentro do ChatGPT e do Claude. Seu aluno assiste e tira dúvidas no mesmo lugar.',
  },
  {
    badge: 'Sem Custo Extra',
    title: 'Sem tokens. Sem servidor. Sem plataforma própria.',
    body: 'Você não gasta em infraestruturas caras, nem paga IA usada pelo seu aluno. A Askine™ cuida da parte técnica — você cuida do conteúdo.',
  },
];

export default function Features() {
  return (
    <section id="recursos" className="container" style={{ display: 'grid', gap: 'clamp(48px,8vw,110px)' }}>
      {rows.map((r, i) => {
        const imageLeft = i % 2 === 0;
        const text = (
          <motion.div variants={reveal} {...inViewProps} style={{ display: 'grid', gap: 18, alignContent: 'center' }}>
            <div><Badge>{r.badge}</Badge></div>
            <h2 style={{ fontSize: 'clamp(28px,3.2vw,38px)', fontWeight: 600, maxWidth: '14ch' }}>{r.title}</h2>
            <p style={{ color: 'var(--ink-soft)', maxWidth: '46ch' }}>{r.body}</p>
            <div><ArrowLink cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
          </motion.div>
        );
        const image = (
          <motion.div variants={reveal} {...inViewProps} style={{ aspectRatio: '4 / 3' }}>
            <Placeholder />
          </motion.div>
        );
        return (
          <div key={r.badge} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,72px)' }}>
            {imageLeft ? <>{image}{text}</> : <>{text}{image}</>}
          </div>
        );
      })}
    </section>
  );
}
```

> Mobile: adicionar regra responsiva via CSS global (Task 16) que força `grid-template-columns: 1fr` < 768px. Por ora, desktop fiel.

- [ ] **Step 2: Montar e verificar visual**

`index.astro`: importar `Features` e renderizar `<Features client:visible />` após o Hero. Conferir 4 linhas alternadas, badges corretos, copy literal, stagger/reveal ao rolar.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Features.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 02 Features bento"
```

---

### Task 8: Como Funciona (`components/sections/HowItWorks.tsx`) — seção 03

**Reference:** `base-lp/section-03.png`.

**Files:**
- Create: `landing/src/components/sections/HowItWorks.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `HowItWorks.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, stagger, staggerItem, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import Card from '../ui/Card';

const steps = [
  {
    title: '1- Conecte a hospedagem de vídeos das suas aulas e os materiais do seu curso',
    body: 'Temos integração com o Panda Video que em poucos cliques, conseguimos transcrever todo o conteúdo do seu curso, além de, campos para você anexar materiais complementares.',
  },
  {
    title: '2- A Askine™ trabalha para criar a base de conhecimento com seu tom de voz',
    body: 'Com o conteúdo inserido na plataforma, criamos todas as instruções necessárias para o ChatGPT e Claude responder, orientar, conduzir e ensinar seus alunos exatamente como você faz.',
  },
  {
    title: '3- Importe seus alunos e integra a plataforma de vendas do seu curso',
    body: 'Dentro da plataforma, você consegue importar alunos por turmas e/ou cursos para ceder acesso manual ao tutor ou integrar a Hotmart para continuar vendendo e ceder acesso automático aos alunos.',
  },
  {
    title: '4- Ative o curso dentro da Askine™ e libere o conector para seus alunos utilizarem',
    body: 'Quando a base de conhecimento estiver pronta, ative o curso dentro da Askine™ e automaticamente seus alunos poderão consumir seu conteúdo e o tutor dentro do GPT e do Claude.',
  },
];

export default function HowItWorks() {
  return (
    <section className="container" style={{ display: 'grid', gridTemplateColumns: '1fr 1.1fr', gap: 'clamp(32px,6vw,80px)', alignItems: 'start' }}>
      <motion.div variants={reveal} {...inViewProps} style={{ position: 'sticky', top: 80, display: 'grid', gap: 18 }}>
        <div><Badge>Como Funciona</Badge></div>
        <h2 style={{ fontSize: 'clamp(30px,3.6vw,44px)', fontWeight: 600, maxWidth: '12ch' }}>
          Em 05 minutos seu curso está integrado
        </h2>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '40ch' }}>
          Conecte sua hospedagem de vídeos, suba os materiais do seu curso e integre sua
          plataforma de vendas. Só isso!
        </p>
        <div><ArrowLink cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
      </motion.div>
      <motion.div variants={stagger} {...inViewProps} style={{ display: 'grid', gap: 24 }}>
        {steps.map((s) => (
          <motion.div key={s.title} variants={staggerItem}>
            <Card>
              <h3 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>{s.title}</h3>
              <p style={{ color: 'var(--ink-soft)' }}>{s.body}</p>
            </Card>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Montar e verificar visual**

`index.astro`: `<HowItWorks client:visible />` após Features. Conferir coluna esquerda sticky + 4 cards numerados à direita, copy literal, stagger ao rolar.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/HowItWorks.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 03 Como Funciona"
```

---

### Task 9: Acesso protegido (`components/sections/Protected.tsx`) — seção 04

**Reference:** `base-lp/section-04.png`.

**Files:**
- Create: `landing/src/components/sections/Protected.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Protected.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, stagger, staggerItem, inViewProps } from '../../lib/motion';
import Card from '../ui/Card';
import Placeholder from '../ui/Placeholder';

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
        o e-mail de compra dele.
      </motion.p>
      <motion.div variants={stagger} {...inViewProps}
        style={{ marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, textAlign: 'left' }}>
        {cards.map((c) => (
          <motion.div key={c.title} variants={staggerItem}>
            <Card style={{ display: 'grid', gap: 18 }}>
              <div style={{ aspectRatio: '16 / 10' }}><Placeholder radius="var(--radius-sm)" /></div>
              <h3 style={{ fontSize: 20, fontWeight: 600 }}>{c.title}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 15 }}>{c.body}</p>
            </Card>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Montar e verificar visual**

`index.astro`: `<Protected client:visible />` após HowItWorks. Conferir título centralizado + 3 cards com placeholder no topo, copy literal.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Protected.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 04 Acesso protegido"
```

---

### Task 10: Mais inteligente (`components/sections/Smarter.tsx`) — seção 05

**Reference:** `base-lp/section-05.png` (card escuro + lista ✕ coral).

**Files:**
- Create: `landing/src/components/sections/Smarter.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Smarter.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, stagger, staggerItem, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';

// Copy literal da referência (inclui o typo "expriências").
const items = [
  'Sem você precisar criar plataforma própria',
  'Sem você precisar ter custo de tokens',
  'Sem você forçar seu aluno usar IA',
  'Sem criar expriências confusas',
];

function CrossIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="rgba(239,68,68,0.18)" stroke="var(--coral)" strokeWidth="1.4" />
      <path d="M9 9l6 6M15 9l-6 6" stroke="var(--coral)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function Smarter() {
  return (
    <section className="container">
      <motion.div variants={reveal} {...inViewProps}
        style={{ background: 'var(--dark)', color: '#fff', borderRadius: 28, padding: 'clamp(28px,5vw,56px)',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,56px)', alignItems: 'center' }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <div><Badge tone="dark">Sem Complicação</Badge></div>
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,40px)', fontWeight: 600, maxWidth: '14ch' }}>
            Com a Askine™ teu curso fica mais inteligente e autônomo
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', maxWidth: '42ch' }}>
            Fazendo o ChatGPT e o Claude trabalharem para você sem se preocupar em dificultar
            a experiência de aprendizado do seu aluno.
          </p>
          <div><ArrowLink tone="light" cta="integrar-meu-curso">Integrar meu curso</ArrowLink></div>
        </div>
        <motion.ul variants={stagger} {...inViewProps}
          style={{ listStyle: 'none', margin: 0, padding: 'clamp(20px,3vw,32px)', display: 'grid', gap: 18,
            background: 'rgba(255,255,255,0.04)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.08)' }}>
          {items.map((t) => (
            <motion.li key={t} variants={staggerItem} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <CrossIcon /><span>{t}</span>
            </motion.li>
          ))}
        </motion.ul>
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Montar e verificar visual**

`index.astro`: `<Smarter client:visible />` após Protected. Conferir card escuro, badge "Sem Complicação", 4 itens com ✕ coral, copy literal (com "expriências").

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Smarter.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 05 Mais inteligente (card escuro)"
```

---

### Task 11: Dados de pricing (`data/pricing.ts`)

**Reference:** `base-lp/section-06-mensal.png` e `base-lp/section-06-anual.png`.

**Files:**
- Create: `landing/src/data/pricing.ts`

- [ ] **Step 1: Criar `data/pricing.ts`**

```ts
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
```

> Typo "equilibrio" mantido fiel à referência.

- [ ] **Step 2: Verificar typecheck**

Run: `cd landing && npm run build`
Expected: sem erros (todos os `over.*!` preenchidos para cada plano).

- [ ] **Step 3: Commit**

```bash
git add landing/src/data/pricing.ts
git commit -m "feat(lp): dados de pricing (mensal/anual, features por plano)"
```

---

### Task 12: Pricing (`components/sections/Pricing.tsx`) — seção 06 (toggle)

**Reference:** `base-lp/section-06-mensal.png` / `-anual.png`.

**Files:**
- Create: `landing/src/components/sections/Pricing.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Pricing.tsx`**

```tsx
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
      <div style={{ marginTop: 48, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, textAlign: 'left', alignItems: 'start' }}>
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
```

- [ ] **Step 2: Verificar comportamento do toggle (navegador)**

Run dev → seção Planos. Clicar **Anual**: pílula branca desliza (layoutId), preços trocam para "12x de R$ 142 / ou R$ 1.470 à vista / cobrado anualmente" (e equivalentes), badge "17% OFF" visível. Clicar **Mensal**: volta para "R$ 147/mês / cobrado mensalmente". Conferir 3 cards (Start claro, Pro violeta com "Mais Popular", Scale escuro), features e botões fiéis.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Pricing.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 06 Pricing com toggle Mensal/Anual"
```

---

### Task 13: FAQ (`components/sections/Faq.tsx`) — seção 07 (accordion)

**Reference:** `base-lp/section-07.png`.

**Files:**
- Create: `landing/src/components/sections/Faq.tsx`
- Modify: `landing/src/pages/index.astro`

> **Respostas 2–6:** a imagem só mostra a resposta do item 1. As demais usam como base o `landing-copy.md` (seção FAQ) e devem ser **confirmadas com o usuário** antes do commit final desta task. Texto-base abaixo.

- [ ] **Step 1: Criar `Faq.tsx`**

```tsx
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import PillButton from '../ui/PillButton';

const faqs = [
  { q: 'Preciso entender de tecnologia?', a: 'Não. Você conecta o PandaVideo e a Askine™ faz o resto.' },
  { q: 'Como meus alunos ganham acesso?', a: 'Quem compra na Hotmart é liberado automaticamente. Nada manual.' },
  { q: 'E quem pede reembolso ou cancela?', a: 'O acesso ao tutor é revogado sozinho, sem você precisar mexer em nada.' },
  { q: 'Meus alunos precisam pagar ChatGPT ou Claude?', a: 'Eles usam a conta que já têm — não há custo extra de IA pra você.' },
  { q: 'O ChatGPT e o Claude inventam respostas?', a: 'O tutor responde com base nas suas aulas, não em achismo.' },
  { q: 'Quanto tempo pra ativar?', a: '5 minutos pra conectar. A transcrição roda sozinha.' },
];

function Item({ q, a, defaultOpen }: { q: string; a: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ width: '100%', background: 'transparent', border: 'none', padding: '22px 0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', textAlign: 'left', fontSize: 19, fontWeight: 600, color: 'var(--ink)' }}>
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
  return (
    <section className="container" style={{ maxWidth: 920 }}>
      <motion.h2 variants={reveal} {...inViewProps} style={{ fontSize: 'clamp(32px,4.4vw,52px)', fontWeight: 700, textAlign: 'center', marginBottom: 40 }}>
        Perguntas Frequentes
      </motion.h2>
      <div>
        {faqs.map((f, i) => <Item key={f.q} q={f.q} a={f.a} defaultOpen={i === 0} />)}
      </div>
      <motion.div variants={reveal} {...inViewProps}
        style={{ marginTop: 48, background: 'var(--surface)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-soft)', padding: 40, textAlign: 'center' }}>
        <h3 style={{ fontSize: 26, fontWeight: 600 }}>Ainda com dúvidas?</h3>
        <p style={{ color: 'var(--ink-soft)', margin: '8px 0 22px' }}>Fale com o nosso time agora mesmo.</p>
        <PillButton variant="dark" cta="falar-com-askine">Falar com Askine™</PillButton>
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Confirmar respostas 2–6 com o usuário**

Mostrar ao usuário as respostas-base (itens 2–6) e ajustar conforme a resposta dele antes de prosseguir. Item 1 é literal da imagem e não muda.

- [ ] **Step 3: Verificar comportamento (navegador)**

Run dev → seção FAQ. Item 1 aberto por padrão mostrando "Não. Você conecta o PandaVideo e a Askine™ faz o resto." Clicar nos demais expande/colapsa com animação de altura; chevron rotaciona. Card "Ainda com dúvidas?" + botão preto "Falar com Askine™".

- [ ] **Step 4: Commit**

```bash
git add landing/src/components/sections/Faq.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 07 FAQ com accordion"
```

---

### Task 14: CTA final (`components/sections/FinalCta.tsx`) — seção 08

**Reference:** `base-lp/section-08.png`.

**Files:**
- Create: `landing/src/components/sections/FinalCta.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `FinalCta.tsx`**

```tsx
import { motion } from 'framer-motion';
import { reveal, inViewProps } from '../../lib/motion';
import Badge from '../ui/Badge';
import ArrowLink from '../ui/ArrowLink';
import Placeholder from '../ui/Placeholder';

export default function FinalCta() {
  return (
    <section className="container">
      <motion.div variants={reveal} {...inViewProps}
        style={{ background: '#f1efe9', borderRadius: 28, padding: 'clamp(28px,5vw,64px)',
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'clamp(24px,5vw,56px)', alignItems: 'center' }}>
        <div style={{ display: 'grid', gap: 22 }}>
          <div><Badge>Experimente Grátis</Badge></div>
          <h2 style={{ fontSize: 'clamp(28px,3.4vw,42px)', fontWeight: 600, maxWidth: '16ch' }}>
            Teste a Askine™ por 07 dias e veja você mesmo a evolução do aprendizado.
          </h2>
          <div><ArrowLink cta="comecar-agora">Começar agora</ArrowLink></div>
        </div>
        <div style={{ aspectRatio: '16 / 10' }}>
          <Placeholder tone="dark" />
        </div>
      </motion.div>
    </section>
  );
}
```

- [ ] **Step 2: Montar e verificar visual**

`index.astro`: `<FinalCta client:visible />` após Faq. Conferir card claro com badge "Experimente Grátis", título, "Começar agora →" e painel escuro à direita.

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/FinalCta.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 08 CTA final"
```

---

### Task 15: Footer (`components/sections/Footer.tsx`) — seção 09

**Reference:** `base-lp/section-09.png`.

**Files:**
- Create: `landing/src/components/sections/Footer.tsx`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Criar `Footer.tsx`** (estático, sem hidratação)

```tsx
const nav = [
  { label: 'Recursos', href: '#recursos' },
  { label: 'Planos', href: '#planos' },
  { label: 'Entrar', href: '#', strong: true },
];
const legal = [
  { label: 'Política de Privacidade', href: '#' },
  { label: 'Termos de Uso', href: '#' },
  { label: 'Coockies', href: '#' }, // typo fiel à referência
];

export default function Footer() {
  return (
    <footer className="container" style={{ paddingBlock: 64 }}>
      <div style={{ textAlign: 'center', display: 'grid', gap: 24, justifyItems: 'center' }}>
        <a href="#" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 22 }}>
          <span style={{ width: 18, height: 18, borderRadius: '50% 50% 50% 2px', background: '#111' }} />
          Askine
        </a>
        <div style={{ display: 'flex', gap: 28, color: 'var(--ink-soft)' }}>
          {nav.map((l) => <a key={l.label} href={l.href} style={{ fontWeight: l.strong ? 700 : 400, color: l.strong ? 'var(--ink)' : 'var(--ink-soft)' }}>{l.label}</a>)}
        </div>
      </div>
      <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '36px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, color: 'var(--ink-soft)', fontSize: 14 }}>
        <span>Copyright © 2026 — Askine LLC. Todos os direitos reservados.</span>
        <div style={{ display: 'flex', gap: 24 }}>
          {legal.map((l) => <a key={l.label} href={l.href}>{l.label}</a>)}
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 2: Montar (estático) e verificar visual**

`index.astro`: importar e renderizar `<Footer />` **sem** diretiva client (renderiza no servidor como HTML estático). Conferir logo centralizado, nav, divisor, copyright à esquerda e links legais à direita (com "Coockies").

- [ ] **Step 3: Commit**

```bash
git add landing/src/components/sections/Footer.tsx landing/src/pages/index.astro
git commit -m "feat(lp): seção 09 Footer"
```

---

### Task 16: Responsividade + reduced-motion + polish final

**Files:**
- Modify: `landing/src/styles/tokens.css`
- Modify: seções com grids de 2/3 colunas (adicionar `data-grid` ou classes utilitárias)

- [ ] **Step 1: Adicionar utilitários responsivos a `tokens.css`**

Acrescentar ao fim do arquivo:
```css
/* Grids responsivos: cada seção com 2/3 colunas usa .lp-grid e colapsa no mobile */
.lp-grid { display: grid; }
@media (max-width: 860px) {
  .lp-grid-2, .lp-grid-3 { grid-template-columns: 1fr !important; }
  section { padding-block: clamp(40px, 12vw, 72px); }
}
```

- [ ] **Step 2: Aplicar `className="lp-grid-2"` / `lp-grid-3` nos containers de grid**

Nos componentes que usam `gridTemplateColumns` inline para 2 ou 3 colunas (`Features`, `HowItWorks`, `Protected`, `Smarter`, `Pricing`, `FinalCta`), adicionar a className correspondente ao elemento de grid, mantendo o `gridTemplateColumns` inline como padrão desktop (a media query sobrescreve no mobile). Exemplo em `Features.tsx` na div de cada linha: `className="lp-grid-2"`. Em `Protected`/`Pricing` (3 colunas): `className="lp-grid-3"`.

- [ ] **Step 3: Verificar responsivo (navegador)**

Run dev → reduzir a janela < 860px. Esperado: bento, how-it-works, cards de proteção, pricing e CTA final empilham em coluna única, sem overflow horizontal. Tipografia escala via `clamp()`.

- [ ] **Step 4: Verificar reduced-motion**

Ativar "reduzir movimento" no SO (ou DevTools → Rendering → Emulate prefers-reduced-motion). Recarregar: conteúdo aparece sem animações de entrada (regra global em `tokens.css` zera durations).

- [ ] **Step 5: Build de produção final**

Run: `cd landing && npm run build && npm run preview`
Expected: build sem erros/warnings de tipo; `npm run preview` serve a LP completa (9 seções na ordem) idêntica ao dev.

- [ ] **Step 6: Commit**

```bash
git add landing/src
git commit -m "feat(lp): responsividade mobile + reduced-motion + polish"
```

---

## Self-Review (preenchido)

**Cobertura do spec:**
- §2 stack/arquitetura → Tasks 1–3. ✓
- §3 estrutura de pastas → Tasks 1, 2, 4, 11 + seções. ✓
- §4 design system (Aleo, tokens, primitivos) → Tasks 2, 4. ✓
- §5 seções 01–09 (copy literal) → Tasks 5–15. ✓
- §6 CTAs placeholder (`href="#"` + `data-cta`) → primitivos em Task 4, usados em todas as seções. ✓
- §7 responsividade → Task 16. ✓
- §8 a11y (reduced-motion, aria do accordion/toggle) → Tasks 13, 12, 16. ✓
- Typos fiéis ("expriências", "equilibrio", "Coockies") → Tasks 10, 11, 15. ✓

**Lacuna conhecida (registrada, não é placeholder de plano):** respostas 2–6 da FAQ não existem na imagem; Task 13 Step 2 obriga confirmação com o usuário antes do commit.

**Consistência de tipos/nomes:** `PillButton` variantes `dark|violet|light|muted` batem entre Task 4 e usos em Tasks 6/12/13. `Placeholder` props `tone|radius|style` consistentes. `plans`/`Plan`/`Feature` de Task 11 consumidos exatamente em Task 12. Variantes Framer `reveal|stagger|staggerItem|inViewProps` definidas em Task 3 e usadas com os mesmos nomes em todas as seções. ✓

**Nota sobre TDD:** projeto de UI visual — verificação por build + conferência visual contra `base-lp/`, com passos comportamentais explícitos no toggle (Task 12) e accordion (Task 13). Tests unitários de markup seriam teatro e foram deliberadamente omitidos.
