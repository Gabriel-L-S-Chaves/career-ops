// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Greenhouse provider — hits the public boards-api JSON endpoint.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.

import { decodeEntities } from './_html-entities.mjs';

const ALLOWED_GREENHOUSE_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

/** @param {string} url */
function assertGreenhouseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`greenhouse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_GREENHOUSE_HOSTS.has(parsed.hostname))
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_GREENHOUSE_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  if (entry.api) {
    assertGreenhouseUrl(entry.api);
    return entry.api;
  }
  const url = entry.careers_url || '';
  const match = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

// ── HTML embed-board fallback (26/11/2026) ──────────────────────────
// Some networks intercept `boards-api.greenhouse.io` specifically — a
// corporate web filter or antivirus HTTPS scanning presents its own
// certificate and the TLS handshake fails with SEC_E_UNTRUSTED_ROOT /
// UNABLE_TO_VERIFY_LEAF_SIGNATURE — while `job-boards.greenhouse.io` stays
// reachable. On such a network EVERY Greenhouse board reads as "network
// error" and the provider goes dark all at once (16 tracked companies in the
// field report that motivated this, with Lever/Ashby/Recruitee/InHire/Breezy
// all answering in the same scan — that asymmetry is the signature).
//
// The public embed board on the reachable host serves the same postings as
// HTML, so a failed JSON fetch falls back to parsing it. Verified against
// job-boards.greenhouse.io/embed/job_board?for=stone on 26/11/2026:
//   - `?format=json` is ignored; the response is always HTML
//   - there is no JSON API on that host (/api/v1/boards/<token>/jobs → 404)
//   - `page=N` paginates at 50 postings per page with NO overlap between
//     pages, and the first page with no postings ends the walk (50 50 50 50
//     50 9, then empty — 259 postings for that board)
//
// The embed board carries no publication date, so postedAt is absent for
// fallback results. scan.mjs treats a missing postedAt as passing every date
// filter (see the age/date filters), so these postings are never silently
// dropped for lacking one.

const EMBED_PAGE_SIZE = 50;
// Hard stop at 5000 postings. Never reached in practice (the largest board
// observed is 367); it exists so a board that ignores `page` and keeps
// serving identical content cannot spin forever. The repeat guard below is
// the primary defence; this is the backstop.
const EMBED_MAX_PAGES = 100;

// Each posting is one anchor wrapping two <p>s — title then location:
//   <tr class="job-post"><td class="cell">
//     <a href="https://job-boards.greenhouse.io/stone/jobs/8209262003" target="_top">
//       <p class="body body--medium">Agente Stone — Apucarana/PR</p>
//       <p class="body body__secondary body--metadata">Apucarana, Parana, Brasil</p>
//     </a>
//   </td></tr>
// Anchors never nest, so the lazy [\s\S]*? cannot run past its own </a>.
const EMBED_POST_RE = /<a\s[^>]*href="(https:\/\/job-boards(?:\.eu)?\.greenhouse\.io\/[^"]*?\/jobs\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
const EMBED_TITLE_RE = /<p[^>]*class="[^"]*body--medium[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
const EMBED_META_RE = /<p[^>]*class="[^"]*body--metadata[^"]*"[^>]*>([\s\S]*?)<\/p>/i;

/** Strip tags, decode entities, collapse whitespace. @param {string} html */
function embedText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Derive the board token (and EU-ness) from a tracked_companies entry. The
// token is what both the JSON API and the embed board are keyed by, so it is
// read from whichever field carries it: a job-boards careers_url, a
// boards-api `api:` URL, or an embed URL's `?for=`.
/** @param {import('./_types.js').PortalEntry} entry */
export function resolveBoardToken(entry) {
  for (const raw of [entry?.careers_url, entry?.api]) {
    if (typeof raw !== 'string' || !raw) continue;
    const m = raw.match(/job-boards(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([^/?#]+)/)
      || raw.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/)
      || raw.match(/[?&]for=([^&#]+)/);
    if (m && m[1]) return { token: m[1], eu: /\.eu\.greenhouse\.io/i.test(raw) };
  }
  return null;
}

/**
 * @param {{ token: string, eu: boolean }} board
 * @param {number} page
 */
export function embedUrlFor({ token, eu }, page) {
  // The EU host is assumed to serve /embed/job_board like the US one. Not
  // verified against a live EU board — if it does not, the fallback simply
  // yields nothing and the original API error is reported, same as before.
  const host = eu ? 'job-boards.eu.greenhouse.io' : 'job-boards.greenhouse.io';
  return `https://${host}/embed/job_board?for=${encodeURIComponent(token)}&page=${page}`;
}

/**
 * Parse one embed-board page into offers.
 * @param {string} html
 * @param {string} companyName
 */
export function parseEmbedPage(html, companyName) {
  const out = [];
  for (const m of String(html ?? '').matchAll(EMBED_POST_RE)) {
    const url = m[1];
    const inner = m[2] || '';
    const title = embedText((inner.match(EMBED_TITLE_RE) || [])[1] || '');
    // No title means this anchor is not a posting row (a "view job" link, a
    // breadcrumb). Dropping it keeps the count honest for the page-size
    // comparison that decides whether to request another page.
    if (!title) continue;
    out.push({
      title,
      url,
      company: companyName,
      location: embedText((inner.match(EMBED_META_RE) || [])[1] || ''),
      // postedAt intentionally absent — the embed board does not carry one.
    });
  }
  return out;
}

/**
 * Walk the embed board. Returns [] when the board is reachable but empty, and
 * null when the fallback itself could not run (no token, first page failed) —
 * the caller distinguishes the two.
 * @param {import('./_types.js').PortalEntry} entry
 * @param {import('./_types.js').ProviderContext} ctx
 */
async function fetchEmbedBoard(entry, ctx) {
  const board = resolveBoardToken(entry);
  if (!board) return null;
  const hinted = Number(ctx?.maxPages);
  const maxPages = Number.isFinite(hinted) && hinted > 0
    ? Math.min(hinted, EMBED_MAX_PAGES)
    : EMBED_MAX_PAGES;

  const seen = new Set();
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = embedUrlFor(board, page);
    assertGreenhouseUrl(url);
    let html;
    try {
      html = await ctx.fetchText(url, { redirect: 'error' });
    } catch {
      // First page unreachable: the fallback never got off the ground, so the
      // caller must report the original API failure, not this one. A later
      // page failing is partial success — keep what was collected.
      if (out.length === 0) return null;
      break;
    }
    const batch = parseEmbedPage(html, entry.name);
    if (batch.length === 0) break;

    let added = 0;
    for (const job of batch) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      out.push(job);
      added += 1;
    }
    // A board that ignores `page` serves page 1 forever; without this the
    // loop would run to EMBED_MAX_PAGES on every scan of such a board.
    if (added === 0) break;
    // A short page is the last one — stop instead of paying for the empty one
    // after it.
    if (batch.length < EMBED_PAGE_SIZE) break;
    if (typeof ctx.sleep === 'function') await ctx.sleep(250);
  }
  return out;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ── Office enrichment ───────────────────────────────────────────────
// Some Greenhouse boards put the *work model* ("Hybrid", "In-Office",
// "Distributed") in location.name and keep the actual city in the separate
// offices[] array — which the /jobs list endpoint does not return. For those
// boards scan.mjs's location_filter never sees a city, so every role is
// evaluated against the string "Hybrid" and silently dropped. Same bug class
// as #1073 (Ashby dropping secondaryLocations), different provider.
//
// The city is recoverable from /v1/boards/{slug}/offices, which nests
// offices → departments → jobs and costs one extra request. That request is
// only worth making for boards that actually exhibit the pattern: boards
// already reporting real cities pay nothing (Datadog's /offices is 2.8MB).

const WORK_MODEL = /^(?:hybrid|in[-\s]?office|on[-\s]?site|distributed|remote|flexible)$/i;

/**
 * True when a location string carries a work model but no geography at all
 * ("Hybrid", "Distributed; Hybrid"). Anything with a place in it
 * ("Hybrid - London", "Remote (Canada)") is already filterable and is left
 * alone, so enrichment can never rewrite a location that was working.
 * @param {unknown} name
 */
export function isWorkModelOnly(name) {
  if (typeof name !== 'string') return false;
  const parts = name.split(';').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => WORK_MODEL.test(p));
}

/**
 * boards/{slug}/jobs → boards/{slug}/offices. Returns null for any other
 * shape (e.g. a single-job URL), which disables enrichment rather than
 * guessing at an endpoint.
 * @param {string} apiUrl
 */
export function officesUrlFor(apiUrl) {
  const m = apiUrl.match(/^(https:\/\/[^/]+\/v1\/boards\/[^/]+)\/jobs(?:$|[?#])/);
  return m ? `${m[1]}/offices` : null;
}

/**
 * Build jobId → Set(office names) by walking offices → departments → jobs.
 * A job listed under several offices collects all of them, which is how a
 * genuinely multi-site role keeps every city it is open to.
 * @param {any} json
 */
export function buildOfficeMap(json) {
  /** @type {Map<any, Set<string>>} */
  const map = new Map();
  /** @param {any} offices */
  const walk = (offices) => {
    if (!Array.isArray(offices)) return;
    for (const office of offices) {
      if (!office || typeof office !== 'object') continue;
      const name = typeof office.name === 'string' ? office.name.trim() : '';
      if (name) {
        for (const dept of Array.isArray(office.departments) ? office.departments : []) {
          for (const job of Array.isArray(dept?.jobs) ? dept.jobs : []) {
            if (!job || job.id == null) continue;
            if (!map.has(job.id)) map.set(job.id, new Set());
            map.get(job.id).add(name);
          }
        }
      }
      walk(office.children);
    }
  };
  walk(json?.offices);
  return map;
}

/** @type {Provider} */
export default {
  id: 'greenhouse',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
    assertGreenhouseUrl(apiUrl);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertGreenhouseUrl above it guarantees the final hostname stays in the allowlist.
    let json;
    try {
      json = /** @type {any} */ (await ctx.fetchJson(apiUrl, { redirect: 'error' }));
    } catch (err) {
      // The JSON host may be unreachable while the embed board is not (see the
      // fallback block above). Try it before giving up.
      const fallback = await fetchEmbedBoard(entry, ctx);
      if (fallback && fallback.length > 0) {
        const cause = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  greenhouse: ${entry.name} JSON API unreachable (${cause}) — fell back to the HTML embed board, ${fallback.length} posting(s), no publication dates`);
        return fallback;
      }
      // Fallback unavailable or empty: report the ORIGINAL failure. Replacing
      // it with the fallback's own error would hide the real cause and make
      // the "unreachable for 3+ runs" signal point at the wrong thing.
      throw err;
    }
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    const usable = jobs.filter(/** @param {any} j */ j => j.absolute_url);

    // Only pay for /offices when this board actually hides its cities there.
    let officeMap = null;
    if (usable.some(/** @param {any} j */ j => isWorkModelOnly(j.location?.name))) {
      const officesUrl = officesUrlFor(apiUrl);
      if (officesUrl) {
        try {
          assertGreenhouseUrl(officesUrl);
          officeMap = buildOfficeMap(await ctx.fetchJson(officesUrl, { redirect: 'error' }));
        } catch (err) {
          // No /offices on this board, or it failed — fall back to the bare
          // work-model string. Enrichment is best-effort; a scan must never
          // fail because the secondary lookup did. Logged so a persistent
          // regression is distinguishable from a board that simply has no
          // /offices, which is expected and harmless.
          // `err` is not guaranteed to be an Error — a promise may reject with
          // anything, and reading .message off null would throw *inside* the
          // catch, defeating the guarantee above.
          const cause = err instanceof Error ? err.message : String(err);
          console.error(`⚠️  greenhouse: ${entry.name} /offices enrichment failed — ${cause} (keeping work-model-only locations)`);
          officeMap = null;
        }
      }
    }

    return usable.map(/** @param {any} j */ (j) => {
      let location = j.location?.name || '';
      if (officeMap && isWorkModelOnly(location)) {
        const offices = officeMap.get(j.id);
        if (offices && offices.size > 0) location = [location, ...offices].join(' · ');
      }
      return {
        title: j.title || '',
        url: j.absolute_url,
        company: entry.name,
        location,
        postedAt: toEpochMs(j.first_published),
      };
    });
  },
};
