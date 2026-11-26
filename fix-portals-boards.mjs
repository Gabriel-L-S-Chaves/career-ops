#!/usr/bin/env node
/**
 * fix-portals-boards.mjs — aplica em portals.yml os boards confirmados por
 * resolve-boards.mjs na varredura de 2026-11-16.
 *
 * Faz tres coisas:
 *   1. Corrige a careers_url de entradas que apontavam para URL adivinhada
 *      (slug de Gupy que nunca existiu, ou pagina institucional em vez de ATS)
 *      e religa a entrada.
 *   2. Insere as empresas novas cujo board foi confirmado por requisicao real.
 *   3. Relata o que mudou, linha por linha.
 *
 * Le e escreve em UTF-8 e preserva o fim de linha original do arquivo, para
 * nao corromper acentos no Windows PowerShell 5.1.
 *
 * Uso:
 *   node fix-portals-boards.mjs --dry-run    # mostra o diff, nao escreve
 *   node fix-portals-boards.mjs              # aplica, com backup .bak
 *   node fix-portals-boards.mjs outro.yml    # outro arquivo
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const NO_BACKUP = args.includes('--no-backup');
const FILE = args.find(a => !a.startsWith('--')) ?? 'portals.yml';

// Entradas existentes cuja careers_url estava errada. Chave = valor exato de
// `- name:` no portals.yml. Cada URL foi confirmada por requisicao real.
const FIXES = {
  'Inter': { url: 'https://job-boards.greenhouse.io/inter', jobs: 114, was: 'inter.gupy.io (404)' },
  'C6 Bank': { url: 'https://job-boards.greenhouse.io/c6bank', jobs: 156, was: 'c6bank.gupy.io (404)' },
  'Elo': { url: 'https://job-boards.greenhouse.io/elo', jobs: 6, was: 'www.elo.com.br (site institucional)' },
  'SumUp': { url: 'https://job-boards.greenhouse.io/sumup', jobs: 314, was: 'sumup.com/careers (pagina de marketing)' },
  'Nubank': { url: 'https://jobs.ashbyhq.com/nubank', jobs: 106, was: 'greenhouse.io/nubank (sem board)' },
};

// Empresas novas, em ordem de prioridade para o perfil (frente remota primeiro,
// depois BaaS e infraestrutura).
const NEW_ENTRIES = [
  ['EBANX', 'https://job-boards.greenhouse.io/ebanx', 35, 'Curitiba. Pagamentos cross-border'],
  ['Matera', 'https://matera.recruitee.com', 17, 'Campinas. Infra de Pix e core banking'],
  ['Neon', 'https://jobs.lever.co/neon', 9, 'Banco digital'],
  ['Swap', 'https://jobs.ashbyhq.com/swap', 7, 'BaaS'],
  ['Dock', 'https://dock.recruitee.com', 7, 'BaaS'],
  ['TAG', 'https://jobs.lever.co/tag', 4, 'Registro de recebiveis'],
  ['RD Station', 'https://job-boards.greenhouse.io/rdstation', 3, 'Florianopolis. SaaS B2B'],
  ['B3', 'https://b3.breezy.hr', 1, 'Infraestrutura de mercado'],
  ['Nomad', 'https://jobs.ashbyhq.com/nomad', 1, 'Conta global'],
  ['QuintoAndar', 'https://job-boards.greenhouse.io/quintoandar', 102, 'Fluxo financeiro de aluguel'],
];

// A entrada antes da qual o bloco novo e inserido. O script sobe por cima dos
// comentarios e linhas vazias que a precedem, para nao enfiar as empresas novas
// debaixo de um cabecalho de secao que nao fala delas.
const ANCHOR_NAME = 'Asaas';

const NAME_RE = /^(\s*)-\s+name:\s*(.+?)\s*$/;

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf >= lf ? '\r\n' : '\n';
}

if (!existsSync(FILE)) {
  console.error(`erro: ${FILE} nao encontrado. Rode na raiz do career-ops.`);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const eol = detectEol(raw);
const lines = raw.split(/\r?\n/);

// Mapeia cada entrada: nome -> { start, end, indent }
const entries = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(NAME_RE);
  if (m) entries.push({ name: unquote(m[2]), start: i, indent: m[1] });
}
for (let k = 0; k < entries.length; k++) {
  entries[k].end = k + 1 < entries.length ? entries[k + 1].start - 1 : lines.length - 1;
}

const changes = [];
const notFound = [];

// ---- 1. Consertos ----------------------------------------------------------
for (const [name, fix] of Object.entries(FIXES)) {
  const matches = entries.filter(e => e.name === name);
  if (matches.length === 0) { notFound.push(name); continue; }
  if (matches.length > 1) {
    console.error(`erro: "${name}" aparece ${matches.length} vezes em ${FILE}. Nada foi alterado.`);
    process.exit(1);
  }
  const e = matches[0];
  let didUrl = false;
  let didEnabled = false;

  for (let i = e.start; i <= e.end; i++) {
    const urlM = lines[i].match(/^(\s*)careers_url:\s*(.*)$/);
    if (urlM && !didUrl) {
      const old = urlM[2].trim();
      if (old !== fix.url) {
        lines[i] = `${urlM[1]}careers_url: ${fix.url}`;
        changes.push(`  ${name}: careers_url  ${old}  ->  ${fix.url}`);
      }
      didUrl = true;
      continue;
    }
    const enM = lines[i].match(/^(\s*)enabled:\s*(.*)$/);
    if (enM && !didEnabled) {
      const old = enM[2].trim();
      if (old !== 'true') {
        lines[i] = `${enM[1]}enabled: true`;
        changes.push(`  ${name}: enabled      ${old}  ->  true`);
      }
      didEnabled = true;
    }
  }

  if (!didUrl) {
    console.error(`erro: entrada "${name}" nao tem careers_url. Nada foi alterado.`);
    process.exit(1);
  }
  if (!didEnabled) {
    // Sem linha enabled: acrescenta logo apos o name, na indentacao do bloco.
    lines.splice(e.start + 1, 0, `${e.indent}  enabled: true`);
    changes.push(`  ${name}: enabled      (ausente)  ->  true`);
    // Os indices mudaram; recalcular nao e necessario porque cada nome e
    // processado uma vez e as entradas seguintes so se deslocam.
    for (const other of entries) {
      if (other.start > e.start) { other.start++; other.end++; }
    }
    e.end++;
  }
}

// ---- 2. Insercao -----------------------------------------------------------
const anchor = entries.find(e => e.name === ANCHOR_NAME);
if (!anchor) {
  console.error(`erro: ancora "- name: ${ANCHOR_NAME}" nao encontrada em ${FILE}. Nada foi inserido.`);
  process.exit(1);
}

const already = new Set(entries.map(e => e.name));
const toInsert = NEW_ENTRIES.filter(([name]) => !already.has(name));
const skipped = NEW_ENTRIES.filter(([name]) => already.has(name)).map(([n]) => n);

let insertAt = anchor.start;
while (insertAt > 0) {
  const prev = lines[insertAt - 1].trim();
  if (prev === '' || prev.startsWith('#')) insertAt--;
  else break;
}

const ind = anchor.indent;
if (toInsert.length > 0) {
  const block = [
    '',
    `${ind}# -- Boards confirmados por resolve-boards.mjs em 2026-11-16 ----------------`,
    `${ind}# Cada URL devolveu vagas numa requisicao real. Nenhuma e palpite.`,
  ];
  for (const [name, url, jobs, note] of toInsert) {
    block.push(`${ind}- name: ${name}`);
    block.push(`${ind}  careers_url: ${url}`);
    block.push(`${ind}  notes: "${note}"`);
    block.push(`${ind}  enabled: true   # ${jobs} vaga(s) em 2026-11-16`);
  }
  lines.splice(insertAt, 0, ...block);
  for (const [name, url, jobs] of toInsert) {
    changes.push(`  + ${name}  ${url}  (${jobs} vaga(s))`);
  }
}

// ---- 3. Relatorio ----------------------------------------------------------
console.log(`\n${FILE} — ${entries.length} entrada(s) lidas, fim de linha ${eol === '\r\n' ? 'CRLF' : 'LF'}\n`);

if (changes.length === 0) {
  console.log('Nada a alterar. O arquivo ja esta como deveria.\n');
  process.exit(0);
}

console.log(`${changes.length} alteracao(oes):`);
for (const c of changes) console.log(c);

if (notFound.length > 0) {
  console.log(`\nNao encontradas (nenhum conserto aplicado): ${notFound.join(', ')}`);
}
if (skipped.length > 0) {
  console.log(`Ja existiam, nao reinseridas: ${skipped.join(', ')}`);
}

if (DRY) {
  console.log('\n--dry-run: nada foi escrito. Rode sem a flag para aplicar.\n');
  process.exit(0);
}

if (!NO_BACKUP) {
  copyFileSync(FILE, `${FILE}.bak`);
  console.log(`\nBackup: ${FILE}.bak`);
}
writeFileSync(FILE, lines.join(eol), 'utf8');
console.log(`${FILE} atualizado.\n`);
