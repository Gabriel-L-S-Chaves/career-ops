---
name: diagnostico-boards
description: >-
  Diagnostica por que uma empresa do portals.yml não devolve vaga — board vazio,
  erro de rede, slug de 404, api: obsoleto — e conserta a config com evidência de
  requisição real. Use quando o scan ou o verify-portals marcar "live but empty",
  "network error", "board sem vaga extraída", quando uma empresa conhecida parar
  de aparecer no radar, ou quando o usuário pedir para checar os boards.
user_invocable: true
user-invocable: true
arguments: alvo
argument-hint: "[vazio = todos os sintomas | <empresa> | vazios | erros | slugs]"
license: MIT
---

# Diagnóstico de Boards — por que uma empresa sumiu do radar

Escrita em 23/11/2026, depois de um diagnóstico que achou **111 vagas da Nubank
invisíveis há semanas** e um slug de 404 no lugar do board da Rede/Itaú.

---

## ⚠️ A regra que organiza tudo

> **"Board vivo mas vazio" quase nunca significa empresa sem vaga.**
> Significa URL apontando para o lugar errado.

Os dois casos confirmados em 23/11, ambos com o mesmo sintoma e causas
diferentes:

| Empresa | Sintoma | Causa real |
|---|---|---|
| Nubank | `greenhouse/nubank (live but empty)` | `api:` obsoleto vencendo um `careers_url` correto. 111 vagas no Ashby. |
| Rede (Itaú) | `🟡 vazio` no scan-gupy | slug `itau` é página de 404. O board é `vemproitau`. |

Uma empresa grande com board vazio é **sempre** suspeita. Cielo, PicPay, Itaú e
Nubank publicam centenas de vagas por trimestre: board vazio nessas é defeito de
config até prova em contrário.

---

## O alçapão do `api:` vs `careers_url`

Dentro de cada provider, `api:` tem precedência sobre `careers_url`, e os
providers são testados em **ordem alfabética** (`providers/_registry.mjs`).
Quando o `api:` aponta para outro ATS:

1. O provider correto roda seu `detect()`, lê o `api:`, a asserção de host lança,
   o `catch` devolve `null` — e ele desiste.
2. O provider do `api:` obsoleto testa o mesmo campo, a asserção dele passa, e
   ele ganha.
3. O board do `careers_url` nunca é varrido. Sintoma: `live but empty`.

`node validate-portals.mjs` avisa sobre isso desde 23/11 (commit `ea4b572`):

```
warning: tracked_companies[40].api: api: resolves to provider "greenhouse" but
careers_url resolves to "ashby" — api wins, so the careers_url board is never
scanned (shows up as live-but-empty).
```

**Conserto:** apagar a linha `api:` quando o `careers_url` já aponta para o board
certo. `api:` do **mesmo** ATS do `careers_url` é uso legítimo (fixar um board sob
uma careers_url institucional) e não dispara aviso.

---

## Árvore de decisão

Rode nesta ordem. Cada passo custa zero token de LLM.

### 1. O que o validador já sabe

```bash
node validate-portals.mjs
```

Pega `api:` conflitante, provider inexistente, nome duplicado, keyword morta.
Se o aviso aparecer, o diagnóstico acabou aqui.

### 2. Quais boards respondem

```bash
node verify-portals.mjs
```

Três sintomas, três caminhos:

- **`✅ (N live)`** → board certo, segue o jogo.
- **`🟡 live but empty`** → vá para o passo 3. Não aceite como "sem vaga".
- **`❌ network error — fetch failed`** → **pode ser transitório.** Em 23/11 a Dock
  deu `fetch failed` no `verify-portals` e `recruitee(9)` no `resolve-boards`
  minutos depois. Rode o passo 3 antes de concluir qualquer coisa.

### 3. Em qual ATS a empresa publica de verdade

```bash
node resolve-boards.mjs --in data/checar-boards.txt --out data/boards-sugeridos.yml
```

Uma empresa por linha no arquivo de entrada. Testa 10 plataformas com requisição
real e grava só o que respondeu.

**Como ler a saída:**

- `ashby(111)` → board real com 111 vagas. É a resposta.
- `greenhouse` sem número → board existe e devolve zero. Combinado com outro
  provider **com** número, é assinatura de migração de ATS com o board antigo
  deixado no ar.
- **`smartrecruiters` e `workable` sem número são RUÍDO.** Essas duas APIs
  devolvem 200 com lista vazia para conta inexistente, então o probe não
  distingue "existe e está vazio" de "não existe". Aparecem em toda empresa.
  Ignore as duas colunas.
- `gupy` / `inhire` sempre vêm sem número por desenho: o probe só confirma que a
  página existe (presença de `__NEXT_DATA__`), porque esses dois não têm API
  pública. A extração é trabalho do `scan-gupy.mjs`.

### 4. Gupy: board vazio ou slug de 404?

A Gupy responde **200 em qualquer subdomínio**, então `🟡 vazio` no `scan-gupy`
não diz se o board existe.

```bash
node scan-gupy.mjs --debug --dry-run
```

Salva o HTML em `data/gupy-debug/{slug}.html`. Leia os dois marcadores:

```powershell
Get-ChildItem data\gupy-debug\*.html | % { $h=[IO.File]::ReadAllText($_.FullName); $t=[regex]::Match($h,'<title>(.*?)</title>').Groups[1].Value; $id=[regex]::Match($h,'careerPageId\\?"?\s*:\s*"?(\d+)').Groups[1].Value; "{0,-14} {1,8} bytes  careerPageId={2,-6} title={3}" -f $_.Name,$h.Length,$id,$t }
```

```bash
for f in data/gupy-debug/*.html; do
  printf '%-16s %8s bytes  title=%s\n' "$(basename "$f")" "$(wc -c <"$f")" \
    "$(grep -o '<title>[^<]*' "$f" | head -1 | cut -c8-)"
done
```

| Leitura | Significado |
|---|---|
| `title=Não encontrado`, `careerPageId` vazio | **Slug não existe.** É a página de 404 da Gupy. |
| `careerPageId=0` | Esqueleto do SPA, sem empresa associada. Mesma conclusão. |
| `careerPageId` com id e 0 registros | Board real e vazio de verdade. Raro. |

Também vale para `portal.gupy.io`: foi `careerPageId: 0` que fechou aquele
diagnóstico em 13/10 (ver o comentário no `portals.yml`).

### 5. Achar o slug verdadeiro

Dois caminhos, nesta ordem:

**a) Busca web com `site:`.** Procura URL de vaga viva, não página institucional:

```
site:gupy.io "{empresa}" vaga
"{empresa}" vagas carreira gupy.io board
```

Em 23/11 foi assim que apareceu `vemproitau.gupy.io/jobs/10847295` — URL de vaga
real, não palpite.

**b) Testar candidatos com requisição real.** Gerar variantes e deixar o
`resolve-boards` decidir. Adivinhar só é errado quando não se testa:

```bash
node resolve-boards.mjs --in data/slugs-candidatos.txt --only gupy
```

**Rendimento observado:** 11 candidatos testados, 1 acerto — e o acerto foi o que
a busca web já havia indicado. **Faça (a) antes de (b).** Se dez variantes
plausíveis falharem, a empresa provavelmente não publica naquele ATS, e o caminho
dela é o Tier B do `radar-vagas` (post de LinkedIn e "trabalhe conosco").

---

## O que escrever no `portals.yml` depois

Regra do projeto: **nenhuma URL por palpite — tudo passa pelo `resolve-boards`.**
Daí decorre:

- Slug errado → corrigir a `careers_url`, não adicionar entrada nova.
- `api:` de outro ATS → apagar a linha.
- Board inexistente em qualquer plataforma → **comentar a entrada com a data e o
  que foi testado.** Não apagar em silêncio: sem o registro, alguém reinventa o
  mesmo slug morto em três meses.

```yaml
  # ⛔ 23/11/2026 — sem board público na Gupy. Os slugs cielo/picpay/celcoin
  # devolvem a página de 404 ("Não encontrado", careerPageId vazio), e 10
  # variantes testadas com resolve-boards --only gupy também não existem.
  # Caminho destas três é Tier B: LinkedIn e "trabalhe conosco".
```

**`portals.yml` é camada de usuário.** Em sessão cloud ele não está no container
(é gitignored): proponha a edição com número de linha e conteúdo exato, não tente
reescrever o arquivo. Evite mandar `Set-Content` no PowerShell 5.1 sobre ele — grava
BOM, e BOM pode quebrar o parser YAML.

---

## Falso diagnóstico a não repetir

Em 23/11 eu afirmei que a Dock tinha migrado do Recruitee para a Gupy, com base
numa notícia de 2021 e na página de carreira. O `resolve-boards` devolveu
`recruitee(9)` logo depois: o board estava vivo. Eu havia construído uma história
a partir de fonte secundária, sem testar o endpoint — e não podia testar, porque o
proxy do container bloqueia `recruitee.com`.

**Regra:** quando o container não alcança o host, dizer isso e pedir o teste na
máquina do usuário. Nunca converter notícia antiga em diagnóstico de
infraestrutura.

---

## Limites de rede a reconhecer

| Onde | O que acontece |
|---|---|
| Container cloud, `curl`/`WebFetch` | `boards-api.greenhouse.io`, `recruitee.com`, `gupy.io`, `inhire.app` → 403 no túnel do proxy. |
| Container cloud, Chromium | Sem rede nenhuma: `ERR_TUNNEL_CONNECTION_FAILED` até para `example.com`. |
| Container cloud, `WebSearch` | **Funciona.** É o único caminho de descoberta daqui. |
| Máquina do usuário, Chromium | Pode dar `ERR_CERT_AUTHORITY_INVALID` em **todos** os boards de uma vez. Nove de nove falhando junto não é problema do ATS: é interceptação de TLS na rede local (antivírus ou proxy corporativo) com certificado que o Chromium do Playwright não conhece. |

Nunca desabilitar verificação de TLS nem remover `HTTPS_PROXY` para contornar
qualquer um destes.

---

## Varredura só de remotas

Independente do diagnóstico, mas da mesma família: `--remote-only` corta tudo que
não prove ser remoto, em ambos os scanners.

```bash
node scan.mjs --remote-only --dry-run
node scan-gupy.mjs --remote-only --dry-run
```

Dois efeitos que precisam ser ditos ao usuário **antes** de ele ler o resultado:

1. Corta também presencial em Goiânia, que a política dele aceita. Não é
   substituto do scan normal.
2. Híbrido conta como não-remoto, mesmo quando o anúncio diz "remoto 2x/semana".

---

## O que esta skill NÃO faz

- **Não edita `portals.yml` sozinha.** Propõe a edição; o arquivo é do usuário.
- **Não conclui "empresa sem vaga"** sem ter passado pelos passos 3 e 4.
- **Não apresenta vaga.** Isso é `radar-vagas`; aqui o produto é config correta.
- **Não trata `smartrecruiters`/`workable` sem número como achado.**
