# Askine.cc — Landing Page — Design Spec

**Data:** 2026-06-11
**Status:** Aprovado para planejamento
**Fonte de verdade da copy/layout:** imagens em `base-lp/section-*.png` (mais recentes que `landing-copy.md`)

---

## 1. Objetivo

Reconstruir a landing page da Askine.cc como um site estático, fiel pixel-a-pixel à
referência em `base-lp/`, usando **Astro + React (islands) + Framer Motion** e a fonte
**Aleo**. Cada seção é replicada com a **mesma copy, pesos e elementos** da referência.

A LP é o produto de marketing do `mcp-agentclass` (backend MCP), mas vive **isolada**
em `landing/` com seu próprio `package.json` e toolchain.

## 2. Stack e arquitetura (Approach A — aprovado)

- **Astro** monta a página e gera saída **estática** (`output: 'static'`).
- Cada **seção é um componente React** (atende o requisito "construa em React").
- Astro hidrata cada seção como **island**:
  - `client:load` → `Nav` (precisa estar interativo de imediato).
  - `client:visible` → seções com reveal/animação on-scroll e interatividade
    (Hero, Features, HowItWorks, Protected, Smarter, Pricing, Faq, FinalCta).
  - estático (sem hidratar) → `Footer`.
- **Framer Motion** para animações: reveal (fade + translateY), stagger em
  listas/cards, toggle de pricing com layout animado, accordion da FAQ. Todas as
  animações respeitam `prefers-reduced-motion`.

### Decisão de deploy (fora do escopo de código, registrada)
O `dist/` estático pode ser servido na raiz `askine.cc` via **Cloudflare Pages**
(domínio raiz na LP, MCP movido para subdomínio/rota) ou pelo servidor atual
servindo o build estático em `/`. Não afeta o código da LP. Decisão tomada no passo
de deploy, depois da implementação.

## 3. Estrutura de pastas

```
landing/
  astro.config.mjs
  package.json
  tsconfig.json
  public/
    fonts/            # Aleo (woff2)
    favicon.*         # ícone Askine
  src/
    pages/index.astro       # monta as seções na ordem 01→09
    layouts/Base.astro      # <head>, fontes, tokens globais, meta/SEO
    styles/tokens.css       # design tokens (CSS custom properties)
    components/
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
      ui/
        Badge.tsx          # rótulo-pill curto
        PillButton.tsx     # botão-pill (preto / violeta / branco / cinza)
        ArrowLink.tsx      # link com seta →
        Placeholder.tsx    # área de imagem com ícone (claro/escuro)
        Card.tsx           # card arredondado com sombra suave
    data/
      pricing.ts           # planos × {mensal, anual}, features, tooltips
    lib/
      motion.ts            # variantes Framer reutilizáveis + reduced-motion
```

**Regra de manutenção (requisito do usuário):** uma seção = um arquivo. Nada de
seções aninhadas em um único componente gigante.

## 4. Design System

### Tipografia — Aleo em tudo
- Display / H1: Aleo ~700, tracking apertado.
- Headings de card: Aleo ~600.
- Corpo / UI / badges: Aleo ~400, cor `--ink-soft`.
- Aleo self-hosted em `public/fonts/` (woff2), `font-display: swap`.

### Tokens de cor (`styles/tokens.css`)
| token | valor aprox. | uso |
|---|---|---|
| `--bg` | `#FAF8F2` | fundo da página (creme quente) |
| `--ink` | `#1A1A1A` | texto/títulos |
| `--ink-soft` | `#6B6B66` | subtítulos, body secundário |
| `--surface` | `#FFFFFF` | cards claros |
| `--placeholder` | `#ECEAE4` | áreas de imagem |
| `--dark` | `#1E1E1E` | cards escuros |
| `--violet` | `#7C3AED` | botão Pro + badge "Mais Popular" |
| `--green-bg` / `--green-ink` | verde claro / verde escuro | badge "17% OFF" |
| `--coral` | `#EF4444` | ícones ✕ (seção 05) |

> Valores são aproximações iniciais; afinados contra as imagens na implementação.

### Elementos recorrentes
- **nav-pill**: container arredondado com logo + links.
- **badge-pill**: rótulo curto, borda fina, fundo translúcido.
- **PillButton**: variantes `dark` (preto), `violet` (Pro), `light` (branco/borda),
  `muted` (cinza, ex. botão do Plano Start).
- **ArrowLink**: texto + `→`, com leve deslocamento no hover.
- **Card**: radius ~24px, sombra suave.
- **Placeholder**: variante clara (`--placeholder`) e escura (`--dark`), ícone de
  imagem centralizado.

## 5. Seções — copy e estrutura (fonte: imagens)

> **Política de copy:** transcrição literal das imagens, **incluindo typos da
> referência** — `expriências` (sec 05), `equilibrio` (sec 06), `Coockies` (sec 09).
> Centralizados numa única fonte de strings para correção futura com troca de 1 linha.

### Nav (todas as seções)
Pill: logo `⬤ Askine` · links **Recursos**, **Planos**, **Entrar** (Entrar em destaque).

### 01 — Hero (`Hero.tsx`)
- H1: **"Seu curso dentro do ChatGPT e do Claude em 5 minutos"**
- Sub: "Transforme as maiores ferramentas de IA do mundo em um tutor treinado com o
  seu conteúdo sem precisar criar agentes, desenvolver plataformas... nem ter custo de
  tokens."
- CTA (PillButton dark): **"Integrar meu curso →"**
- Frame de browser/mockup grande (Placeholder claro).

### 02 — Features bento (`Features.tsx`) — 4 linhas alternadas (img/texto)
1. badge **Agente Nativo** · "Um tutor que conhece cada aula e material do seu curso." ·
   "A Askine™ transcreve todas suas aulas e cria todas as instruções necessárias para
   responder, orientar, conduzir e ensinar com base no seu conteúdo." · ArrowLink
   "Integrar meu curso →"
2. badge **Um Lugar Só** · "Seu aluno não troca de aba. Nem de plataforma." · "O tutor
   vive nativo dentro do ChatGPT e do Claude — as ferramentas que seus alunos já usam
   todo dia. Nada de login novo, plataforma nova ou tutorial." · ArrowLink
3. badge **Aulas Nativas** · "Suas aulas são assistidas dentro do ChatGPT e Claude" ·
   "Mais que conversar: a Askine™ traz a aula para ser assistido dentro do ChatGPT e do
   Claude. Seu aluno assiste e tira dúvidas no mesmo lugar." · ArrowLink
4. badge **Sem Custo Extra** · "Sem tokens. Sem servidor. Sem plataforma própria." ·
   "Você não gasta em infraestruturas caras, nem paga IA usada pelo seu aluno. A
   Askine™ cuida da parte técnica — você cuida do conteúdo." · ArrowLink

Layout: linhas 1 e 3 imagem à esquerda; linhas 2 e 4 imagem à direita.

### 03 — Como Funciona (`HowItWorks.tsx`)
Esquerda (sticky): badge **Como Funciona** · "Em 05 minutos seu curso está integrado" ·
"Conecte sua hospedagem de vídeos, suba os materiais do seu curso e integre sua
plataforma de vendas. Só isso!" · ArrowLink "Integrar meu curso →"
Direita — 4 cards numerados:
1. **Conecte a hospedagem de vídeos das suas aulas e os materiais do seu curso** —
   "Temos integração com o Panda Video que em poucos cliques, conseguimos transcrever
   todo o conteúdo do seu curso, além de, campos para você anexar materiais
   complementares."
2. **A Askine™ trabalha para criar a base de conhecimento com seu tom de voz** — "Com o
   conteúdo inserido na plataforma, criamos todas as instruções necessárias para o
   ChatGPT e Claude responder, orientar, conduzir e ensinar seus alunos exatamente como
   você faz."
3. **Importe seus alunos e integra a plataforma de vendas do seu curso** — "Dentro da
   plataforma, você consegue importar alunos por turmas e/ou cursos para ceder acesso
   manual ao tutor ou integrar a Hotmart para continuar vendendo e ceder acesso
   automático aos alunos."
4. **Ative o curso dentro da Askine™ e libere o conector para seus alunos utilizarem** —
   "Quando a base de conhecimento estiver pronta, ative o curso dentro da Askine™ e
   automaticamente seus alunos poderão consumir seu conteúdo e o tutor dentro do GPT e
   do Claude."

### 04 — Acesso protegido (`Protected.tsx`)
- H (centralizado): **"Acesso autenticado. Seu curso protegido."**
- Sub: "Seus alunos só conectam seu curso dentro do ChatGPT ou Claude, depois de
  autenticar o e-mail de compra dele."
- 3 cards (Placeholder topo + título + body):
  1. "Vendeu na Hotmart? Já sabemos quem comprou." — "A integração com a hotmart, nos
     permite identificar instantaneamente quem comprou, quem está ativo e registrar o
     e-mail/status para autenticação."
  2. "Somente aluno pagante e ativo consegue utilizar" — "O conector da Askine™ só
     funciona para alunos que possuem e-mail de compra ativo. Deixou de pagar? O tutor
     dentro do GPT ou Claude para de funcionar na hora."
  3. "Um só conector para múltiplos cursos e alunos" — "Venda quantos cursos, quantas
     aulas e para quantos alunos quiser. Nossa tecnologia permite que você tenha quantos
     tutores quiser fazendo o GPT e o Claude trabalharem para você."

### 05 — Mais inteligente (`Smarter.tsx`) — card escuro
- badge **Sem Complicação**
- H: **"Com a Askine™ teu curso fica mais inteligente e autônomo"**
- P: "Fazendo o ChatGPT e o Claude trabalharem para você sem se preocupar em dificultar
  a experiência de aprendizado do seu aluno."
- ArrowLink "Integrar meu curso →"
- Painel interno com 4 itens ✕ (coral):
  - "Sem você precisar criar plataforma própria"
  - "Sem você precisar ter custo de tokens"
  - "Sem você forçar seu aluno usar IA"
  - "Sem criar expriências confusas" *(typo fiel à referência)*

### 06 — Pricing (`Pricing.tsx`) — toggle Mensal/Anual
- H: **"Simples como deve ser"** · Sub: "Sem pegadinhas. Cancele quando quiser."
- Toggle: **Mensal** | **Anual** `[17% OFF]`
- 3 planos (dados em `data/pricing.ts`):

| | Start | Pro *(Mais Popular)* | Scale |
|---|---|---|---|
| tagline | Ideal para Low-tickets | Ideal para quem busca equilibrio | Ideal para quem está escalando |
| mensal | R$ 147/mês · "cobrado mensalmente" | R$ 297/mês | R$ 497/mês |
| anual | 12x de R$ 142 · ou R$ 1.470 à vista · "cobrado anualmente" | 12x de R$ 286 · ou R$ 2.970 à vista | 12x de R$ 478 · ou R$ 4.970 à vista |
| card | claro / botão `muted` | borda violeta / botão `violet` | escuro / botão `light` |

Features (✓ + ícone (i) tooltip):
- **Start:** 01 curso · 25h de transcrição/mês · 500 alunos ativos · 100 MB de arquivos
  · Base de conhecimento integrada · Tutor nativo Askine™ · Integração com Hotmart ·
  Integração com Panda Video
- **Pro:** 03 cursos · 50h de transcrição/mês · 1.000 alunos ativos · 500 MB de arquivos
  · Base de conhecimento integrada · Tutor nativo Askine™ · Integração com Hotmart ·
  Integração com Panda Video · Relatórios de insights (em breve) · Ferramentas
  Interativas dentro do GPT e Claude (em breve)
- **Scale:** 10 cursos · 90h de transcrição/mês · 2.500 alunos ativos · 2 GB de arquivos
  · (demais iguais ao Pro)

Botão de todos: **"Experimente 7 dias grátis"**.

### 07 — FAQ (`Faq.tsx`) — accordion
- H: **"Perguntas Frequentes"**
- Itens (1º aberto por padrão):
  1. "Preciso entender de tecnologia?" → "Não. Você conecta o PandaVideo e a Askine™ faz
     o resto."
  2. "Como meus alunos ganham acesso?"
  3. "E quem pede reembolso ou cancela?"
  4. "Meus alunos precisam pagar ChatGPT ou Claude?"
  5. "O ChatGPT e o Claude inventam respostas?"
  6. "Quanto tempo pra ativar?"
- Card final: **"Ainda com dúvidas?"** · "Fale com o nosso time agora mesmo." ·
  PillButton dark **"Falar com Askine™"**

> Respostas dos itens 2–6 não aparecem na imagem (accordion fechado). Serão preenchidas
> a partir de `landing-copy.md` (seção FAQ) como base e confirmadas com o usuário na
> implementação. Item 1 é literal da imagem.

### 08 — CTA final (`FinalCta.tsx`)
- badge **Experimente Grátis**
- H: **"Teste a Askine™ por 07 dias e veja você mesmo a evolução do aprendizado."**
- ArrowLink **"Começar agora →"**
- Painel escuro à direita (Placeholder dark — vídeo/print).

### 09 — Footer (`Footer.tsx`)
- logo `⬤ Askine` centralizado · nav Recursos · Planos · Entrar
- divisor
- esquerda: "Copyright © 2026 — Askine LLC. Todos os direitos reservados."
- direita: "Política de Privacidade" · "Termos de Uso" · "Coockies" *(typo fiel)*

## 6. CTAs (placeholder)
Todos os CTAs usam `href="#"` + `data-cta="<nome>"` por ora. Lista para conectar depois:
`integrar-meu-curso`, `experimente-7-dias` (× plano), `entrar`, `falar-com-askine`,
`comecar-agora`, links legais.

## 7. Responsividade
Referência é desktop. Definir breakpoints na implementação:
- Mobile: seções bento (02) e how-it-works (03) empilham em coluna única; pricing vira
  carrossel/stack; nav-pill colapsa. Tudo single-column < 768px.
- Manter hierarquia tipográfica (escala fluida com `clamp()`).

## 8. Acessibilidade
- `prefers-reduced-motion`: desliga reveals/stagger.
- Accordion FAQ com `aria-expanded`/`aria-controls`; toggle de pricing com `role` e
  estado anunciado; contraste AA nos cards escuros.

## 9. Fora de escopo (agora)
- Integração real de CTAs (URLs).
- Assets reais de imagem/vídeo (usar placeholders estilizados).
- Deploy/roteamento do domínio raiz.
- i18n (somente pt-BR).

## 10. Ordem de implementação proposta
Setup (scaffold Astro + Aleo + tokens + ui/) → Nav → 01 Hero → 02 Features →
03 HowItWorks → 04 Protected → 05 Smarter → 06 Pricing → 07 Faq → 08 FinalCta →
09 Footer → polish (responsivo + reduced-motion) → build de verificação.
