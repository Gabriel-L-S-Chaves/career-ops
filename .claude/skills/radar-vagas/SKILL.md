---
name: radar-vagas
description: >-
  Radar de vagas para os segmentos de adquirência, BaaS, AaaS, instituições de
  pagamento e fintechs B2B. Varre empresas-alvo por busca web, aplica os filtros
  do perfil (localização, idioma, nível), verifica liveness e devolve uma
  shortlist com evidência. Use quando o usuário pedir para buscar vagas novas,
  rodar o radar, varrer empresas do setor de pagamentos, ou perguntar o que
  apareceu de vaga.
user_invocable: true
user-invocable: true
arguments: alvo
argument-hint: "[vazio = varredura completa | <empresa> | tier-a | tier-b | novas | verificar]"
license: MIT
---

# Radar de Vagas — Adquirência, BaaS e Fintech B2B

Varredura de vagas nos segmentos do candidato, desenhada para funcionar **em sessões onde os portais estão bloqueados**.

---

## ⚠️ Regra de ferramenta — leia primeiro

**`WebSearch` funciona mesmo quando `WebFetch` está bloqueado.** São caminhos de rede diferentes.

Em sessões cloud, `linkedin.com`, `gupy.io`, `greenhouse.io`, `inhire.app` e afins costumam devolver `EGRESS_BLOCKED` no `WebFetch`. **Isso não significa que não há acesso** — significa que o caminho é a busca.

**Nunca declarar ausência de acesso sem ter testado `WebSearch`.**

Ordem de tentativa:
1. `WebSearch` com `site:` filtrando o board da empresa
2. `WebSearch` genérica pelo nome da empresa mais o cargo
3. `node check-liveness.mjs <url>` — funciona em Gupy, Greenhouse, Ashby e Lever quando a rede permite
4. `WebFetch` — último recurso, costuma falhar em cloud

---

## Contexto obrigatório

Antes de qualquer busca, carregar:

- `cv.md` — o que o candidato sabe fazer
- `modes/_profile.md` — arquétipos, eliminatórios, penalizações, política de localização
- `modes/_custom.md` — regras de processo
- `data/applications.md` — o que já foi avaliado, para não repetir
- `data/scan-history.tsv` — dedup de URLs
- `data/pipeline.md` — o que já está na fila
- `data/radar.md` — empresas-alvo, se existir

---

## Modos

| Argumento | O que faz |
|---|---|
| *(vazio)* | Varredura completa: Tier A e Tier B, todos os segmentos |
| `<empresa>` | Varre uma empresa específica |
| `tier-a` | Só as grandes com ATS próprio |
| `tier-b` | Só as emergentes — busca em post de LinkedIn e "trabalhe conosco" |
| `novas` | Descobre empresas do segmento ainda não mapeadas |
| `verificar` | Só roda liveness sobre `data/verify-queue.txt`, sem buscar nada novo |

---

## Segmentos e empresas-alvo

### Adquirentes e subadquirentes
Stone · Ton · Cielo · Getnet · Rede (Itaú) · PagBank · PicPay · SumUp · Adyen Brasil · Mercado Pago · Appmax · CloudWalk/InfinitePay · Pagar.me · Giro.Tech · Acqio · Paggcerto · Tecpay

### BaaS e AaaS
Dock · Zoop · Celcoin · Swap · Matera · Pismo · QI Tech · Fitbank · Bankly · PayTime · Iugu

### Instituições de pagamento e fintech B2B
Asaas · Cora · Conta Simples · Nomad · Efí Bank · ValeCard · Sem Parar (Corpay) · Inter · C6 Bank

### Infraestrutura e registro
Núclea · CERC · TAG · CRDC · B3 · Elo

### Adjacentes de alto encaixe
Grupo Boticário (franquias + pagamentos) · iFood / iFood Pago · Mercos · UpFlux · Pipefy

> Manter esta lista em `data/radar.md`. Quando uma empresa nova aparecer com bom encaixe, **acrescentar lá**, não aqui — este arquivo é da skill, aquele é do usuário.

---

## ⚠️ O que a busca web NÃO resolve — leia antes de montar query

**`WebSearch` encontra o que o Google indexou, não o que está aberto.** Em boards de ATS o índice atrasa semanas.

Evidência acumulada: 02/08, 4 de 4 encerradas · 17/08, triagem sobre 36 URLs de 15 a 48 dias, várias mortas · 16/09, a Mercos fechou em 5 dias e o iFood não aceitava candidatura · 16/09, **as 3 melhores da varredura estavam encerradas no mesmo dia**, incluindo uma com jobId recente — o que derruba a heurística de estimar idade pelo ID.

**Consequência prática: nunca entregar link profundo de vaga como resultado principal.** Ele apodrece entre a varredura e a leitura.

O que entregar no lugar, quando não há como verificar:
- **Raiz de board** (`https://{empresa}.gupy.io/`) — lista sempre atual
- **Busca salva no portal** (`https://portal.gupy.io/job-search`, filtros aplicados na interface) — consulta ao vivo
- Ver `data/radar-links-vivos.md`, que é a lista mantida disso

**O único canal vivo é a API do ATS** — `scan.mjs` para Greenhouse, Ashby e Lever. Em sessão cloud os hosts de API também caem no proxy (`boards-api.greenhouse.io`, `portal.api.gupy.io` e `{empresa}.gupy.io/api` testados em 16/09: todos bloqueados). **Então a varredura viva roda na máquina do usuário, não aqui.** O papel desta skill em sessão bloqueada é mapear e priorizar, não afirmar disponibilidade.

---

## Consultas de busca

**`site:` funciona, busca ampla não.**

As queries com `site:` devolveram vagas específicas com ID e título. As genéricas ("vaga analista operações fintech remoto") devolveram apenas páginas de listagem do Indeed e do Glassdoor, sem anúncio nenhum. **Comece sempre por `site:` e só use busca ampla para descobrir empresa nova** — e trate o retorno como mapa de empresa, não como vaga disponível.

### 1ª linha — por board de empresa (use isto primeiro)

```
site:asaas.gupy.io analista operações produto dados
site:pagseguro.gupy.io analista conciliação pagamentos
site:job-boards.greenhouse.io/stone business analyst remoto
site:grupoboticario.gupy.io analista operações financeiras remoto
site:{empresa}.gupy.io {cargo}
```

Dá para agrupar boards com `OR` numa query só:
```
site:cielo.gupy.io OR site:picpay.gupy.io OR site:celcoin.gupy.io analista operações
```

### 2ª linha — por cargo e segmento (só para descobrir empresa nova)

```
vaga "analista de operações" adquirência remoto 2026
"product operations" fintech pagamentos remoto Brasil
vaga "antecipação de recebíveis" analista operações
```

⚠️ Espere páginas de agregador. Use para **mapear empresas**, não para achar vaga.

### 3ª linha — combinações raras (prioridade máxima quando retornam)

```
vaga operações "inteligência artificial" fintech pagamentos remoto
vaga franquias "meios de pagamento" analista
vaga conciliação chargeback adquirência remoto
vaga operações BACEN "arranjo de pagamento"
```

### 4ª linha — Tier B, o canal menos disputado

```
{empresa} linkedin vagas contratando
site:linkedin.com/posts {empresa} vaga
{empresa} trabalhe conosco carreiras
```

Fintechs emergentes anunciam vaga em post de LinkedIn, sem ATS. Não há concorrência de 200 candidatos porque a vaga nunca foi indexada por agregador.

---

## Filtros — aplicar nesta ordem

### 1. Localização (REVISTO 16/09 — não é mais eliminatório absoluto)

Ordem de preferência:

1. **100% remoto** — preferência, sem ressalva
2. **Presencial ou híbrido em Goiânia-GO** — equivale a remoto
3. **Fora de Goiânia** → **avaliar, não descartar.** Registrar explicitamente se compensa:
   - a empresa custeia a mudança, **ou**
   - salto relevante de cargo (Analista → Coordenador, Especialista, Sênior), **ou**
   - salto relevante de salário
4. **Modalidade não declarada** → marcar "confirmar modalidade"

Motivo da mudança: o candidato quer sair da empresa atual o quanto antes. Localização virou trade-off, não muro.

### 2. Idioma (CONTINUA ELIMINATÓRIO)
`cv.md` declara inglês básico, em curso.

- Inglês avançado ou fluente exigido → descartar
- **Anúncio escrito inteiramente em inglês** → tratar como exigência de inglês de trabalho, mesmo sem dizer. Triagem por vídeo em inglês é gate imediato
- Inglês como diferencial ou nice to have → passa, registrar

### 3. Nível (REVISTO 16/09)

**Estágio e trainee** → descartar, sempre.

**Júnior** → **aceito**, desde que:
- a vaga seja **100% remota**, **e**
- a empresa seja do **setor** de fintech, pagamentos, adquirência ou BaaS

Júnior presencial, ou júnior fora do setor → descartar.

**Head ou gerente com gestão formal de força de vendas** → descartar.
**Coordenador ou especialista sem gestão de pessoas** → passa, e é bom sinal.

### 4. Função (ELIMINATÓRIO de fato)
Vendas de campo, prospecção, gestão de carteira comercial → descartar.
⚠️ **O título engana.** Ler as responsabilidades antes de decidir — precedentes #040 (BTG) e #039 (Mercado Pago), ambas com "adquirência" no título e vendas no corpo.

### 5. Penalizações (reduzem, não eliminam)
SQL avançado como requisito central · Looker/Metabase/Tableau como core · capacity planning e forecast · plataformas de CS · agregador de vagas · vaga saturada (mais de 100 candidatos ou mais de 30 dias no ar) · contrato temporário

**Salário abaixo de R$ 5.000** → registrar como sinal, **não descartar**. O candidato aceita piso menor em empresa de bom perfil, dada a urgência de saída.

**Setor fora de fintech** → penalização leve **se a vaga for remota**; descarte se for presencial fora de Goiânia sem compensação.

### 6. Regime de contratação
**CLT e PJ são aceitos.** PJ exige remuneração **equivalente** ao CLT — não o mesmo valor nominal. Ver a conta em `modes/_profile.md`.

Ao encontrar vaga PJ: **não descartar**, mas registrar no achado que o valor precisa passar no teste de equivalência.

### 7. Dedup
Cruzar com `data/applications.md` e `data/scan-history.tsv`.
Mesma empresa e mesmo cargo → **não reavaliar**, atualizar a linha existente.
Empresa igual com cargo diferente → é vaga nova; registrar o ID do anúncio nas notas.

---

## Verificação de liveness — OBRIGATÓRIA

**Nenhuma vaga é apresentada sem verificação.** Aprendido em 02/08: 4 de 4 vagas de busca web estavam encerradas. Repetido em 16/09: a Mercos fechou em 5 dias, e o iFood já não aceitava candidatura.

```bash
node check-liveness.mjs --file data/verify-queue.txt --throttle=1500
```

Se a rede bloquear, **dizer isso e marcar `unconfirmed`** — nunca apresentar como verificada uma vaga que não foi.

Sinais de encerramento a procurar no texto: "inscrições encerradas" · "não aceita candidaturas" · "no longer accepting applications" · "vaga encerrada".

---

## Saída

Duas listas, **nunca misturadas**:

### ✅ Verificadas ativas
Tabela com: empresa · cargo · modalidade · idade do anúncio · encaixe estimado · link

### ⚠️ A confirmar
Mesma tabela, com o motivo de não ter sido possível verificar.

### ⛔ Descartadas
Uma linha por vaga, com o motivo objetivo. **Sempre mostrar** — o usuário precisa ver o que foi filtrado e por quê.

### Ordenação
Por `(encaixe × urgência de fechamento)`. Vaga recente com bom encaixe vem antes de vaga antiga com encaixe ótimo — a janela pode ser de 5 dias.

---

## Depois da varredura

1. **Acrescentar as novas URLs** a `data/pipeline.md`, no formato `- [ ] {url} | {empresa} | {cargo} | {modalidade}`
2. **Regenerar** `data/verify-queue.txt` com o que passou nos filtros
3. **Não avaliar automaticamente.** Apresentar a shortlist e esperar o usuário escolher
4. Para cada vaga que o usuário mandar avaliar: rodar `oferta`, e **gerar o dossiê da empresa** se o score for ≥ 3.0 (ver `modes/_custom.md`)

---

## O que este radar NÃO faz

- **Não submete candidatura.** Nunca. Gera material, para antes do envio
- **Não inventa vaga.** Se a busca não retornou, dizer que não retornou
- **Não apresenta vaga sem verificação** — nem como "a confirmar", salvo quando a limitação de rede for declarada explicitamente
- **Não reavalia** o que já está no tracker com o mesmo cargo

---

## Lição que motivou esta skill

Em 17/08, a triagem foi feita sobre 36 URLs não verificadas, com idade de 15 a 48 dias. Várias estavam encerradas, e o usuário notou antes do sistema.

Em 16/09, a Mercos — Product Manager remoto, CLT, carreira especialista, **4.0/5** — foi publicada em 11/09 e fechou em até 5 dias.

**A conclusão: verificar antes de triar, e rodar com frequência.** Uma janela de 5 dias exige varredura semanal, não varredura quando chega um lote de links.
