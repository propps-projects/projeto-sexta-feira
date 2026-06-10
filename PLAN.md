# Askine — Plano de Implementação SaaS Multi-Tenant

> Tutor agêntico para infoprodutores: o aluno conversa com Claude/ChatGPT, o agente cita timestamps reais das aulas, mostra trechos do vídeo inline e responde com base no conteúdo do curso.

---

## 1. Identidade

- **Marca:** Askine
- **CNPJ:** 35.735.278/0001-91
- **Domínio principal (registrado):** `askine.cc` — apontado para a VPS
- **Emails institucionais sugeridos:** `contato@askine.cc`, `suporte@askine.cc`, `legal@askine.cc`
- **Logo + identidade visual:** será criada (TODO — fora do escopo de engenharia)

---

## 2. Visão de Produto

**Cliente B2B (infoprodutor):** assina mensalmente, conecta Panda + Hotmart, sobe cursos, recebe os tutores agênticos prontos.

**Usuário final (aluno):** dentro do Claude.ai / ChatGPT que já usa, conecta o connector do seu curso, autentica, conversa.

**Vantagem competitiva:** o aluno não precisa abrir mais um app — vive no chat que já é parte da rotina dele.

---

## 3. Stack Técnica (atualizada)

| Camada | Tech | Por quê |
|---|---|---|
| Runtime | Node.js + TypeScript | continuamos com o que já temos |
| Web | Fastify (API) + Next.js (admin) | Fastify p/ rotas leves; Next p/ dashboard com server actions |
| **DB** | **Supabase** (Postgres + pgvector + Storage + Auth + RLS) | DB + vetores + storage no mesmo lugar; RLS ajuda isolamento multi-tenant |
| Cache + queue | Redis (Upstash) | BullMQ jobs, rate limit, sessions |
| Object storage | Supabase Storage ou Cloudflare R2 | áudios temp + KB materials (PDFs) |
| Auth | OAuth 2.0 próprio (sobre Supabase Auth) + magic link | Claude/GPT exigem OAuth; magic link p/ UX leve |
| **Pagamento** | **ValidaPay** | PIX Automático + cartão + outros métodos (aceita qualquer formato via webhook). API REST + OAuth2. Subcontas + Split nativos (caminho fácil pra modelo marketplace no futuro) |
| Background jobs | BullMQ sobre Redis | ingest assíncrono, retry, dashboard de jobs |
| Transcrição | OpenAI Whisper API (`whisper-1`) | igual hoje — pt-BR funciona bem |
| Embeddings | `Xenova/multilingual-e5-small` local | igual hoje — zero custo runtime |
| Hospedagem | Fly.io (api + worker + redis) ou Railway | volumes, deploy bundled |
| Frontend admin | Next.js + shadcn/ui (dark mode estilo OpenAI Platform) | clean, profissional, rápido |
| Observabilidade | Sentry + Logtail | erros + logs estruturados |

---

## 4. Schema do Banco (núcleo)

```sql
-- Multi-tenant
tenants(id, name, email, slug, plan_id, status, trial_ends_at,
        panda_api_key_enc, hotmart_app_token_enc, hotmart_basic_token_enc,
        validapay_customer_id, created_at)

-- Catálogo de cursos por tenant
courses(id, tenant_id, name, source_type ENUM('panda','vimeo',...),
        source_config JSONB, -- ex: { folder_id: '1c52c2e9-...' }
        hotmart_product_ids TEXT[],  -- mapeia 1:N produtos Hotmart pra 1 curso
        ingest_status ENUM('pending','ingesting','ready','error'),
        ingest_error TEXT, created_at)

lessons(id, course_id, source_video_id, number, title,
        duration_sec, hls_url, embed_url, thumbnail_url,
        transcript JSONB, -- { language, segments: [{start,end,text}] }
        transcript_source ENUM('whisper','uploaded'),
        transcription_cost_usd NUMERIC)

-- Knowledge Base não-vídeo (PDFs, textos, MDs)
materials(id, course_id, type ENUM('pdf','markdown','text'),
          name, storage_path, size_bytes)

-- Chunks unificados (vídeo + materiais) para busca semântica
chunks(id BIGSERIAL, course_id, source_type ENUM('lesson','material'),
       lesson_id NULL, material_id NULL,
       start_sec REAL NULL, end_sec REAL NULL,
       text, embedding vector(384))
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

-- Alunos
students(id, tenant_id, email, hotmart_buyer_id, last_active_at, created_at)
course_access(id, student_id, course_id, granted_at, revoked_at,
              source ENUM('hotmart_webhook','manual','imported'))

-- Progresso do aluno (NOVO)
student_progress(id, student_id, lesson_id,
                 last_position_sec INT,
                 total_watched_sec INT,
                 completed_at TIMESTAMPTZ NULL,
                 updated_at TIMESTAMPTZ)

-- OAuth (nossa server)
oauth_clients(id, tenant_id, client_id, client_secret_hash,
              redirect_uris TEXT[], scopes)
oauth_access_tokens(token_hash, student_id, scopes, expires_at)
oauth_refresh_tokens(token_hash, student_id, expires_at)

-- Eventos de uso (billing + analytics)
usage_events(id BIGSERIAL, tenant_id, type, amount NUMERIC,
             metadata JSONB, occurred_at)
-- types: 'transcription_minute', 'course_ingested',
--        'student_active', 'kb_bytes_added', 'tool_call'

-- Analytics de interação (NOVO)
tool_calls(id BIGSERIAL, tenant_id, student_id, course_id,
           tool_name, input JSONB, occurred_at, latency_ms)
search_queries(id BIGSERIAL, tenant_id, course_id, student_id,
               query TEXT, query_embedding vector(384),
               result_lesson_ids INT[], occurred_at)

-- Rate limiting (sliding window — bucket por hora)
rate_limit_buckets(key TEXT, window_start TIMESTAMPTZ, count INT)
-- key ex: 'tenant:abc:tool_calls:hour' ou 'student:def:hour'
```

**Isolamento via Supabase RLS:** policies do tipo `tenant_id = current_setting('app.current_tenant')::uuid` em toda tabela. Cada request seta o tenant no início da transação. Se rolar bug de scope, RLS é segunda barreira.

---

## 5. Pricing — Tiers e Análise de Margem

### Tiers propostos

| Tier | Cursos | Horas transcrição/mês * | Alunos ativos/mês ** | KB size *** | Preço |
|---|---|---|---|---|---|
| **Starter** | 3 | 10h | 100 | 100 MB | **R$ 99/mês** |
| **Pro** | 15 | 60h | 500 | 500 MB | **R$ 299/mês** |
| **Scale** | 50 | 200h | 2.000 | 2 GB | **R$ 999/mês** |
| **Enterprise** | custom | custom | custom | custom | sob proposta |

\* **Horas de transcrição** consumidas no mês pelo Whisper API. **Isento se** subir transcrição pronta no formato `{lessonNumber, title, segments[]}`.

\** **Aluno ativo** = aluno que fez pelo menos 1 tool call nos últimos 30 dias. Inativos não contam.

\*** **KB size** = tamanho total de **Knowledge Base** (PDFs, MDs, textos) carregados — material extra além dos vídeos. Não inclui transcrições nem chunks (estão no DB, custo desprezível).

### Análise de margem (custo mensal aproximado)

**Starter — R$ 99 venda:**

| Item | Custo |
|---|---|
| Whisper API (10h × $0.006/min × 60) | ~R$ 20 |
| Supabase shared | ~R$ 5 |
| Storage R2 (100 MB KB) | ~R$ 0,10 |
| Compute (Fly shared) | ~R$ 3 |
| ValidaPay fee (~1,5% PIX) | ~R$ 1,50 |
| **Total custo** | **~R$ 30** |
| **Margem bruta** | **~70% (R$ 69)** |

**Pro — R$ 299 venda:**

| Item | Custo |
|---|---|
| Whisper API (60h) | ~R$ 120 |
| Supabase Pro slice | ~R$ 15 |
| Storage R2 (500 MB) | ~R$ 0,50 |
| Compute | ~R$ 10 |
| ValidaPay fee | ~R$ 4,50 |
| **Total custo** | **~R$ 150** |
| **Margem bruta** | **~50% (R$ 149)** |

**Scale — R$ 999 venda:**

| Item | Custo |
|---|---|
| Whisper API (200h) | ~R$ 400 |
| Supabase Pro maior | ~R$ 50 |
| Storage R2 (2 GB) | ~R$ 2 |
| Compute (dedicated) | ~R$ 30 |
| ValidaPay fee | ~R$ 15 |
| **Total custo** | **~R$ 500** |
| **Margem bruta** | **~50% (R$ 499)** |

### Overage (quando passar do tier)

Cobrar **automaticamente no fim do mês** via mesma assinatura:

- Hora extra de transcrição: **R$ 15/h**
- 100 alunos ativos extras: **R$ 20**
- 100 MB KB extra: **R$ 5**
- Curso extra (no tier): **R$ 15/mês**

### Estratégia de margem

- Starter tem margem alta — atrai pequenos infoprodutores
- Pro/Scale margem ~50% — sustentável e dá espaço pra desconto anual
- Upload pré-transcrito = puxa custo Whisper pra zero → margem 80%+ nesses tenants → **incentivar com banner "economize subindo transcrição pronta"**
- Plano anual: 20% off → reduz churn + cash upfront

---

## 6. Funcionalidades Transversais (em todas as fases)

### 6.1 Rate Limiting

- **Por tenant:** 1.000 tool calls/hora no Starter, 5k/Pro, 20k/Scale (sliding window via Redis)
- **Por aluno:** 100 tool calls/hora (anti-abuse)
- **Por endpoint sensível:** `play_lesson` 30/hora por aluno (evita scraping)
- **Por OAuth issue:** 10 emissões/dia por aluno (evita brute force)

Implementação: token bucket no Redis. Header `Retry-After` quando estoura.

### 6.2 Métricas & Analytics

**Por tenant (infoprodutor vê no dashboard):**
- Tool calls totais, por dia/semana/mês
- Top 10 aulas mais consultadas (rank por `play_lesson` + `search_course` hits)
- Top 50 queries de busca (semanticamente clusterizadas com k-means leve sobre embeddings — agrupa "como funciona o funil" e "explica o funil")
- Top 20 timestamps citados (descobre os trechos "gold")
- Drop-off: alunos que pararam de usar (last_active_at > 30 dias)
- Alunos por curso, ativos/inativos

**Por plataforma (você vê):**
- MRR, churn, growth rate
- Tenants próximos do cap (oportunidade de upsell)
- Custo Whisper agregado vs. revenue
- Latência média de tool calls

### 6.3 Progresso do Aluno

- `student_progress` atualizado a cada `play_lesson` com `startSec`
- Frontend widget envia `progress-event` postMessage periódico (a cada 15s ou em pause/seek) → server atualiza `last_position_sec` + `total_watched_sec`
- Lesson marcada `completed` quando `total_watched_sec / duration_sec > 0.85`
- Tool nova `get_my_progress(courseId?)` mostra ao aluno o que já viu

### 6.4 Auth Persistida

- Refresh tokens com rotação (RFC 6749 + 7009)
- Sessions ativas listadas no dashboard do aluno; pode revogar device específico
- Access token TTL: 1h. Refresh TTL: 30 dias.
- Revogação cascade: tenant suspenso → todos os tokens dos alunos invalidados

---

## 7. As 5 Fases

### Fase 0 — Fundação Multi-Tenant (3 semanas)

**Goal:** mesma funcionalidade, mas com schema e isolamento prontos.

**Tarefas:**
- Provisionar Supabase (Postgres + pgvector + Storage + RLS habilitado)
- Migrar dados atuais (1 tenant manual) pro novo schema
- Refatorar tool handlers pra receber `tenantId` + `studentId` no contexto
- Implementar policies RLS em todas as tabelas (`tenant_id` scope)
- Refatorar storage de áudio pra Supabase Storage / R2 (temp, deletar após transcrever)
- CLI interno: `create-tenant <name> <email> <plan>` (você cadastra manualmente)

**Entregável:** o que roda hoje, mas multi-tenant ready.

### Fase 1 — Auth + Hotmart + 1º cliente real (3 semanas)

**Goal:** você vende pro primeiro infoprodutor manualmente; alunos dele autenticam de verdade.

**Tarefas:**
- OAuth 2.0 provider (`/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/revoke`, `/introspect`)
- Magic link via Resend (15min TTL, single-use)
- Refresh tokens com rotação
- Hotmart webhook receiver (`POST /webhooks/hotmart/:tenant_slug`):
  - Valida HMAC com tenant.hotmart_basic_token
  - `PURCHASE_APPROVED` → INSERT em `course_access`
  - `PURCHASE_REFUNDED` / `CHARGEBACK` / `SUBSCRIPTION_CANCELLATION` → revoga
- Hotmart API client (pra validar compra ao emitir token)
- Tenant cadastra `hotmart_product_id ↔ course_id` mapping no admin
- Tool calls validam `student.tenant_id == course.tenant_id` + access ativa

**Entregável:** infoprodutor #1 onboarded, alunos dele logam e conversam.

### Fase 2 — Ingest Self-Service (3 semanas)

**Goal:** infoprodutor adiciona curso sozinho via UI; ingest roda em background.

**Tarefas:**
- BullMQ workers (Redis): `course-ingest`, `transcribe-lesson`, `index-chunks`
- Pipeline ingest:
  - List Panda folder (key do tenant) → cria `lessons` rows
  - Pra cada lesson: download HLS → audio → upload R2 → fila `transcribe-lesson`
  - `transcribe-lesson`: Whisper → grava `transcript` + `transcription_cost_usd` → fila `index-chunks`
  - `index-chunks`: chunk + embed → INSERT chunks → marca lesson `ready`
  - Quando todas as lessons OK → curso `ready`
- **Upload pré-transcrito**: aceita JSON {schema}, pula Whisper, marca `transcript_source = 'uploaded'`
- **Knowledge Base**: upload PDF/MD/TXT → parse text → chunk + embed → grava `materials` + `chunks`
- Dashboard Next.js:
  - "Adicionar curso" wizard (Panda folder ID, Hotmart product IDs, nome)
  - "Ingest progress" com bar por lesson
  - "Upload transcrição pronta" (drag & drop JSON)
  - "Upload material" (drag & drop PDF)

**Entregável:** novos clientes onboardam sem você no loop pro ingest.

### Fase 3 — Tiers + Billing ValidaPay (2 semanas)

**Goal:** assinatura recorrente automática, cota enforced, overage cobrado.

**Tarefas:**
- Tier config seedado no DB
- Enforcement em pontos críticos (before-actions):
  - `enforceQuota(tenant, 'add_course')` → check `count(courses) < tier.courses`
  - `enforceQuota(tenant, 'transcribe', estimatedMinutes)` → projetar mês corrente
  - `enforceQuota(tenant, 'add_student')` → check active_students count
  - `enforceQuota(tenant, 'upload_kb', sizeBytes)` → check current KB total
- ValidaPay integration:
  - **Auth OAuth2 Bearer**: client_credentials grant pra obter token de servidor → refresh quando expira
  - Sandbox: `https://sandbox.validapay.com.br`
  - Produção: `https://api.validapay.com.br`
  - **Múltiplos métodos de pagamento** disponíveis: PIX Automático (recorrência nativa), cartão de crédito, e outros — ValidaPay aceita qualquer formato via webhook
  - Checkout no signup oferece: PIX Automático (default, sem fricção) e cartão recorrente (opção)
  - **Webhook flexível**: ValidaPay envia qualquer schema de payload que a gente configurar — modelamos eventos no nosso shape
  - Eventos críticos a tratar (nomes internos nossos): pagamento confirmado, pagamento falhou, assinatura cancelada, assinatura expirou
  - Pagamento confirmado → estende `subscription_active_until` + atualiza `usage_events`
  - Pagamento falhou → grace 7 dias → auto-suspend (`tenant.status = 'suspended'`)
  - Trial 14 dias Starter ao signup (com método já cadastrado no fim do trial pra cobrar automaticamente)
- Overage tracking → cobrança extra no fim do mês
- Dashboard de uso (gauge real-time: 3/10 cursos, 8.5/10h transcrição, etc)
- Página de pricing pública + upgrade fluxo

**Entregável:** revenue automática, sem você emitir nota.

### Fase 4 — Analytics + Progresso + Polimento (2 semanas)

**Goal:** infoprodutor vê valor dos seus dados; aluno tem continuidade.

**Tarefas:**
- Pipeline de analytics:
  - Toda tool call salva em `tool_calls` (async, fire-and-forget)
  - `search_course` também salva embedding da query em `search_queries`
  - Daily aggregation job: top lessons, top queries, cluster de queries similares
- Dashboard:
  - Aba "Insights" por curso: top aulas, top perguntas, mapa de calor de timestamps
  - Aba "Alunos": lista com last_active, % completion, alertas de drop-off
- Progresso do aluno (Fase 6.3) implementado em ambos widgets (Claude e ChatGPT)
- Tool `get_my_progress` exposta
- Rate limiting (Fase 6.1) implementado
- Sentry + Logtail configurados
- Backups automáticos Supabase (built-in)

**Entregável:** plataforma observável + insights vendáveis pro infoprodutor.

### Fase 5 — Hardening + Escala (2 semanas)

**Goal:** parar de ter você no loop pra coisas operacionais.

**Tarefas:**
- Onboarding 100% self-service: signup → conectar Hotmart (OAuth ou manual key) → conectar Panda (manual key) → trial Starter ativo
- Dashboard aluno (opcional): lista cursos, links pra connector Claude/GPT
- Status page pública
- Documentação pública (developer-facing API se vier demanda)
- Migração final do EasyPanel pro Fly.io (`api`, `worker`, `redis`, `postgres` (managed))
- Plano de DR: backup Postgres + restore drill
- Tier Enterprise: signup leva pra "Fale com vendas"

**Entregável:** SaaS rodando sozinho, suportável remotamente.

### Fase 5.5 — Submissão Apps Directory (OpenAI) + Anthropic Directory (2-3 semanas + tempo de review)

**Goal:** sair do "Custom Connector via URL com dev mode" → "1-click install na vitrine oficial". Marketing massivo + alcance mainstream.

**Pré-requisitos técnicos (devem estar em pé antes de submeter):**

- [ ] Identidade verificada no `platform.openai.com` (PF ou PJ — usar CNPJ se já tiver)
- [ ] OAuth 2.1 com Authorization Code + **PKCE S256** funcionando
- [ ] Discovery endpoints publicados: `/.well-known/oauth-protected-resource` + `/oauth-authorization-server` (ou `/openid-configuration`)
- [ ] mTLS validation do cert da OpenAI (`mtls.prod.connectors.openai.com`) — fail closed em qualquer outro
- [ ] Server retorna `401` + `WWW-Authenticate` em token inválido
- [ ] Tools com `annotations` corretas: `readOnlyHint`, `destructiveHint: false`, `idempotentHint`, `openWorldHint: false` (já temos)
- [ ] `inputSchema` + `outputSchema` em todas as 5 tools (já temos)
- [ ] Tool result separado: `content` (texto), `structuredContent` (dados), `_meta` (UI hints) — já temos
- [ ] Widget MIME `text/html;profile=mcp-app` exato (já temos)
- [ ] `_meta.ui.domain` definido na resource (TODO — apontar pra `askine.cc` ou subdomain)
- [ ] `_meta.ui.csp` completo (já temos)
- [ ] **Decisão de player no ChatGPT** (iframe vs `<video>` HTML5 — ver experimento abaixo)

**Decisão de player no ChatGPT (`<video>` vs `<iframe>` — RESOLVIDO):**

OpenAI explícita: *"Apps using iframes receive extra manual review and are often not approved for broad distribution"*. Nosso ChatGPT path usa iframe pro Panda.

**Resultado do experimento** (`GPT_USE_VIDEO=true` no commit `cf73979`):

Testamos `<video>` + hls.js + MSE no /mcp-gpt com CSP no lugar correto. Console retornou:

```
Loading media from 'blob: ...web-sandbox.oaiusercontent.com/...'
violates "media-src 'self' ... *.tv.pandavideo.com.br cdn.pandavideo.com".
```

- ✅ Boa: nossos `connectDomains`/`resourceDomains` propagaram pra `media-src` (Panda apareceu na lista)
- ❌ Ruim: o scheme `blob:` (criado por MSE) **não é configurável** via _meta — não há chave pra adicionar schemes em CSP

**Decisão final: manter iframe no ChatGPT.** `GPT_USE_VIDEO=false` (default).

**Estratégia de submissão pro Apps Directory:**

Argumentação "iframe é core" — apoiada em:

1. **Conteúdo educacional em vídeo IS o core do produto** (igual Coursera, que passou)
2. **Player nativo do Panda preserva features essenciais:** DRM, analytics, watermark, captura real de progresso, qualidade adaptativa — tirar isso degrada produto
3. **Não há alternativa técnica:** ChatGPT impede `<video>` HTML5 pra fontes externas (blob: bloqueado em media-src, scheme não configurável)
4. **Precedente forte:** Coursera, YouTube, Spotify, Vimeo no Apps Directory todos com iframe pra player próprio

**Conta demo permanente (obrigatória pra reviewers):**

- Tenant: **`demo.askine.cc`** com o curso de teste do MVP (**VMA Produtificação** — 13 aulas, já transcritas, vetores indexados)
- Login: email/senha simples, **sem MFA, SMS, ou verificação por email**
- Credenciais salvas no painel de submissão (rotacionar semestralmente)
- Sample knowledge base: 1-2 PDFs de teste já carregados
- Dashboard tenant: deixar 1-2 cursos abertos com transcrição pronta pra mostrar o fluxo
- **Manter forever** — não desativar nunca, reviewers retestam em updates

**Legal & Negócio (obrigatórios):**

- [ ] CNPJ ativo (vou perguntar se já tem)
- [ ] **Privacy Policy** em `askine.cc/privacidade` cobrindo: categorias de dados, propósitos, recipients (Supabase, ValidaPay, OpenAI, Anthropic, Hotmart), retention, controles do usuário (LGPD-compliant)
- [ ] **Terms of Service** em `askine.cc/termos`
- [ ] **Customer support contact** publicado (`suporte@askine.cc` ou similar) com tempo de resposta declarado
- [ ] Project OpenAI com **global data residency** (NÃO EU — projetos EU não podem submeter)
- [ ] Brasil + PT-BR declarados no campo de localization
- [ ] **CRÍTICO — sem monetização visível no widget:** removemos qualquer texto/CTA tipo "upgrade", "comprar curso", "vire premium". A política proíbe. Tutor é tutor, ponto.

**UX & Design (rejeições comuns):**

- [ ] Nome final na vitrine: **definir** (provavelmente "Askine" + tagline)
- [ ] Logo + favicon (256×256 PNG mínimo) — provisório se a gente não tem designer ainda
- [ ] 4-6 screenshots de fluxos reais (precisamos descobrir dimensões exatas — ambíguo na doc)
- [ ] Texto descritivo do app (~150 palavras, claro, sem hype)
- [ ] Sem fonts customizadas no widget (usar `system-ui` — já fazemos)
- [ ] Cores brand só em botões/ícones (não override de background/texto base)

**Multi-tenant submission:**

OpenAI suporta via **Template submission**:
- 1 demo MCP URL completo (= `demo.askine.cc`)
- 1 Template URL pattern (= `{tenant}.askine.cc/mcp-gpt` — segmento variável)
- **Submissão única cobre todos os infoprodutores futuros.** Cada novo tenant não precisa de re-review.

**Roteiro de testes pra reviewers (entregar junto):**

- 5 prompts exemplo que devem funcionar com a conta demo:
  1. "O que esse curso ensina?"
  2. "Como ele explica esteira de produção?"
  3. "Me mostra a aula 6"
  4. "Cite o trecho onde ele fala de funil de consciência"
  5. "Qual aula é melhor pra começar?"
- Output esperado documentado pra cada um

**Anthropic Directory (paralelo, mais simples):**

Submissão menos rigorosa. Mesma demo tenant. Sem o problema de iframe (Claude já não usa iframe externo no nosso fluxo — usa `<video>`). Provavelmente passamos primeiro lá → marketing inicial enquanto OpenAI revisa.

**Entregável:** "Askine" listada em ambas as vitrines oficiais → install 1-click → mercado mainstream destravado.

**Cronograma:**

- Dev/preparação: 2-3 semanas
- Review Anthropic: ~2-4 semanas (estimativa)
- Review OpenAI: ~4-8 semanas (estimativa, sem SLA oficial — pode levar mais se rolar iteração)

---

## 8. Adapters de Video Source (future-proof)

```typescript
interface VideoSourceAdapter {
  readonly type: 'panda' | 'vimeo' | 'mux' | ...
  listLessons(config: SourceConfig): Promise<LessonMetadata[]>
  getAudioStream(lesson: Lesson): Promise<Readable>     // pra Whisper
  getHlsUrl(lesson: Lesson): string                      // pra Claude <video>
  getEmbedUrl(lesson: Lesson, opts?: { startSec? }): string  // pra ChatGPT iframe
  getThumbnailUrl(lesson: Lesson): string
}
```

**Hoje:** `PandaAdapter` (única implementação).

**Quando expandir:** novo adapter, registrar no `SourceRegistry`, expor no dropdown "Source type" no admin. Sem refator do core.

---

## 9. Open Items

- [x] **Marca:** Askine
- [x] **CNPJ:** 35.735.278/0001-91 (ativo)
- [x] **Domínio:** `askine.cc` registrado e apontado para a VPS
- [ ] **Logo + identidade visual:** em criação
- [ ] **Termos de Uso + Política de Privacidade:** redigir + publicar em `askine.cc/legal` (LGPD-compliant; obrigatório p/ submissão OpenAI + Anthropic)
- [ ] **Emissão de NF:** integrar com emissor (ex: NFE.io, eNotas) pra automatizar — antes do primeiro pagamento confirmado
- [ ] **Conta bancária PJ + Pix CNPJ:** ValidaPay vai depositar lá
- [ ] **Confirmar fee real do ValidaPay** (assumido ~1,5% PIX na análise de margem — validar antes de fechar pricing)

---

## 10. Cronograma Sumário

```
S1-3   Fase 0 — Fundação multi-tenant
S4-6   Fase 1 — Auth + Hotmart + 1º cliente   ← já dá pra começar a vender
S7-9   Fase 2 — Ingest self-service
S10-11 Fase 3 — Tiers + ValidaPay            ← revenue automática
S12-13 Fase 4 — Analytics + progresso
S14-15 Fase 5 — Hardening + scale

Total: ~15 semanas (~3.5 meses) pra produto SaaS completo
```

Pode acelerar pulando F4/F5 — atende suporte manual no começo, isso é OK.
