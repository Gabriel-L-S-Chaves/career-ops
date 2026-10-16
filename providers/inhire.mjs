// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// InHire provider — ATS brasileiro usado por fintechs e startups de tecnologia,
// e um ponto cego do scanner até aqui: várias empresas do setor de pagamentos
// publicam exclusivamente no InHire e nenhuma era alcançável por `node scan.mjs`.
//
// ── O endpoint ─────────────────────────────────────────────────────────────
// A página de carreira pública é servida por:
//
//   GET https://api.inhire.app/job-posts/public/pages
//   Header obrigatório: X-Tenant: {slug}
//
// O tenant é o mesmo slug do subdomínio da empresa na plataforma, então um
// `careers_url` de `https://{slug}.inhire.app` o determina sozinho. Não há
// token: as rotas autenticadas vivem em auth.inhire.app e são do lado
// empregador, fora do escopo deste scanner.
//
// Não existe busca global no InHire — diferente do portal da Gupy, cada tenant
// é consultado isoladamente. Portanto este provider funciona por empresa, como
// greenhouse e lever, e só enxerga quem estiver no `tracked_companies`.
//
// ── Tolerância de nomes de campo, e por quê ────────────────────────────────
// A documentação pública confirma o envelope `{ tenantName, about, logo,
// background, jobsPage: [{ status, jobId, displayName }] }`, mas não publica o
// schema completo dos itens — e o ambiente onde isto foi escrito não alcança
// api.inhire.app para conferir contra uma resposta real. Seguindo o mesmo
// critério do providers/gupy.mjs: cada campo é lido por uma lista de nomes
// plausíveis em vez de uma chave fixa, e um envelope irreconhecível ESTOURA
// nomeando as chaves que realmente vieram, em vez de devolver zero vagas em
// silêncio. Um scanner que diz "0 novas" quando na verdade está quebrado é
// pior do que um que falha.

const INHIRE_HOST_RE = /^([a-z0-9][a-z0-9-]*)\.inhire\.app$/;
const PUBLIC_PAGES_API = 'https://api.inhire.app/job-posts/public/pages';

/**
 * Extrai o tenant de um careers_url do InHire.
 * `https://empresa.inhire.app` → `empresa`; qualquer outra coisa → null.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function tenantFromCareersUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const m = INHIRE_HOST_RE.exec(parsed.hostname);
  if (!m) return null;
  const tenant = m[1];
  // `api` e `jobs` são hosts de serviço, não tenants de empresa.
  if (tenant === 'api' || tenant === 'jobs' || tenant === 'www' || tenant === 'auth') return null;
  return tenant;
}

/** Primeiro valor string não vazio entre os apelidos conhecidos. */
function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// Status que indicam vaga fora do ar. Qualquer outro valor — inclusive um
// desconhecido — passa: a convenção do scanner é não penalizar dado ausente
// ou inesperado, e o endpoint é o da página pública, que já deveria listar
// apenas o que está publicado.
const CLOSED_STATUS = new Set([
  'closed', 'draft', 'archived', 'paused', 'finished',
  'canceled', 'cancelled', 'inactive', 'unpublished',
]);

/**
 * Normaliza um item de `jobsPage` para o contrato Job. Exportada para teste.
 *
 * @param {any} raw
 * @param {string} tenant
 * @param {string} companyName
 * @returns {{title: string, url: string, company: string, location: string, postedAt?: number} | null}
 */
export function normalizeInhireJob(raw, tenant, companyName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const title = firstString(raw, ['displayName', 'name', 'title', 'jobTitle']);
  const id = raw.jobId ?? raw.id ?? raw.jobPostId ?? null;
  if (!title || id === null || id === undefined || String(id).trim() === '') return null;

  const status = firstString(raw, ['status', 'jobStatus', 'state']).toLowerCase();
  if (status && CLOSED_STATUS.has(status)) return null;

  // Localização: string plana ou objeto aninhado, dependendo do tenant.
  let location = firstString(raw, ['location', 'city', 'workplaceCity', 'locationName']);
  if (!location && raw.address && typeof raw.address === 'object') {
    location = [raw.address.city, raw.address.state, raw.address.country]
      .filter(p => typeof p === 'string' && p.trim())
      .join(', ');
  }
  // O InHire marca remoto num campo próprio. Sem isto, uma vaga 100% remota
  // chegaria ao filtro de localização como string vazia e passaria por sorte,
  // não por mérito.
  const remoteRaw = raw.isRemote ?? raw.remote ?? raw.workplaceType ?? raw.workModel;
  const isRemote = remoteRaw === true
    || (typeof remoteRaw === 'string' && /remote|remoto|home\s*office/i.test(remoteRaw));
  if (isRemote) location = location ? `${location} (Remoto)` : 'Remoto';

  const publishedRaw = firstString(raw, ['publishedAt', 'publishedDate', 'createdAt', 'startDate']);
  const published = publishedRaw ? Date.parse(publishedRaw) : NaN;

  const job = {
    title,
    url: `https://${tenant}.inhire.app/vaga/${encodeURIComponent(String(id))}`,
    company: companyName,
    location,
  };
  if (Number.isFinite(published) && published > 0) {
    return { ...job, postedAt: published };
  }
  return job;
}

/**
 * Lê o array de vagas do envelope da página de carreira. Exportada para teste.
 *
 * Estoura com as chaves recebidas quando o envelope não é reconhecido, em vez
 * de devolver [] e mascarar uma quebra de contrato da API.
 *
 * @param {any} json
 * @param {string} tenant
 * @param {string} companyName
 * @returns {Array<object>}
 */
export function parseInhireResponse(json, tenant, companyName) {
  if (!json || typeof json !== 'object') {
    throw new Error(`inhire: resposta não é um objeto para tenant "${tenant}"`);
  }
  const list = json.jobsPage ?? json.jobs ?? json.data ?? json.items;
  if (!Array.isArray(list)) {
    const keys = Object.keys(json).join(', ') || '(nenhuma)';
    throw new Error(
      `inhire: envelope irreconhecível para tenant "${tenant}" — `
      + `esperava um array em jobsPage, vieram as chaves: ${keys}`,
    );
  }
  return list
    .map(raw => normalizeInhireJob(raw, tenant, companyName))
    .filter(Boolean);
}

/** @type {Provider} */
export default {
  id: 'inhire',

  detect(entry) {
    const tenant = tenantFromCareersUrl(entry.careers_url);
    return tenant ? { url: PUBLIC_PAGES_API } : null;
  },

  async fetch(entry, ctx) {
    const tenant = tenantFromCareersUrl(entry.careers_url);
    if (!tenant) {
      throw new Error(
        `inhire: não consegui derivar o tenant de "${entry.name}" — `
        + 'careers_url precisa ser https://{slug}.inhire.app',
      );
    }
    // A URL é constante e literal, então não há superfície de SSRF: o valor
    // controlado pelo portals.yml entra só no header X-Tenant, nunca no host.
    const json = await ctx.fetchJson(PUBLIC_PAGES_API, {
      headers: { 'X-Tenant': tenant },
      redirect: 'error',
    });
    return parseInhireResponse(json, tenant, entry.name);
  },
};
