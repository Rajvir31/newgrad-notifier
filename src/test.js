import assert from 'node:assert/strict';
import { countryOf, channelsFor, isNewGrad, isSweRole, needsClearance } from './filter.js';
import { blocksFor, postJobs } from './slack.js';
import { relativeToEpoch, splitLocations } from './sources.js';
import { normalizeUrl, collapse, pickFresh, idsOf, KEY } from './poll.js';

// Country routing — every entry here is a trap that bit a naive implementation.
for (const [loc, want] of [
  ['Vancouver, WA', 'US'],            // not Vancouver BC
  ['Vancouver, BC, Canada', 'CA'],
  ['Ontario, CA', 'US'],              // Ontario, California
  ['Toronto, ON', 'CA'],
  ['Toronto, ON, Canada', 'CA'],
  ['London, UK', 'OTHER'],
  ['London, ON, Canada', 'CA'],
  ['Waterloo, IA', 'US'],
  ['Waterloo, ON, Canada', 'CA'],
  ['Richmond, VA', 'US'],
  ['Richmond, BC, Canada', 'CA'],
  ['Cambridge, MA', 'US'],
  ['Cambridge, ON, Canada', 'CA'],
  ['Windsor, CT', 'US'],
  ['Hamilton, OH', 'US'],
  ['Sydney, Australia', 'OTHER'],
  ['California', 'US'],
  ['Remote in US', 'US'],
  ['Remote in Canada', 'CA'],
  ['Milan, Italy', 'OTHER'],
  ['NYC', 'US'],
  ['', 'UNKNOWN'],
]) {
  assert.equal(countryOf(loc), want, `countryOf(${JSON.stringify(loc)})`);
}

// Multi-location jobs land in both channels; non-NA locations add no channel.
assert.deepEqual(channelsFor({ locations: ['Seattle, WA', 'Toronto, ON, Canada'] }), ['US', 'CA']);
assert.deepEqual(channelsFor({ locations: ['London, UK'] }), []);
assert.deepEqual(channelsFor({ locations: [] }), []);

// Level classification, scoped mode: the Simplify repo is already curated to
// new-grad roles, so a title only has to avoid disqualifying itself.
for (const [title, want] of [
  ['Software Engineer', true],
  ['Java 8 Developer', true],          // version number, not a seniority level
  ['Python 3 Engineer', true],
  ['Senior Software Engineer', false],
  ['Software Engineer II', false],
  ['Software Engineer 3', false],
  ['Staff Engineer', false],
  ['Engineering Manager', false],
  ['AI Transformation Leader', false],
  ['Software Engineering Intern', false],
  ['SWE Co-op - Summer 2027', false],
  ['AI Trainer - Freelance', false],   // data-labelling gig spam
  ['Part-Time Data Annotator', false],
  ['Software Engineer, 10+ years experience', false],
  // "Member of Technical Staff" is the standard ENTRY title at the AI labs;
  // a bare \bstaff\b rejected exactly the roles this is meant to catch.
  ['Member of Technical Staff, New Grad', true],
  ['Staff Software Engineer', false],
  ['Staff Engineer', false],
  // A level token only counts at the end of a title — otherwise it is a team
  // or product name.
  ['Software Engineer, L4 Autonomy Team', true],
  ['Perception Engineer - T5 Stack', true],
  ['Software Engineer L5', false],
  ['Software Engineer (L6)', false],
  ['Software Engineer, Level 5', false],
  // Season/year appears in both orders in real postings.
  ['SWE Intern - Summer 2027', false],
  ['SWE Intern - 2027 Summer', false],
]) {
  assert.equal(isNewGrad({ title, newGradScoped: true }), want, `scoped isNewGrad(${JSON.stringify(title)})`);
}

// Unscoped mode: a company ATS board lists every open role, so a positive
// entry-level signal is required. This is what stops a whole board from being
// announced as new-grad openings.
for (const [title, want] of [
  ['New Grad Software Engineer', true],
  ['Software Developer, Early Career', true],
  ['University Grad - Software Engineer', true],
  ['Entry-Level Web Developer', true],
  ['Junior Data Engineer', true],
  ['Associate Software Engineer', true],
  ['Software Engineer I', true],
  ['Software Engineer, 2027 Grads', true],
  ['Software Engineer, Online Database Infrastructure', false], // ordinary req
  ['Backend Developer', false],
  ['Product Security Engineer', false],
  ['Senior Software Engineer, New Grad Programs', false],       // disqualifier wins
]) {
  assert.equal(isNewGrad({ title }), want, `unscoped isNewGrad(${JSON.stringify(title)})`);
}

// Role relevance: Simplify's curated category wins when present; otherwise the
// title needs an engineering noun AND a technical domain. A domain word alone
// used to let legal and design roles through.
assert.equal(isSweRole({ title: 'Analyst', category: 'Software' }), true);
assert.equal(isSweRole({ title: 'Mechanical Design Engineer', category: 'Hardware' }), false);
assert.equal(isSweRole({ title: 'Backend Developer' }), true);
assert.equal(isSweRole({ title: 'Machine Learning Engineer' }), true);
assert.equal(isSweRole({ title: 'Systems Engineer' }), true);
assert.equal(isSweRole({ title: 'Registered Nurse' }), false);
assert.equal(isSweRole({ title: 'Regulatory Counsel, AI Regulation, US' }), false);
assert.equal(isSweRole({ title: 'Safety & Security Counsel' }), false);
assert.equal(isSweRole({ title: 'Designer, Web, Presence & Platform' }), false);
assert.equal(isSweRole({ title: 'Mechanical Design Engineer' }), false);

// Structured country hints beat location strings, but only when populated —
// Ashby ships addressCountry as "" on real Canada-eligible postings.
assert.deepEqual(channelsFor({ country: 'CA', locations: ['Seattle, WA'] }), ['CA']);
assert.deepEqual(channelsFor({ country: '', locations: ['Toronto, ON, Canada'] }), ['CA']);
assert.deepEqual(channelsFor({ country: undefined, locations: ['Austin, TX'] }), ['US']);

// countryOf can only name one country, so a dual-eligible string used to resolve
// to CA alone and never reach #usa.
assert.deepEqual(channelsFor({ locations: ['Remote - US or Canada'] }), ['US', 'CA']);
assert.deepEqual(channelsFor({ locations: ['Remote (United States | Canada)'] }), ['US', 'CA']);
assert.deepEqual(channelsFor({ locations: ['Toronto, ON, Canada'] }), ['CA']);

assert.equal(needsClearance({ title: 'Developer - Active TS/SCI with Poly' }), true);
assert.equal(needsClearance({ title: 'Developer' }), false);

// --- Slack payload ---------------------------------------------------------
// Slack rejects the whole message on a limit breach, so the caps are asserted
// against a deliberately abusive job rather than a tidy one.
{
  const long = {
    company: 'A'.repeat(200),
    title: 'B'.repeat(200),
    locations: ['Toronto, ON, Canada', 'Vancouver, BC, Canada'],
    url: 'https://example.com/apply?id=' + 'c'.repeat(4000),
    postedAt: 1788484604,
    source: 'Greenhouse',
  };
  const p = blocksFor(long);
  assert.ok(p.text, 'top-level text is the mobile push preview — must never be empty');
  assert.equal(p.unfurl_links, false);
  assert.equal(p.unfurl_media, false);
  assert.ok(p.blocks.length <= 50, 'max 50 blocks per message');

  const header = p.blocks[0];
  assert.equal(header.type, 'header');
  assert.equal(header.text.type, 'plain_text', 'header is plain_text only — mrkdwn renders literally');
  assert.ok(header.text.text.length <= 150, `header ${header.text.text.length} > 150`);

  const button = p.blocks.find((b) => b.type === 'actions').elements[0];
  assert.ok(button.text.text.length <= 75, 'button text max 75');
  assert.ok(button.url.length <= 3000, `button url ${button.url.length} > 3000`);

  // Per-viewer date token, so a community spanning timezones each sees local time.
  const fields = p.blocks[1].fields.map((f) => f.text).join('\n');
  assert.match(fields, /<!date\^1788484604\^[^|]+\|[^>]+>/, 'date token needs a |fallback segment');

  // A job with no timestamp must not emit <!date^0^...>.
  const undated = blocksFor({ ...long, postedAt: 0 });
  assert.doesNotMatch(JSON.stringify(undated), /<!date\^0\^/);

  // Whole payload must be JSON-serializable with no undefined leaking in.
  assert.doesNotMatch(JSON.stringify(p), /undefined/);
}

// --- Source helpers --------------------------------------------------------
const NOW = 1_788_500_000;
assert.equal(relativeToEpoch('Posted Today', NOW), NOW);
assert.equal(relativeToEpoch('Posted Yesterday', NOW), NOW - 86400);
assert.equal(relativeToEpoch('Posted 4 Days Ago', NOW), NOW - 4 * 86400);
assert.equal(relativeToEpoch('Posted 30+ Days Ago', NOW), NOW - 30 * 86400);
assert.equal(relativeToEpoch('', NOW), 0);

// Greenhouse mixes ";" and "," in one location string; the comma-run stays whole
// so "Toronto, ON" is not shredded into "Toronto" and "ON".
assert.deepEqual(splitLocations('Calgary, Canada; Edmonton, Canada'), ['Calgary, Canada', 'Edmonton, Canada']);
assert.deepEqual(splitLocations('Toronto, ON'), ['Toronto, ON']);
assert.deepEqual(splitLocations(''), []);
assert.deepEqual(splitLocations(undefined), []);

// --- URL normalization (cross-source dedup) --------------------------------
// Simplify rewrites titles, so the apply URL is the only thing tying its copy of
// a posting to the company's own board. These are the exact strings that made
// Notion's "Software Engineer, Early Career (AI)" fire twice.
{
  const same = (a, b, msg) => assert.equal(normalizeUrl(a), normalizeUrl(b), msg);
  const differ = (a, b, msg) => assert.notEqual(normalizeUrl(a), normalizeUrl(b), msg);

  same(
    'https://jobs.ashbyhq.com/notion/85947779/application?embed=true',
    'https://jobs.ashbyhq.com/notion/85947779/application',
    'Simplify appends ?embed=true to the same posting'
  );
  same(
    'https://job-boards.greenhouse.io/x/jobs/1?t=1&gh_src=abc',
    'https://job-boards.greenhouse.io/x/jobs/1',
    'greenhouse tracking params are not identity'
  );
  same('https://WWW.Example.com/job/1/', 'https://example.com/job/1', 'host case, www, trailing slash');
  same('https://example.com/j?a=1&b=2', 'https://example.com/j?b=2&a=1', 'param order is not identity');

  // gh_jid IS identity: Stripe's absolute_url is the same search page for every
  // req, so dropping it would fuse the entire board into one job.
  differ(
    'https://stripe.com/jobs/search?gh_jid=8130930',
    'https://stripe.com/jobs/search?gh_jid=8130881',
    'gh_jid distinguishes Stripe reqs and must survive normalization'
  );
  // Must never throw on junk.
  assert.equal(normalizeUrl('not a url'), 'not a url');
}

// --- Delivery failure handling ---------------------------------------------
// The worst failure this system has: a job that failed to post gets marked seen,
// is never retried, and the workflow still reports success. These stub fetch to
// prove postJobs reports back exactly what did not get through.
{
  const job = (id) => ({
    id,
    company: 'Acme',
    title: `Engineer ${id}`,
    locations: ['Austin, TX'],
    url: `https://example.com/${id}`,
    postedAt: 1788484604,
    source: 'Greenhouse',
  });
  const realFetch = globalThis.fetch;
  const stub = (body, status = 200) => {
    globalThis.fetch = async () => ({
      status,
      headers: new Map(),
      json: async () => body,
    });
  };

  // Slack's signature trap: HTTP 200 with ok:false. Must count as failure.
  stub({ ok: false, error: 'not_in_channel' });
  let r = await postJobs('xoxb-x', { C_CA: [job('a'), job('b')] });
  assert.deepEqual(r.results, [['C_CA', 0, 2]], 'HTTP 200 + ok:false is a failure, not a success');
  assert.deepEqual(r.failed.map((j) => j.id), ['a', 'b'], 'failed jobs must be reported back');

  // A transport error must cost one message, not reject the whole batch —
  // an escaping rejection used to skip the state save and re-post everything.
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };
  r = await postJobs('xoxb-x', { C_US: [job('c')] });
  assert.deepEqual(r.results, [['C_US', 0, 1]], 'a socket error must not reject postJobs');
  assert.deepEqual(r.failed.map((j) => j.id), ['c']);

  stub({ ok: true, ts: '1.2' });
  r = await postJobs('xoxb-x', { C_US: [job('d')] });
  assert.deepEqual(r.results, [['C_US', 1, 1]]);
  assert.deepEqual(r.failed, [], 'a successful post reports nothing failed');

  globalThis.fetch = realFetch;
}

// --- Dedup across feeds ----------------------------------------------------
{
  const gh = {
    id: 'gh:stripe:1', source: 'Greenhouse', company: 'Stripe',
    title: 'Software Engineer, New Grad', url: 'https://stripe.com/jobs/search?gh_jid=1',
    locations: ['Seattle, WA'], postedAt: 1788484604,
  };
  // Same posting as `gh`: same apply URL, but Simplify has rewritten the title
  // and appended a tracking param. Company+title alone would let both through.
  const si = {
    ...gh, id: 'simplify:abc', source: 'Simplify', newGradScoped: true,
    title: 'Software Engineer – New Grad',
    url: 'https://stripe.com/jobs/search?gh_jid=1&utm_source=Simplify',
  };
  // A different city's requisition: same title, distinct URL, routes to Canada.
  const ghToronto = {
    ...gh, id: 'gh:stripe:2',
    url: 'https://stripe.com/jobs/search?gh_jid=2',
    locations: ['Toronto, ON, Canada'],
  };

  let c = collapse([si, gh]);
  assert.equal(c.length, 1, 'one posting reported by two feeds must collapse to one alert');
  assert.equal(c[0].source, 'Greenhouse', "the company's own board wins over the aggregator");
  assert.deepEqual(c[0].alsoSeen, ['simplify:abc'], 'the collapsed copy is remembered');
  // Order must not change the outcome, or the winner depends on which fetch finished first.
  assert.equal(collapse([gh, si])[0].id, 'gh:stripe:1');

  // Per-city reqs must survive into their own channels — a channel-blind key
  // collapsed these and silently deleted the Toronto role from #canada.
  c = collapse([gh, ghToronto]);
  assert.equal(c.length, 2, 'same-title reqs in different channels are different jobs');
  assert.deepEqual(c.map((j) => j.channels), [['US'], ['CA']]);

  // Feed flap: whichever feed is up, the role is announced exactly once, ever.
  const seenSet = new Set();
  const runs = [[gh, si], [si], [gh, si], [gh], [si, gh]]; // both, gh down, both, simplify down, both
  const posted = runs.map((feed) => {
    const cands = collapse(feed);
    const fresh = pickFresh(cands, seenSet);
    for (const j of cands) for (const id of idsOf(j)) seenSet.add(KEY(id));
    return fresh.length;
  });
  assert.deepEqual(posted, [1, 0, 0, 0, 0], 'a flapping feed must not re-announce the same role');
}

console.log('all assertions passed');
