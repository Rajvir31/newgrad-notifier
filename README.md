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
src/test.js      self-check (node src/test.js)
```

## Setup

**1. Slack app.** api.slack.com/apps → Create New App → From scratch → pick your
workspace. Under *OAuth & Permissions* add the bot scopes `chat:write` and
`chat:write.public` (the second one lets the bot post to public channels without
being invited). Install to Workspace, copy the `xoxb-…` token.

Leave *Interactivity* switched **off**. The Apply button is a plain URL button
and still navigates fine; turning interactivity on without a Request URL means
clickers get an error.

**2. Channels.** Create `#usa` and `#canada`, then copy each channel ID from
*View channel details* (bottom of the dialog, `C…`).

**3. Repo config.** Settings → Secrets and variables → Actions:

| Where | Name | Value |
| --- | --- | --- |
| **Secrets** tab | `SLACK_BOT_TOKEN` | `xoxb-…` |
| **Variables** tab | `SLACK_CHANNEL_US` | `C…` for #usa |
| **Variables** tab | `SLACK_CHANNEL_CA` | `C…` for #canada |

The channel IDs go in *Variables*, not Secrets, on purpose: they are not
sensitive, and Actions masks secret values everywhere they appear, so as secrets
the logs read `posted 3/3 to ***` — redacting the one field you need when
delivery breaks.

**4. Make the repo public.** Not optional — 144 runs/day is roughly 4,320 runs a
month, which blows the 2,000-minute GitHub Free allowance for a private repo.
Public repos get free runner minutes. Nothing secret is committed; the state file
holds truncated hashes, not job data.

**5. Seed the state**, so the first run does not fire 350 backlogged roles:

```bash
npm run bootstrap    # records what is currently open, posts nothing
git add data/seen.json && git commit -m "seed" && git push
```

Then enable Actions. `npm run dry` prints what *would* be posted without sending
or saving anything.

**6. Landing page** (optional). `public/index.html` deploys to Vercel as-is.
Put your Slack shared-invite link in `vercel.json` under the `/join` redirect —
a Slack invite link expires after **30 days or 400 people**, so keeping it in one
redirect means rotating it without touching the page.

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

Current volume: ~11k postings scanned per poll, ~27 new-grad SWE roles per day.

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
- **Total failure has to be loud.** If every post fails, or a third of the feeds
  fail, the run throws — a failing scheduled workflow emails you, which is the
  only free monitoring available here.
