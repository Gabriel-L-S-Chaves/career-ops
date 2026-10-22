#!/usr/bin/env node
/**
 * scan-gupy.mjs — varredura das páginas de carreira Gupy com navegador.
 *
 * Por que este script existe
 * ──────────────────────────
 * A Gupy deixou de servir a lista de vagas por HTTP sem navegador (diagnóstico
 * fechado em 16/10/2026 e registrado em portals.yml):
 *
 *   1. employability-portal.gupy.io — host morto, sem resposta HTTP
 *   2. portal.gupy.io — devolve 200 e o HTML do SPA para QUALQUER caminho,
 *      inclusive /api/v1/jobs. O __NEXT_DATA__ existe mas vem sem registros
 *      de vaga (careerPageId: 0, companyName: 0)
 *   3. api.gupy.io — 401, é o lado empregador autenticado
 *
 * Como os alvos Gupy do portals.yml estão todos `enabled: false`, o scan.mjs
 * fica cego para a maior parte do mercado brasileiro de fintech. Este script
 * cobre essa lacuna abrindo cada página `https://{slug}.gupy.io` num Chromium
 * de verdade.
 *
 * Estratégia de extração, em ordem de confiabilidade
 * ──────────────────────────────────────────────────
 *   1. Interceptação de rede — a página busca as vagas por XHR; capturamos as
 *      respostas JSON e lemos os registros de lá. É o caminho mais estável:
 *      não depende de nome de classe CSS nem de marcação.
 *   2. __NEXT_DATA__ — o payload que o Next.js embute no HTML.
 *   3. DOM — último recurso, lendo os links `/job/{id}`.
 *
 * O script NÃO avalia nada e NÃO se candidata a nada. Ele só alimenta
 * data/pipeline.md e data/scan-history.tsv, exatamente como o scan.mjs.
 *
 * Uso
 * ───
 *   node scan-gupy.mjs                     # todos os alvos *.gupy.io
 *   node scan-gupy.mjs --only=asaas,cielo  # só estes slugs
 *   node scan-gupy.mjs --debug             # mostra o que cada estratégia achou
 *   node scan-gupy.mjs --headed            # abre o navegador na tela
 *   node scan-gupy.mjs --dry-run           # não escreve nada
 *   node scan-gupy.mjs --limit=5           # para depois de N empresas
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

import {
  buildTitleFilter,
  buildLocationFilter,
  buildPostingAgeFilter,
  loadSeenUrls,
  loadSeenCompanyRoles,
  buildCompanyCanonicalizer,
  companyRoleDedupKey,
  normalizeUrlForDedup,
  appendToPipeline,
  appendToScanHistory,
  appendScanRunSummary,
} from './scan.mjs';

const PORTALS_PATH = 'portals.yml';
const BLACKLIST_PATH = 'data/blacklist.md';
const DEBUG_DIR = 'data/gupy-debug';

// ── Argumentos ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DEBUG = flag('debug');
const HEADED = flag('headed');
const DRY_RUN = flag('dry-run');
const ONLY = (value('only') || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const LIMIT = Number(value('limit')) > 0 ? Number(value('limit')) : Infinity;
const THROTTLE = Number(value('throttle')) >= 0 ? Number(value('throttle')) : 1200;
const TIMEOUT = Number(value('timeout')) > 0 ? Number(value('timeout')) : 30000;

const dbg = (...args) => { if (DEBUG) console.log('   ·', ...args); };

// ── Descoberta dos alvos a partir do portals.yml ────────────────────────────

/**
 * Extrai o slug de uma careers_url Gupy. Aceita as duas formas que aparecem
 * no portals.yml, com e sem barra final, com e sem caminho.
 *   https://asaas.gupy.io        → asaas
 *   https://pagseguro.gupy.io/   → pagseguro
 * Devolve null para qualquer coisa que não seja um subdomínio da gupy.io
 * (portal.gupy.io e api.gupy.io são deliberadamente rejeitados: não são
 * páginas de carreira de empresa).
 */
export function gupySlugFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(/^https?:\/\/([a-z0-9][a-z0-9-]*)\.gupy\.io/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (slug === 'portal' || slug === 'api' || slug === 'www' || slug === 'employability-portal') return null;
  return slug;
}

function loadTargets() {
  if (!existsSync(PORTALS_PATH)) {
    console.error(`❌ ${PORTALS_PATH} não encontrado. Rode a partir da raiz do career-ops.`);
    process.exit(1);
  }
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];

  const targets = [];
  for (const entry of companies) {
    if (!entry || typeof entry !== 'object') continue;
    const slug = gupySlugFromUrl(entry.careers_url);
    if (!slug) continue;
    // Deliberado: NÃO olhamos `enabled`. Esses alvos estão desligados porque o
    // scan.mjs não consegue lê-los por HTTP — é exatamente a razão de existir
    // deste script. Quem decide o recorte aqui é --only.
    if (ONLY.length > 0 && !ONLY.includes(slug)) continue;
    targets.push({
      slug,
      name: typeof entry.name === 'string' ? entry.name : slug,
      url: `https://${slug}.gupy.io`,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
    });
  }
  return { config, targets };
}

function loadBlacklist() {
  if (!existsSync(BLACKLIST_PATH)) return [];
  return readFileSync(BLACKLIST_PATH, 'utf-8')
    .split('\n')
    .map((l) => l.replace(/^[-*\s[\]x]+/i, '').split('|')[0].trim().toLowerCase())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

// ── Normalização de um registro de vaga ─────────────────────────────────────

const FIRST = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};

/**
 * A Gupy já mudou o nome dos campos mais de uma vez, e o payload de empresa
 * difere do payload do portal. Em vez de fixar um formato, aceitamos os
 * apelidos conhecidos e exigimos apenas o mínimo: um título e um id.
 */
export function normalizeGupyJob(raw, target) {
  if (!raw || typeof raw !== 'object') return null;

  const title = FIRST(raw, ['name', 'jobName', 'title', 'roleName']);
  const id = raw.id ?? raw.jobId ?? raw.careerPageJobId ?? raw.code ?? null;
  if (!title || id === null || id === undefined) return null;

  // Localização: às vezes string plana, às vezes objeto {city, state, country}.
  let location = FIRST(raw, ['location', 'city', 'addressCity', 'workplaceCity']);
  if (!location && raw.address && typeof raw.address === 'object') {
    location = [raw.address.city, raw.address.state, raw.address.country]
      .filter((p) => typeof p === 'string' && p.trim())
      .join(', ');
  }
  // A Gupy marca remoto num campo próprio; sem isso, uma vaga 100% remota
  // chegaria ao filtro de localização como string vazia e passaria por sorte,
  // não por mérito. Melhor declarar.
  const remoteFlag = raw.isRemoteWork ?? raw.remote ?? raw.workplaceType;
  const isRemote = remoteFlag === true
    || (typeof remoteFlag === 'string' && /remote|remoto/i.test(remoteFlag));
  if (isRemote) location = location ? `${location} (Remoto)` : 'Remoto';

  // Data de publicação, se vier. Vira epoch ms para o filtro de idade.
  const publishedRaw = FIRST(raw, ['publishedDate', 'createdAt', 'publishedAt', 'startDate']);
  const published = publishedRaw ? Date.parse(publishedRaw) : NaN;

  // O caminho canônico de uma vaga Gupy de empresa.
  const explicit = FIRST(raw, ['jobUrl', 'url', 'applyUrl']);
  const url = explicit && /^https?:\/\//.test(explicit)
    ? explicit
    : `${target.url}/job/${id}`;

  return {
    url,
    title,
    company: target.name,
    location,
    source: `gupy/${target.slug}`,
    postedAt: Number.isFinite(published) && published > 0 ? published : undefined,
  };
}

// ── As três estratégias de extração ─────────────────────────────────────────

/**
 * Procura, em qualquer lugar de uma estrutura JSON, arrays cujos elementos
 * pareçam registros de vaga. Resolve o problema de o payload da Gupy aninhar
 * as vagas sob chaves diferentes (`data`, `jobs`, `props.pageProps...`) sem
 * precisar adivinhar o caminho.
 */
export function harvestJobArrays(node, out = [], depth = 0) {
  if (depth > 8 || !node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    const looksLikeJobs = node.length > 0 && node.every(
      (el) => el && typeof el === 'object' && !Array.isArray(el)
        && (el.name || el.jobName || el.title || el.roleName)
        && (el.id !== undefined || el.jobId !== undefined || el.careerPageJobId !== undefined),
    );
    if (looksLikeJobs) out.push(node);
    else for (const el of node) harvestJobArrays(el, out, depth + 1);
    return out;
  }
  for (const v of Object.values(node)) harvestJobArrays(v, out, depth + 1);
  return out;
}

async function fromNextData(page) {
  try {
    const raw = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });
    if (!raw) return [];
    const arrays = harvestJobArrays(JSON.parse(raw));
    return arrays.flat();
  } catch {
    return [];
  }
}

async function fromDom(page, target) {
  try {
    return await page.evaluate((base) => {
      const seen = new Set();
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/job/"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/job\/(\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        // O título é o texto mais substancial dentro do cartão do link.
        const card = a.closest('li, article, div') || a;
        const heading = card.querySelector('h1, h2, h3, h4, [class*="title" i]');
        const name = (heading?.textContent || a.textContent || '').trim().split('\n')[0].trim();
        if (!name) continue;
        const text = (card.textContent || '').replace(/\s+/g, ' ');
        const loc = text.match(/([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ.\s]+?\s*[-/]\s*[A-Z]{2})\b/);
        out.push({
          id: m[1],
          name,
          location: loc ? loc[1].trim() : '',
          isRemoteWork: /\bremoto\b|\bremote\b/i.test(text),
          jobUrl: href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`,
        });
      }
      return out;
    }, target.url);
  } catch {
    return [];
  }
}

// ── Varredura de uma empresa ────────────────────────────────────────────────

async function scrapeCompany(context, target) {
  const page = await context.newPage();

  // Estratégia 1: ouvir a rede antes de navegar, para não perder o XHR inicial.
  const captured = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!/gupy\.io|gupy\.?app/i.test(url)) return;
      if (!response.ok()) return;
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (!type.includes('json')) return;
      const body = await response.json();
      const arrays = harvestJobArrays(body);
      if (arrays.length > 0) {
        captured.push(...arrays.flat());
        dbg(`rede: ${arrays.flat().length} registro(s) em ${url.slice(0, 90)}`);
      }
    } catch {
      // Resposta já consumida, body não-JSON, navegação cancelada — ignorar.
    }
  });

  const result = { raw: [], strategy: null, error: null };

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    // A lista chega por XHR depois do DOMContentLoaded. Esperar a rede
    // assentar; se nunca assentar (long-polling, analytics), seguir mesmo
    // assim — já pode haver vagas capturadas.
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
    // Alguns portais só montam a lista após o primeiro scroll.
    await page.evaluate(() => window.scrollBy(0, 2000)).catch(() => {});
    await page.waitForTimeout(1500);

    if (captured.length > 0) {
      result.raw = captured;
      result.strategy = 'rede';
    } else {
      const next = await fromNextData(page);
      dbg(`__NEXT_DATA__: ${next.length} registro(s)`);
      if (next.length > 0) {
        result.raw = next;
        result.strategy = '__NEXT_DATA__';
      } else {
        const dom = await fromDom(page, target);
        dbg(`DOM: ${dom.length} registro(s)`);
        if (dom.length > 0) {
          result.raw = dom;
          result.strategy = 'DOM';
        }
      }
    }

    // Quando nada funciona, guardar o HTML para diagnóstico posterior. É o
    // que fechou o diagnóstico do portal.gupy.io, e evita ter de reproduzir
    // a falha à mão.
    if (DEBUG && result.raw.length === 0) {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const out = `${DEBUG_DIR}/${target.slug}.html`;
      writeFileSync(out, await page.content(), 'utf-8');
      dbg(`nada extraído — HTML salvo em ${out}`);
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    await page.close().catch(() => {});
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { config, targets } = loadTargets();

  if (targets.length === 0) {
    console.log('Nenhum alvo *.gupy.io encontrado em portals.yml.');
    if (ONLY.length > 0) console.log(`Filtro --only=${ONLY.join(',')} não casou com nenhum slug.`);
    return;
  }

  const passesTitle = buildTitleFilter(config.title_filter);
  const passesLocation = buildLocationFilter(config.location_filter);
  const passesAge = buildPostingAgeFilter(config.max_posting_age_days);
  const blacklist = loadBlacklist();
  const seenUrls = loadSeenUrls(config);
  // Mesma chamada do scan.mjs: a assinatura é (appsPath, canonicalize, opções).
  // O canonicalizador tem de ser o MESMO usado ao gerar a chave de cada vaga
  // nova, senão o dedup de empresa+cargo compara chaves de alfabetos diferentes.
  const canonicalizeCompany = buildCompanyCanonicalizer(config.company_aliases);
  const seenRoles = loadSeenCompanyRoles(undefined, canonicalizeCompany, { policy: config });

  const today = new Date().toISOString().slice(0, 10);
  const selected = targets.slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`🔎 Gupy via navegador — ${selected.length} empresa(s)`);
  if (DRY_RUN) console.log('   (--dry-run: nada será gravado)\n');
  else console.log('');

  const counters = {
    companies: selected.length, boards: 0, found: 0,
    filtered_title: 0, filtered_location: 0, filtered_posting_age: 0,
    filtered_blacklist: 0, dupes: 0, new_added: 0, errors: 0,
  };

  const fresh = [];
  const emptyBoards = [];
  const failed = [];

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    locale: 'pt-BR',
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });

  try {
    for (const target of selected) {
      process.stdout.write(`  ${target.name.padEnd(28)} `);
      const { raw, strategy, error } = await scrapeCompany(context, target);

      if (error) {
        counters.errors++;
        failed.push({ target, error });
        console.log(`❌ ${error.split('\n')[0].slice(0, 70)}`);
        continue;
      }

      counters.boards++;
      const jobs = raw
        .map((r) => normalizeGupyJob(r, target))
        .filter(Boolean);
      counters.found += jobs.length;

      if (jobs.length === 0) {
        emptyBoards.push(target);
        console.log('🟡 vazio');
        if (THROTTLE) await new Promise((r) => setTimeout(r, THROTTLE));
        continue;
      }

      let added = 0;
      for (const job of jobs) {
        if (!passesTitle(job.title)) { counters.filtered_title++; continue; }
        if (!passesLocation(job.location, job.url, job.title)) { counters.filtered_location++; continue; }
        if (!passesAge(job.postedAt)) { counters.filtered_posting_age++; continue; }

        const companyLower = (job.company || '').toLowerCase();
        if (blacklist.some((b) => companyLower.includes(b))) { counters.filtered_blacklist++; continue; }

        const normUrl = normalizeUrlForDedup(job.url);
        const roleKey = companyRoleDedupKey(job.company, job.title, canonicalizeCompany);
        if (seenUrls.has(normUrl) || seenRoles.has(roleKey)) { counters.dupes++; continue; }

        seenUrls.add(normUrl);
        seenRoles.add(roleKey);
        fresh.push(job);
        added++;
      }

      counters.new_added += added;
      console.log(`${jobs.length} vaga(s) · ${added} nova(s)  [${strategy}]`);
      if (THROTTLE) await new Promise((r) => setTimeout(r, THROTTLE));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Relatório ────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Empresas varridas:     ${counters.companies}`);
  console.log(`Boards com resposta:   ${counters.boards}`);
  console.log(`Vagas encontradas:     ${counters.found}`);
  console.log(`Filtradas por título:  ${counters.filtered_title}`);
  console.log(`Filtradas por local:   ${counters.filtered_location}`);
  if (counters.filtered_posting_age) console.log(`Filtradas por idade:   ${counters.filtered_posting_age}`);
  if (counters.filtered_blacklist) console.log(`Filtradas (blacklist): ${counters.filtered_blacklist}`);
  console.log(`Duplicadas:            ${counters.dupes}`);
  console.log(`Novas vagas:           ${counters.new_added}`);
  if (counters.errors) console.log(`Erros:                 ${counters.errors}`);

  if (emptyBoards.length > 0) {
    console.log(`\n🟡 ${emptyBoards.length} board(s) sem vaga extraída: ${emptyBoards.map((t) => t.slug).join(', ')}`);
    console.log('   Rode com --debug para salvar o HTML e ver qual estratégia falhou.');
  }

  if (failed.length > 0) {
    console.log('\n❌ Falhas:');
    for (const { target, error } of failed) {
      console.log(`   ${target.slug}: ${error.split('\n')[0].slice(0, 100)}`);
    }
  }

  if (fresh.length > 0) {
    console.log('\nNovas vagas:');
    for (const j of fresh) {
      console.log(`  + ${j.company} | ${j.title}${j.location ? ` | ${j.location}` : ''}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: pipeline.md e scan-history.tsv não foram tocados.');
    return;
  }

  if (fresh.length > 0) {
    await appendToPipeline(fresh);
    appendToScanHistory(fresh, today);
    console.log(`\n✅ ${fresh.length} vaga(s) em data/pipeline.md e data/scan-history.tsv`);
  }
  appendScanRunSummary(counters);

  console.log('\n→ Rode o modo pipeline para avaliar as novas vagas.');
}

// Permite importar as funções puras em teste sem disparar a varredura.
// pathToFileURL em vez de concatenar "file://": no Windows o argv[1] vem como
// caminho nativo com barras invertidas e letra de unidade, enquanto
// import.meta.url é uma URL file:// com barras normais. A comparação ingênua
// nunca casa ali, e o script sairia em silêncio, sem saída e sem erro.
// O argv[1] pode ser indefinido (node -e, REPL), daí o guarda antes de converter.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry !== null && import.meta.url === entry) {
  main().catch((err) => {
    console.error('❌', err);
    process.exit(1);
  });
}
