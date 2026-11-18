#!/usr/bin/env node
/**
 * fix-title-filter.mjs — conserta o title_filter do portals.yml.
 *
 * Diagnostico de 17/11/2026, feito com o diag-gupy-titles.mjs sobre Asaas e
 * PagBank (38 e 918 vagas reais):
 *
 *   1. "BI" como positivo casa por substring dentro de palavra — visiBIlidade,
 *      contaBIl, rentaBIlizacao, receBImento, observaBIlidade, confiaBIlidade —
 *      e dentro de nome de cidade: BIlac, BIrigui, BomBInhas, IBItinga, IBIuna,
 *      ItoBI, ItumBIara, SuruBIm, TanaBI. Aprovava ~30 vagas de "Executivo de
 *      Vendas (Rentabilizacao)" por engano.
 *
 *   2. "iOS" como negativo mata vaga boa: "Analista de Inteligencia de
 *      NegocIOS Sr. (Business Analytics)" foi descartada por um termo criado
 *      para barrar desenvolvedor de iPhone.
 *
 *   3. Faltavam positivos que a PagBank provou existirem: Pricing, Split
 *      Payment, Reforma Tributaria, Antecipacao, Recebiveis, Inteligencia de
 *      Negocios, Informacoes Gerenciais, Backoffice, Liquidacao, Onboarding,
 *      Prevencao a Fraude, Antifraude. Entre as perdidas estava "Especialista
 *      Fiscal (Split Payment e Reforma Tributaria)" — as duas certificacoes do
 *      candidato no titulo da vaga.
 *
 * Edita apenas as listas dentro de title_filter, por manipulacao de linha, para
 * preservar todos os comentarios e o resto do arquivo. Le e escreve em UTF-8 e
 * mantem o fim de linha original.
 *
 * Uso:
 *   node fix-title-filter.mjs --dry-run        # mostra o diff, nao escreve
 *   node fix-title-filter.mjs                  # aplica, com backup .bak
 *   node fix-title-filter.mjs --bloquear-vendas  # tambem barra vagas comerciais
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const BLOCK_SALES = args.includes('--bloquear-vendas');
const FILE = args.find((a) => !a.startsWith('--')) ?? 'portals.yml';

const REMOVE_POSITIVE = ['BI'];
const REMOVE_NEGATIVE = ['iOS'];

const ADD_POSITIVE = [
  'Pricing',
  'Precificação',
  'Split Payment',
  'Reforma Tributária',
  'Antecipação',
  'Recebíveis',
  'Inteligência de Negócios',
  'Informações Gerenciais',
  'Backoffice',
  'Back Office',
  'Liquidação',
  'Onboarding',
  'Prevenção a Fraude',
  'Antifraude',
];

// Ruido de volume que nao e vaga comercial: campo, atendimento, aprendiz.
//
// 18/11/2026: somadas as vagas afirmativas PcD. O usuario declarou em 16/11 que
// nao e PcD (gravado em modes/_profile.md), e vaga afirmativa exige laudo — nao
// ha caminho de candidatura. Duas delas passaram na varredura Gupy do Boticario:
// "(Vaga Afirmativa para PcD)" e "(Vaga afirmativa para pessoas com deficiencia)".
//
// Sobre o risco de substring, que ja mordeu este filtro uma vez com "BI":
// "pcd" nao ocorre dentro de palavra em portugues, entao e seguro como termo
// solto. O filtro so olha o TITULO, nunca o corpo do anuncio — uma vaga comum
// que mencione acessibilidade na descricao continua passando. E o corte vale so
// para PcD: vagas afirmativas de outros recortes seguem visiveis, porque o
// usuario nao pediu para barra-las.
const ADD_NEGATIVE = [
  'Técnico de Campo',
  'Assistente de Atendimento',
  'Jovem Aprendiz',
  'PcD',
  'pessoas com deficiência',
];

// So com --bloquear-vendas. O usuario pediu em 17/11/2026 para MANTER vagas
// comerciais visiveis, entao isto fica desligado por padrao.
const SALES_NEGATIVE = ['Executivo de Vendas', 'Supervisor de Vendas', 'Assistente de Vendas'];

if (!existsSync(FILE)) {
  console.error(`erro: ${FILE} nao encontrado. Rode na raiz do career-ops.`);
  process.exit(1);
}

const raw = readFileSync(FILE, 'utf8');
const eol = (raw.match(/\r\n/g) ?? []).length >= (raw.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const indentOf = (s) => (s.match(/^(\s*)/) ?? ['', ''])[1].length;
const isItem = (s) => /^\s*-\s+/.test(s);
const itemValue = (s) => {
  const m = s.match(/^\s*-\s+(.*?)\s*$/);
  if (!m) return null;
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
};

// Localiza title_filter: e, dentro dele, as sublistas por nome.
const tfIdx = lines.findIndex((l) => /^\s*title_filter\s*:/.test(l));
if (tfIdx === -1) {
  console.error('erro: bloco "title_filter:" nao encontrado em ' + FILE);
  process.exit(1);
}
const tfIndent = indentOf(lines[tfIdx]);

let tfEnd = lines.length;
for (let i = tfIdx + 1; i < lines.length; i++) {
  const l = lines[i];
  if (l.trim() === '' || l.trim().startsWith('#')) continue;
  if (indentOf(l) <= tfIndent) { tfEnd = i; break; }
}

function findList(name) {
  for (let i = tfIdx + 1; i < tfEnd; i++) {
    if (new RegExp(`^\\s*${name}\\s*:`).test(lines[i])) {
      let last = i;
      for (let j = i + 1; j < tfEnd; j++) {
        const l = lines[j];
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        if (isItem(l)) { last = j; continue; }
        break;
      }
      return { header: i, last };
    }
  }
  return null;
}

const changes = [];
// Trabalha de baixo para cima para os indices nao se deslocarem.
const plan = [
  { name: 'negative', remove: REMOVE_NEGATIVE, add: [...ADD_NEGATIVE, ...(BLOCK_SALES ? SALES_NEGATIVE : [])] },
  { name: 'positive', remove: REMOVE_POSITIVE, add: ADD_POSITIVE },
];

for (const step of plan) {
  const loc = findList(step.name);
  if (!loc) { console.error(`erro: lista "${step.name}" nao encontrada dentro de title_filter.`); process.exit(1); }

  const existing = [];
  for (let i = loc.header + 1; i <= loc.last; i++) {
    if (isItem(lines[i])) existing.push({ i, v: itemValue(lines[i]) });
  }
  if (existing.length === 0) { console.error(`erro: lista "${step.name}" esta vazia.`); process.exit(1); }

  const itemIndent = ' '.repeat(indentOf(lines[existing[0].i]));
  const quoted = /^\s*-\s+"/.test(lines[existing[0].i]);
  const fmt = (v) => `${itemIndent}- ${quoted ? JSON.stringify(v) : v}`;

  // Remocoes (de tras para frente).
  const toRemove = existing.filter((e) => step.remove.some((r) => r.toLowerCase() === String(e.v).toLowerCase()));
  for (const e of [...toRemove].reverse()) {
    lines.splice(e.i, 1);
    changes.push(`  ${step.name}: − ${e.v}`);
  }

  // Insercoes, pulando o que ja existe.
  const loc2 = findList(step.name);
  const have = new Set();
  for (let i = loc2.header + 1; i <= loc2.last; i++) {
    if (isItem(lines[i])) have.add(String(itemValue(lines[i])).toLowerCase());
  }
  const fresh = step.add.filter((v) => !have.has(v.toLowerCase()));
  if (fresh.length) {
    lines.splice(loc2.last + 1, 0, ...fresh.map(fmt));
    for (const v of fresh) changes.push(`  ${step.name}: + ${v}`);
  }
}

console.log(`\n${FILE} — fim de linha ${eol === '\r\n' ? 'CRLF' : 'LF'}\n`);
if (changes.length === 0) {
  console.log('Nada a alterar. O filtro ja esta como deveria.\n');
  process.exit(0);
}
console.log(`${changes.length} alteracao(oes):`);
for (const c of changes) console.log(c);

if (!BLOCK_SALES) {
  console.log('\nVagas comerciais continuam VISIVEIS (pedido do usuario em 17/11/2026).');
  console.log('Para barra-las depois: node fix-title-filter.mjs --bloquear-vendas');
}

if (DRY) {
  console.log('\n--dry-run: nada foi escrito.\n');
  process.exit(0);
}

copyFileSync(FILE, `${FILE}.bak`);
writeFileSync(FILE, lines.join(eol), 'utf8');
console.log(`\nBackup: ${FILE}.bak`);
console.log(`${FILE} atualizado.\n`);
