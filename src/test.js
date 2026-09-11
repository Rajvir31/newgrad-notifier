import assert from 'node:assert/strict';
import { countryOf, channelsFor, isNewGrad, isSweRole, needsClearance, usEligibility, sponsorshipStatus, clearanceStatus } from './filter.js';
import { htmlToText, jobPostingJsonLd } from './description.js';
import { blocksFor, postJobs, mentionTag, ageLabel } from './slack.js';
import { relativeToEpoch, splitLocations } from './sources.js';
import { normalizeUrl, collapse, pickFresh, pickQueued, idsOf, KEY } from './poll.js';

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

// Role relevance is an allowlist: the title itself must read as a build-software
// job. `category` is not a signal — the aggregator tags "Broista" as AI/ML/Data
// and a genuine "Software Engineer - Crypto and Cross Domain Solutions" as
// Hardware, so it is wrong in both directions.
for (const [title, want] of [
  // Software on sight, no supporting domain word in the title.
  ['Software Engineer, New Grad', true],
  ['Associate Software Engineer', true],
  ['Software Engineering Associate', true],
  ['Software Development Graduate - AI', true],
  ['Graduate Programmer', true],
  ['SDE 1', true],
  // Build noun + software domain.
  ['Backend Developer', true],
  ['Machine Learning Engineer', true],
  ['Systems Engineer', true],
  ['Data Engineer 1 - Enterprise Technology Services', true],
  ['AI Engineer - Early Career', true],
  ['Forward Deployed Infrastructure Engineer, New Grad', true],
  ['SQL Server Developer', true],
  ['Data Warehouse Software Engineer', true],
  // A title may name the LANGUAGE and no domain at all. These reached the
  // channel through the old `category` pass; ~37 were live when the allowlist
  // replaced it, every one an unambiguous entry-level dev job.
  ['Entry Level .Net Developer', true],
  ['Java Developer', true],
  ['Junior Java Developer', true],
  ['Graduate C++ Developer', true],
  ['Angular JS Developer', true],
  ['Support Engineer - Python', true],
  ['Mainframe Developer', true],
  ['Salesforce Developer', true],
  // `\balgorithm\b` cannot match the plural, and the neighbouring alternatives
  // all handle theirs — "Applied Algorithms Engineer New Grad" was rejected.
  ['Algorithm Engineer, New Grad', true],
  ['Algorithms Engineer, New Grad', true],
  // Analyst / scientist / BI titles. These are the flood the category pass let
  // in: 174 of 382 alerts came from Simplify's AI/ML/Data tag alone.
  ['Data Analyst', false],
  ['Associate Data Scientist - Decision Analytics', false],
  ['Business Intelligence Analyst - Data & Analytics', false],
  ['Applied Machine Learning Scientist', false],
  ['AI Business Development Analyst', false],
  ['Analytics Leadership Development Program Associate', false],
  // Banking. Both of these passed on a domain word alone ("Infrastructure",
  // "Solutions") while `analyst` still counted as an engineering noun.
  ['2027 Investment Banking Analyst I - Energy, Infrastructure, & Transition', false],
  ['2027 Analyst I, Equity Solutions Group', false],
  // Not technical at all, yet all shipped under a technical category.
  ['Broista', false],
  ['Barback', false],
  ['Sales Associate', false],
  ['Customer Service Representative', false],
  ['Research Assistant - Instructional', false],
  ['Patient Coordinator', false],
  ['Registered Nurse', false],
  ['Born Digital Aide', false],
  ['AI Model Policy Trainer', false],
  // A domain word without a build noun is not a software role.
  ['Regulatory Counsel, AI Regulation, US', false],
  ['Designer, Web, Presence & Platform', false],
  ['GIS/Cartography Technician 1', false],
  ['Robot Teleoperation Specialist', false],
  // A language token still needs a build noun beside it.
  ['SAP Material Master Data Specialist', false],
  // A build noun outside software.
  ['Mechanical Design Engineer', false],
  ['Electrical Engineer New Grad', false],
  // Correctly paired, but the qualifier says the job is not building anything.
  ['Engineering Technician - Abuse Test & Engineering', false],
  ['Systems Engineer/Analyst', false],
  ['Software Engineering TRAIL Operations Specialist', false],
]) {
  assert.equal(isSweRole({ title }), want, `isSweRole(${JSON.stringify(title)})`);
}

// The category cannot rescue a non-software title, and cannot sink a real one.
assert.equal(isSweRole({ title: 'Analyst', category: 'Software' }), false);
assert.equal(isSweRole({ title: 'Dental Assistant', category: 'AI/ML/Data' }), false);
assert.equal(
  isSweRole({ title: 'Software Engineer - Crypto and Cross Domain Solutions', category: 'Hardware' }),
  true
);

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

// A bare US city name must route. There was no US city list at all — only
// CA_CITY — so a board naming cities without a state code produced UNKNOWN,
// then an empty channel list, and poll.js seeds a channel-less job as "decided":
// silently dropped forever, no retry. Stripe's "Software Engineer, New Grad"
// lists exactly "San Francisco, Seattle, New York" and was lost this way.
assert.deepEqual(channelsFor({ locations: ['San Francisco, Seattle, New York'] }), ['US']);
for (const city of ['San Francisco', 'Seattle', 'Austin', 'Boston', 'Chicago', 'Palo Alto', 'Denver']) {
  assert.equal(countryOf(city), 'US', `countryOf(${JSON.stringify(city)})`);
  assert.deepEqual(channelsFor({ locations: [city] }), ['US'], `channelsFor(${JSON.stringify(city)})`);
}

// ...but the US city list runs LAST, so it must never steal a name that the
// Canadian or non-North-American tests already claimed.
for (const [loc, want] of [
  ['Toronto', 'CA'],
  ['Vancouver', 'CA'],       // Vancouver BC, not WA
  ['Vancouver, WA', 'US'],
  ['Waterloo', 'CA'],
  ['Waterloo, IA', 'US'],
  ['London, ON', 'CA'],
  ['London, UK', 'OTHER'],
  ['Cambridge, ON', 'CA'],
  ['Cambridge, MA', 'US'],
  ['Richmond, BC', 'CA'],
  ['Richmond, VA', 'US'],
  ['Ontario, CA', 'US'],     // Ontario, California
  ['Manchester, UK', 'OTHER'],
  ['Birmingham, UK', 'OTHER'],
  ['Durham, NC', 'US'],
]) {
  assert.equal(countryOf(loc), want, `countryOf(${JSON.stringify(loc)})`);
}

assert.equal(needsClearance({ title: 'Developer - Active TS/SCI with Poly' }), true);
assert.equal(needsClearance({ title: 'Developer' }), false);

// --- Posting age -----------------------------------------------------------
// Slack's {date_short_pretty} renders "Sep 4", which reads as current at a
// glance. The age is what tells you a role is actually fresh — an aggregator
// can surface a week-old posting as brand new, which is exactly what MAX_AGE_DAYS
// now suppresses.
{
  const now = 1788484604;
  assert.equal(ageLabel(now, now), 'today');
  assert.equal(ageLabel(now - 3600, now), 'today');
  assert.equal(ageLabel(now - 86400, now), 'yesterday');
  assert.equal(ageLabel(now - 4 * 86400, now), '4 days ago');
  assert.equal(ageLabel(0, now), '', 'an unknown date must render nothing, not "NaN days ago"');
  assert.equal(ageLabel(undefined, now), '');
  // A clock skew between the feed and the runner must not read as the future.
  assert.equal(ageLabel(now + 3600, now), 'today');

  const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
  const p = blocksFor({ company: 'A', title: 'B', url: 'https://x.test', postedAt: twoDaysAgo });
  const posted = p.blocks[1].fields[1].text;
  assert.ok(posted.includes('2 days ago'), `age must appear in the Posted field: ${JSON.stringify(posted)}`);
  assert.ok(posted.includes('<!date^'), 'the absolute date is kept alongside the age');
  // A job with no date must not render a stray empty bracket.
  const q = blocksFor({ company: 'A', title: 'B', url: 'https://x.test', postedAt: 0 });
  assert.ok(!q.blocks[1].fields[1].text.includes('()'), q.blocks[1].fields[1].text);
}

// --- US eligibility: sponsorship + clearance -------------------------------
// Every string below is real text harvested from the live feeds. The rule is
// exclude ONLY on an explicit statement; silence includes the job.
const eligible = (description, title = 'Software Engineer') =>
  usEligibility({ title, description }).ok;

// Explicit "we do not sponsor" -> excluded.
for (const s of [
  'We are unable to provide visa sponsorship.',
  'Visa Sponsorship is not available for this position.',
  'This role is not eligible for visa sponsorship.',
  'At this time, CapTech cannot transfer nor sponsor a work visa for this position.',
  'Applicants must be authorized to work directly for any employer in the United States without visa sponsorship.',
  'GM does not provide immigration-related sponsorship for this role.',
  'The company does not sponsor/support H-1B petitions, TN, or Forms I-983/STEM OPT, for this role.',
  'Must be legally authorized to work in the United States without the need for employer sponsorship, now or at any time in the future.',
  'Aerotech does not provide US work authorization sponsorship for this position.',
  'We do not sponsor visas.',
]) {
  assert.equal(eligible(s), false, `must exclude on: ${s.slice(0, 60)}`);
}

// Explicit clearance requirement -> excluded.
for (const s of [
  'Hold an active Secret or Top Secret security clearance.',
  'Ability to obtain and maintain a Secret clearance.',
  'Position requires an active TS/SCI clearance with polygraph.',
  'Required Security Clearance: TS/SCI w/Poly',
  'A government issued security clearance is required.',
  'CLEARANCE REQUIREMENTS: Department of Defense Secret security clearance is obtainable within a reasonable amount of time after hire.',
  'However, as a requirement of continued employment in this position you will be required to obtain a Top Secret clearance.',
  'Are able to obtain an Interim Secret security clearance by your start date.',
]) {
  assert.equal(eligible(s), false, `must exclude on: ${s.slice(0, 60)}`);
}

// Silence, positive statements, and near-misses -> INCLUDED. These are the
// expensive mistakes: each one is a real posting that a naive regex drops.
for (const s of [
  // Nothing said at all.
  'Build and ship backend services in Go. Bachelor of Science in Computer Science.',
  // Sponsorship explicitly OFFERED.
  'Retell AI is open to sponsoring work authorization for qualified candidates.',
  'H1B sponsorship is available for this position.',
  // Application-form questions, not policy. A scraped board page carries the
  // form as well as the description.
  'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?',
  'Are you eligible to obtain the security clearance specified in the job description?',
  // "sponsor" in a non-immigration sense.
  'You will deliver presentations to technical staff, program leadership, and government sponsors.',
  'You will analyze simulation outputs and translate results into clear insights for the research sponsor.',
  'We offer equity, a sponsored 401K, parental leave, and fully paid health insurance.',
  // Clearance mentioned without being required.
  'Minimum Clearance Required to Start: None Employee Type: Regular',
  'Learn more about the background check process for Security Clearances.',
  'Ability to obtain FAA clearance. Junior Level Bachelor degree in Computer Science.',
  'Clearance eligibility may be required depending on program.',
  // Page chrome from a careers-site search sidebar, not the posting.
  'Location All Category All Department All Telework All Relocation All Clearance Required All Clear',
]) {
  assert.equal(eligible(s), true, `must INCLUDE on: ${s.slice(0, 60)}`);
}

// A missing description means "unknown", never "clean" — a scrape failure must
// not silently hide a role.
assert.equal(eligible(''), true, 'no description must include the job');
assert.equal(eligible(undefined), true, 'undefined description must include the job');

// A clearance requirement is often stated only in the title.
assert.equal(eligible('', 'Software Engineer - Active TS/SCI Clearance Required'), false);

// The reported reason drives the log line, so it must be the real cause.
assert.equal(
  usEligibility({ title: 'X', description: 'We are unable to provide visa sponsorship.' }).reason,
  'no sponsorship'
);
assert.equal(
  usEligibility({ title: 'X', description: 'Must hold an active Top Secret clearance.' }).reason,
  'clearance required'
);

// Status helpers report what was actually found.
assert.equal(sponsorshipStatus('H1B sponsorship is available for this position.'), 'offered');
assert.equal(sponsorshipStatus('We cannot sponsor visas.'), 'denied');
assert.equal(sponsorshipStatus('A normal job description.'), 'none');
assert.equal(clearanceStatus('Must hold an active Secret clearance.'), 'required');
assert.equal(clearanceStatus('A normal job description.'), 'none');

// A hard US citizenship requirement is stricter than "we do not sponsor" — no
// visa makes you eligible for one — so it excludes too.
for (const s of [
  'U.S. Citizenship is required for this position.',
  'Must be a U.S. Citizen.',
  'This position requires US citizenship.',
  'Please note US citizenship is required to obtain a Secret Clearance.',
]) {
  assert.equal(eligible(s), false, `must exclude on: ${s}`);
}
// ...but an EEO nicety is not a restriction.
for (const s of [
  'U.S. citizens and permanent residents are encouraged to apply.',
  'We welcome applicants of all citizenships and backgrounds.',
  'Citizenship is not required for this role.',
]) {
  assert.equal(eligible(s), true, `must INCLUDE on: ${s}`);
}

// The periods inside "U.S." are not sentence ends. Splitting on them produced
// "U." / "S." / "Citizenship is required" and no pattern could match across it.
assert.equal(sponsorshipStatus('U.S. Citizenship is required for this role.'), 'denied');

// Simplify curates a sponsorship tag. It is authoritative where present and is
// the ONLY signal for boards that refuse programmatic reads — iCIMS answers
// HTTP 405 to any GET, which covers General Dynamics, Peraton and Framatome.
assert.equal(usEligibility({ title: 'X', sponsorshipTag: 'Does Not Offer Sponsorship' }).ok, false);
assert.equal(usEligibility({ title: 'X', sponsorshipTag: 'U.S. Citizenship is Required' }).ok, false);
assert.equal(
  usEligibility({ title: 'X', sponsorshipTag: 'U.S. Citizenship is Required' }).reason,
  'US citizenship required'
);
assert.equal(usEligibility({ title: 'X', sponsorshipTag: 'Offers Sponsorship' }).ok, true);
// "Other" is Simplify's value for "unknown", which must not exclude anything —
// it is 20,014 of 20,117 rows.
assert.equal(usEligibility({ title: 'X', sponsorshipTag: 'Other' }).ok, true);
assert.equal(usEligibility({ title: 'X', sponsorshipTag: '' }).ok, true);

// --- Description extraction ------------------------------------------------
// JSON-LD is preferred over stripping the document because the page body also
// carries nav, search widgets and the application form. Huntington Ingalls'
// careers page yields "Clearance Required All" from a filter dropdown.
{
  const html = `<html><head>
    <script type="application/ld+json">
      {"@type":"JobPosting","description":"<p>Build services.</p><p>No clearance needed.</p>"}
    </script></head>
    <body><nav>Clearance Required All Telework All</nav></body></html>`;
  const text = jobPostingJsonLd(html);
  assert.ok(text.includes('Build services'), 'JSON-LD description is extracted');
  assert.ok(!text.includes('Telework All'), 'page chrome is excluded from the JSON-LD text');

  // Greenhouse returns `content` ENTITY-ESCAPED. A single strip-then-decode
  // pass leaves literal tags in the output and, worse, never turns </p> into a
  // sentence break — collapsing the whole posting into one sentence and letting
  // a negation in one bullet bind to "sponsorship" in a distant one.
  const escaped = '&lt;p&gt;Authorized to work.&lt;/p&gt;&lt;p&gt;Sponsorship available.&lt;/p&gt;';
  const decoded = htmlToText(escaped);
  assert.ok(!/<[a-z/]/i.test(decoded), `escaped markup must not survive: ${decoded}`);
  assert.ok(decoded.includes('Authorized to work.'), decoded);
  assert.ok(decoded.includes('Sponsorship available.'), decoded);

  // An array payload, and @graph, are both common in the wild.
  assert.ok(
    jobPostingJsonLd('<script type="application/ld+json">[{"@type":"WebSite"},{"@type":"JobPosting","description":"Hi"}]</script>').includes('Hi')
  );
  // One malformed block must not abandon the rest.
  assert.ok(
    jobPostingJsonLd(
      '<script type="application/ld+json">{ not json </script>' +
        '<script type="application/ld+json">{"@type":"JobPosting","description":"Good"}</script>'
    ).includes('Good')
  );
  assert.equal(jobPostingJsonLd('<html><body>nothing</body></html>'), '');
}

assert.equal(htmlToText('<p>One</p><li>Two</li>'), 'One. Two.');
assert.equal(htmlToText('a&nbsp;b &amp; c'), 'a b & c');

// A question ending a block element must stay a question. The block close
// appends ". ", so "<p>...sponsorship?</p>" became "...sponsorship?." — no
// longer terminal — which defeated filter.js's interrogative guard and turned
// every embedded application-form question into a policy statement. This is the
// HTML path that Greenhouse, Workday and generic scrapes all take, so the
// plain-string assertions above do not cover it.
for (const html of [
  '<p>Are you legally authorized to work in the United States without sponsorship?</p>',
  '<p>Are you authorized to work in the US without the need for employer sponsorship?</p>',
  '<li>Do you currently hold an active Top Secret clearance?</li>',
  '<div>Will you now or in the future require sponsorship for employment visa status?</div>',
]) {
  const text = htmlToText(html);
  assert.ok(/\?$/.test(text), `question must stay terminal, got: ${text}`);
  assert.equal(eligible(text), true, `form question must not exclude: ${text.slice(0, 50)}`);
}
// ...but a STATEMENT in the same markup still excludes.
assert.equal(eligible(htmlToText('<p>We are unable to provide visa sponsorship.</p>')), false);
assert.equal(eligible(htmlToText('<li>Must hold an active Top Secret clearance.</li>')), false);

// The citizenship pattern runs against third-party HTML the poller does not
// control. A nested `(\w+\s*){0,3}` quantifier backtracked cubically there —
// 18 seconds on a 2,000-char unbroken word run, enough to stall the poll past
// the workflow timeout and lose the record of what was already delivered.
{
  const nasty = 'US citizen ' + 'word_'.repeat(800); // 4,000 chars, no "required"
  const started = Date.now();
  usEligibility({ title: 'Software Engineer', description: nasty });
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `citizenship regex backtracking: ${ms}ms on a 4k word run`);
}

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

// --- @-mentions ------------------------------------------------------------
// A malformed id renders as literal "<@raj>" on every single alert and pings
// nobody, so anything that isn't a real member ID must degrade to no mention.
for (const [input, want] of [
  ['U0BV1RKUR46', '<@U0BV1RKUR46>'],
  ['<@U0BV1RKUR46>', '<@U0BV1RKUR46>'],   // already wrapped
  ['<@U0BV1RKUR46|raj>', '<@U0BV1RKUR46>'], // wrapped with a label
  ['  U0BV1RKUR46  ', '<@U0BV1RKUR46>'],
  ['u0bv1rkur46', '<@U0BV1RKUR46>'],
  ['W012ABCDEFG', '<@W012ABCDEFG>'],       // Enterprise Grid ids start with W
  ['U123', ''],                            // too short to be an id
  ['@raj', ''],
  ['raj', ''],
  ['', ''],
  [undefined, ''],
  [null, ''],
]) {
  assert.equal(mentionTag(input), want, `mentionTag(${JSON.stringify(input)})`);
}

{
  const job = {
    company: 'TD Bank', title: 'Associate Software Engineer',
    locations: ['Toronto, ON, Canada'], url: 'https://example.com/j/1',
    postedAt: 1788484604, source: 'Workday',
  };
  const withMention = blocksFor(job, 'U0BV1RKUR46');
  // The push preview must lead with it, or the phone notification does not read
  // as directed at you.
  assert.match(withMention.text, /^<@U0BV1RKUR46> /);
  // And it must also appear in a RENDERED mrkdwn block — a mention living only
  // in the fallback text is not reliably parsed as a real mention.
  const context = withMention.blocks.at(-1).elements[0];
  assert.equal(context.type, 'mrkdwn');
  assert.match(context.text, /<@U0BV1RKUR46>/);
  // Never in the header: that block is plain_text, so it would render literally.
  assert.doesNotMatch(withMention.blocks[0].text.text, /<@/);

  // Unset or malformed leaves the card exactly as it was.
  for (const bad of [undefined, '', 'raj']) {
    const plain = blocksFor(job, bad);
    assert.doesNotMatch(JSON.stringify(plain), /<@/, `no stray mention for ${JSON.stringify(bad)}`);
    assert.equal(plain.blocks.at(-1).elements[0].text, 'via Workday');
  }
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

  // Apply URLs come from third-party boards. Anything that is not http(s) is
  // dropped here, before it can reach a Slack button or the local UI.
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/job',
    '',
    null,
  ]) {
    assert.deepEqual(collapse([{ ...gh, url }]), [], `must drop url ${JSON.stringify(url)}`);
  }
  assert.equal(collapse([gh]).length, 1, 'an ordinary https url still passes');

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

// --- Replay ----------------------------------------------------------------
// `--bootstrap` and the first run both write state WITHOUT posting, so every
// role open at that moment is suppressed permanently. The replay queue is the
// only way back: it announces roles the seen-set has already retired.
{
  const gh = {
    id: 'gh:stripe:1',
    title: 'Software Engineer, New Grad',
    company: 'Stripe',
    locations: ['San Francisco, Seattle, New York'],
    url: 'https://boards.greenhouse.io/stripe/jobs/1?gh_jid=1',
    postedAt: 1788484604,
    source: 'Greenhouse',
  };
  const other = { ...gh, id: 'gh:stripe:2', url: 'https://boards.greenhouse.io/stripe/jobs/2', title: 'Backend Engineer, New Grad' };
  const cands = collapse([gh, other]);
  assert.equal(cands.length, 2);

  // Everything already seen: a normal poll announces nothing...
  const seenSet = new Set(cands.flatMap(idsOf).map(KEY));
  assert.equal(pickFresh(cands, seenSet).length, 0, 'seen roles must not re-announce on a normal poll');

  // ...but the queue picks out exactly the queued role, seen or not.
  const queued = pickQueued(cands, new Set([KEY('gh:stripe:1')]));
  assert.equal(queued.length, 1, 'replay must announce a queued role despite the seen-set');
  assert.equal(queued[0].id, 'gh:stripe:1');
  assert.equal(pickQueued(cands, new Set()).length, 0, 'an empty queue replays nothing');

  // The queue is keyed on every copy's id, because it records whichever feed
  // won at bootstrap time and a different feed may win now.
  const si = { ...gh, id: 'simplify:abc', source: 'Simplify', url: gh.url + '&embed=true' };
  const merged = collapse([gh, si]);
  assert.equal(merged.length, 1);
  assert.equal(
    pickQueued(merged, new Set([KEY('simplify:abc')])).length,
    1,
    'a queue entry naming the losing copy must still match the collapsed role'
  );
}

console.log('all assertions passed');
