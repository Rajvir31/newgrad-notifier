// Slack delivery via bot token + chat.postMessage.
//
// Why not incoming webhooks: a webhook is permanently bound to the one channel
// chosen at install time ("You cannot override the default channel"), so two
// channels would mean two secrets and a reinstall to add a third. One bot token
// posts anywhere and returns a parseable result.
//
// THE trap: the Slack Web API returns HTTP 200 even on hard auth failure —
// a dead token yields 200 {"ok":false,"error":"invalid_auth"}. Code that checks
// the status code reports success while posting nothing, forever, silently.
// Every response here is branched on the JSON `ok` field, never the status.

const API = 'https://slack.com/api';

// chat.postMessage is Special-tier: one message per second PER CHANNEL. Breaching
// it is user-visible ("some messages from your app are not being displayed"),
// not just logged. Channels are paced independently so two channels drain in
// parallel rather than serially.
const PACE_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, token, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Without the charset Slack answers with a `missing_charset` warning.
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const retryAfter = Number(res.headers.get('retry-after')) || 0;
  const json = await res.json().catch(() => ({ ok: false, error: `bad_json_${res.status}` }));
  return { ...json, status: res.status, retryAfter };
}

/** Fail fast on a bad token instead of discovering it on job 1 of 40. */
export async function checkAuth(token) {
  const r = await call('auth.test', token, {});
  if (!r.ok) throw new Error(`Slack auth failed: ${r.error} (no token -> not_authed, bad token -> invalid_auth)`);
  return r;
}

/**
 * Block Kit payload for one job.
 * - `header` is plain_text only (max 150 chars) — links and bold render literally
 *   there, so the Apply link can never live in the header.
 * - The date uses Slack's per-viewer token so a community spanning timezones
 *   each sees its own local time. The `|fallback` segment is mandatory.
 * - Top-level `text` is the mobile push preview and the accessibility fallback;
 *   a blocks-only message shows up blank in notifications.
 */
export function blocksFor(job) {
  const head = `${job.company} — ${job.title}`.slice(0, 150);
  const where = job.locations?.length ? job.locations.join(' • ') : 'Location not listed';
  const when = job.postedAt
    ? `<!date^${job.postedAt}^{date_short_pretty} at {time}|posted recently>`
    : 'recently';

  return {
    text: `${head} (${where})`,
    unfurl_links: false, // else every alert drags in a giant ATS link preview
    unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: head, emoji: true } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Location*\n${where}` },
          { type: 'mrkdwn', text: `*Posted*\n${when}` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Apply', emoji: true },
            url: String(job.url).slice(0, 3000),
            style: 'primary',
          },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `via ${job.source}` }] },
    ],
  };
}

async function postOne(token, channel, job) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // A transport error (ECONNRESET, DNS, TLS) must cost one message, not the
    // whole batch: an uncaught reject here would escape Promise.all and skip
    // the state save, re-posting everything already delivered on the next run.
    const r = await call('chat.postMessage', token, { channel, ...blocksFor(job) }).catch((e) => ({
      ok: false,
      error: `network: ${e.message}`,
      status: 0,
      retryAfter: 0,
    }));
    if (r.ok) return true;
    if (r.status === 429 || r.error === 'ratelimited') {
      // Sleep exactly what Slack asks for — guessing is how you get throttled twice.
      await sleep((r.retryAfter || 30) * 1000);
      continue;
    }
    // Anything else (channel_not_found, invalid_auth, ...) will not fix itself.
    console.error(`  slack ${channel}: ${r.error} for ${job.company} — ${job.title}`);
    return false;
  }
  // Rate-limited out of retries. Logged so both failure paths are greppable —
  // this one used to drop a job with no record of which one.
  console.error(`  slack ${channel}: gave up after 4 attempts for ${job.company} — ${job.title}`);
  return false;
}

/**
 * Post a batch of jobs, one message each, paced per channel.
 * One message per job rather than a digest: each role gets its own Apply button,
 * its own thread, and its own "I applied" reaction. (A digest also caps out —
 * 50 blocks per message means 12 jobs at 4 blocks each.)
 *
 * Returns { results, failed } where `failed` holds the jobs that did NOT get
 * through. The caller must keep those out of the seen-set, or a job that failed
 * to post is marked as delivered and never announced.
 */
export async function postJobs(token, byChannel) {
  const failed = [];
  const results = await Promise.all(
    Object.entries(byChannel).map(async ([channel, jobs]) => {
      let sent = 0;
      for (const [i, job] of jobs.entries()) {
        if (i) await sleep(PACE_MS);
        if (await postOne(token, channel, job)) sent++;
        else failed.push(job);
      }
      return [channel, sent, jobs.length];
    })
  );
  return { results, failed };
}
