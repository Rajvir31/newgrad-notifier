# NewGradNotifier

New-grad SWE postings pushed to Slack. 43 company ATS boards are read directly on
a 10-minute cycle; a 2,800-role aggregator backstops everyone else within the hour.
Two channels (🇺🇸 USA / 🍁 Canada), no duplicates, no email.

The poller runs on GitHub Actions every 10 minutes, diffs what it finds against a
committed seen-set, and posts anything new to Slack. There is no server, no
database and no paid dependency.

```
src/sources.js   fetch + normalize every feed
src/filter.js    is it new-grad? is it SWE? which channel?
src/slack.js     Block Kit + rate-limited delivery
src/poll.js      orchestration + seen-state
src/ui.js        local dashboard server
src/doctor.js    setup checker (npm run doctor)
public/app.html  the dashboard itself
src/test.js      self-check (node src/test.js)
```

## Just want to browse the jobs?

```bash
npm run ui        # http://localhost:8787, opens your browser
```

No Slack, no secrets, no setup — it fetches all 44 feeds and gives you a local
board: search, filter by US/Canada, filter by age and source, and mark roles as
applied (kept in the browser, so it survives reloads). Refresh re-polls.

Served over HTTP rather than opened as a `file://` page because Chrome gives
`file://` an opaque origin where `localStorage` throws — and `localStorage` is
what remembers what you have applied to.

The Slack setup below is only needed if you want to be *pushed* new roles rather
than checking the board yourself.

## Setup (Slack alerts)

Only needed if you want roles *pushed* to you. The board above works without any
of this.

**1. Workspace.** If you don't have one to use, make a free one at
slack.com/get-started (a personal workspace is fine). Create two channels:
`#usa` and `#canada`.

**2. App.** api.slack.com/apps -> Create New App -> From scratch -> name it,
pick your workspace. Then *OAuth & Permissions* -> Bot Token Scopes -> add both:

    chat:write          post messages
    chat:write.public   post without being invited to each channel

Scroll up, *Install to Workspace*, authorize, and copy the **Bot User OAuth
Token** — it starts `xoxb-`. (The one starting `xoxp-` is a user token; wrong one.)

Leave *Interactivity* **off**. The Apply button is a plain URL button and works
fine; switching Interactivity on without a Request URL makes clickers see an error.

**3. Channel IDs.** In Slack, click the channel name -> *View channel details* ->
the ID is at the very bottom of that dialog, like `C09ABCDEFGH`. Not the `#name`.

**4. Test it locally first.** Create a `.env` in the repo root (already gitignored):

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_CHANNEL_US=C09ABCDEFGH
SLACK_CHANNEL_CA=C09ZYXWVUTS
```

```bash
npm run doctor
```

It checks reachability, the token, both scopes, and posts one real test message
to each channel. Every misconfiguration here fails *silently* in production —
Slack answers HTTP 200 on a dead token — so get a clean run before going further.

**5. Seed the state**, or the first live run fires ~370 backlogged roles at once:

```bash
npm run bootstrap    # records what is currently open, posts nothing
```

**6. Push to GitHub, public.** Not optional: 144 runs/day is ~4,320 runs a month,
which blows the 2,000-minute Free allowance on a private repo. Public repos get
free runner minutes. Nothing secret is committed — the state file holds truncated
hashes, not job data, and `.env` is ignored.

```bash
gh repo create newgrad-notifier --public --source=. --push
```

**7. Repo config.** Settings -> Secrets and variables -> Actions:

| Where | Name | Value |
| --- | --- | --- |
| **Secrets** tab | `SLACK_BOT_TOKEN` | `xoxb-…` |
| **Variables** tab | `SLACK_CHANNEL_US` | `C…` for #usa |
| **Variables** tab | `SLACK_CHANNEL_CA` | `C…` for #canada |
| **Variables** tab | `SLACK_MENTION` (optional) | `U…` your member ID |

The channel IDs go in *Variables*, not Secrets, on purpose: they are not
sensitive, and Actions masks secret values everywhere they appear, so as secrets
the logs read `posted 3/3 to ***` — redacting the one field you need when
delivery breaks.

**Getting actually notified.** A bot message in a channel does not necessarily
push-notify you — Slack has an account-level choice between "Everything" and
"Mentions and direct messages", and mobile settings are separate from desktop.
Two ways to be sure:

- Set both channels to **All new messages** (channel name -> Notifications), on
  desktop *and* in the mobile app; or
- Set `SLACK_MENTION` to your member ID (your avatar -> Profile -> the `...`
  button -> **Copy member ID**). Every alert then @-mentions you, which pings
  regardless of that preference. `npm run doctor` includes the mention in its
  test message, so you can confirm your phone buzzes without waiting for a real
  posting.

**8. Enable it.** Actions tab -> enable workflows -> *poll-jobs* -> **Run
workflow** to fire it once by hand. Check the log says `slack ok:` and
`posted n/n`. After that it runs every 10 minutes on its own.

**Then leave it alone**, except: a public repo's scheduled workflows are
auto-disabled after 60 days with no repository activity, and it is undocumented
whether the bot's own state commits reset that clock. Hit *Run workflow* once
every ~50 days, or push anything.

**Landing page** (optional). `public/index.html` deploys to Vercel as-is. Put
your Slack shared-invite link in `vercel.json` under the `/join` redirect — an
invite link expires after **30 days or 400 people**, so keeping it in one
redirect means rotating it without touching the page.


## If the schedule never fires

GitHub's scheduler is best-effort, and on a brand-new repo it sometimes never
starts at all. Symptom: `workflow_dispatch` works perfectly, `schedule` produces
zero runs for hours. Check with:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/actions/runs?event=schedule" | grep total_count
```

Every *documented* cause is easy to rule out, and worth ruling out before
assuming the worst — the REST API reports a distinct state for each:

| Cause | How to rule it out |
| --- | --- |
| 60-day inactivity auto-disable | workflow state would be `disabled_inactivity`, not `active` |
| Forked repo (disabled by default) | state would be `disabled_fork` |
| Wrong branch | schedules run **only** on the default branch, and the file must exist there |
| Under the 5-minute floor | anything ≥ 5 min is fine |
| Bad cron syntax | `-`, `,` and `/` are all documented operators; `3-59/10` is valid |

If all of those are clean and it still never fires, you have hit undocumented
behaviour. It is widely reported (GitHub community discussions #201436, #203822 —
same shape: new repo, manual works, schedule silent) and **has no known fix other
than waiting**, sometimes many hours.

Do not keep editing the cron to try to force it. Each edit is an unverified
attempt at re-registration and may restart whatever internal clock exists.

**The fix is to stop depending on GitHub's clock.** `workflow_dispatch` is proven
reliable, so drive it from a clock you control and leave the `schedule:` block in
as a backstop — if it ever wakes up you just get duplicate runs, which the
seen-set already dedupes.

**1. Make a fine-grained PAT** at github.com/settings/personal-access-tokens/new
- Repository access: **Only select repositories** → this repo
- Permissions: **Actions → Read and write** (nothing else)
- Set an expiry, and a calendar reminder to rotate it

**2. Verify the dispatch works** before wiring anything up:

```bash
curl -i -X POST   -H "Accept: application/vnd.github+json"   -H "Authorization: Bearer $GH_PAT"   -H "X-GitHub-Api-Version: 2022-11-28"   https://api.github.com/repos/<owner>/<repo>/actions/workflows/poll.yml/dispatches   -d '{"ref":"main"}'
```

Expect **HTTP 204 No Content**. A 404 here almost always means the token lacks
Actions:write, not a wrong path.

**3. Point a free external cron at that call.** cron-job.org is the lightest
option: free, 1-minute granularity, supports custom POST headers. Create a job
with method POST, the URL above, body `{"ref":"main"}`, and the three headers
from step 2. Treat 204 as success.

This replaces only the broken part. The poller, filtering, Slack delivery and
state all keep running on GitHub's runners exactly as before — and since the repo
is public, those minutes stay free.

Fully-off-GitHub alternatives, if you would rather not depend on it at all:
**Deno Deploy cron + Deno KV** is the best free one (1M requests and 10 CPU-hours
a month covers a 10-minute poll comfortably; state moves to KV). Cloudflare
Workers' free tier does **not** fit — 10 ms CPU per cron invocation, and this
parses ~10 MB of JSON. Vercel Hobby cron cannot do sub-daily intervals at all.

## Tuning

- **Companies polled directly** — `BOARDS` at the top of `src/sources.js`.
  Find a board token by loading the company's careers page and grepping for
  `greenhouse.io/<token>`, `jobs.ashbyhq.com/<org>`, `jobs.lever.co/<slug>`.
- **What counts as new-grad / SWE** — the regexes at the top of `src/filter.js`.
  After loosening either one, re-run `npm run bootstrap`, or the newly-matching
  backlog gets announced as new.
- **Volume knobs** — `MAX_AGE_DAYS` (ignore postings older than this),
  `MAX_BURST` (if a poll finds more than this, seed instead of posting — a feed
  changing shape should not spam the channel), `MAX_SEEN` in `src/poll.js`.

Current volume: ~10k postings scanned per poll in about 4 seconds, ~1,500 open
new-grad SWE roles in US/Canada, of which ~30 a day are new.

## Notes from building this

Things that cost real debugging time, recorded so they don't have to be
rediscovered:

- **Slack returns HTTP 200 on auth failure.** A dead token gives
  `200 {"ok":false,"error":"invalid_auth"}`. Code that checks the status code
  reports success while posting nothing, silently, forever. Branch on `ok`.
- **`chat.postMessage` allows 1 message/sec/channel**, and breaching it is
  user-visible ("some messages from your app are not being displayed"). Posts are
  paced 1.1s apart, per channel in parallel, and honour `Retry-After` on 429.
- **Ashby and SmartRecruiters return HTTP 200 for companies that don't exist** —
  an empty array, not a 404. Health checks assert a non-empty result.
- **Greenhouse ignores `?updated_after=`** silently rather than rejecting it, so
  every poll diffs the full list client-side.
- **Don't strip the query string off a Greenhouse `absolute_url`.** On some boards
  (Stripe) it's a generic search page and `?gh_jid=` is the only job identifier.
- **Workday needs both the right facet name and a `searchText`.** The facet name
  differs per tenant (`locationCountry` / `Country` / `Location_Country`) though
  the Canada country WID is identical everywhere; a wrong facet is a hard 400.
  Without a search term you get the newest 20 retail-banking roles and zero SWE.
- **SmartRecruiters was dropped** after measuring it: 1,255 postings across
  ServiceNow, Ubisoft and Bosch produced zero new-grad SWE roles, and its own
  "Early Career" field tags *Senior Staff Software Engineer* as early-career.
- **Company ATS boards list every open role**, so they need a *positive*
  new-grad signal. Only the SimplifyJobs feed is pre-curated; everything else is
  title-matched, or "Software Engineer, Database Infrastructure" at Stripe reads
  as a new-grad opening.
- **Location routing traps** covered by tests: Vancouver WA vs BC, Ontario CA
  (California) vs Ontario Canada, Waterloo IA vs ON, London UK vs ON,
  Richmond VA vs BC, Cambridge MA vs ON.
- **Scheduled Actions drift.** GitHub documents that schedules "can be delayed
  during periods of high loads" and may be dropped. The poller is idempotent, so
  a missed tick costs latency and nothing else.
- **Public repos disable scheduled workflows after 60 days of no activity.**
  It isn't documented whether the bot's own state commits reset that clock, so
  assume not: hit *Run workflow* manually every ~50 days.
- **A failed Slack post must not be marked seen.** The seed is built from what was
  actually delivered. Marking a job seen on a failed post suppresses it forever
  while the workflow still shows a green check — the worst failure mode this
  thing has, because nobody notices.
- **Jobs routed to an unconfigured channel stay unseen.** A mistyped
  `SLACK_CHANNEL_CA` would otherwise silently discard every Canadian role.
- **A transport error must cost one message, not the batch.** An uncaught `fetch`
  rejection escaped `Promise.all` and skipped the state save, re-posting
  everything already delivered on the next run.
- **The duplicate-collapse key is scoped to the destination channel.** Large
  employers open one requisition per city with an identical title — Stripe posts
  six "Software Engineer, New Grad" — and a channel-blind key collapsed all six
  into one, deleting the Toronto req from #canada.
- **Simplify rewrites titles.** Notion's board says "Software Engineer, Early
  Career (AI)"; Simplify calls the same posting "Software Engineer – Early
  Career - AI". Cross-source dedup has to key on the normalized apply URL, but
  must keep identifying query params — dropping `?gh_jid=` fuses Stripe's whole
  board into one job.
- **`staff` is not a seniority marker on its own.** "Member of Technical Staff"
  is the standard *entry* title at the AI labs.
- **A level token only counts at the end of a title.** `/(l|t)[4-9]/` anywhere
  rejected "Software Engineer, L4 Autonomy Team" and "Perception Engineer - T5".
- **A category tag is not enough on its own.** The aggregator files "Patient
  Coordinator" and "Dental Assistant" under `category: "Software"`, so there is
  an explicit non-technical blocklist. It is a blocklist rather than a
  requirement that every title contain an engineering noun, because that
  requirement also rejects real postings like "Software Development Graduate".
  `server` and `warehouse` are deliberately NOT on it — they would eat
  "SQL Server Developer" and "Data Warehouse Software Engineer".
- **Assigning `.href` does not neutralize a `javascript:` URL.** Apply links come
  from third-party boards; the UI checks the scheme before making one clickable,
  and the poller drops non-http(s) URLs before that.
- **Total failure has to be loud.** If every post fails, or a third of the feeds
  fail, the run throws — a failing scheduled workflow emails you, which is the
  only free monitoring available here.
