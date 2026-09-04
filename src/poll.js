// Poll every source, alert on genuinely-new new-grad roles, remember what was sent.
//
//   node src/poll.js              poll and post
//   node src/poll.js --dry        poll and print, post nothing, write nothing
//   node src/poll.js --bootstrap  seed the seen-set without posting (first run,
//                                 or after adding boards / loosening filters)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAll } from './sources.js';
import { isNewGrad, isSweRole, channelsFor, needsClearance } from './filter.js';
import { checkAuth, postJobs, blocksFor } from './slack.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = resolve(ROOT, 'data/seen.json');

// Ids are stored as 48-bit hashes: it keeps the committed state file small
// enough that git deltas stay cheap, and stops a public repo from publishing a
// readable log of every posting. Collision odds at the 50k cap are ~4e-6.
const KEY = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);

// Insertion-ordered, capped rather than time-windowed: with no per-id timestamps
// the file only changes when something new arrives, so most runs produce no git
// diff and therefore no commit.
const MAX_SEEN = 50_000;

// A posting older than this is backlog, not news. Without it, adding a board
// replays that company's entire history into the channel on the next poll.
const MAX_AGE_DAYS = 14;

// If a poll ever finds more new jobs than this, something broke upstream (an id
// format changed, a feed was rebuilt) rather than 200 roles going live at once.
// Seed them instead of firing them into the channel.
const MAX_BURST = 60;

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry');
const BOOTSTRAP = argv.has('--bootstrap');

function loadSeen() {
  try {
    const parsed = JSON.parse(readFileSync(STATE, 'utf8'));
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return []; // no state yet — first run
  }
}

function saveSeen(ids) {
  mkdirSync(dirname(STATE), { recursive: true });
  const kept = ids.slice(-MAX_SEEN);
  writeFileSync(STATE, JSON.stringify({ ids: kept }, null, 0) + '\n');
  return kept.length;
}

// Tracking junk varies by source for the same posting — Simplify appends
// ?embed=true, Greenhouse adds ?t=&gh_src=. Identifying params must survive:
// Stripe's absolute_url is the same /jobs/search page for every req and only
// gh_jid tells them apart, so a blanket query strip would fuse its whole board.
const TRACKING = /^(embed|ref|source|t|gh_src|utm_[a-z]+)$/i;

export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\/+$/, '');
    u.searchParams.sort();
    return u.toString().toLowerCase();
  } catch {
    return String(raw).toLowerCase();
  }
}

/**
 * Filter to alertable roles and collapse the copies of each one down to a single
 * candidate. Pure, so the dedup guarantees are testable without the network.
 *
 * Two collapse keys are needed:
 *  - by URL, because Simplify rewrites titles. Notion's board says "Software
 *    Engineer, Early Career (AI)" while Simplify calls the same posting
 *    "Software Engineer – Early Career - AI", so company+title alone lets both
 *    through as separate jobs.
 *  - by company+title+channel, because one opening is usually listed once per
 *    city with a distinct URL each time (Stripe posts six identical "Software
 *    Engineer, New Grad" reqs). Scoping the key to the destination channel
 *    collapses per-city duplicates within a channel while keeping the Toronto
 *    req alive for #canada — a channel-blind key silently deleted it.
 *
 * Direct ATS feeds sort first, so the company's own wording wins and the result
 * does not depend on which fetch happened to finish first.
 */
export function collapse(jobs, { cutoff = 0 } = {}) {
  const SOURCE_RANK = { Greenhouse: 0, Ashby: 0, Lever: 0, Workday: 0, Simplify: 1 };
  const ordered = [...jobs].sort(
    (a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
  );

  const byUrl = new Map();
  const byTitle = new Map();
  const candidates = [];
  for (const job of ordered) {
    // An alert with no apply link is not worth sending, and Slack rejects a
    // button without a url outright — which would lose the whole message.
    if (!job.url || !/^https?:\/\//.test(job.url)) continue;
    if (!isNewGrad(job) || !isSweRole(job)) continue;
    if (job.postedAt && cutoff && job.postedAt < cutoff) continue;

    const channels = channelsFor(job);
    const urlKey = normalizeUrl(job.url);
    const titleKey = `${job.company}|${job.title}|${channels.join('+')}`.toLowerCase();
    const winner = byUrl.get(urlKey) ?? byTitle.get(titleKey);
    if (winner) {
      // Keep the losing copy's id on the winner. Without it, the role is
      // announced again the next time the winning feed is down and a different
      // copy takes over.
      winner.alsoSeen.push(job.id);
      continue;
    }
    const candidate = { ...job, channels, alsoSeen: [] };
    byUrl.set(urlKey, candidate);
    byTitle.set(titleKey, candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/** Every id this role is known by — the winner's plus every collapsed copy's. */
export const idsOf = (job) => [job.id, ...(job.alsoSeen || [])];

/**
 * A role is fresh only if NO copy of it has been seen, from any feed. Testing
 * just the winner's id re-announces a role whenever the winning feed changes.
 */
export function pickFresh(candidates, seenSet) {
  return candidates.filter((j) => !idsOf(j).some((id) => seenSet.has(KEY(id))));
}

function describe(job, channels) {
  const where = job.locations?.length ? job.locations.join(' / ') : '?';
  return `[${channels.join('+') || '--'}] ${job.company} — ${job.title}  (${where})  ${job.url}`;
}

async function main() {
  const token = process.env.SLACK_BOT_TOKEN;
  const channels = { US: process.env.SLACK_CHANNEL_US, CA: process.env.SLACK_CHANNEL_CA };
  const live = !DRY && !BOOTSTRAP;

  if (live) {
    if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
    if (!channels.US && !channels.CA) throw new Error('set SLACK_CHANNEL_US and/or SLACK_CHANNEL_CA');
    const who = await checkAuth(token); // fail on a dead token before fetching anything
    console.log(`slack ok: ${who.team} as ${who.user}`);
  }

  console.log('fetching...');
  const { jobs, failures, sourceCount } = await fetchAll();
  console.log(`${jobs.length} raw postings from ${sourceCount - failures.length}/${sourceCount} feeds`);

  // Individual feeds fail all the time (a company switches ATS) and that is fine.
  // A third of them failing at once is an outage, and quietly posting the
  // survivors makes it look like a slow day — the one failure nobody notices.
  if (failures.length > sourceCount / 3) {
    throw new Error(
      `${failures.length}/${sourceCount} feeds failed — treating as an outage rather than a quiet day: ` +
        failures.map((f) => f.name).join(', ')
    );
  }

  const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const seen = loadSeen();
  const seenSet = new Set(seen);

  const candidates = collapse(jobs, { cutoff });

  const fresh = pickFresh(candidates, seenSet);
  // A job is deliverable only if it routes to a channel that is actually
  // configured. If SLACK_CHANNEL_CA is unset or mistyped, Canadian roles are
  // NOT quietly marked seen — that would suppress them permanently while the
  // workflow still reported success.
  // --dry / --bootstrap have no Slack config, so every channel counts as open.
  const configured = (c) => (live ? Boolean(channels[c]) : true);
  const routed = fresh
    .map((job) => ({ job, channels: job.channels.filter(configured) }))
    .filter((r) => r.channels.length);
  const deliverable = new Set(routed.map((r) => r.job.id));

  console.log(
    `${candidates.length} new-grad SWE roles, ${fresh.length} unseen, ${routed.length} deliverable`
  );

  // Seed everything that was CONSIDERED AND DELIVERABLE. Jobs filtered out for
  // being outside US/CA are seeded too (they are decided, not pending), but a
  // job destined for an unconfigured channel is left unseen so it goes out once
  // the secret is fixed.
  const seedable = (extraSkip = new Set()) =>
    seen.concat(
      candidates
        .filter((j) => !j.channels.length || (deliverable.has(j.id) && !extraSkip.has(j.id)))
        // Every copy of the role, not just the winning feed's, so a feed going
        // down later cannot resurrect it as "new".
        .flatMap(idsOf)
        .map(KEY)
        .filter((k) => !seenSet.has(k))
    );
  const nextSeen = seedable();

  if (DRY) {
    for (const { job, channels: ch } of routed.slice(0, 40)) console.log('  ' + describe(job, ch));
    if (routed.length > 40) console.log(`  ... and ${routed.length - 40} more`);
    console.log('\n--dry: nothing posted, nothing saved');
    return;
  }

  if (BOOTSTRAP) {
    const kept = saveSeen(nextSeen);
    console.log(`--bootstrap: seeded ${kept} ids, posted nothing`);
    return;
  }

  if (seen.length === 0) {
    const kept = saveSeen(nextSeen);
    console.log(`first run: seeded ${kept} ids without posting (re-run to start alerting)`);
    return;
  }

  if (routed.length > MAX_BURST) {
    const kept = saveSeen(nextSeen);
    console.warn(
      `!! ${routed.length} new roles exceeds the ${MAX_BURST} burst guard — a feed probably changed shape.\n` +
        `   Seeded ${kept} ids without posting. Check the diff, then let the next poll run normally.`
    );
    return;
  }

  const byChannel = {};
  for (const { job, channels: ch } of routed) {
    for (const c of ch) {
      const id = channels[c];
      // Both env vars can point at the same channel; don't post the job twice.
      const arr = (byChannel[id] ||= []);
      if (!arr.includes(job)) arr.push(job);
    }
  }

  if (!Object.keys(byChannel).length) {
    saveSeen(nextSeen);
    console.log('nothing to post');
    return;
  }

  const { results, failed } = await postJobs(token, byChannel);
  for (const [channel, ok, total] of results) console.log(`posted ${ok}/${total} to ${channel}`);

  // A job that failed to post must stay unseen, or it is silently suppressed
  // forever while the workflow reports success.
  const kept = saveSeen(seedable(new Set(failed.map((j) => j.id))));
  console.log(`state: ${kept} ids`);

  if (failures.length) {
    console.warn(`${failures.length} feed(s) failed: ${failures.map((f) => f.name).join(', ')}`);
  }

  // Fail the workflow when delivery is wholly broken. A failing scheduled run
  // emails the workflow author — the cheapest possible monitoring, and the only
  // thing standing between a dead bot and nobody noticing for a month.
  const [ok, total] = results.reduce(([o, t], [, s, n]) => [o + s, t + n], [0, 0]);
  if (total && !ok) {
    throw new Error(`all ${total} posts failed — state not advanced for them`);
  }
}

// Only poll when run directly, so the test file can import normalizeUrl and KEY
// without kicking off a live poll as an import side effect.
//
// exitCode rather than process.exit(): forcing exit while fetch's keep-alive
// sockets are still open trips a libuv assertion on Windows, which buries the
// actual error message under a stack trace.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

export { KEY };
