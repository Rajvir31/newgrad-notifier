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
import { isNewGrad, isSweRole, channelsFor, usEligibility } from './filter.js';
import { attachDescriptions } from './description.js';
import { checkAuth, postJobs, blocksFor } from './slack.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = resolve(ROOT, 'data/seen.json');
// A queue of already-seen ids to announce anyway. `--bootstrap` and the very
// first run both write state WITHOUT posting, so everything open at that moment
// is suppressed forever — there was no way to recover a role once seeded.
const REPLAY = resolve(ROOT, 'data/replay.json');

// Ids are stored as 48-bit hashes: it keeps the committed state file small
// enough that git deltas stay cheap, and stops a public repo from publishing a
// readable log of every posting. Collision odds at the 50k cap are ~4e-6.
const KEY = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);

// Insertion-ordered, capped rather than time-windowed: with no per-id timestamps
// the file only changes when something new arrives, so most runs produce no git
// diff and therefore no commit.
const MAX_SEEN = 50_000;

// A posting older than THIS MANY DAYS is backlog, not news — measured from the
// company's own posting date, not from when we first saw it. Two jobs it does:
//
//  1. Stops adding a board from replaying that company's entire history.
//  2. Suppresses the aggregator's ingestion tail. Simplify's `date_posted` is
//     honest about when the COMPANY posted, but it surfaces rows on its own
//     schedule: median 0.9 days behind, p90 6.5 days, and a measured max of
//     6.8. Those late arrivals look brand new to the seen-set diff and were
//     announced as news, so an alert would land for a role posted a week
//     earlier — which is what this is set low to prevent.
//
// 3 days keeps 97% of real alert volume (157 of the last 162) while dropping
// exactly that stale tail. Raise it with MAX_AGE_DAYS if the poller is going to
// be down longer than the window: a posting that ages out during an outage is
// skipped permanently, because the seen-set never learns it existed.
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS) || 3;

// If a poll ever finds more new jobs than this, something broke upstream (an id
// format changed, a feed was rebuilt) rather than 200 roles going live at once.
// Seed them instead of firing them into the channel.
const MAX_BURST = 60;

// A replay bypasses MAX_BURST, so it needs its own bound. State is only durable
// once the whole batch resolves and the workflow commits it, so an unbounded
// batch that hits the 10-minute job timeout mid-send loses the record of every
// message already delivered and re-posts them on the next replay. At PACE_MS
// (1.1s per channel) 50 messages is under a minute of pacing with plenty of
// headroom for Slack's 429 back-off. Larger backlogs drain over several runs.
const REPLAY_BATCH = 50;

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry');
const BOOTSTRAP = argv.has('--bootstrap');
// Announce the queue in data/replay.json instead of diffing against the
// seen-set. Deliberate operator action, so the burst guard does not apply.
const REPLAYING = argv.has('--replay');

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

function loadReplay() {
  try {
    const parsed = JSON.parse(readFileSync(REPLAY, 'utf8'));
    return Array.isArray(parsed.ids) ? parsed.ids : [];
  } catch {
    return [];
  }
}

/**
 * Drop the ids that made it out. What remains is retried by the next replay
 * run, so a batch interrupted halfway (rate limit, runner timeout) resumes
 * instead of either duplicating what was sent or losing what was not.
 */
function saveReplay(ids) {
  mkdirSync(dirname(REPLAY), { recursive: true });
  writeFileSync(REPLAY, JSON.stringify({ ids }, null, 0) + '\n');
  return ids.length;
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

/**
 * The replay counterpart: pick the roles whose ids are queued, regardless of
 * the seen-set. Keyed on every copy's id for the same reason pickFresh is —
 * the queue records whichever feed won at bootstrap time, which is not
 * necessarily the feed winning now.
 */
export function pickQueued(candidates, replaySet) {
  return candidates.filter((j) => idsOf(j).some((id) => replaySet.has(KEY(id))));
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

  // A replay is an explicit "announce exactly these ids" instruction, so it
  // bypasses the freshness window the same way it bypasses the burst guard.
  // Applying MAX_AGE_DAYS here would be a silent no-op: a backlog is old by
  // definition (the queued roles currently run to a 10.6-day median), so every
  // replay run would match nothing and the queue would never drain.
  const cutoff = REPLAYING ? 0 : Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const seen = loadSeen();
  const seenSet = new Set(seen);
  const queue = REPLAYING ? loadReplay() : [];

  const candidates = collapse(jobs, { cutoff });

  const fresh = REPLAYING
    ? pickQueued(candidates, new Set(queue))
    : pickFresh(candidates, seenSet);
  // A job is deliverable only if it routes to a channel that is actually
  // configured. If SLACK_CHANNEL_CA is unset or mistyped, Canadian roles are
  // NOT quietly marked seen — that would suppress them permanently while the
  // workflow still reported success.
  // --dry / --bootstrap have no Slack config, so every channel counts as open.
  const configured = (c) => (live ? Boolean(channels[c]) : true);
  const routedAll = fresh
    .map((job) => ({ job, channels: job.channels.filter(configured) }))
    .filter((r) => r.channels.length);
  // Cap a replay so one run cannot outlive the job timeout mid-batch. Whatever
  // is left stays queued and goes out on the next replay run. Capping BEFORE the
  // eligibility gate keeps the description fetches proportional to what is
  // actually about to be sent.
  const capped = REPLAYING ? routedAll.slice(0, REPLAY_BATCH) : routedAll;

  // US eligibility gate. Sponsorship and clearance statements live in the
  // description body, which no list endpoint returns, so this is the one place
  // the poller fetches them — for the handful of US roles about to be alerted,
  // never for the ~10k scanned. Skipped on --bootstrap, which posts nothing.
  const gated = [];
  const usBound = capped.filter((r) => r.channels.includes('US'));
  if (usBound.length && !BOOTSTRAP) {
    console.log(`checking sponsorship/clearance for ${usBound.length} US role(s)...`);
    await attachDescriptions(usBound.map((r) => r.job));
    for (const r of usBound) {
      const verdict = usEligibility(r.job);
      if (verdict.ok) continue;
      // Drop ONLY the US channel. A role open in both countries is still a
      // perfectly good Canadian posting — US visa sponsorship does not apply
      // to it, and silently deleting it from #canada would be a regression.
      r.channels = r.channels.filter((c) => c !== 'US');
      r.job.channels = r.job.channels.filter((c) => c !== 'US');
      gated.push({ job: r.job, reason: verdict.reason });
    }
  }
  // A role gated out of every channel it had is DECIDED, not pending: it falls
  // out of `routed` here and is picked up by seedable()'s no-channel branch, so
  // it is marked seen and never re-fetched.
  const routed = capped.filter((r) => r.channels.length);
  const deliverable = new Set(routed.map((r) => r.job.id));

  if (gated.length) {
    console.log(`${gated.length} US role(s) excluded:`);
    for (const g of gated.slice(0, 20)) {
      console.log(`  [${g.reason}] ${g.job.company} — ${g.job.title}`);
    }
    if (gated.length > 20) console.log(`  ... and ${gated.length - 20} more`);
  }

  console.log(
    REPLAYING
      ? `${candidates.length} new-grad SWE roles, ${queue.length} queued for replay, ` +
          `${routed.length} deliverable this batch (of ${routedAll.length} matched)`
      : `${candidates.length} new-grad SWE roles, ${fresh.length} unseen, ${routed.length} deliverable`
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

  if (seen.length === 0 && !REPLAYING) {
    const kept = saveSeen(nextSeen);
    console.log(`first run: seeded ${kept} ids without posting (re-run to start alerting)`);
    return;
  }

  // The burst guard catches a feed changing shape. A replay is a deliberate
  // request to announce a known list, so the count is expected, not suspicious —
  // and applying the guard here would silently re-swallow the exact backlog the
  // replay exists to recover.
  if (routed.length > MAX_BURST && !REPLAYING) {
    const kept = saveSeen(nextSeen);
    console.warn(
      `!! ${routed.length} new roles exceeds the ${MAX_BURST} burst guard — a feed probably changed shape.\n` +
        `   Seeded ${kept} ids without posting. Check the diff, then let the next poll run normally.\n` +
        `   To announce them anyway: queue their ids in data/replay.json and run with --replay.`
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
    // Retire anything the gate decided against even though nothing was posted —
    // otherwise a batch that is entirely ineligible re-fetches its descriptions
    // on every future replay and the queue never drains. Only fully-gated roles
    // qualify: one that kept a channel simply had no CONFIGURED channel left,
    // and must stay queued until that secret is fixed.
    const fullyGated = gated.filter((g) => !g.job.channels.length);
    if (REPLAYING && fullyGated.length) {
      const done = new Set(fullyGated.map((g) => g.job).flatMap(idsOf).map(KEY));
      const left = saveReplay(queue.filter((k) => !done.has(k)));
      console.log(`replay: 0 announced, ${fullyGated.length} excluded, ${left} still queued`);
    } else if (REPLAYING && queue.length) {
      // Nothing MATCHED — a feed carrying the queued roles was down, the ids are
      // in the wrong format, or they have aged past MAX_AGE_DAYS — not that they
      // were delivered. Truncating the file on a run that posted nothing would
      // discard the whole backlog silently, which is the exact failure the
      // replay queue exists to undo.
      console.warn(
        `replay: ${queue.length} queued ids matched nothing deliverable this run — queue left intact.\n` +
          `   Ids must be 12-hex sha256(id) prefixes, and the roles must still be within MAX_AGE_DAYS.`
      );
    }
    console.log('nothing to post');
    return;
  }

  const { results, failed } = await postJobs(token, byChannel, process.env.SLACK_MENTION);
  for (const [channel, ok, total] of results) console.log(`posted ${ok}/${total} to ${channel}`);

  // A job that failed to post must stay unseen, or it is silently suppressed
  // forever while the workflow reports success.
  const kept = saveSeen(seedable(new Set(failed.map((j) => j.id))));
  console.log(`state: ${kept} ids`);

  if (REPLAYING) {
    // Retire only what actually went out. Anything that failed, and anything
    // whose posting has since fallen outside the age window or off its board,
    // is left queued rather than dropped on the floor.
    //
    // Roles the eligibility gate excluded ARE retired: they were examined and
    // decided against, so leaving them queued would re-fetch their descriptions
    // on every future replay and never drain.
    //
    // Only those gated out of EVERY channel, though. A US+CA role that merely
    // lost its US channel is still being delivered to #canada — retiring it
    // here would cancel the `failed` exclusion above and lose it for good.
    const done = new Set(
      routed
        .map((r) => r.job)
        .filter((j) => !failed.includes(j))
        .concat(gated.filter((g) => !g.job.channels.length).map((g) => g.job))
        .flatMap(idsOf)
        .map(KEY)
    );
    const left = saveReplay(queue.filter((k) => !done.has(k)));
    console.log(`replay: ${queue.length - left} announced, ${left} still queued`);
  }

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
