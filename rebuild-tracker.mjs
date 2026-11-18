#!/usr/bin/env node
/**
 * rebuild-tracker.mjs — reconstroi data/applications.md a partir de reports/.
 *
 * O tracker e camada de usuario e e gitignored. Quando ele se perde — maquina
 * trocada, checkout limpo, pasta apagada — os relatorios continuam la, e cada
 * um carrega o proprio veredito no bloco `## Machine Summary`:
 *
 *     num: 36
 *     company: Firepay
 *     role: Especialista de Implementacao
 *     score: 2.3
 *     status: SKIP
 *     url: https://...
 *
 * Ou seja: o tracker e derivavel. Este script le cada relatorio, monta uma
 * linha TSV por vaga em batch/tracker-additions/ e cria o applications.md
 * vazio se preciso. O merge-tracker.mjs faz a juncao, como sempre — este
 * script NAO escreve no tracker diretamente, porque a regra do projeto e que
 * so o merge-tracker adiciona linhas.
 *
 * O que ele recupera: numero, data, empresa, cargo, score, status, PDF, link
 * do relatorio e o primeiro blocker como nota.
 *
 * O que ele NAO recupera: o que aconteceu DEPOIS da avaliacao. Se a vaga foi
 * aplicada e depois rejeitada, o relatorio ainda diz o que dizia no dia em que
 * foi escrito. Linhas assim precisam de correcao manual via set-status.mjs.
 *
 * Uso:
 *   node rebuild-tracker.mjs --dry-run     # mostra o que faria
 *   node rebuild-tracker.mjs               # escreve os TSV
 *   node rebuild-tracker.mjs --force       # sobrescreve TSV que ja existam
 *
 * Depois:
 *   node merge-tracker.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');

const REPORTS_DIR = 'reports';
const TSV_DIR = join('batch', 'tracker-additions');
const TRACKER = join('data', 'applications.md');
const STATES_FILE = join('templates', 'states.yml');

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n');

/** Rotulos canonicos de templates/states.yml, mais os apelidos aceitos. */
function loadStates() {
  const byKey = new Map();
  if (!existsSync(STATES_FILE)) return byKey;
  const cfg = yaml.load(readFileSync(STATES_FILE, 'utf8')) || {};
  for (const s of cfg.states ?? []) {
    if (!s?.label) continue;
    byKey.set(String(s.label).toLowerCase(), s.label);
    byKey.set(String(s.id ?? '').toLowerCase(), s.label);
    for (const a of s.aliases ?? []) byKey.set(String(a).toLowerCase(), s.label);
  }
  return byKey;
}

const STATES = loadStates();

/** TSV nao sobrevive a tab nem a quebra de linha. Achata e corta. */
const cell = (v, max = 160) =>
  String(v ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);

/** Extrai o bloco ```yaml que segue "## Machine Summary". */
function machineSummary(text) {
  const m = text.match(/##\s*Machine Summary\s*```ya?ml\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    const parsed = yaml.load(m[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // YAML quebrado num relatorio nao pode derrubar a reconstrucao
  }
}

/** Campos **Rotulo:** valor do cabecalho. */
function headerField(text, label) {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

/**
 * Empresa e cargo do titulo `# Empresa — Cargo`.
 * Aceita travessao, hifen longo e hifen simples cercado de espacos, porque os
 * relatorios foram escritos ao longo de meses e nao sao uniformes.
 */
function fromTitle(text) {
  const m = text.match(/^#\s+(.+)$/m);
  if (!m) return { company: '', role: '' };
  // Os relatorios 001-016 desta base usam "# Evaluation: Empresa — Cargo"; os
  // seguintes usam "# Empresa — Cargo". Sem cortar o rotulo, a empresa entrava
  // no tracker como "Evaluation: Appmax" e o dedup por empresa do
  // merge-tracker deixava de casar com qualquer avaliacao futura da mesma.
  const titleText = m[1].replace(/^\s*(?:evaluation|avalia[cç][aã]o|report|relat[oó]rio)\s*:\s*/i, '');
  const parts = titleText.split(/\s+[—–]\s+|\s+-\s+/);
  return {
    company: (parts[0] ?? '').trim(),
    role: parts.slice(1).join(' - ').trim(),
  };
}

const files = existsSync(REPORTS_DIR)
  ? readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith('.md') && !/RESERVED/i.test(f))
      .sort()
  : [];

if (files.length === 0) {
  console.error(`erro: nenhum relatorio em ${REPORTS_DIR}/. Rode na raiz do career-ops.`);
  process.exit(1);
}

console.log(`\n🔁 Reconstruindo tracker a partir de ${files.length} relatorio(s)\n`);

const rows = [];
const problems = [];

for (const file of files) {
  const numMatch = file.match(/^(\d{3})-/);
  if (!numMatch) { problems.push(`${file}: nome fora do padrao {###}-...`); continue; }
  const num = String(Number(numMatch[1]));

  const text = readFileSync(join(REPORTS_DIR, file), 'utf8');
  const ms = machineSummary(text) ?? {};
  const title = fromTitle(text);

  const company = cell(ms.company || title.company, 80);
  const role = cell(ms.role || title.role, 120);
  if (!company) { problems.push(`${file}: sem empresa no Machine Summary nem no titulo`); continue; }

  // Data: cabecalho primeiro, nome do arquivo como rede de seguranca.
  const dateFromName = (file.match(/(\d{4}-\d{2}-\d{2})\.md$/) ?? [])[1] ?? '';
  const date = cell(headerField(text, 'Data') || dateFromName, 10);

  // Score: numero do Machine Summary, senao o cabecalho (ja vem "2.3/5").
  let score = '';
  const msScore = ms.score;
  if (msScore !== undefined && msScore !== null && String(msScore).trim() !== '') {
    const n = Number(String(msScore).replace(',', '.').replace('/5', ''));
    score = Number.isFinite(n) ? `${n.toFixed(1)}/5` : '';
  }
  if (!score) {
    const h = headerField(text, 'Score');
    const n = Number(String(h).replace(',', '.').replace('/5', '').trim());
    score = Number.isFinite(n) ? `${n.toFixed(1)}/5` : 'N/A'; // sentinela reconhecido (#1799)
  }

  // Status canonico. Um valor desconhecido vira Evaluated, que e o unico
  // estado que a existencia do relatorio por si so comprova.
  const rawStatus = String(ms.status ?? '').trim().toLowerCase();
  const status = STATES.get(rawStatus) ?? (rawStatus === 'skip' ? 'SKIP' : 'Evaluated');
  if (rawStatus && !STATES.has(rawStatus) && rawStatus !== 'skip') {
    problems.push(`${file}: status "${ms.status}" nao e canonico — gravado como Evaluated`);
  }

  const pdf = /✅/.test(headerField(text, 'PDF')) ? '✅' : '❌';

  // Nota: o primeiro blocker diz mais que qualquer texto generico que eu
  // inventasse aqui. Sem blocker, fica a marca de reconstrucao.
  const firstBlocker = Array.isArray(ms.blockers) && ms.blockers.length
    ? cell(ms.blockers[0], 110)
    : '';
  const notes = firstBlocker || 'reconstruido de reports/ — status pos-avaliacao a confirmar';

  const report = `[${num}](reports/${file})`;

  rows.push({
    file,
    num,
    tsv: [num, date, company, role, status, score, pdf, report, notes].join('\t'),
    status,
    score,
    company,
    role,
  });
}

for (const r of rows) {
  console.log(`  ${String(r.num).padStart(3)} ${r.status.padEnd(10)} ${r.score.padEnd(7)} ${r.company} — ${r.role.slice(0, 50)}`);
}

const byStatus = new Map();
for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Linhas montadas: ${rows.length}`);
for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${s}`);
}

if (problems.length) {
  console.log(`\n⚠️  ${problems.length} aviso(s):`);
  for (const p of problems) console.log(`   ${p}`);
}

if (DRY) {
  console.log('\n--dry-run: nada foi escrito.\n');
  process.exit(0);
}

if (!existsSync(TSV_DIR)) mkdirSync(TSV_DIR, { recursive: true });

let written = 0;
let skipped = 0;
for (const r of rows) {
  const slug = r.file.replace(/^\d{3}-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '').replace(/\.md$/, '');
  const out = join(TSV_DIR, `${String(r.num).padStart(3, '0')}-${slug}.tsv`);
  if (existsSync(out) && !FORCE) { skipped++; continue; }
  writeFileSync(out, `${r.tsv}\n`, 'utf8');
  written++;
}

console.log(`\n✅ ${written} TSV escrito(s) em ${TSV_DIR}/`);
if (skipped) console.log(`   ${skipped} ja existia(m) — use --force para sobrescrever`);

if (!existsSync(TRACKER)) {
  if (!existsSync('data')) mkdirSync('data', { recursive: true });
  writeFileSync(TRACKER, TRACKER_HEADER, 'utf8');
  console.log(`✅ ${TRACKER} criado (vazio, so o cabecalho)`);
} else {
  console.log(`   ${TRACKER} ja existe — mantido`);
}

console.log('\nAgora rode:  node merge-tracker.mjs\n');
