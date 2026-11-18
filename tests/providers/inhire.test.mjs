// tests/providers/inhire.test.mjs — InHire, ATS brasileiro (página de carreira pública).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — inhire');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/inhire.mjs')).href);
  const inhire = mod.default;
  const { tenantFromCareersUrl, normalizeInhireJob, parseInhireResponse } = mod;

  if (inhire.id === 'inhire') pass('inhire.id is "inhire"');
  else fail(`inhire.id is ${JSON.stringify(inhire.id)}`);

  // ── detect / tenant ──────────────────────────────────────────────────────
  const hit = inhire.detect({ name: 'Acme', careers_url: 'https://acme.inhire.app' });
  if (hit && hit.url === 'https://api.inhire.app/job-posts/public/pages') {
    pass('inhire.detect() claims <slug>.inhire.app and points at the public pages API');
  } else {
    fail(`inhire.detect() returned ${JSON.stringify(hit)}`);
  }

  if (inhire.detect({ name: 'X', careers_url: 'https://example.com/careers' }) === null) {
    pass('inhire.detect() returns null for non-inhire URLs');
  } else {
    fail('inhire.detect() should return null for non-inhire URLs');
  }

  if (tenantFromCareersUrl('https://acme.inhire.app/') === 'acme') {
    pass('tenantFromCareersUrl strips a trailing slash');
  } else {
    fail(`tenantFromCareersUrl trailing slash → ${tenantFromCareersUrl('https://acme.inhire.app/')}`);
  }

  // Hosts de serviço não são tenants de empresa — evita varrer api/jobs/auth.
  const serviceHosts = ['api', 'jobs', 'auth', 'www'];
  const leaked = serviceHosts.filter(h => tenantFromCareersUrl(`https://${h}.inhire.app`) !== null);
  if (leaked.length === 0) {
    pass('tenantFromCareersUrl rejects the service hosts (api/jobs/auth/www)');
  } else {
    fail(`tenantFromCareersUrl accepted service hosts: ${leaked.join(', ')}`);
  }

  if (tenantFromCareersUrl('http://acme.inhire.app') === null) {
    pass('tenantFromCareersUrl rejects non-HTTPS');
  } else {
    fail('tenantFromCareersUrl should reject non-HTTPS');
  }

  // ── normalizeInhireJob ───────────────────────────────────────────────────
  const job = normalizeInhireJob(
    { jobId: '42', displayName: 'Analista de Operações', status: 'PUBLISHED', city: 'Goiânia' },
    'acme', 'Acme',
  );
  if (job
    && job.title === 'Analista de Operações'
    && job.url === 'https://acme.inhire.app/vaga/42'
    && job.company === 'Acme'
    && job.location === 'Goiânia') {
    pass('normalizeInhireJob maps displayName/jobId/city onto the Job contract');
  } else {
    fail(`normalizeInhireJob returned ${JSON.stringify(job)}`);
  }

  const remote = normalizeInhireJob({ id: 7, name: 'Analista', isRemote: true }, 'acme', 'Acme');
  if (remote && remote.location === 'Remoto') {
    pass('normalizeInhireJob renders the remote flag as a location string');
  } else {
    fail(`normalizeInhireJob remote → ${JSON.stringify(remote)}`);
  }

  const nested = normalizeInhireJob(
    { jobId: 9, title: 'Analista', address: { city: 'Goiânia', state: 'GO' } },
    'acme', 'Acme',
  );
  if (nested && nested.location === 'Goiânia, GO') {
    pass('normalizeInhireJob assembles a nested address object');
  } else {
    fail(`normalizeInhireJob nested address → ${JSON.stringify(nested)}`);
  }

  const dated = normalizeInhireJob(
    { jobId: 1, displayName: 'X', publishedAt: '2026-10-14T00:00:00Z' },
    'acme', 'Acme',
  );
  if (dated && dated.postedAt === Date.parse('2026-10-14T00:00:00Z')) {
    pass('normalizeInhireJob exposes postedAt as epoch ms');
  } else {
    fail(`normalizeInhireJob postedAt → ${JSON.stringify(dated)}`);
  }

  const undated = normalizeInhireJob({ jobId: 1, displayName: 'X' }, 'acme', 'Acme');
  if (undated && !('postedAt' in undated)) {
    pass('normalizeInhireJob omits postedAt when there is no usable date');
  } else {
    fail(`normalizeInhireJob undated → ${JSON.stringify(undated)}`);
  }

  const closed = normalizeInhireJob({ jobId: 1, displayName: 'X', status: 'CLOSED' }, 'acme', 'Acme');
  if (closed === null) pass('normalizeInhireJob drops a closed posting');
  else fail(`normalizeInhireJob closed → ${JSON.stringify(closed)}`);

  // Status desconhecido passa — a convenção é não penalizar dado inesperado.
  const weird = normalizeInhireJob({ jobId: 1, displayName: 'X', status: 'WHATEVER' }, 'acme', 'Acme');
  if (weird !== null) pass('normalizeInhireJob keeps a posting whose status is unrecognized');
  else fail('normalizeInhireJob should not drop an unrecognized status');

  const incomplete = [
    normalizeInhireJob({ jobId: 1 }, 'acme', 'Acme'),
    normalizeInhireJob({ displayName: 'X' }, 'acme', 'Acme'),
    normalizeInhireJob(null, 'acme', 'Acme'),
    normalizeInhireJob([], 'acme', 'Acme'),
  ];
  if (incomplete.every(j => j === null)) {
    pass('normalizeInhireJob returns null without both a title and an id');
  } else {
    fail(`normalizeInhireJob incomplete → ${JSON.stringify(incomplete)}`);
  }

  // ── parseInhireResponse ──────────────────────────────────────────────────
  const parsed = parseInhireResponse({
    tenantName: 'Acme',
    jobsPage: [
      { jobId: 1, displayName: 'Analista de Operações', status: 'PUBLISHED' },
      { jobId: 2, displayName: 'Fechada', status: 'CLOSED' },
    ],
  }, 'acme', 'Acme');
  if (parsed.length === 1 && parsed[0].title === 'Analista de Operações') {
    pass('parseInhireResponse reads jobsPage and filters closed postings');
  } else {
    fail(`parseInhireResponse → ${JSON.stringify(parsed)}`);
  }

  // Um envelope irreconhecível tem de ESTOURAR nomeando as chaves recebidas,
  // não devolver [] — "0 novas" quando está quebrado é pior do que falhar.
  let threw = null;
  try {
    parseInhireResponse({ unexpected: true, alsoThis: 1 }, 'acme', 'Acme');
  } catch (err) {
    threw = err;
  }
  if (threw && /unexpected/.test(threw.message) && /alsoThis/.test(threw.message)) {
    pass('parseInhireResponse throws naming the keys it actually received');
  } else {
    fail(`parseInhireResponse should throw naming the keys; got ${threw && threw.message}`);
  }

  if (parseInhireResponse({ jobs: [{ jobId: 3, displayName: 'Y' }] }, 'acme', 'Acme').length === 1) {
    pass('parseInhireResponse tolerates the jobs/data/items envelope aliases');
  } else {
    fail('parseInhireResponse should tolerate envelope aliases');
  }
} catch (err) {
  fail(`inhire provider test crashed: ${err.message}`);
}
