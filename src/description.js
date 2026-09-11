// Job description retrieval, for the US eligibility gate in filter.js.
//
// The poller deliberately never fetched descriptions: on a list endpoint they are
// a 16x payload blowup for data needed on under 1% of records. Sponsorship and
// clearance statements only ever live in the description body, so this fetches
// them ON DEMAND — for the handful of US-routed roles about to be alerted, never
// for the ~10k scanned per poll.
//
// Every endpoint below was confirmed with a live request against this repo's own
// feeds. Retrieval is best-effort by design: `filter.js` treats missing text as
// "no statement found", which INCLUDES the job. A network blip must never
// silently hide a role.

const TIMEOUT_MS = 20_000;
// Some career sites (Taleo, iCIMS) serve a stub or a challenge page to an
// unrecognized agent. This is the plain browser string, not an attempt to hide
// what the poller is — the endpoints are all public, unauthenticated job pages.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function get(url, opts = {}) {
  return fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...opts,
  });
}

/**
 * HTML (or an HTML fragment from an ATS `content` field) to flat text.
 *
 * Runs strip-then-decode TWICE. Greenhouse returns the description fully
 * entity-escaped (`&lt;p&gt;Text&lt;/p&gt;`), so on the first pass there are no
 * literal tags to strip and decoding is what reveals them. A single pass leaves
 * markup in the output AND — far worse — never converts `</p>` into a sentence
 * break, collapsing the whole posting into one sentence. filter.js splits on
 * sentences to keep a negation in one bullet from binding to "sponsorship" in a
 * distant one, so losing those boundaries manufactures false positives.
 */
export function htmlToText(html) {
  let s = String(html || '');
  for (let pass = 0; pass < 2; pass++) {
    s = s
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      // Block-level ends become sentence breaks so each bullet stands alone.
      .replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section|blockquote)>/gi, '. ')
      .replace(/<br\s*\/?>/gi, '. ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&lt;|&#60;/gi, '<')
      .replace(/&gt;|&#62;/gi, '>')
      .replace(/&quot;|&#34;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&amp;|&#38;/gi, '&')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&[a-z]+;/gi, ' ');
  }
  return s
    .replace(/\s*\.\s*(\.\s*)+/g, '. ')
    // A block close appends ". ", so a question ending a <p>/<li> became
    // "...sponsorship?." — no longer terminal, which defeats filter.js's
    // interrogative guard and turns an application-form QUESTION into a policy
    // STATEMENT. That is the single largest false-positive source in the gate.
    .replace(/([?!])\s*\.+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * schema.org JobPosting embedded in the page. Strongly preferred over stripping
 * the whole document: it is the description ALONE, free of the nav chrome,
 * search-filter sidebars and embedded application form that produce false
 * positives. Huntington Ingalls' page yields the literal text "Clearance
 * Required All" from a filter dropdown; its JSON-LD does not.
 */
export function jobPostingJsonLd(html) {
  const blocks = String(html || '').matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const [, raw] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue; // one malformed block must not abandon the rest
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
    for (const node of nodes) {
      const type = node?.['@type'];
      const isJob = Array.isArray(type) ? type.some((t) => /JobPosting/i.test(t)) : /JobPosting/i.test(type || '');
      if (isJob && node.description) return htmlToText(node.description);
    }
  }
  return '';
}

// --- Per-ATS retrieval ------------------------------------------------------

async function greenhouseDescription(url) {
  // Regional boards exist: IMC posts on job-boards.EU.greenhouse.io, which a
  // pattern anchored to "<sub>.greenhouse.io" silently misses.
  const m = url.match(/(?:job-boards|boards|boards-api)(?:\.[a-z]{2})?\.greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)/i);
  const id = url.match(/\/jobs\/(\d+)/)?.[1] || url.match(/[?&]gh_jid=(\d+)/)?.[1];
  if (!m || !id) return '';
  const r = await get(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${id}`);
  if (!r.ok) return '';
  // `content` is the description only, and arrives ENTITY-ESCAPED. The board
  // PAGE also renders the application form, whose "Will you now or in the
  // future require sponsorship?" question would read as a policy statement.
  return htmlToText((await r.json()).content);
}

async function workdayDescription(url) {
  // https://<tenant>.wdN.myworkdayjobs.com/en-US/<site>/job/<loc>/<slug>_<req>
  const m = url.match(/^https?:\/\/([^/]+\.myworkdayjobs\.com)\/(.+)$/i);
  if (!m) return '';
  const host = m[1];
  const tenant = host.split('.')[0];
  const rest = m[2].replace(/^([a-z]{2}-[A-Z]{2})\//, ''); // strip a locale segment
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  const site = rest.slice(0, slash);
  const path = rest.slice(slash);
  const r = await get(`https://${host}/wday/cxs/${tenant}/${site}${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!r.ok) return '';
  return htmlToText((await r.json())?.jobPostingInfo?.jobDescription);
}

/** Anything else: the posting's own page. */
async function genericDescription(url) {
  const r = await get(url);
  if (!r.ok) return '';
  const html = await r.text();
  // JSON-LD first — see jobPostingJsonLd. Only strip the whole document when
  // the page carries no structured data at all.
  return jobPostingJsonLd(html) || htmlToText(html);
}

/**
 * Best-effort description text for one job. Never throws: every failure path
 * returns '', which the caller must treat as "unknown", not as "clean".
 *
 * Ashby and Lever need no request at all — both ship descriptionPlain in the
 * list response the poller already makes, so sources.js attaches it there.
 */
export async function fetchDescription(job) {
  if (job.description) return job.description;
  const url = job.url || '';
  if (!/^https?:\/\//.test(url)) return '';
  try {
    if (/greenhouse\.io/i.test(url)) return await greenhouseDescription(url);
    if (/myworkdayjobs\.com/i.test(url)) return await workdayDescription(url);
    return await genericDescription(url);
  } catch {
    return ''; // timeout, DNS, TLS, bot-block — all mean "unknown"
  }
}

/** Attach `description` to each job, bounded concurrency, failures left blank. */
export async function attachDescriptions(jobs, { concurrency = 6 } = {}) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        job.description = await fetchDescription(job);
      }
    })
  );
  return jobs;
}
