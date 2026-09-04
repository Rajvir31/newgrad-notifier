// Source adapters. Every adapter returns jobs normalized to:
//   { id, title, company, locations: string[], url, postedAt (epoch s),
//     category?, country?, source }
// `country` is a STRUCTURED hint ('US' | 'CA'); when present and non-empty it
// beats location-string parsing. Empty string / null must fall through — 1Password's
// Ashby board leaves addressCountry "" on 39 of 62 jobs, including Canada-eligible ones.
//
// Every endpoint below was confirmed with a live request. All keyless, no
// User-Agent required, CORS-open. See README for the per-vendor traps.

const TIMEOUT_MS = 25_000;

async function req(url, opts = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const secs = (ms) => Math.floor(ms / 1000);
const iso = (s) => (s ? Math.floor(Date.parse(s) / 1000) || 0 : 0);

// ---------------------------------------------------------------------------
// Boards polled directly. These beat the aggregator on latency: an ATS reflects
// the company board the instant a recruiter publishes, whereas Simplify's file
// is only regenerated every ~30 min.
// ---------------------------------------------------------------------------
export const BOARDS = {
  // Greenhouse token -> company label. The only ATS with a true first-publish
  // timestamp, so "new since last poll" is exact rather than inferred.
  greenhouse: {
    stripe: 'Stripe', databricks: 'Databricks', anthropic: 'Anthropic',
    coinbase: 'Coinbase', robinhood: 'Robinhood', mongodb: 'MongoDB',
    cloudflare: 'Cloudflare', reddit: 'Reddit', brex: 'Brex', samsara: 'Samsara',
    gitlab: 'GitLab', affirm: 'Affirm', asana: 'Asana', figma: 'Figma',
    instacart: 'Instacart', duolingo: 'Duolingo', discord: 'Discord',
    airtable: 'Airtable', sigmacomputing: 'Sigma Computing',
    // Canada-heavy
    faire: 'Faire', ada18: 'Ada', hootsuite: 'Hootsuite', shakepay: 'Shakepay',
  },
  // Ashby org slug -> company label.
  ashby: {
    openai: 'OpenAI', ramp: 'Ramp', notion: 'Notion', cursor: 'Cursor',
    linear: 'Linear', sierra: 'Sierra', harvey: 'Harvey', abridge: 'Abridge',
    // Canada-heavy
    cohere: 'Cohere', wealthsimple: 'Wealthsimple', '1password': '1Password',
    jobber: 'Jobber',
  },
  // Lever slug -> company label. Lever's public footprint is far thinner than its
  // reputation (only 3 of 22 well-known slugs resolve) and it cannot suppress
  // descriptions, so each of these fetches is megabytes.
  lever: {
    palantir: 'Palantir', spotify: 'Spotify', matchgroup: 'Match Group',
    pointclickcare: 'PointClickCare',
  },
  // SmartRecruiters is deliberately absent. It was polled (ServiceNow, Ubisoft,
  // Bosch) and yielded zero new-grad SWE roles across 1,255 postings, and its
  // own "Early Career" custom field is mislabelled — it tags "Senior Staff
  // Software Engineer" as early-career. 15 requests per poll for nothing.
  //
  // Workday CXS. The Canada country WID is identical across every tenant tested
  // (td, cibc, bmo, sunlife), but the FACET NAME differs per tenant — get it
  // wrong and the request hard-fails with HTTP 400 (verified), so a bad facet is loud.
  // `search` matters as much: these are whole-bank boards, so the newest 20 with
  // no search term is 20 retail-banking roles. TD goes from 0 to 276 CA hits with it.
  workday: [
    { company: 'TD Bank', host: 'td.wd3.myworkdayjobs.com', tenant: 'td', site: 'TD_Bank_Careers', facet: 'locationCountry', search: 'software' },
    { company: 'BMO', host: 'bmo.wd3.myworkdayjobs.com', tenant: 'bmo', site: 'External', facet: 'Country', search: 'software' },
    { company: 'Sun Life', host: 'sunlife.wd3.myworkdayjobs.com', tenant: 'sunlife', site: 'Experienced', facet: 'Location_Country', search: 'software' },
    // A dedicated campus board — small and already early-talent scoped, so it is
    // polled unfiltered rather than searched.
    { company: 'CIBC', host: 'cibc.wd3.myworkdayjobs.com', tenant: 'cibc', site: 'campus', facet: 'Country', search: '' },
  ],
};

const WD_COUNTRY = {
  CA: 'a30a87ed25634629aa6c3958aa2b91ea',
  US: 'bc33aa3152ec42d4995f4791a106ed09',
};

// ---------------------------------------------------------------------------
// SimplifyJobs/New-Grad-Positions — the safety net. Broad (~2.8k live roles,
// every company including Google/Meta/Amazon via their own ATS links) but
// regenerated only every ~30 min. `dev` is the default branch; `main` 404s.
// ---------------------------------------------------------------------------
export async function fetchSimplify() {
  const rows = await req(
    'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
  );
  const BACHELORS = ["Bachelor's", "Associate's"];
  return rows
    .filter((r) => r.active && r.is_visible)
    // degrees of exactly ["PhD"] / ["Master's"] / ["Master's","PhD"] are
    // advanced-degree-only. An empty array means unknown — keep those.
    .filter((r) => !r.degrees?.length || r.degrees.some((d) => BACHELORS.includes(d)))
    .map((r) => ({
      id: `simplify:${r.id}`,
      title: (r.title || '').trim(),
      company: r.company_name,
      locations: r.locations || [],
      url: r.url,
      postedAt: r.date_posted,
      category: r.category,
      // The repo itself is curated to new-grad roles, so these need no title
      // signal. Every other source is a full company board and does.
      newGradScoped: true,
      source: 'Simplify',
    }));
}

// --- Greenhouse -------------------------------------------------------------
// Poll the plain list; ?content=true is a 16x payload blowup for data needed on
// under 1% of records. `?updated_after=` is silently IGNORED — diff client-side.
async function greenhouse(token, company) {
  const { jobs } = await req(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
  return (jobs || []).map((j) => ({
    id: `gh:${token}:${j.id}`,
    title: (j.title || '').trim(),
    company,
    locations: splitLocations(j.location?.name),
    // Do NOT strip the query string. On some boards (Stripe) absolute_url is
    // a generic search page and `?gh_jid=` is the only thing identifying the job.
    url: j.absolute_url,
    postedAt: iso(j.first_published || j.updated_at),
    source: 'Greenhouse',
  }));
}

// --- Ashby ------------------------------------------------------------------
// TRAP: an unknown-but-plausible org returns HTTP 200 with an empty array
// (`vercel`, `deel` both do) rather than a 404. Assert length, not status.
async function ashby(org, company) {
  const data = await req(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
  const jobs = data.jobs || [];
  if (!jobs.length) throw new Error(`ashby:${org} returned 0 jobs (bad slug?)`);
  return jobs
    .filter((j) => j.isListed !== false)
    .filter((j) => j.employmentType !== 'Intern' && j.employmentType !== 'Contract')
    .map((j) => {
      const addrs = [j.address, ...(j.secondaryLocations || []).map((s) => s.address)];
      const countries = addrs
        .map((a) => a?.postalAddress?.addressCountry)
        .filter((c) => c && c.trim()); // "" and missing must fall through to strings
      return {
        id: `ashby:${org}:${j.id}`,
        title: (j.title || '').trim(), // leading/double spaces occur in real data
        company,
        locations: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)]
          .filter(Boolean)
          .concat(countries),
        url: j.applyUrl || j.jobUrl,
        postedAt: iso(j.publishedAt),
        source: 'Ashby',
      };
    });
}

// --- Lever ------------------------------------------------------------------
// Title lives in `text`, not `title`. createdAt is epoch MILLISECONDS.
// `country` is a clean ISO-2 and the most reliable country field of any ATS.
async function lever(slug, company) {
  const rows = await req(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (rows || [])
    .filter((j) => j.categories?.commitment !== 'Full Time Contractor')
    .map((j) => ({
      id: `lever:${slug}:${j.id}`,
      title: (j.text || '').trim(),
      company,
      locations: j.categories?.allLocations?.length
        ? j.categories.allLocations
        : [j.categories?.location].filter(Boolean),
      url: j.applyUrl || j.hostedUrl,
      postedAt: j.createdAt ? secs(j.createdAt) : 0,
      country: j.country === 'CA' ? 'CA' : j.country === 'US' ? 'US' : undefined,
      source: 'Lever',
    }));
}

// --- Workday ----------------------------------------------------------------
// POST, not GET. Results come back newest-first, so one page per country is
// enough for a 10-minute poll. `postedOn` is relative text ("Posted Yesterday"),
// never a timestamp, so it is parsed approximately and used for display only.
const WD_PAGE = 20;
async function workday(cfg) {
  const out = [];
  for (const [country, wid] of Object.entries(WD_COUNTRY)) {
    const data = await req(`https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: { [cfg.facet]: [wid] }, limit: WD_PAGE, offset: 0, searchText: cfg.search ?? '' }),
    });
    for (const j of data.jobPostings || []) {
      out.push({
        id: `wd:${cfg.tenant}:${j.bulletFields?.[0] || j.externalPath}`,
        title: (j.title || '').trim(),
        company: cfg.company,
        // "2 Locations" is a real value, and at least one CIBC posting has no
        // locationsText key at all — the country hint below covers both.
        locations: [j.locationsText].filter((l) => l && !/^\d+\s+Locations?$/i.test(l)),
        url: `https://${cfg.host}/en-US/${cfg.site}${j.externalPath}`,
        postedAt: relativeToEpoch(j.postedOn),
        country,
        source: 'Workday',
      });
    }
  }
  return out;
}

// "Posted Today" / "Posted Yesterday" / "Posted 4 Days Ago" / "Posted 30+ Days Ago"
export function relativeToEpoch(text = '', now = Math.floor(Date.now() / 1000)) {
  const t = String(text).toLowerCase();
  if (t.includes('today')) return now;
  if (t.includes('yesterday')) return now - 86400;
  const m = t.match(/(\d+)\+?\s*day/);
  if (m) return now - Number(m[1]) * 86400;
  return 0;
}

// Greenhouse glues locations together inconsistently — Hootsuite ships
// "Montreal, Quebec, Vancouver, Canada, Toronto, Canada; Calgary, Canada".
// Split on ";" and keep each comma-run whole so "Toronto, ON" survives intact.
export function splitLocations(raw) {
  if (!raw) return [];
  return String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Runner. One source failing must never sink the poll: a board that starts 404ing
// because the company switched ATS should cost that board only.
// ---------------------------------------------------------------------------
export function allSources() {
  const tasks = [['simplify', fetchSimplify]];
  for (const [t, c] of Object.entries(BOARDS.greenhouse)) tasks.push([`greenhouse:${t}`, () => greenhouse(t, c)]);
  for (const [o, c] of Object.entries(BOARDS.ashby)) tasks.push([`ashby:${o}`, () => ashby(o, c)]);
  for (const [s, c] of Object.entries(BOARDS.lever)) tasks.push([`lever:${s}`, () => lever(s, c)]);
  for (const cfg of BOARDS.workday) tasks.push([`workday:${cfg.tenant}`, () => workday(cfg)]);
  return tasks;
}

export async function fetchAll({ concurrency = 6, only = null } = {}) {
  const tasks = allSources().filter(([n]) => !only || n.includes(only));
  const jobs = [];
  const failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (next < tasks.length) {
        const [name, fn] = tasks[next++];
        try {
          const got = await fn();
          jobs.push(...got);
          console.log(`  ok   ${name} (${got.length})`);
        } catch (e) {
          failures.push({ name, error: e.message });
          console.warn(`  FAIL ${name}: ${e.message}`);
        }
      }
    })
  );
  return { jobs, failures, sourceCount: tasks.length };
}
