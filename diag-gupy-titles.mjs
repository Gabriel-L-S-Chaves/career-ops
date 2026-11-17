#!/usr/bin/env node
/**
 * diag-gupy-titles.mjs — diagnostico: a varredura Gupy esta lendo os titulos?
 *
 * Em 17/11/2026 o scan-gupy.mjs leu 1.196 vagas em tres empresas e descartou
 * 1.169 (97,7%) pelo filtro de titulo, sem nenhuma sobrevivente. O filtro do
 * portals.yml e largo (33 termos positivos), entao ha duas hipoteses opostas:
 *
 *   A. Os titulos nao encaixam mesmo — o filtro esta certo e nao ha o que fazer.
 *   B. Os titulos nao estao sendo lidos — mapeamento de campo errado, e a
 *      varredura inteira da Gupy esta cega.
 *
 * Este script separa as duas. Abre um board Gupy num Chromium, captura o que a
 * pagina busca por XHR E o __NEXT_DATA__, mostra os titulos de verdade, e roda
 * o title_filter do portals.yml sobre eles imprimindo o que passa e o que cai.
 *
 * Nao escreve nada. Nao avalia nada. So diagnostica.
 *
 * Uso:
 *   node diag-gupy-titles.mjs                  # asaas
 *   node diag-gupy-titles.mjs pagseguro        # outro slug
 *   node diag-gupy-titles.mjs asaas --all      # imprime todos, nao so 40
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { buildLocationFilter } from './scan.mjs';

const args = process.argv.slice(2);
const SLUG = args.find((a) => !a.startsWith('--')) ?? 'asaas';
const SHOW_ALL = args.includes('--all');
const DUMP = args.includes('--dump');
const URL = `https://${SLUG}.gupy.io`;

// Campos onde o titulo da vaga pode estar, em ordem de probabilidade.
const TITLE_KEYS = ['name', 'jobName', 'title', 'position', 'roleName', 'vacancyName'];
// Campos onde a localizacao pode estar, na mesma ordem de probabilidade.
const LOC_KEYS = ['city', 'location', 'workplaceCity', 'addressCity', 'jobLocation', 'place'];
const STATE_KEYS = ['state', 'uf', 'workplaceState', 'addressState', 'region'];

function pickLocation(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const parts = [];
  for (const k of LOC_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) { parts.push(v.trim()); break; }
  }
  for (const k of STATE_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) { parts.push(v.trim()); break; }
  }
  const type = rec.workplaceType ?? rec.type ?? rec.remote;
  if (typeof type === 'string' && type.trim()) parts.push(type.trim());
  return parts.join(', ');
}

function pickTitle(rec) {
  if (!rec || typeof rec !== 'object') return null;
  for (const k of TITLE_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim().length >= 3) return v.trim();
  }
  return null;
}

/** Varre qualquer JSON procurando arrays de objetos que pareçam vagas. */
function harvest(node, out, depth = 0) {
  if (depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    const titled = node.filter((x) => pickTitle(x));
    if (titled.length >= 3) out.push(...titled);
    for (const x of node) harvest(x, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) harvest(v, out, depth + 1);
  }
}

function loadFilter() {
  if (!existsSync('portals.yml')) return null;
  const cfg = yaml.load(readFileSync('portals.yml', 'utf8')) || {};
  return cfg.title_filter ?? null;
}

/** Mesma logica do scan.mjs: substring, minusculas, negativo vence. */
function verdict(title, tf) {
  if (!tf) return { pass: true, why: 'sem filtro' };
  const lower = title.toLowerCase();
  const neg = (tf.negative ?? []).find((k) => lower.includes(String(k).toLowerCase()));
  if (neg) return { pass: false, why: `negativo: ${neg}` };
  const pos = (tf.positive ?? []).find((k) => lower.includes(String(k).toLowerCase()));
  if (pos) return { pass: true, why: `positivo: ${pos}` };
  return { pass: false, why: 'nenhum positivo' };
}

const browser = await chromium.launch();
const page = await browser.newPage();

const fromNetwork = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!/gupy\.io|gupy\.app/i.test(u)) return;
  const ct = res.headers()['content-type'] ?? '';
  if (!ct.includes('json')) return;
  try {
    const body = await res.json();
    const found = [];
    harvest(body, found);
    if (found.length) fromNetwork.push({ url: u.slice(0, 110), count: found.length, recs: found });
  } catch {
    /* resposta nao-JSON ou ja consumida */
  }
});

console.log(`\nAbrindo ${URL} ...`);
try {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
} catch (e) {
  console.log(`aviso: networkidle nao foi atingido (${e.message.split('\n')[0]}); seguindo assim mesmo`);
}
await page.waitForTimeout(2500);

const nextRaw = await page.evaluate(() => {
  const s = document.getElementById('__NEXT_DATA__');
  return s ? s.textContent : '';
});
await browser.close();

console.log('\n── Estrategia 1: interceptacao de rede ──');
if (fromNetwork.length === 0) {
  console.log('  nenhuma resposta JSON com registros de vaga');
} else {
  for (const r of fromNetwork) console.log(`  ${String(r.count).padStart(4)} registro(s)  ${r.url}`);
}

const fromNext = [];
console.log('\n── Estrategia 2: __NEXT_DATA__ ──');
if (!nextRaw) {
  console.log('  __NEXT_DATA__ ausente');
} else {
  try {
    harvest(JSON.parse(nextRaw), fromNext);
    console.log(`  ${fromNext.length} registro(s) com campo de titulo reconhecivel`);
  } catch (e) {
    console.log(`  __NEXT_DATA__ presente mas nao parseavel: ${e.message}`);
  }
}

// O proxy de feature flags da Gupy (unleash) responde JSON com campo `name` e
// polui a amostra com centenas de chaves de configuracao. Descartado aqui.
const all = [
  ...fromNetwork.filter((r) => !/unleash/i.test(r.url)).flatMap((r) => r.recs),
  ...fromNext,
];
const byTitle = new Map();
const recByTitle = new Map();
for (const rec of all) {
  const t = pickTitle(rec);
  if (t && !byTitle.has(t)) { byTitle.set(t, pickLocation(rec)); recByTitle.set(t, rec); }
}
const titles = [...byTitle.keys()];

console.log(`\n── Titulos distintos: ${titles.length} ──`);
if (titles.length === 0) {
  console.log('\n  >>> HIPOTESE B CONFIRMADA: nenhum titulo foi extraido.');
  console.log('      O filtro nao tem culpa; a leitura e que esta quebrada.');
  if (all.length > 0) {
    console.log(`      ${all.length} registro(s) foram vistos. Chaves do primeiro:`);
    console.log('      ' + Object.keys(all[0]).slice(0, 25).join(', '));
  }
  process.exit(0);
}

const tf = loadFilter();
if (!tf) console.log('  (portals.yml sem title_filter — rode na raiz do projeto)');

const cfg = existsSync('portals.yml') ? yaml.load(readFileSync('portals.yml', 'utf8')) || {} : {};
const passesLocation = buildLocationFilter(cfg.location_filter);

const passed = [];
const failed = [];
for (const t of titles) {
  const v = verdict(t, tf);
  (v.pass ? passed : failed).push({ t, why: v.why, loc: byTitle.get(t) ?? '' });
}

const cap = SHOW_ALL ? titles.length : 40;

// Dos que passam no titulo, quais sobrevivem tambem a localizacao.
const locOk = [];
const locNo = [];
for (const p of passed) (passesLocation(p.loc, '', p.t) ? locOk : locNo).push(p);

console.log(`\n✅ PASSAM no titulo: ${passed.length}`);
for (const p of passed.slice(0, cap)) {
  const mark = passesLocation(p.loc, '', p.t) ? '✅' : '📍';
  console.log(`   ${mark} ${p.t}`);
  console.log(`      local: ${p.loc || '(vazio)'}   [${p.why}]`);
}

console.log(`\n❌ CAEM no titulo: ${failed.length}`);
for (const f of failed.slice(0, cap)) console.log(`   ${f.t}   [${f.why}]`);
if (!SHOW_ALL && failed.length > cap) console.log(`   ... e mais ${failed.length - cap}. Use --all para ver tudo.`);

if (DUMP && passed.length > 0) {
  const sample = recByTitle.get(passed[0].t);
  console.log(`\n── Registro completo de "${passed[0].t}" ──`);
  console.log('  chaves:', Object.keys(sample).join(', '));
  console.log('\n  valores de texto curto (candidatos a localizacao):');
  for (const [k, v] of Object.entries(sample)) {
    if (typeof v === 'string' && v.length <= 60 && v.trim()) console.log(`    ${k} = ${JSON.stringify(v)}`);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.entries(v)
        .filter(([, iv]) => typeof iv === 'string' && iv.length <= 60 && iv.trim())
        .map(([ik, iv]) => `${ik}=${JSON.stringify(iv)}`);
      if (inner.length) console.log(`    ${k}.{ ${inner.join(', ')} }`);
    }
  }
}

console.log(`\n── Localizacao, so entre os aprovados no titulo ──`);
console.log(`  ✅ passam tambem na localizacao: ${locOk.length}`);
console.log(`  📍 barrados pela localizacao:    ${locNo.length}`);
if (locNo.length > 0) {
  const porLocal = new Map();
  for (const p of locNo) porLocal.set(p.loc || '(vazio)', (porLocal.get(p.loc || '(vazio)') ?? 0) + 1);
  console.log('\n  Locais que estao barrando:');
  for (const [l, n] of [...porLocal.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}x  ${l}`);
  }
}

const pct = titles.length ? ((passed.length / titles.length) * 100).toFixed(1) : '0';
console.log(`\n── Veredito ──`);
console.log(`  Titulo: ${passed.length}/${titles.length} (${pct}%) passam.`);
console.log(`  Localizacao: ${locOk.length} sobrevivem aos dois filtros.`);
if (passed.length > 0 && locOk.length === 0) {
  console.log('  Todas morrem na localizacao. A lista acima mostra quais locais acrescentar\n  ao allow do portals.yml, ou quais estao batendo no block por substring.');
}
