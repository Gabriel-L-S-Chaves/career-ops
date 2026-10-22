// tests/providers/gupy.test.mjs — unit tests for the Gupy provider.
//
// The provider was written without access to a live gupy.io response (the
// authoring environment blocks the host), so these tests pin the behaviour that
// has to hold whatever the payload turns out to look like: field-name
// tolerance, host locking, closed-posting rejection, and a loud failure on an
// envelope the provider does not recognize.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — gupy');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/gupy.mjs')).href);
  const gupy = mod.default;
  const { normalizeGupyJob, resolveGupyApiUrl, extractGupyJobs } = mod;

  if (gupy.id === 'gupy') pass('gupy.id is "gupy"');
  else fail(`gupy.id is ${JSON.stringify(gupy.id)}`);

  // ── resolveGupyApiUrl ────────────────────────────────────────────────
  if (resolveGupyApiUrl({ careers_url: 'https://asaas.gupy.io/' }) === 'https://asaas.gupy.io/api/v1/jobs')
    pass('resolveGupyApiUrl derives a company board API from careers_url');
  else fail(`derived = ${resolveGupyApiUrl({ careers_url: 'https://asaas.gupy.io/' })}`);

  if (resolveGupyApiUrl({ careers_url: 'https://portal.gupy.io/job-search' }) === 'https://employability-portal.gupy.io/api/v1/jobs')
    pass('resolveGupyApiUrl maps the portal to the portal-wide search API');
  else fail(`portal mapping = ${resolveGupyApiUrl({ careers_url: 'https://portal.gupy.io/job-search' })}`);

  const explicit = 'https://employability-portal.gupy.io/api/v1/jobs?jobName=concilia%C3%A7%C3%A3o';
  if (resolveGupyApiUrl({ api: explicit, careers_url: 'https://asaas.gupy.io/' }) === explicit)
    pass('resolveGupyApiUrl: explicit api: wins over careers_url');
  else fail('explicit api: did not win');

  if (resolveGupyApiUrl({ careers_url: 'https://boards.greenhouse.io/stone' }) === null)
    pass('resolveGupyApiUrl returns null for a non-Gupy careers_url');
  else fail('non-Gupy careers_url was not rejected');

  // An `api:` on another host belongs to another provider: not mine, not an
  // error. detect() runs against every entry, so throwing here made a Lever
  // entry raise during detection.
  let threw = false;
  try {
    if (resolveGupyApiUrl({ api: 'https://api.lever.co/v0/postings/x' }) === null)
      pass('resolveGupyApiUrl returns null for another provider\'s api: URL (does not throw)');
    else fail('off-host api: URL was claimed as Gupy');
  } catch (err) {
    fail(`off-host api: URL threw instead of returning null — ${err.message}`);
  }

  // A gupy host with a bad protocol IS this provider's entry, misconfigured.
  threw = false;
  try { resolveGupyApiUrl({ api: 'http://asaas.gupy.io/api/v1/jobs' }); } catch { threw = true; }
  if (threw) pass('resolveGupyApiUrl throws on a non-HTTPS gupy.io api: URL');
  else fail('http:// api: URL was accepted');

  // detect() must never throw, whatever entry the registry hands it.
  for (const entry of [
    { api: 'https://api.lever.co/v0/postings/x' },
    { api: 'not-a-url' },
    { careers_url: 'https://boards.greenhouse.io/stone' },
    {},
  ]) {
    try {
      if (gupy.detect(entry) === false) pass(`detect() returns false without throwing for ${JSON.stringify(entry)}`);
      else fail(`detect() claimed ${JSON.stringify(entry)}`);
    } catch (err) {
      fail(`detect() threw for ${JSON.stringify(entry)} — ${err.message}`);
    }
  }

  // ── detect ───────────────────────────────────────────────────────────
  if (gupy.detect({ careers_url: 'https://pagseguro.gupy.io/' }) === true) pass('detect() matches a gupy.io careers_url');
  else fail('detect() missed a gupy.io careers_url');
  if (gupy.detect({ careers_url: 'https://jobs.lever.co/x' }) === false) pass('detect() ignores a non-Gupy entry');
  else fail('detect() claimed a non-Gupy entry');

  // ── normalizeGupyJob — documented field names ────────────────────────
  const full = normalizeGupyJob(
    {
      id: 8701964,
      name: '  Analista de Conciliação Sênior  ',
      careerPageName: '  Asaas  ',
      city: 'Joinville',
      state: 'SC',
      workplaceType: 'remote',
      publishedDate: '2026-09-01T12:00:00.000Z',
      jobUrl: 'https://asaas.gupy.io/jobs/8701964',
    },
    { fallbackCompany: 'Fallback', now: Date.parse('2026-09-17T00:00:00Z') },
  );
  if (full && full.title === 'Analista de Conciliação Sênior' && full.company === 'Asaas'
      && full.url === 'https://asaas.gupy.io/jobs/8701964'
      && full.location === 'Joinville, SC, Remoto, remote'
      && full.postedAt === Date.parse('2026-09-01T12:00:00.000Z')) {
    pass('normalizeGupyJob maps name/careerPageName/city/state/workplaceType/publishedDate');
  } else {
    fail(`full row = ${JSON.stringify(full)}`);
  }

  // Alternate field names must work identically — the payload was never seen live.
  const alt = normalizeGupyJob(
    { title: 'Analista de Operações', companyName: 'PagBank', applyUrl: 'https://pagseguro.gupy.io/jobs/9550383', workModel: 'hybrid', createdAt: '2026-08-20T00:00:00Z' },
    { now: Date.parse('2026-09-17T00:00:00Z') },
  );
  if (alt && alt.title === 'Analista de Operações' && alt.company === 'PagBank' && alt.location.includes('Híbrido'))
    pass('normalizeGupyJob accepts title/companyName/applyUrl/workModel variants');
  else fail(`alt row = ${JSON.stringify(alt)}`);

  // company as a nested object
  const nested = normalizeGupyJob({ name: 'X', company: { name: 'iugu' }, jobUrl: 'https://iugu.gupy.io/jobs/1' });
  if (nested?.company === 'iugu') pass('normalizeGupyJob reads a nested company.name');
  else fail(`nested company = ${JSON.stringify(nested)}`);

  // fallback company when the payload carries none
  const noCompany = normalizeGupyJob({ name: 'X', jobUrl: 'https://cora.gupy.io/jobs/1' }, { fallbackCompany: 'Cora' });
  if (noCompany?.company === 'Cora') pass('normalizeGupyJob falls back to the portal entry name');
  else fail(`fallback company = ${JSON.stringify(noCompany)}`);

  // ── URL rebuilding and host locking ──────────────────────────────────
  const rebuilt = normalizeGupyJob({ name: 'X', id: 12345 }, { boardOrigin: 'https://asaas.gupy.io' });
  if (rebuilt?.url === 'https://asaas.gupy.io/jobs/12345') pass('normalizeGupyJob rebuilds a missing url from boardOrigin + id');
  else fail(`rebuilt = ${JSON.stringify(rebuilt)}`);

  const offHost = normalizeGupyJob({ name: 'X', jobUrl: 'https://evil.example.com/jobs/1' });
  if (offHost === null) pass('normalizeGupyJob drops an off-host posting URL');
  else fail(`off-host row = ${JSON.stringify(offHost)}`);

  const httpUrl = normalizeGupyJob({ name: 'X', jobUrl: 'http://asaas.gupy.io/jobs/1' });
  if (httpUrl === null) pass('normalizeGupyJob drops a non-HTTPS posting URL');
  else fail(`http row = ${JSON.stringify(httpUrl)}`);

  const dirtyId = normalizeGupyJob({ name: 'X', id: '../../etc/passwd' }, { boardOrigin: 'https://asaas.gupy.io' });
  if (dirtyId === null) pass('normalizeGupyJob refuses to build a URL from a non-bare id (path traversal)');
  else fail(`dirty id row = ${JSON.stringify(dirtyId)}`);

  // ── closed postings are dropped ──────────────────────────────────────
  const now = Date.parse('2026-09-17T00:00:00Z');
  const expired = normalizeGupyJob(
    { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', applicationDeadline: '2026-09-10T00:00:00Z' },
    { now },
  );
  if (expired === null) pass('normalizeGupyJob drops a posting past its applicationDeadline');
  else fail(`expired row = ${JSON.stringify(expired)}`);

  const futureDeadline = normalizeGupyJob(
    { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', applicationDeadline: '2026-10-30T00:00:00Z' },
    { now },
  );
  if (futureDeadline !== null) pass('normalizeGupyJob keeps a posting whose deadline is still ahead');
  else fail('future deadline was dropped');

  for (const [label, row] of [
    ['status: closed', { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', status: 'closed' }],
    ['status: encerrada', { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', status: 'Encerrada' }],
    ['isActive: false', { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', isActive: false }],
    ['published: false', { name: 'X', jobUrl: 'https://asaas.gupy.io/jobs/1', published: false }],
  ]) {
    if (normalizeGupyJob(row, { now }) === null) pass(`normalizeGupyJob drops a posting with ${label}`);
    else fail(`${label} was not dropped`);
  }

  // A title-less row is not a job.
  if (normalizeGupyJob({ jobUrl: 'https://asaas.gupy.io/jobs/1' }) === null) pass('normalizeGupyJob drops a row with no title');
  else fail('title-less row survived');

  // ── envelope extraction ──────────────────────────────────────────────
  if (extractGupyJobs({ data: [1, 2] })?.length === 2) pass('extractGupyJobs reads the documented { data: [...] } envelope');
  else fail('data envelope not read');
  if (extractGupyJobs([1, 2, 3])?.length === 3) pass('extractGupyJobs accepts a bare array');
  else fail('bare array not accepted');
  if (extractGupyJobs({ jobs: [1] })?.length === 1) pass('extractGupyJobs tolerates a { jobs: [...] } wrapper');
  else fail('jobs wrapper not tolerated');
  if (extractGupyJobs({ unexpected: true }) === null) pass('extractGupyJobs returns null for an unrecognized envelope');
  else fail('unrecognized envelope was accepted');

  // ── fetch: pagination, and a loud failure on a bad envelope ──────────
  const page = (n) => Array.from({ length: n }, (_, i) => ({ name: `Job ${i}`, id: 1000 + i }));
  const seen = [];
  const ctx = {
    fetchJson: async (url) => {
      seen.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { data: offset === 0 ? page(100) : page(7) }; // second page short → stop
    },
  };
  const jobs = await gupy.fetch({ name: 'Asaas', careers_url: 'https://asaas.gupy.io/' }, ctx);
  if (jobs.length === 107) pass('fetch() walks pages until a short page (100 + 7 = 107)');
  else fail(`fetch returned ${jobs.length} jobs`);
  if (seen.length === 2 && seen[0].includes('offset=0') && seen[1].includes('offset=100'))
    pass('fetch() paginates with limit/offset and stops after the short page');
  else fail(`requested: ${JSON.stringify(seen)}`);
  if (jobs[0].url === 'https://asaas.gupy.io/jobs/1000' && jobs[0].company === 'Asaas')
    pass('fetch() rebuilds posting URLs against the board origin and fills the company');
  else fail(`first job = ${JSON.stringify(jobs[0])}`);

  const capped = await gupy.fetch(
    { name: 'Asaas', careers_url: 'https://asaas.gupy.io/', max_pages: 1 },
    { fetchJson: async () => ({ data: page(100) }) },
  );
  if (capped.length === 100) pass('fetch() honours max_pages');
  else fail(`max_pages=1 returned ${capped.length} jobs`);

  let fetchThrew = '';
  try {
    await gupy.fetch({ name: 'Asaas', careers_url: 'https://asaas.gupy.io/' }, { fetchJson: async () => ({ oops: 1 }) });
  } catch (err) {
    fetchThrew = err.message;
  }
  if (fetchThrew.includes('unexpected API response') && fetchThrew.includes('oops'))
    pass('fetch() throws naming the keys it saw, instead of reporting an empty board');
  else fail(`fetch error was: ${fetchThrew || '(none)'}`);
} catch (err) {
  fail(`gupy provider tests threw: ${err.message}`);
}
