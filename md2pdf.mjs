#!/usr/bin/env node
// md2pdf.mjs — converte um dossiê markdown em PDF estilizado.
// Uso: node md2pdf.mjs data/dossie-empresa.md output/dossie-empresa.pdf
// Ferramenta local do usuário; não faz parte do career-ops upstream.

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { chromium } from 'playwright';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('Uso: node md2pdf.mjs <entrada.md> <saida.pdf>');
  process.exit(1);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function render(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0, inTable = false;

  while (i < lines.length) {
    const l = lines[i];

    if (/^\|/.test(l) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const head = l.split('|').slice(1, -1).map(c => `<th>${inline(c.trim())}</th>`).join('');
      out.push(`<table><tr>${head}</tr>`);
      i += 2; inTable = true;
      while (i < lines.length && /^\|/.test(lines[i])) {
        const row = lines[i].split('|').slice(1, -1).map(c => `<td>${inline(c.trim())}</td>`).join('');
        out.push(`<tr>${row}</tr>`); i++;
      }
      out.push('</table>'); inTable = false; continue;
    }

    if (/^---+$/.test(l.trim())) { out.push('<hr>'); i++; continue; }
    if (/^#{1,4}\s/.test(l)) {
      const n = l.match(/^#+/)[0].length;
      out.push(`<h${n}>${inline(l.replace(/^#+\s/, ''))}</h${n}>`); i++; continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(inline(lines[i].replace(/^>\s?/, ''))); i++; }
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`); continue;
    }
    if (/^[-*]\s/.test(l) || /^\d+\.\s/.test(l)) {
      const ord = /^\d+\.\s/.test(l);
      const tag = ord ? 'ol' : 'ul';
      out.push(`<${tag}>`);
      while (i < lines.length && (/^[-*]\s/.test(lines[i]) || /^\d+\.\s/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        if (/^\s{2,}\S/.test(lines[i])) { out.push(`<div class="sub">${inline(lines[i].trim())}</div>`); i++; continue; }
        out.push(`<li>${inline(lines[i].replace(/^([-*]|\d+\.)\s/, ''))}</li>`); i++;
      }
      out.push(`</${tag}>`); continue;
    }
    if (l.trim() === '') { i++; continue; }

    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^[#>|-]/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

const CSS = `
@page { size: A4; margin: 15mm 13mm 13mm 13mm; }
*{box-sizing:border-box}
body{font:9.8pt/1.5 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1b1726;margin:0}
h1{font-size:21pt;margin:0 0 10px;letter-spacing:-.5px;color:#2a1b45;border-bottom:3px solid #6d3bd4;padding-bottom:8px}
h2{font-size:12.5pt;margin:20px 0 8px;padding:6px 10px;color:#2a1b45;background:#f1ebfb;border-left:4px solid #6d3bd4;border-radius:0 3px 3px 0;page-break-after:avoid}
h3{font-size:10.5pt;margin:14px 0 5px;color:#2a1b45;page-break-after:avoid}
h4{font-size:9.8pt;margin:11px 0 4px;color:#463a5e;page-break-after:avoid}
p{margin:6px 0}
table{width:100%;border-collapse:collapse;margin:9px 0 12px;font-size:8.6pt;page-break-inside:avoid}
th{background:#2a1b45;color:#fff;text-align:left;padding:5px 8px;font-weight:600;font-size:8.3pt}
td{padding:5px 8px;border-bottom:1px solid #e4dfec;vertical-align:top}
tr:nth-child(even) td{background:#faf8fd}
blockquote{background:#eef4fd;border:1px solid #b4cdf0;border-left:4px solid #2563c7;padding:9px 12px;margin:12px 0;border-radius:0 4px 4px 0;font-size:9.2pt;page-break-inside:avoid}
code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:8.2pt;background:#f1ebfb;color:#5b2eb8;padding:1px 4px;border-radius:3px}
ul,ol{margin:6px 0;padding-left:19px}
li{margin:3px 0}
.sub{margin:2px 0 6px 19px;font-size:8.8pt;color:#5d5470;font-style:italic}
hr{border:0;border-top:1px solid #e4dfec;margin:14px 0}
strong{color:#2a1b45}
a{color:#5b2eb8;text-decoration:none;word-break:break-all}
em{color:#463a5e}
`;

const md = readFileSync(input, 'utf-8');
const title = (md.match(/^#\s+(.+)$/m) || [, 'Dossiê'])[1];
const html = `<meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style>\n${render(md)}`;

const tmp = output.replace(/\.pdf$/, '.__tmp.html');
writeFileSync(tmp, html, 'utf-8');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.goto('file://' + process.cwd() + '/' + tmp, { waitUntil: 'networkidle' });
await page.pdf({ path: output, format: 'A4', printBackground: true });
await browser.close();
unlinkSync(tmp);

console.log(`✅ ${output}`);
