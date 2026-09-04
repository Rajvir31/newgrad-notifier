// Setup checker: `npm run doctor`
//
// Every way this can be misconfigured fails SILENTLY in production — Slack
// answers HTTP 200 on a dead token, an unset Actions variable expands to an
// empty string, and a bot that was never invited just gets `not_in_channel`.
// So this proves the whole path end to end and posts one real test message.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://slack.com/api';

const token = process.env.SLACK_BOT_TOKEN;
const channels = { US: process.env.SLACK_CHANNEL_US, CA: process.env.SLACK_CHANNEL_CA };

let failed = 0;
let authOk = false;
const ok = (msg) => console.log(`  \x1b[32mOK\x1b[0m    ${msg}`);
const bad = (msg, fix) => {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
  if (fix) console.log(`        -> ${fix}`);
};
const skip = (msg) => console.log(`  \x1b[90m--\x1b[0m    ${msg}`);

async function call(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body || {}),
  });
  // Slack returns 200 even on hard auth failure, so the JSON `ok` is the truth.
  return { json: await res.json().catch(() => ({ ok: false, error: 'bad_json' })), headers: res.headers };
}

console.log('\nChecking Slack setup...\n');

// 1. Can we reach Slack at all? Distinguishes "network is broken" from
//    "credentials are broken" before anything else is blamed.
try {
  const res = await fetch(`${API}/api.test`, { method: 'POST' });
  const j = await res.json();
  j.ok ? ok('Slack is reachable') : bad('Slack responded but not ok', JSON.stringify(j));
} catch (e) {
  bad(`Cannot reach Slack: ${e.message}`, 'check your network / proxy');
  process.exit(1);
}

// 2. Token
if (!token) {
  // A .env in the wrong place is the nastiest version of this: --env-file-if-exists
  // just shrugs, so a fully-correct token sitting one directory over looks
  // identical to having no token at all.
  const misplaced = [
    'src/.env', 'public/.env', '.env.txt', '.env.local.txt', 'env', '.env.local',
  ].filter((p) => existsSync(resolve(ROOT, p)));

  if (misplaced.length) {
    bad(
      `SLACK_BOT_TOKEN is not set, but found ${misplaced.join(', ')}`,
      `only "${resolve(ROOT, '.env')}" is loaded — move it there (note Windows "Save As" appends .txt)`
    );
  } else {
    bad(
      'SLACK_BOT_TOKEN is not set',
      `create ${resolve(ROOT, '.env')} — copy .env.example and fill it in`
    );
  }
} else if (!token.startsWith('xoxb-')) {
  bad(
    `SLACK_BOT_TOKEN does not look like a bot token (starts "${token.slice(0, 5)}")`,
    'you want the Bot User OAuth Token from OAuth & Permissions, which starts xoxb-'
  );
} else {
  const { json: auth, headers } = await call('auth.test');
  if (!auth.ok) {
    bad(
      `Token rejected: ${auth.error}`,
      auth.error === 'invalid_auth'
        ? 'the token is wrong or was revoked — reinstall the app and copy it again'
        : 'see https://docs.slack.dev/reference/methods/auth.test'
    );
  } else {
    authOk = true;
    ok(`Token valid — workspace "${auth.team}", bot "${auth.user}"`);

    // 3. Scopes. Missing chat:write.public is the classic one: everything looks
    //    fine until the bot tries a channel it was never invited to.
    const scopes = (headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
    for (const need of ['chat:write', 'chat:write.public']) {
      scopes.includes(need)
        ? ok(`Scope ${need}`)
        : bad(
            `Missing scope ${need}`,
            'OAuth & Permissions -> Bot Token Scopes -> add it -> then REINSTALL the app'
          );
    }
  }
}

// 4. Channels — the real test is posting, since we intentionally do not request
//    the channels:read scope needed to look a channel up.
const configured = Object.entries(channels).filter(([, id]) => id);
if (!configured.length) {
  bad(
    'Neither SLACK_CHANNEL_US nor SLACK_CHANNEL_CA is set',
    'copy each channel ID from Slack: channel name -> View channel details -> bottom of the dialog (C...)'
  );
}
for (const [name, id] of Object.entries(channels)) {
  if (!id) {
    skip(`SLACK_CHANNEL_${name} not set (that channel just gets no alerts)`);
    continue;
  }
  if (!/^[CG][A-Z0-9]{6,}$/.test(id)) {
    bad(
      `SLACK_CHANNEL_${name}="${id}" is not a channel ID`,
      'it must be the ID like C09ABCDEFGH, not the name "#usa"'
    );
    continue;
  }
  if (!authOk) {
    // Don't re-report the token failure once per channel.
    skip(`SLACK_CHANNEL_${name}: looks well-formed, untested until the token works`);
    continue;
  }
  const { json } = await call('chat.postMessage', {
    channel: id,
    text: `NewGradNotifier setup check — ${name} channel is wired up correctly. You can delete this message.`,
    unfurl_links: false,
  });
  if (json.ok) ok(`Posted a test message to SLACK_CHANNEL_${name} (${id})`);
  else
    bad(
      `Cannot post to SLACK_CHANNEL_${name}: ${json.error}`,
      {
        channel_not_found: 'wrong ID, or the channel is in a different workspace than the app',
        not_in_channel: 'add chat:write.public and reinstall, or /invite the bot to that channel',
        is_archived: 'the channel is archived',
        missing_scope: 'add chat:write to Bot Token Scopes and reinstall',
      }[json.error] || 'see https://docs.slack.dev/reference/methods/chat.postMessage'
    );
}

console.log(
  failed
    ? `\n\x1b[31m${failed} problem(s).\x1b[0m Fix the above, then run \`npm run doctor\` again.\n`
    : '\n\x1b[32mAll good.\x1b[0m Seed state with `npm run bootstrap`, then push and enable Actions.\n'
);
process.exitCode = failed ? 1 : 0;
