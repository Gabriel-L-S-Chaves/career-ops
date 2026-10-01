#!/usr/bin/env node
// Diagnóstico do endpoint público da Gupy.
//
// Motivo: todos os alvos Gupy do portals.yml voltam HTTP 404 ("slug_gone"),
// tanto as varreduras do portal quanto os boards por empresa. O caminho da API
// usado em providers/gupy.mjs foi escrito a partir da documentação, sem
// verificação contra uma resposta real — este script descobre o caminho certo.
//
// Uso:  node probe-gupy.mjs
// Cole a saída inteira de volta na conversa.

const CANDIDATES = [
  // Portal — busca em toda a plataforma
  'https://employability-portal.gupy.io/api/v1/jobs?limit=3',
  'https://employability-portal.gupy.io/api/job?limit=3',
  'https://employability-portal.gupy.io/api/v1/jobs/search?limit=3',
  'https://portal.gupy.io/api/v1/jobs?limit=3',
  'https://portal-api.gupy.io/api/v1/jobs?limit=3',
  'https://api.gupy.io/api/v1/jobs?limit=3',
  // Board de uma empresa só (Asaas está no portals.yml e falha há 3+ rodadas)
  'https://asaas.gupy.io/api/v1/jobs',
  'https://asaas.gupy.io/api/v1/jobs?limit=3',
  'https://asaas.gupy.io/api/job?limit=3',
];

// Páginas HTML: servem para saber se o host responde e se os dados vêm
// embutidos na página (Next.js) em vez de numa API separada.
const PAGES = ['https://portal.gupy.io/', 'https://asaas.gupy.io/'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function probe(url, headers, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const ms = Date.now() - t0;
    const ctype = (res.headers.get('content-type') || '').split(';')[0];
    const loc = res.headers.get('location');
    let hint = '';
    if (res.status >= 200 && res.status < 300) {
      const body = await res.text();
      if (ctype.includes('json')) {
        try {
          const json = JSON.parse(body);
          const keys = Array.isArray(json) ? `array[${json.length}]` : Object.keys(json).join(',');
          // quantas vagas vieram, se der para saber
          const rows = Array.isArray(json) ? json : json.data || json.jobs || json.results || null;
          hint = `keys=[${keys}]${Array.isArray(rows) ? ` rows=${rows.length}` : ''}`;
        } catch {
          hint = `json ilegível, ${body.length}b`;
        }
      } else {
        hint = `${body.length}b${body.includes('__NEXT_DATA__') ? ' · tem __NEXT_DATA__' : ''}`;
      }
    }
    if (loc) hint += ` → ${loc}`;
    console.log(`  ${String(res.status).padEnd(3)} ${label.padEnd(10)} ${ms}ms  ${url}`);
    if (hint) console.log(`      ${hint}`);
  } catch (err) {
    console.log(`  ERR ${label.padEnd(10)} ${url}`);
    console.log(`      ${err?.cause?.code || err?.name || ''} ${err?.message || err}`);
  }
}

console.log('\n=== APIs candidatas ===');
console.log('(sem User-Agent — é como o scan.mjs chama hoje)');
for (const url of CANDIDATES) await probe(url, { accept: 'application/json' }, 'sem-UA');

console.log('\n(com User-Agent de navegador — para separar 404 de bloqueio de bot)');
for (const url of CANDIDATES) await probe(url, { accept: 'application/json', 'user-agent': UA }, 'com-UA');

console.log('\n=== Páginas HTML ===');
for (const url of PAGES) await probe(url, { 'user-agent': UA }, 'página');

console.log('\nCole tudo acima de volta na conversa.\n');
