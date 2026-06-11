# Askine — Simulação de Planos

> 3 tiers (Start/Pro/Scale) × toggle **Mensal ↔ Anual**. Anual = 2 meses grátis (~17%).
> **Cota de transcrição mensal e renovável (sem rollover).** Base de custo: [cost-margin-model.md](cost-margin-model.md) · **Data:** 2026-06-11

---

## 0. Premissas

| Item | Decisão |
|---|---|
| Juros do cartão | **Repassados ao cliente** → meu lucro independe da parcela |
| PIX | Só **à vista** (planos anuais). Mensal não tem PIX. |
| Mensal | **Só cartão recorrente** |
| Anual | **PIX à vista** ou cartão até 12× (com juros) |
| NF | **6% sobre o valor bruto da venda** |
| Cota de transcrição | **Mensal, renovável, sem rollover.** Estouro de mês → add-on; estouro sempre → upgrade |
| Infra/tenant | ≈ R$ 0 (Supabase free) · Overhead fixo **R$ 200/mês** |

---

## 1. Cards dos planos

```
            ┌───────────┐  ┌───────────┐  ┌───────────┐
            │   START   │  │ ⭐ PRO    │  │   SCALE   │
            │ Começando │  │  Popular  │  │ Escalado  │
            ├───────────┤  ├───────────┤  ├───────────┤
  Mensal    │ R$147/mês │  │ R$297/mês │  │ R$497/mês │
  Anual     │ R$122/mês │  │ R$247/mês │  │ R$414/mês │
            │ (1.470/a) │  │ (2.970/a) │  │ (4.970/a) │
            └───────────┘  └───────────┘  └───────────┘
   Cursos        1              3              10
   Transcr/mês  25h            50h            90h
   Alunos       500           1.000          2.500
   Storage     100MB          500MB           2GB
```

🟢 **[ Toggle: Mensal / Anual — economize 2 meses ]**

---

## 2. MEU lucro por assinante (varia com o uso da cota)

A transcrição renova todo mês, então a margem oscila: cheia quando o cliente grava muito, ~94% quando não sobe nada.

### Margem por uso — Mensal
| Plano | Uso cheio (piso) | Uso médio (~50%) | Mês leve |
|---|---|---|---|
| Start | 57% | 76% | 94% |
| Pro | 58% | 76% | 94% |
| Scale | 55% | 74% | 94% |

### Margem por uso — Anual
| Plano | Uso cheio | Uso médio | Mês leve |
|---|---|---|---|
| Start | 50% | 72% | 94% |
| Pro | 50% | 72% | 94% |
| Scale | 47%* | 70% | 94% |

\* Scale anual, 100% da cota todo mês (270 aulas/mês × 12) — cenário irreal. Realista: 70–94%.

---

## 3. Formas de pagamento e parcelas

**Mensal:** cartão recorrente (Start ~R$153/mês, Pro ~R$309, Scale ~R$517 com juros 1× repassados).

**Anual** — PIX à vista ou cartão (juros repassados, gross-up). Aproximado, confira no painel:

| Plano (anual) | PIX à vista | 6× | 12× |
|---|---|---|---|
| Start (R$ 1.470) | R$ 1.470 | R$ 267,18 ×6 | **R$ 141,13 ×12** |
| Pro (R$ 2.970) | R$ 2.970 | R$ 539,76 ×6 | **R$ 285,12 ×12** |
| Scale (R$ 4.970) | R$ 4.970 | R$ 903,29 ×6 | **R$ 477,09 ×12** |

> **🔥 Gancho:** o **anual em 12×** sai mais barato/mês que o mensal em todos os tiers (Pro 285 < 297 · Scale 477 < 497). Argumento forte de checkout.

---

## 4. Lucro líquido e break-even

**Lucro líquido = Σ(contribuição mensal) − R$ 200.** Contribuição varia com o uso; tabela em uso médio (~50% da cota):

| Plano | Contribuição/mês — Mensal | Anual |
|---|---|---|
| Start | ~R$ 111 | ~R$ 88 |
| Pro | ~R$ 225 | ~R$ 179 |
| Scale | ~R$ 370 | ~R$ 292 |

**Break-even:** 2 Start, ou 1 Pro, ou 1 Scale cobrem o overhead.

---

## 5. Simulador de mix

```
lucro_liquido_mensal = Σ (assinantes × contribuição_do_plano) − 200
caixa_adiantado      = Σ (assinantes_anuais × preço_anual)
```

### Exemplo: 10 Start + 6 Pro + 3 Scale (60% anual, uso médio)

| Plano | Qtd | Subtotal/mês | Caixa upfront |
|---|---|---|---|
| Start (6 mensal + 4 anual) | 10 | 6×111 + 4×88 = **R$ 1.018** | 4×1.470 = R$ 5.880 |
| Pro (2 mensal + 4 anual) | 6 | 2×225 + 4×179 = **R$ 1.166** | 4×2.970 = R$ 11.880 |
| Scale (1 mensal + 2 anual) | 3 | 1×370 + 2×292 = **R$ 954** | 2×4.970 = R$ 9.940 |
| **Total contribuição** | 19 | **R$ 3.138/mês** | **R$ 27.700** |
| − Overhead | | − R$ 200 | |
| **= Lucro líquido** | | **≈ R$ 2.938/mês** | + R$ 27.700 de caixa |

> Contribuição menor que no modelo de cota total — é o custo real de dar transcrição que renova todo mês. Ainda assim, margem rodando em 70–94% e caixa adiantado forte.

---

## 6. Add-ons — válvula de emergência

| Add-on | Preço | Margem |
|---|---|---|
| **+10h transcrição** | R$ 49 | ~49% |
| +1 curso | R$ 30 | ~92% |
| +500 alunos | R$ 80 | ~93% |
| +500 MB | R$ 25 | ~92% |

Socorro de mês atípico, preço camarada. Estouro recorrente = sinal de upgrade.

---

## 7. Recomendações

1. **Toggle com anual destacado** ("Economize 2 meses").
2. **Anual em 12× como isca** — mais barato/mês que o mensal.
3. **Cota mensal generosa (25/50/90h)** cobre quase todo mundo → add-on raro, sem cara de armadilha.
4. **Mensal:** cartão recorrente. **Anual:** PIX à vista como principal.

## 8. Status

✅ **Modelo fechado** — cota mensal 25/50/90h sem rollover, add-on +10h R$49, toggle anual, NF sobre o bruto, overhead R$200. Nenhuma pendência.
