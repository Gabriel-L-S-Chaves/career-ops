// tests/scan-gupy.test.mjs — pins the two defects fixed on 18/11/2026.
//
// Both were found against live boards, not against a fixture:
//
//   1. The remote flag on a real company board lives at the NESTED path
//      `workplace.workplaceType` ("on-site" / "remote" / "hybrid"). Reading only
//      `raw.workplaceType` made every remote posting reach the location filter
//      as an empty string, so a 100% remote job passed or failed by luck.
//      `raw.type` must NOT be read as a location: on Gupy it carries
//      "vacancy_type_effective", a contract-type enum.
//
//   2. A posting URL is NOT `/job/{id}`. That link redirects to the board root —
//      the user hit this by clicking a link this scanner had written into the
//      pipeline. The segment is the base64 of {"jobId":N,"source":"company_page"}.
//      The expected string below is a real PagBank link, verified by hand.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan-gupy — remote flag and posting URL');

try {
  const { normalizeGupyJob, gupyJobToken } = await import(
    pathToFileURL(join(ROOT, 'scan-gupy.mjs')).href
  );

  const target = { slug: 'pagseguro', name: 'PagBank', url: 'https://pagseguro.gupy.io' };
  const norm = (raw) => normalizeGupyJob(raw, target);

  // ── 1. nested workplace.workplaceType ────────────────────────────────
  const remote = norm({ id: 1, title: 'Analista', workplace: { workplaceType: 'remote' } });
  if (remote?.location === 'Remoto') pass('nested workplace.workplaceType "remote" marks the job remote');
  else fail(`nested remote flag ignored: location = ${JSON.stringify(remote?.location)}`);

  const onsite = norm({ id: 2, title: 'Analista', city: 'São Paulo', workplace: { workplaceType: 'on-site' } });
  if (onsite?.location === 'São Paulo') pass('nested "on-site" leaves the city untouched');
  else fail(`on-site mangled the location: ${JSON.stringify(onsite?.location)}`);

  const hybrid = norm({ id: 3, title: 'Analista', city: 'São Paulo', workplace: { workplaceType: 'hybrid' } });
  if (hybrid?.location === 'São Paulo') pass('nested "hybrid" is not treated as remote');
  else fail(`hybrid read as remote: ${JSON.stringify(hybrid?.location)}`);

  const flat = norm({ id: 4, title: 'Analista', isRemoteWork: true });
  if (flat?.location === 'Remoto') pass('top-level isRemoteWork still wins (no regression)');
  else fail(`top-level flag broken: ${JSON.stringify(flat?.location)}`);

  // The regression that produced ~21 bogus "locations" in the 17/11 measurement.
  const vacancyType = norm({ id: 5, title: 'Analista', type: 'vacancy_type_effective' });
  if (!/vacancy_type/i.test(vacancyType?.location ?? ''))
    pass('raw.type ("vacancy_type_effective") is never used as a location');
  else fail(`contract-type enum leaked into location: ${JSON.stringify(vacancyType?.location)}`);

  // ── 2. posting URL token ─────────────────────────────────────────────
  const KNOWN_ID = 11876855;
  const KNOWN_TOKEN = 'eyJqb2JJZCI6MTE4NzY4NTUsInNvdXJjZSI6ImNvbXBhbnlfcGFnZSJ9';

  if (gupyJobToken(KNOWN_ID) === KNOWN_TOKEN) pass('gupyJobToken reproduces a real PagBank job token');
  else fail(`token = ${gupyJobToken(KNOWN_ID)}, expected ${KNOWN_TOKEN}`);

  if (gupyJobToken(String(KNOWN_ID)) === KNOWN_TOKEN) pass('gupyJobToken accepts a numeric id passed as a string');
  else fail(`string id produced ${gupyJobToken(String(KNOWN_ID))}`);

  const decoded = JSON.parse(Buffer.from(gupyJobToken(42), 'base64').toString('utf8'));
  if (decoded.jobId === 42 && decoded.source === 'company_page')
    pass('token decodes back to {jobId, source: "company_page"}');
  else fail(`decoded to ${JSON.stringify(decoded)}`);

  // A non-numeric id must pass through rather than be encoded into a link that
  // looks valid and silently 404s.
  if (gupyJobToken('x-9') === 'x-9') pass('a non-numeric id is passed through, not encoded');
  else fail(`non-numeric id became ${gupyJobToken('x-9')}`);

  const built = norm({ id: KNOWN_ID, title: 'Analista de Processos Sr.' });
  if (built?.url === `https://pagseguro.gupy.io/job/${KNOWN_TOKEN}`)
    pass('normalizeGupyJob builds the base64 posting URL, not /job/{id}');
  else fail(`built URL = ${built?.url}`);

  if (!/\/job\/\d+$/.test(built?.url ?? '')) pass('the broken /job/{numeric-id} form is gone');
  else fail(`still emitting the redirect-to-root form: ${built?.url}`);

  const explicit = norm({ id: 7, title: 'Analista', jobUrl: 'https://pagseguro.gupy.io/job/ABC' });
  if (explicit?.url === 'https://pagseguro.gupy.io/job/ABC')
    pass('an explicit jobUrl from the DOM still wins over the built token');
  else fail(`explicit jobUrl overridden: ${explicit?.url}`);

  // ── 3. dedup contract with scan.mjs ──────────────────────────────────
  //
  // scan-gupy crashed with "seenUrls.has is not a function" the moment a job
  // first survived the filters: it treated loadSeenUrls()'s return value as a
  // Set. These pin the shape both scanners depend on, so the next change to
  // loadSeenUrls fails here instead of at runtime in the middle of a sweep.
  const scan = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  if (typeof scan.scanHistoryPolicy === 'function')
    pass('scan.mjs exports scanHistoryPolicy (scan-gupy needs the derived policy)');
  else fail('scanHistoryPolicy is not exported from scan.mjs');

  const seenState = scan.loadSeenUrls(scan.scanHistoryPolicy({}));

  if (seenState?.seen instanceof Set) pass('loadSeenUrls returns { seen: Set, ... }');
  else fail(`loadSeenUrls returned ${JSON.stringify(Object.keys(seenState ?? {}))}`);

  if (typeof seenState.has !== 'function')
    pass('loadSeenUrls return value is NOT itself a Set — callers must unwrap .seen');
  else fail('loadSeenUrls now returns a Set directly; scan-gupy unwraps .seen and would break');

  if (typeof seenState.recheckEligible === 'number')
    pass('loadSeenUrls reports recheckEligible as a number');
  else fail(`recheckEligible = ${JSON.stringify(seenState.recheckEligible)}`);
} catch (err) {
  fail(`scan-gupy tests threw: ${err.message}`);
}
