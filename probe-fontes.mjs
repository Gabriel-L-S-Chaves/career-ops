#!/usr/bin/env node
// Diagnóstico de fontes de vaga — descobre COMO cada portal expõe os dados,
// para que os providers sejam escritos contra evidência e não contra a
// documentação. A rodada anterior (probe-gupy) provou que isso importa: o
// provider da Gupy foi escrito a partir da documentação, apontava para uma API
// que não existe, e devolveu 404 em todas as rodadas por duas semanas.
//
// O que já está respondido pela rodada anterior, e não se repete aqui:
//   employability-portal.gupy.io/api/*  → 404 (a API não existe)
//   api.gupy.io                         → 401 (é a API do empregador, com auth)
//   portal.gupy.io e {empresa}.gupy.io  → 200 em HTML, com __NEXT_DATA__
// Ou seja: a Gupy publica por Next.js, com os dados embutidos na página. Esta
// rodada descobre ONDE dentro do __NEXT_DATA__ as vagas ficam.
//
// Uso:
//   node probe-fontes.mjs
//   node probe-fontes.mjs https://empresa.inhire.app/vaga/123   (URL real opcional)
//
// Cole a saída inteira de volta na conversa.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const extraUrls = process.argv.slice(2).filter((a) => /^https?:\/\//i.test(a));

async function get(url, accept = 'text/html') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  const body = await res.text();
  return { status: res.status, ctype: (res.headers.get('content-type') || '').split(';')[0], body };
}

// ── Caça às vagas dentro de um JSON de forma genérica ───────────────────────
// Procura arrays cujos itens pareçam vaga: objeto com um campo de título
// (name/title/jobName) e, de preferência, um id ou uma URL. Imprime o caminho
// até o array e os nomes dos campos do primeiro item — que é exatamente o que
// falta para escrever o provider.
function looksLikeJob(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const hasTitle = ['name', 'title', 'jobName', 'position', 'vacancyName'].some(
    (k) => typeof o[k] === 'string' && o[k].trim().length > 2,
  );
  if (!hasTitle) return false;
  return ['id', 'url', 'jobUrl', 'slug', 'careerPageId', 'publishedDate', 'city'].some((k) => k in o);
}

function findJobArrays(root, maxHits = 6) {
  const hits = [];
  const seen = new WeakSet();
  (function walk(node, path, depth) {
    if (hits.length >= maxHits || depth > 12 || !node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const sample = node.filter(looksLikeJob);
      if (sample.length >= 1 && node.length >= 1) {
        hits.push({ path, count: node.length, matching: sample.length, keys: Object.keys(sample[0]) });
        return; // não desce dentro de um array já identificado
      }
      for (let i = 0; i < Math.min(node.length, 25); i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k, depth + 1);
  })(root, '', 0);
  return hits;
}

async function probeNextData(url) {
  try {
    const { status, body } = await get(url);
    console.log(`\n  ${status}  ${url}  (${body.length}b)`);
    const m = body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      // Next.js moderno às vezes usa self.__next_f.push em vez de __NEXT_DATA__
      const streamed = body.includes('self.__next_f');
      console.log(`      sem __NEXT_DATA__${streamed ? ' — mas tem self.__next_f (App Router)' : ''}`);
      return;
    }
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch (e) {
      console.log(`      __NEXT_DATA__ ilegível: ${e.message}`);
      return;
    }
    console.log(`      __NEXT_DATA__ ok (${m[1].length}b) · raiz: [${Object.keys(json).join(', ')}]`);
    const hits = findJobArrays(json);
    if (!hits.length) {
      console.log('      nenhum array de vagas encontrado — a lista deve vir por XHR depois do carregamento');
      return;
    }
    for (const h of hits) {
      console.log(`      ► ${h.path}  (${h.count} itens, ${h.matching} parecem vaga)`);
      console.log(`        campos: ${h.keys.slice(0, 22).join(', ')}`);
    }
  } catch (err) {
    console.log(`  ERR ${url}`);
    console.log(`      ${err?.cause?.code || err?.name || ''} ${err?.message || err}`);
  }
}

async function probeApi(url, label) {
  try {
    const { status, ctype, body } = await get(url, 'application/json');
    let hint = `${ctype} ${body.length}b`;
    if (status >= 200 && status < 300 && ctype.includes('json')) {
      try {
        const json = JSON.parse(body);
        const keys = Array.isArray(json) ? `array[${json.length}]` : Object.keys(json).slice(0, 12).join(',');
        hint = `keys=[${keys}]`;
        const hits = findJobArrays(json, 2);
        for (const h of hits) hint += `\n        ► ${h.path} (${h.count} itens) campos: ${h.keys.slice(0, 18).join(', ')}`;
      } catch {
        /* mantém o hint simples */
      }
    } else if (ctype.includes('xml') || body.startsWith('<?xml') || body.includes('<rss')) {
      const items = (body.match(/<item>/g) || []).length;
      hint = `RSS/XML · ${items} <item>`;
    }
    console.log(`  ${String(status).padEnd(3)} ${label.padEnd(12)} ${url}`);
    console.log(`      ${hint}`);
  } catch (err) {
    console.log(`  ERR ${label.padEnd(12)} ${url}`);
    console.log(`      ${err?.cause?.code || err?.name || ''} ${err?.message || err}`);
  }
}

console.log('\n════ 1. GUPY — onde ficam as vagas dentro da página ════');
console.log('(a Gupy fica: o objetivo é ler o HTML, já que a API não existe)');
for (const u of [
  'https://portal.gupy.io/pt',
  'https://portal.gupy.io/job-search/term=analista%20de%20opera%C3%A7%C3%B5es',
  'https://asaas.gupy.io/',
]) {
  await probeNextData(u);
}

console.log('\n════ 2. INHIRE — ATS brasileiro ════');
for (const [u, l] of [
  ['https://api.inhire.app/job-posts', 'api'],
  ['https://api.inhire.app/v1/job-posts', 'api-v1'],
  ['https://inhire.app/api/job-posts', 'app-api'],
]) {
  await probeApi(u, l);
}
await probeNextData('https://jobs.inhire.app/');

console.log('\n════ 3. INDEED BRASIL ════');
for (const [u, l] of [
  ['https://br.indeed.com/rss?q=analista+de+opera%C3%A7%C3%B5es&l=Goi%C3%A2nia%2C+GO', 'rss'],
  ['https://br.indeed.com/jobs?q=analista+de+opera%C3%A7%C3%B5es&l=Goi%C3%A2nia&format=rss', 'rss-alt'],
  ['https://br.indeed.com/jobs?q=analista+de+opera%C3%A7%C3%B5es&l=Goi%C3%A2nia', 'html'],
]) {
  await probeApi(u, l);
}

console.log('\n════ 4. OUTROS ATS BRASILEIROS ════');
for (const [u, l] of [
  ['https://api.quickin.io/v1/jobs', 'quickin'],
  ['https://api.recrutei.com.br/api/vacancies', 'recrutei'],
  ['https://app.pandape.infojobs.com.br/api/vacancies', 'pandape'],
  ['https://www.vagas.com.br/vagas-de-analista-de-operacoes', 'vagas.com'],
  ['https://www.solides.com.br/api/jobs', 'solides'],
]) {
  await probeApi(u, l);
}

if (extraUrls.length) {
  console.log('\n════ 5. URLs QUE VOCÊ PASSOU ════');
  for (const u of extraUrls) await probeNextData(u);
}

console.log('\nCole tudo acima de volta na conversa.\n');
