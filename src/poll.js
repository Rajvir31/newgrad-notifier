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

  const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const seen = loadSeen();
  const seenSet = new Set(seen);

  // The same role reaches us from several feeds (Simplify carries the ATS link
  // for boards we also poll directly), so collapse on company+title before the
  // seen-check or one posting fires twice.
  const dedup = new Map();
  const candidates = [];
  for (const job of jobs) {
    // An alert with no apply link is not worth sending, and Slack rejects a
    // button without a url outright — which would lose the whole message.
    if (!job.url || !/^https?:\/\//.test(job.url)) continue;
    if (!isNewGrad(job) || !isSweRole(job)) continue;
    if (job.postedAt && job.postedAt < cutoff) continue;
    const collapse = `${job.company}|${job.title}`.toLowerCase();
    if (dedup.has(collapse)) continue;
    dedup.set(collapse, true);
    candidates.push(job);
  }

  const fresh = candidates.filter((j) => !seenSet.has(KEY(j.id)));
  const routed = fresh
    .map((job) => ({ job, channels: channelsFor(job) }))
    .filter((r) => r.channels.length);

  console.log(
    `${candidates.length} new-grad SWE roles, ${fresh.length} unseen, ${routed.length} in US/CA`
  );

  // Everything considered goes into the seen-set, not just what was posted:
  // otherwise a later filter tweak turns months of old postings into "new".
  const nextSeen = seen.concat(candidates.map((j) => KEY(j.id)).filter((k) => !seenSet.has(k)));

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
      if (!id) continue;
      (byChannel[id] ||= []).push(job);
    }
  }

  if (!Object.keys(byChannel).length) {
    saveSeen(nextSeen);
    console.log('nothing to post');
    return;
  }

  const sent = await postJobs(token, byChannel);
  for (const [channel, ok, total] of sent) console.log(`posted ${ok}/${total} to ${channel}`);

  const kept = saveSeen(nextSeen);
  console.log(`state: ${kept} ids`);

  if (failures.length) {
    console.warn(`${failures.length} feed(s) failed: ${failures.map((f) => f.name).join(', ')}`);
  }
}

// exitCode rather than process.exit(): forcing exit while fetch's keep-alive
// sockets are still open trips a libuv assertion on Windows, which buries the
// actual error message under a stack trace.
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

export { KEY, blocksFor, needsClearance };
