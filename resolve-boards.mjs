#!/usr/bin/env node
/**
 * resolve-boards.mjs — descobre em qual ATS cada empresa publica, testando.
 *
 * Problema que resolve: ampliar o `portals.yml` para centenas de empresas exige
 * uma `careers_url` por empresa, e escrever essas URLs à mão é adivinhação. O
 * provider da Gupy nasceu de um palpite documental, apontou para uma API que não
 * existe e devolveu 404 por duas semanas sem ninguém notar. Este script inverte
 * isso: gera slugs a partir do nome, bate em cada plataforma e grava apenas o
 * que respondeu com vagas de verdade.
 *
 * Uso:
 *   node resolve-boards.mjs                          # lê data/empresas-alvo.txt
 *   node resolve-boards.mjs --in lista.txt
 *   node resolve-boards.mjs --out data/boards.yml    # trecho pronto p/ portals.yml
 *   node resolve-boards.mjs --only gupy,greenhouse   # subconjunto de plataformas
 *   node resolve-boards.mjs --concurrency 6          # padrão 6
 *   node resolve-boards.mjs --resume                 # continua de onde parou
 *
 * Zero token de LLM: é só HTTP e JSON.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// Charset seguro para interpolar em URL. Qualquer slug fora disto é descartado
// antes de virar requisição — é a mesma defesa que scan-ats-full.mjs aplica ao
// dataset público de empresas.
// Mínimo de 2 caracteres, não 4: siglas reais do setor — xp, elo, bin — seriam
// descartadas por um mínimo maior e a empresa nunca seria testada.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,47}[a-z0-9])?$/;

// ── Plataformas ────────────────────────────────────────────────────────────
// `url` monta o endereço a partir do slug; `ok` recebe a resposta já parseada e
// devolve quantas vagas vieram (0 = board existe mas está vazio, null = não é
// este ATS). `careers` é a URL humana que entra no portals.yml.
const PLATFORMS = {
  greenhouse: {
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    kind: 'json',
    ok: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
    careers: (s) => `https://job-boards.greenhouse.io/${s}`,
  },
  lever: {
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    kind: 'json',
    ok: (j) => (Array.isArray(j) ? j.length : null),
    careers: (s) => `https://jobs.lever.co/${s}`,
  },
  ashby: {
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    kind: 'json',
    ok: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
    careers: (s) => `https://jobs.ashbyhq.com/${s}`,
  },
  recruitee: {
    url: (s) => `https://${s}.recruitee.com/api/offers/`,
    kind: 'json',
    ok: (j) => (Array.isArray(j?.offers) ? j.offers.length : null),
    careers: (s) => `https://${s}.recruitee.com`,
  },
  breezy: {
    url: (s) => `https://${s}.breezy.hr/json`,
    kind: 'json',
    ok: (j) => (Array.isArray(j) ? j.length : null),
    careers: (s) => `https://${s}.breezy.hr`,
  },
  smartrecruiters: {
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings`,
    kind: 'json',
    ok: (j) => (Array.isArray(j?.content) ? j.content.length : null),
    careers: (s) => `https://careers.smartrecruiters.com/${s}`,
  },
  workable: {
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    kind: 'json',
    ok: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
    careers: (s) => `https://apply.workable.com/${s}`,
  },
  teamtailor: {
    url: (s) => `https://${s}.teamtailor.com/jobs.rss`,
    kind: 'xml',
    ok: (t) => (t.includes('<rss') || t.includes('<feed') ? (t.match(/<item>/g) || []).length : null),
    careers: (s) => `https://${s}.teamtailor.com/jobs`,
  },
  // Gupy e InHire não expõem API pública: a página responde em HTML com os dados
  // embutidos (Next.js). Aqui só confirmamos que o board EXISTE — a extração das
  // vagas é trabalho do provider.
  gupy: {
    url: (s) => `https://${s}.gupy.io/`,
    kind: 'html',
    ok: (t) => (t.includes('__NEXT_DATA__') || t.includes('self.__next_f') ? 0 : null),
    careers: (s) => `https://${s}.gupy.io`,
  },
  inhire: {
    url: (s) => `https://${s}.inhire.app/`,
    kind: 'html',
    ok: (t) => (t.includes('__NEXT_DATA__') || t.includes('self.__next_f') ? 0 : null),
    careers: (s) => `https://${s}.inhire.app`,
  },
};

// ── Slugs ──────────────────────────────────────────────────────────────────
/** Variantes plausíveis de slug para um nome comercial, da mais à menos provável. */
export function slugVariants(name) {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acento
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // "PagBank (PagSeguro)" → "pagbank"
    .replace(/\b(s\.?a\.?|ltda|group|grupo|brasil|brazil|inc|co|tecnologia|pagamentos|bank)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return [];
  const words = base.split(/\s+/);
  // Ordem importa: as formas completas vão primeiro e a varredura para no
  // primeiro acerto com vagas. A primeira palavra sozinha é a mais arriscada
  // — "software" casaria com qualquer board chamado software — por isso fica
  // por último, e o slug escolhido aparece na saída para conferência.
  const out = new Set([
    words.join(''), // "starkbank"
    words.join('-'), // "stark-bank"
    words.slice(0, 2).join(''), // "softwareexpress", quando há cauda descartável
    words[0], // "stark"
  ]);
  // Nome com a palavra removida acima pode ser o slug real: "pagbank" vs "pagbankbrasil"
  const raw = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  out.add(raw);
  return [...out].filter((s) => SLUG_RE.test(s));
}

// ── HTTP ───────────────────────────────────────────────────────────────────
async function probe(platform, slug) {
  const p = PLATFORMS[platform];
  const url = p.url(slug);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: p.kind === 'json' ? 'application/json' : '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) return null;
    const text = await res.text();
    let count;
    if (p.kind === 'json') {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return null; // 200 em HTML onde se esperava JSON = página de erro
      }
      count = p.ok(json);
    } else {
      count = p.ok(text);
    }
    if (count === null) return null;
    return { platform, slug, count, careers: p.careers(slug), api: url };
  } catch {
    return null; // timeout, DNS, TLS — tratados como "não é aqui"
  }
}

/** Testa todas as plataformas × slugs de uma empresa; devolve os acertos. */
async function resolveCompany(name, platforms) {
  const slugs = slugVariants(name);
  const hits = [];
  for (const slug of slugs) {
    const found = await Promise.all(platforms.map((pl) => probe(pl, slug)));
    for (const f of found) if (f) hits.push(f);
    // Um acerto com vagas já basta: não gastar requisição nas outras variantes.
    if (hits.some((h) => h.count > 0)) break;
  }
  return { name, hits };
}

// ── Execução com limite de paralelismo ─────────────────────────────────────
async function mapLimit(items, limit, fn, onDone) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
        onDone?.(results[i], i, items.length);
      }
    }),
  );
  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────────
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const IN = arg('--in', 'data/empresas-alvo.txt');
const OUT = arg('--out', 'data/boards-resolvidos.yml');
const STATE = 'data/cache/resolve-boards-state.json';
const CONCURRENCY = Math.max(1, Math.min(12, Number(arg('--concurrency', '6')) || 6));
const ONLY = arg('--only', '');
const RESUME = process.argv.includes('--resume');

const platforms = ONLY
  ? ONLY.split(',').map((s) => s.trim()).filter((s) => s in PLATFORMS)
  : Object.keys(PLATFORMS);

if (!platforms.length) {
  console.error(`--only não casou com nenhuma plataforma. Disponíveis: ${Object.keys(PLATFORMS).join(', ')}`);
  process.exit(1);
}
if (!existsSync(IN)) {
  console.error(`Lista não encontrada: ${IN}`);
  process.exit(1);
}

const names = readFileSync(IN, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*$/, '').trim())
  .filter(Boolean);

let done = {};
if (RESUME && existsSync(STATE)) {
  try {
    done = JSON.parse(readFileSync(STATE, 'utf8'));
    console.log(`--resume: ${Object.keys(done).length} empresa(s) já resolvidas, pulando.`);
  } catch {
    console.log('--resume: estado ilegível, começando do zero.');
  }
}

const pending = names.filter((n) => !(n in done));
console.log(
  `Resolvendo ${pending.length} de ${names.length} empresa(s) em ${platforms.length} plataforma(s), ${CONCURRENCY} em paralelo.\n`,
);

let processed = 0;
const started = Date.now();

const results = await mapLimit(pending, CONCURRENCY, (n) => resolveCompany(n, platforms), (r) => {
  processed++;
  const mark = r.hits.length ? (r.hits.some((h) => h.count > 0) ? '✓' : '○') : '·';
  const detail = r.hits.length
    ? r.hits.map((h) => `${h.platform}${h.count > 0 ? `(${h.count})` : ''}`).join(' ')
    : '';
  console.log(`  ${mark} ${String(processed).padStart(3)}/${pending.length}  ${r.name.padEnd(28)} ${detail}`);
  done[r.name] = r.hits;
  if (processed % 20 === 0) saveState();
});

function saveState() {
  try {
    mkdirSync(path.dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(done, null, 1));
  } catch {
    /* estado é conveniência; falhar aqui não derruba a varredura */
  }
}
saveState();

// ── Saída ──────────────────────────────────────────────────────────────────
const all = names.map((n) => ({ name: n, hits: done[n] || [] }));
const withJobs = all.filter((r) => r.hits.some((h) => h.count > 0));
const emptyBoard = all.filter((r) => r.hits.length && !r.hits.some((h) => h.count > 0));
const misses = all.filter((r) => !r.hits.length);

const lines = [
  '# Gerado por resolve-boards.mjs — NÃO editar à mão.',
  `# ${new Date().toISOString().slice(0, 10)} · ${withJobs.length} board(s) com vagas de ${names.length} empresa(s).`,
  '#',
  '# Cole o bloco abaixo dentro de `tracked_companies:` no portals.yml.',
  '# Cada entrada foi confirmada por requisição real — nenhuma URL é palpite.',
  '',
];
for (const r of withJobs) {
  // Quando mais de uma plataforma responde, fica a que tem mais vagas.
  const best = r.hits.slice().sort((a, b) => b.count - a.count)[0];
  lines.push(`  - name: ${/[:#]/.test(r.name) ? JSON.stringify(r.name) : r.name}`);
  lines.push(`    careers_url: ${best.careers}`);
  // O slug entra no comentário de propósito: um acerto por primeira-palavra
  // ("software") pode ser outra empresa, e isso só se vê olhando o slug.
  lines.push(
    `    enabled: true   # ${best.platform} · slug "${best.slug}" · ${best.count} vaga(s) em ${new Date().toISOString().slice(0, 10)}`,
  );
}
if (emptyBoard.length) {
  lines.push('');
  lines.push('# Board existe mas estava vazio na varredura — descomente para acompanhar:');
  for (const r of emptyBoard) {
    const best = r.hits[0];
    lines.push(`#  - name: ${r.name}`);
    lines.push(`#    careers_url: ${best.careers}   # ${best.platform}`);
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n') + '\n');

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${'─'.repeat(60)}`);
console.log(`✓ ${withJobs.length} com vagas   ○ ${emptyBoard.length} board vazio   · ${misses.length} sem board público`);
console.log(`Gravado em ${OUT}  (${mins} min)`);
if (misses.length) {
  console.log(`\nSem board público (vão pelo caminho Tier B — LinkedIn e "trabalhe conosco"):`);
  console.log('  ' + misses.map((r) => r.name).join(', '));
}
console.log('');
