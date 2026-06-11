# Askine — Modelo de Custo × Preço × Margem

> **Estrutura:** 3 tiers de valor (Start/Pro/Scale) × toggle de cobrança **Mensal ↔ Anual** (anual = 2 meses grátis, ~17%).
> **Cota de transcrição = MENSAL e RENOVÁVEL** (sem rollover — use-it-or-lose-it). Custo de Whisper é variável e recorre conforme o uso do mês.
> Dimensionamento: cotas generosas o bastante pra cobrir quase todo mundo → **add-on é válvula de emergência, não fonte de lucro.**
> Taxas ValidaPay reais · **juros do cartão repassados ao cliente** · **NF 6% sobre o bruto** · Supabase free (infra/tenant ≈ R$0) · Hospedagem R$200/mês.
>
> **Data:** 2026-06-11 · Câmbio: 6 BRL/USD

---

## 1. Inputs de custo

| Variável | Valor | Tipo | Status |
|---|---|---|---|
| Whisper (transcrição) | **R$ 2,16 / hora** | variável **recorrente** (por uso/mês) | ✅ código |
| Storage | R$ 0,10 / GB·mês (free ≈ R$ 0) | variável | ✅ código |
| Nota Fiscal (Simples) | **6% do valor bruto da venda** | variável | ✅ confirmado |
| ValidaPay — PIX à vista | **R$ 0,47 fixo** | variável | ✅ real |
| ValidaPay — Cartão | % por parcela + R$ 0,17 — **juros repassados ao cliente** | **≈ R$ 0 pra mim** | ✅ real |
| Supabase | R$ 0 (free) → ~R$ 150/mês (Pro) ao escalar | fixo | ✅ |
| Hospedagem (EasyPanel/VPS) | **R$ 200/mês** | fixo | ✅ |

> **A virada:** custo de um assinante = **NF (6% do bruto) + transcrição do mês** (variável, conforme uso). Cartão ≈ R$0 (juros do cliente). Infra/tenant ≈ 0.
> No cartão parcelado a NF incide sobre os juros embutidos → absorvo 6% dos juros (**< 1 ponto**). PIX à vista não muda nada.

---

## 2. Planos (3 tiers × toggle Mensal/Anual)

| Capacidade | **Start** | **Pro** ⭐ | **Scale** |
|---|---|---|---|
| Perfil | Low-ticket / começando | Chefe da casa | Negócio escalado |
| Cursos | 1 | 3 | 10 |
| **Transcrição/mês (renova)** | 25h (~75 aulas) | 50h (~150 aulas) | 90h (~270 aulas) |
| Alunos | 500 | 1.000 | 2.500 |
| Storage | 100 MB | 500 MB | 2 GB |

| Preço | **Start** | **Pro** | **Scale** |
|---|---|---|---|
| **Mensal** | R$ 147/mês | R$ 297/mês | R$ 497/mês |
| **Anual** (2 meses grátis) | R$ 1.470/ano | R$ 2.970/ano | R$ 4.970/ano |
| Anual equivale a | R$ 122,50/mês | R$ 247,50/mês | R$ 414,17/mês |
| Economia anual | R$ 294 | R$ 594 | R$ 994 |

> Cota **renova todo mês** e **não acumula**. O infoprodutor grava sempre — a cota acompanha. Quem estoura num mês atípico usa o add-on; quem estoura sempre, sobe de tier.

---

## 3. Custo de transcrição (variável, por uso do mês)

| Plano | Cota/mês | Custo se usar **100%** | Custo se usar **~50%** |
|---|---|---|---|
| Start | 25h | R$ 54,00 | R$ 27,00 |
| Pro | 50h | R$ 108,00 | R$ 54,00 |
| Scale | 90h | R$ 194,40 | R$ 97,20 |

> Cada hora transcrita = R$ 2,16. Mês sem conteúdo novo = custo de transcrição R$ 0.

---

## 4. Margem por cenário de uso

Custo = NF 6% + transcrição do mês (+ PIX 0,47 no anual à vista). Margem cai quanto mais o cliente transcreve.

### Cobrança Mensal (preço cheio/mês)
| Plano | **Uso cheio (piso)** | Uso médio (~50%) | Mês leve (sem novo) |
|---|---|---|---|
| Start | **57,3%** | 75,6% | 94,0% |
| Pro | **57,6%** | 75,8% | 94,0% |
| Scale | **54,9%** | 74,4% | 94,0% |

### Cobrança Anual (/mês efetivo menor → margem menor)
| Plano | **Uso cheio (piso)** | Uso médio (~50%) | Mês leve |
|---|---|---|---|
| Start | **49,9%** | 71,9% | 94,0% |
| Pro | **50,4%** | 72,2% | 94,0% |
| Scale | **47,1%** ⚠️ | 70,5% | 94,0% |

> ⚠️ **Único ponto abaixo de 50%:** Scale **anual** com uso de 100% da cota **todo mês** (270 aulas/mês × 12). Cenário irreal. No mensal o mesmo uso dá 55%; uso realista fica em 70–94%. Todo o resto do sistema respeita o piso de 50%.

---

## 5. Add-ons — válvula de emergência (via PIX à vista)

| Add-on | Preço | Custo | **Margem** |
|---|---|---|---|
| **+10h transcrição** | **R$ 49** | 21,60 + NF 2,94 + PIX 0,47 | **~R$ 24,00 · 49%** |
| +1 curso | R$ 30 | NF 1,80 + PIX 0,47 | ~92% |
| +500 alunos | R$ 80 | NF 4,80 + PIX 0,47 | ~93% |
| +500 MB | R$ 25 | NF 1,50 + PIX 0,47 | ~92% |

> Add-on de horas é **socorro de mês atípico**, com preço camarada (49%) — não é fonte de lucro. Estouro recorrente = sinal de upgrade de tier. Empilhável (+10h × N).

---

## 6. Overhead e break-even

**Overhead = R$ 200/mês (hospedagem)** · ~R$ 350/mês quando o Supabase virar Pro.

Contribuição mensal (uso médio ~50%): Start mensal ~R$111 / anual ~R$88 · Pro mensal ~R$225 / anual ~R$179 · Scale mensal ~R$370 / anual ~R$292.

| Overhead/mês | Cobre com |
|---|---|
| **R$ 200 (hoje)** | 2 Start · ou 1 Pro · ou 1 Scale |
| R$ 350 (+ Supabase Pro) | 3 Start · ou 2 Pro · ou 1 Scale |

---

## 7. Fórmulas

```
custo_transcricao = horas_usadas_no_mes × 2,16      (RENOVÁVEL, sem rollover)
custo_nf          = preco_bruto × 0,06
fee_pix           = 0,47                              (anual à vista)
fee_cartao        = 0                                 (juros repassados)
custo_infra       = 0

margem_mes  = preco − (nf + fee + horas_usadas × 2,16)
lucro_liq   = Σ(contribuicao_mensal) − 200
```

> ✅ **Modelo fechado** — sem rollover, cota mensal 25/50/90h, add-on +10h R$49. Nenhuma pendência (NF confirmada sobre o bruto).
