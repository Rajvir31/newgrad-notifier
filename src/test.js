import assert from 'node:assert/strict';
import { countryOf, channelsFor, isNewGrad, isSweRole, needsClearance } from './filter.js';
import { blocksFor } from './slack.js';
import { relativeToEpoch, splitLocations } from './sources.js';

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

console.log('all assertions passed');
