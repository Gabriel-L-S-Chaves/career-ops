// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Gupy provider — Brazil's dominant ATS, and until now the scanner's biggest
// blind spot: most Brazilian fintech, payments and retail employers publish
// exclusively on Gupy, and none of them were reachable by `node scan.mjs`.
//
// Two shapes of endpoint, both public JSON, neither needing a token (the
// authenticated api.gupy.io is the employer-side API and is NOT used here):
//
//   1. Per-company board — `https://{company}.gupy.io/api/v1/jobs`
//      Derived automatically from a `careers_url` of `https://{company}.gupy.io`.
//      Use this for a portals.yml entry that names one employer.
//
//   2. Portal-wide search — `https://employability-portal.gupy.io/api/v1/jobs`
//      Queries EVERY company on Gupy at once, filtered by `?jobName=&city=&state=`.
//      Set it explicitly as `api:` on an entry to sweep the whole platform by
//      keyword instead of by employer. This is the high-yield mode: one entry
//      covers employers that were never on any company list.
//
// Pagination is `?limit=&offset=`; pages are walked until one comes back short
// or the page cap is hit (`max_pages`, default 5).
//
// ── Field-name tolerance, and why ──────────────────────────────────────────
// This provider was written from Gupy's public documentation and third-party
// descriptions of the payload, NOT verified against a live response (the
// authoring environment blocks gupy.io). Every field is therefore read through
// a list of plausible names rather than one hardcoded key, and an unrecognized
// envelope throws with the keys it actually saw instead of silently returning
// zero jobs — a scanner that reports "0 new" when it is really broken is worse
// than one that fails. If the live payload differs, the error names the fix.

const GUPY_SUFFIX = '.gupy.io';
const PORTAL_HOST = 'employability-portal.gupy.io';
const PORTAL_API = `https://${PORTAL_HOST}/api/v1/jobs`;
const PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 50;

/** Any host on gupy.io — company boards are `{company}.gupy.io`. */
function isGupyHost(hostname) {
  return hostname === 'gupy.io' || hostname.endsWith(GUPY_SUFFIX);
}

/** @param {string} url */
function assertGupyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`gupy: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`gupy: URL must use HTTPS: ${url}`);
  if (!isGupyHost(parsed.hostname))
    throw new Error(`gupy: untrusted hostname "${parsed.hostname}" — must be gupy.io or a subdomain`);
  return url;
}

/**
 * Resolve the JSON endpoint for a portal entry.
 * An explicit `api:` wins (that is how the portal-wide sweep is configured);
 * otherwise a `{company}.gupy.io` careers_url becomes that board's API.
 *
 * @param {import('./_types.js').PortalEntry} entry
 * @returns {string | null}
 */
export function resolveGupyApiUrl(entry) {
  if (entry?.api) {
    // detect() runs this against EVERY entry, including other providers'. An
    // `api:` on another host means "not mine" — return null rather than throw,
    // or a Lever entry makes this provider raise during detection (#registry
    // catches it, but the warning is noise and the verdict is wrong). A gupy
    // host with a bad protocol IS mine and misconfigured, so that still throws.
    let parsed;
    try {
      parsed = new URL(entry.api);
    } catch {
      return null;
    }
    if (!isGupyHost(parsed.hostname)) return null;
    assertGupyUrl(entry.api);
    return entry.api;
  }
  const raw = entry?.careers_url || '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!isGupyHost(parsed.hostname)) return null;
  if (parsed.hostname === PORTAL_HOST || parsed.hostname === 'portal.gupy.io') return PORTAL_API;
  return `https://${parsed.hostname}/api/v1/jobs`;
}

/** First non-empty string among `keys` on `obj`. */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Gupy's workplaceType vocabulary → a label a Portuguese location_filter matches.
// The raw token is kept alongside it so an English filter still hits.
const WORKPLACE_LABELS = {
  remote: 'Remoto',
  hybrid: 'Híbrido',
  'on-site': 'Presencial',
  on_site: 'Presencial',
  onsite: 'Presencial',
  presencial: 'Presencial',
  remoto: 'Remoto',
  hibrido: 'Híbrido',
};

/**
 * Normalize one Gupy job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape (each read through name variants,
 * see the header note on why):
 *   - title:    `name` | `title` | `jobName`, trimmed; item dropped without one.
 *   - url:      `jobUrl` | `applyUrl` | `url` | `careerPageUrl`, required to be
 *               https on gupy.io. When absent but an `id` is present, it is
 *               rebuilt as `{board}/jobs/{id}` from the request host. Dedup key.
 *   - company:  `careerPageName` | `companyName` | `company` (string or
 *               `{name}`), falling back to the portal entry name.
 *   - location: `city` + `state` + the workplace label (and its raw token).
 *   - postedAt: `publishedDate` | `publishedAt` | `createdAt` → epoch ms.
 *
 * A posting whose `applicationDeadline` has already passed, or whose status
 * says it is closed, is dropped: returning live openings is the entire reason
 * this provider exists.
 *
 * @param {any} j
 * @param {{ fallbackCompany?: string, boardOrigin?: string, now?: number }} [opts]
 * @returns {{ title: string, url: string, company: string, location: string, postedAt?: number } | null}
 */
export function normalizeGupyJob(j, opts = {}) {
  if (!j || typeof j !== 'object') return null;

  const title = pick(j, ['name', 'title', 'jobName']);
  if (!title) return null;

  // Closed postings are dropped — a stale opening is exactly what this replaces.
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const deadline = toEpochMs(pick(j, ['applicationDeadline', 'expiresAt', 'endDate']));
  if (deadline !== undefined && deadline < now) return null;
  const status = pick(j, ['status', 'jobStatus']).toLowerCase();
  if (status && /closed|encerrad|cancel|expired|archived|inativ/.test(status)) return null;
  if (j.isActive === false || j.active === false || j.published === false) return null;

  // url must be an absolute https posting link on gupy.io; otherwise rebuild it
  // from the board origin and the job id, and drop the item if neither works.
  let url = '';
  const rawUrl = pick(j, ['jobUrl', 'applyUrl', 'url', 'careerPageUrl', 'link']);
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && isGupyHost(parsed.hostname)) url = parsed.href;
    } catch {
      // malformed → fall through to the id-based rebuild
    }
  }
  if (!url && opts.boardOrigin && (typeof j.id === 'number' || typeof j.id === 'string')) {
    const id = String(j.id).trim();
    // Guard the path segment: only a bare id may reach the URL.
    if (/^[A-Za-z0-9_-]+$/.test(id)) {
      try {
        const origin = new URL(opts.boardOrigin);
        if (origin.protocol === 'https:' && isGupyHost(origin.hostname)) {
          url = `https://${origin.hostname}/jobs/${id}`;
        }
      } catch {
        // unusable origin → url stays empty → dropped below
      }
    }
  }
  if (!url) return null;

  let company = pick(j, ['careerPageName', 'companyName', 'company', 'employerName']);
  if (!company && j.company && typeof j.company === 'object') company = pick(j.company, ['name']);
  if (!company) company = opts.fallbackCompany || 'Gupy';

  const workplaceRaw = pick(j, ['workplaceType', 'workModel', 'workplace']);
  const workplaceLabel = WORKPLACE_LABELS[workplaceRaw.toLowerCase()] || '';
  const location = [
    pick(j, ['city', 'cityName']),
    pick(j, ['state', 'stateName', 'uf']),
    workplaceLabel,
    // keep the raw token when it adds something the label does not
    workplaceLabel && workplaceRaw.toLowerCase() !== workplaceLabel.toLowerCase() ? workplaceRaw : '',
  ]
    .filter(Boolean)
    .join(', ');

  /** @type {{ title: string, url: string, company: string, location: string, postedAt?: number }} */
  const job = { title, url, company, location };
  const postedAt = toEpochMs(pick(j, ['publishedDate', 'publishedAt', 'createdAt', 'createdDate']));
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Pull the job array out of the response envelope. Gupy is documented as
 * `{ data: [...] }`; accept the bare array and a couple of common wrappers so a
 * minor shape change does not read as an empty board.
 */
export function extractGupyJobs(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const key of ['data', 'jobs', 'results', 'items', 'content']) {
      if (Array.isArray(json[key])) return json[key];
    }
  }
  return null;
}

/** @type {Provider} */
export default {
  id: 'gupy',

  detect(entry) {
    return resolveGupyApiUrl(entry) !== null;
  },

  async fetch(entry, ctx) {
    const base = resolveGupyApiUrl(entry);
    if (!base) return [];
    assertGupyUrl(base);

    const maxPages = resolveMaxPages(entry);
    const fallbackCompany = entry?.name;
    const boardOrigin = new URL(base).origin;
    const out = [];

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(base);
      url.searchParams.set('limit', String(PER_PAGE));
      url.searchParams.set('offset', String(page * PER_PAGE));

      // redirect:'error' prevents SSRF via server-side redirects
      const json = await ctx.fetchJson(url.href, { redirect: 'error' });
      const rows = extractGupyJobs(json);
      if (rows === null) {
        throw new Error(
          `gupy: unexpected API response at offset ${page * PER_PAGE} — expected { data: [...] }, got keys: [${
            json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json
          }]`,
        );
      }

      for (const row of rows) {
        const normalized = normalizeGupyJob(row, { fallbackCompany, boardOrigin });
        if (normalized) out.push(normalized);
      }
      if (rows.length < PER_PAGE) break; // short page → last page reached
    }
    return out;
  },
};
