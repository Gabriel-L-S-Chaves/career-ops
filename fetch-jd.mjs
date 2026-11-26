#!/usr/bin/env node
/**
 * fetch-jd.mjs — baixa o texto de um anuncio de vaga e salva em jds/.
 *
 * O gargalo recorrente desta busca: as vagas chegam ao pipeline por scan, mas
 * avaliar exige o TEXTO do anuncio, e colar a pagina do navegador traz junto
 * menu, rodape, banner de cookie e "vagas semelhantes". Em 17/11 um anuncio
 * colado do LinkedIn veio com ~200 linhas de navegacao em volta de 40 de
 * conteudo. Este script busca a pagina num Chromium e devolve so o anuncio.
 *
 * Nao avalia nada, nao se candidata a nada, nao toca no tracker. Salva em
 * jds/ e imprime no terminal, pronto para colar numa conversa.
 *
 * Uso
 * ───
 *   node fetch-jd.mjs <url> [url...]          # URLs explicitas
 *   node fetch-jd.mjs --from-pipeline         # tudo que esta em data/pipeline.md
 *   node fetch-jd.mjs --from-pipeline --grep=Asaas   # so as linhas que casam
 *   node fetch-jd.mjs --from-pipeline --limit=3
 *   node fetch-jd.mjs <url> --quiet           # so grava, nao imprime
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const FROM_PIPELINE = flag('from-pipeline');
const QUIET = flag('quiet');
const GREP = opt('grep');
const LIMIT = Number(opt('limit', '0')) || Infinity;
const OUT_DIR = 'jds';
const PIPELINE = join('data', 'pipeline.md');

/**
 * Sinais de que a pagina capturada e o INDICE do board, e nao um anuncio.
 *
 * 18/11/2026: a vaga da RD Station tinha sido removida, o Greenhouse
 * redirecionou para o indice do board, e o script salvou a pagina
 * institucional como se fosse o anuncio — com titulo "Jobs at RD Station",
 * texto sobre beneficios e uma lista de duas vagas nenhuma delas a buscada.
 * Entregar isso como JD e pior que falhar: um texto plausivel e errado leva a
 * uma avaliacao inteira baseada em nada.
 */
const INDEX_PAGE_SIGNALS = [
  /create a job alert/i,
  /\b\d+\s+jobs?\b/i,
  /^jobs at /i,
  /banco de talentos/i,
  /todas as vagas/i,
  /ver todas as (vagas|oportunidades)/i,
];

/** Ruido de navegacao que nenhuma vaga precisa. Comparado em minusculas. */
const NOISE = [
  'cookie', 'aceitar todos', 'política de privacidade', 'politica de privacidade',
  'vagas semelhantes', 'vagas relacionadas', 'compartilhar', 'voltar para',
  'candidatura simplificada', 'pular para', 'acessibilidade',
];

const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

/** Le as URLs do pipeline, com a empresa e o cargo que o scan anotou. */
function fromPipeline() {
  if (!existsSync(PIPELINE)) {
    console.error(`erro: ${PIPELINE} nao encontrado. Rode na raiz do career-ops.`);
    process.exit(1);
  }
  const out = [];
  for (const line of readFileSync(PIPELINE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/- \[([ x])\]\s+(https?:\/\/\S+)(.*)$/);
    if (!m) continue;
    if (GREP && !line.toLowerCase().includes(GREP.toLowerCase())) continue;
    out.push({ url: m[2], note: m[3].replace(/^\s*\|\s*/, '').trim(), done: m[1] === 'x' });
  }
  return out;
}

/**
 * Extrai o anuncio da pagina ja carregada.
 *
 * Estrategia: preferir <main> ou o maior bloco de texto da pagina, e so entao
 * cair para o <body> inteiro. Depois corta linhas de navegacao conhecidas e
 * colapsa linhas em branco repetidas. Deliberadamente conservador: e melhor
 * sobrar um pedaco de menu do que cortar meio requisito.
 */
async function extract(page) {
  return page.evaluate(() => {
    for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'svg']) {
      for (const el of document.querySelectorAll(sel)) el.remove();
    }
    // Ordem de PREFERENCIA, nao de tamanho. Pegar "o maior" era errado: o
    // <body> contem o <main> e portanto sempre ganha, o que trazia de volta
    // todo o ruido que escolher o <main> deveria evitar. Aceita-se o primeiro
    // container semantico com conteudo de verdade; o body e so o ultimo caso.
    const candidates = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('article'),
    ].filter(Boolean);
    for (const el of candidates) {
      const t = el.innerText ?? '';
      if (t.trim().length >= 200) return { text: t, title: document.title };
    }
    return { text: document.body?.innerText ?? '', title: document.title };
  });
}

function clean(raw) {
  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
  const kept = [];
  let blanks = 0;
  for (const line of lines) {
    const low = line.trim().toLowerCase();
    if (!low) {
      if (++blanks > 1) continue;
      kept.push('');
      continue;
    }
    blanks = 0;
    if (low.length < 60 && NOISE.some((n) => low.includes(n))) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

const targets = FROM_PIPELINE
  ? fromPipeline().slice(0, LIMIT === Infinity ? undefined : LIMIT)
  : args.filter((a) => /^https?:\/\//.test(a)).map((url) => ({ url, note: '' }));

if (targets.length === 0) {
  console.error('erro: nenhuma URL. Passe URLs ou use --from-pipeline.');
  process.exit(1);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

console.log(`\n📄 Buscando ${targets.length} anuncio(s)...\n`);

const browser = await chromium.launch();
const page = await browser.newPage();
const saved = [];
let indexPages = 0;

for (const t of targets) {
  process.stdout.write(`  ${t.note || t.url.slice(0, 60)} ... `);
  try {
    await page.goto(t.url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    // networkidle e um luxo; se nao vier, seguimos com o que carregou.
  }
  await page.waitForTimeout(2000);

  try {
    const { text, title } = await extract(page);
    const body = clean(text);
    if (body.length < 200) {
      console.log(`⚠️  so ${body.length} caracteres — pagina pode nao ter carregado`);
      continue;
    }

    // Antes de salvar: isto e mesmo um anuncio, ou o indice do board?
    const haystack = `${title}\n${body}`;
    const hits = INDEX_PAGE_SIGNALS.filter((re) => re.test(haystack));
    if (hits.length >= 2) {
      console.log('⚠️  parece o INDICE do board, nao um anuncio — vaga provavelmente removida');
      console.log(`      titulo: ${String(title).slice(0, 60)}`);
      console.log('      nada salvo. Confirme com check-liveness.mjs');
      indexPages++;
      continue;
    }
    const name = `${slug(t.note || title || 'vaga')}.md`;
    const path = join(OUT_DIR, name);
    const header = [
      `# ${title || t.note || 'Vaga'}`,
      '',
      `**URL:** ${t.url}`,
      `**Capturado em:** ${new Date().toISOString().slice(0, 10)} via fetch-jd.mjs`,
      t.note ? `**Anotacao do scan:** ${t.note}` : '',
      '',
      '---',
      '',
    ].filter((l) => l !== '').join('\n');
    writeFileSync(path, `${header}\n${body}\n`, 'utf8');
    saved.push({ path, chars: body.length, title: title || t.note });
    console.log(`✅ ${body.length} caracteres → ${path}`);
  } catch (err) {
    console.log(`❌ ${err.message.split('\n')[0].slice(0, 80)}`);
  }
}

await browser.close();

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`${saved.length} anuncio(s) salvos em ${OUT_DIR}/`);
if (indexPages) console.log(`${indexPages} pagina(s) de indice descartada(s) — vaga removida do board`);
console.log("");

if (!QUIET) {
  for (const s of saved) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(readFileSync(s.path, 'utf8'));
  }
}
