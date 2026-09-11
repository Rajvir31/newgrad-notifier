# NewGradNotifier

New-grad SWE postings pushed to Slack. 43 company ATS boards are read directly on
a 10-minute cycle; a 2,800-role aggregator backstops everyone else within the hour.
Two channels (🇺🇸 USA / 🍁 Canada), no duplicates, no email.

The poller runs on GitHub Actions every 10 minutes, diffs what it finds against a
committed seen-set, and posts anything new to Slack. There is no server, no
database and no paid dependency.

```
src/sources.js   fetch + normalize every feed
src/filter.js    is it new-grad? is it SWE? which channel? US-eligible?
src/description.js  on-demand job description text (sponsorship/clearance)
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


## If the schedule never fires — or barely fires

GitHub's scheduler is best-effort, and it fails in two different ways.

**It never starts.** On a brand-new repo the schedule sometimes never fires at
all. Symptom: `workflow_dispatch` works perfectly, `schedule` produces zero runs
for hours. Check with:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/actions/runs?event=schedule" | grep total_count
```

**It fires, but nowhere near the interval you asked for.** This is the common
one, and it is easy to miss because the workflow reports success every time.
Measured on this repo over 4.7 days against a 10-minute cron:

| | |
| --- | --- |
| Requested | 144 runs/day |
| Delivered | **7.7 runs/day — 5.3% of slots** |
| Shortest gap observed | **101 min** (never once close to 10) |
| Median gap | 183 min |
| Worst gap | 343 min |

A hard floor of ~101 minutes across 36 runs is not random slot-dropping, it is
rate limiting. Measure your own rather than assuming a number:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/actions/workflows/poll.yml/runs?per_page=100" \
  | grep -o '"created_at":"[^"]*"'
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

If all of those are clean and it still under-delivers, you have hit undocumented
behaviour. It is widely reported (GitHub community discussions #201436, #203822)
and **has no known fix from inside the cron expression.**

Do not keep editing the cron to try to force it. Each edit is an unverified
attempt at re-registration and may restart whatever internal clock exists.

There are two mitigations, and they compose.

### 1. Loop inside the run (already on, no setup)

A schedule-triggered run keeps polling for `POLL_LOOP_MINUTES` (default 40)
instead of exiting after one pass, committing state after each one. A 40-minute
window at 10-minute intervals is 4 passes, so the observed 7.7 runs/day becomes
~30 polls/day — with no external dependency and no token anywhere.

It applies to `schedule` only. A `workflow_dispatch` — the external cron below, a
manual kick, or a replay — always does exactly one pass, so the two mechanisms
never fight each other.

This is a floor, not a fix: it cannot beat the interval it loops at, and it holds
a runner for 40 minutes at a time (free on a public repo, and another reason this
repo must stay public).

### 2. Drive it from a clock you control (real 10-minute polling)

`workflow_dispatch` is not throttled, so point a real cron at it and leave the
`schedule:` block in as a backstop — if it fires too you just get an extra run,
which the seen-set already dedupes.

**1. Make a fine-grained PAT** at github.com/settings/personal-access-tokens/new
- Repository access: **Only select repositories** → this repo
- Permissions: **Actions → Read and write** (nothing else)
- Set an expiry, and a calendar reminder to rotate it

The blast radius if this token leaks is "a stranger can trigger your job
poller". It cannot read your Slack token, which stays in Actions secrets.

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

**4. Turn the loop off** once that is confirmed working: set the
`POLL_LOOP_MINUTES` repository variable to `0` (Settings → Secrets and variables
→ Actions → Variables). Otherwise a 40-minute scheduled loop holds the
concurrency group and your 10-minute dispatches queue up behind it.

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
- **US sponsorship / clearance gate** — `usEligibility` in `src/filter.js`. A
  US-routed role is dropped only when the posting EXPLICITLY says it will not
  sponsor, requires US citizenship, or requires a security clearance. Silence
  includes the job, and so does a description that could not be fetched — a
  scrape failure must never silently hide a role. Canadian routing is untouched:
  a role open in both countries that fails the US gate still goes to #canada.
  Remove the `usEligibility` block in `src/poll.js` to turn it off.
- **Recovering a suppressed backlog** — `npm run replay`, or the workflow's
  "Run workflow" button with `replay` ticked. `--bootstrap` and the first run
  both write state WITHOUT posting, so everything open at that moment is
  retired unannounced; the seen-set alone has no way back. Queue the ids to
  re-announce in `data/replay.json` (12-hex `sha256(id)` prefixes, the same
  form as `data/seen.json`) and the replay run posts them regardless of the
  seen-set, skipping the burst guard. It sends at most `REPLAY_BATCH` per run
  and retires only what actually went out, so a large backlog drains over
  several runs and an interrupted one resumes instead of duplicating. A run
  that matches nothing leaves the queue untouched rather than clearing it.
- **Volume knobs** — `MAX_AGE_DAYS` (ignore postings older than this, default 3;
  override with the env var of the same name), `MAX_BURST` (if a poll finds more
  than this, seed instead of posting — a feed changing shape should not spam the
  channel), `MAX_SEEN` in `src/poll.js`.
- **Freshness** — `MAX_AGE_DAYS` is measured from the COMPANY's posting date,
  not from when the poller first saw the row, and that distinction is the whole
  point. See "An aggregator surfaces old postings as new" below.
- **How often it actually polls** — the `POLL_LOOP_MINUTES` repository variable
  (default 40). GitHub delivers only ~5% of a 10-minute cron's slots, so a
  schedule-triggered run polls repeatedly for this many minutes instead of
  exiting after one pass. Set it to `0` if you wire up an external cron, and see
  "If the schedule never fires — or barely fires" above.

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
  CIBC's *campus* board is early-talent scoped but not technical, and is no
  exception: unsearched, 24 of its 24 Canadian postings are investment-banking
  analyst reqs.
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
- **A city name with no state code has to route too.** There was a `CA_CITY`
  list but no US equivalent, so "San Francisco", "Seattle" and "Austin" returned
  UNKNOWN, `channelsFor` returned `[]`, and a channel-less job is seeded as
  *decided* — dropped forever with no retry. Stripe's "Software Engineer, New
  Grad" lists exactly `San Francisco, Seattle, New York` and was lost that way
  every single poll. `US_CITY` is checked LAST, after the Canadian and
  non-North-American tests, and omits every name shared with a Canadian or UK
  city so the ambiguous cases keep resolving the safe way.
- **An aggregator back-fills.** Simplify's `date_posted` is when the *company*
  posted, not when the row appeared in the feed. "Framatome — Computer Science
  Engineer 1" was posted Aug 31 and only edited into the feed on Sep 9, so it
  alerted 9 days "late" while the poller in fact reacted 28 minutes after the
  row changed. Measured over a week: 79% of alerts are under a day old and 8%
  are 3+ days stale, all of them Simplify back-fill. Direct ATS boards do not
  have this problem, which is the argument for adding companies to `BOARDS`.
- **Scheduled Actions drift far more than "drift" suggests.** The docs say
  schedules "can be delayed during periods of high loads" and may be dropped,
  which reads like the occasional missed tick. Measured here it was 5.3% of
  slots delivered — 7.7 runs/day against 144 requested, with a hard floor of 101
  minutes between runs that no cron edit moves. Budget for *hours* of latency
  from GitHub's clock, not minutes, and drive `workflow_dispatch` externally if
  that matters. The poller is idempotent, so a missed tick only costs latency.
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
- **A category tag is worse than useless — it was removed as a signal.** Simplify  filed "Broista", "Barback", "Sales Associate", "Customer Service
  Representative" and dozens of pricing/BI/marketing analysts under
  `category: "AI/ML/Data"`, and a real "Software Engineer - Crypto and Cross
  Domain Solutions" under `"Hardware"`. Treating the category as an outright pass
  made 174 of 382 alerts non-software. Classification is now a title
  **allowlist**: a build noun (`engineer`, `developer`, `programmer`,
  `architect`) beside a software domain, or an unambiguous phrase like "Software
  Engineering"/"Programmer"/"SDE". A blocklist can only ever name the junk it has
  already seen.
- **`analyst` and `scientist` are not engineering nouns.** While they were,
  "2027 Investment Banking Analyst I - Energy, Infrastructure, & Transition" and
  "2027 Analyst I, Equity Solutions Group" qualified as software roles on the
  words `infrastructure` and `solutions` alone. `solutions` and `product` are out
  of the domain list for the same reason — at a chip maker "Product Engineer" is
  a hardware job. `sql` is in, so "SQL Server Developer" survives.
- **A title can name the language instead of the domain.** "Java Developer",
  ".Net Developer", "Graduate C++ Developer" carry a build noun and no domain
  word at all, so a domain-only allowlist rejects every one of them. `c++` and
  `c#` also cannot live inside a `\b(...)\b` alternation — the trailing `\b`
  after `+` demands a word character — which is why `SOFTWARE_LANG` is separate.
- **Seeding without posting is a one-way door — until it isn't.** `--bootstrap`
  and the `seen.length === 0` first run both retire every currently-open role
  unannounced, and the burst guard does the same to any poll over `MAX_BURST`.
  That is correct for a backlog and catastrophic for a real batch: a local
  bootstrap on day one swallowed 138 open software roles, including Stripe's
  "Software Engineer, New Grad", with no way to get them back. `data/replay.json`
  plus `--replay` is that way back — and it must never clear the queue on a run
  that posted nothing, or the recovery tool reproduces the bug it exists to fix.
- **An aggregator surfaces old postings as new.** Simplify's `date_posted` is
  honest — checked against the companies' own `first_published` / JSON-LD
  `datePosted`, 103 of 104 sampled alerts matched to the day. What drifts is
  WHEN THE ROW APPEARS: median 0.9 days after the company posted, p90 6.5 days,
  measured max 6.8. A row that shows up a week late is brand new to the seen-set
  diff, so it was announced as news — and the alert landed for a job posted the
  previous week. That is a freshness problem, not a date-accuracy problem, and
  no amount of polling faster fixes it.

  The fix is `MAX_AGE_DAYS`, measured from the company's date. At 3 days it
  keeps 97% of real alert volume (157 of the last 162) and drops exactly the
  stale tail. Two consequences worth knowing:
  - A posting that ages past the window during an outage is skipped
    **permanently** — the seen-set never learns it existed. Raise the window
    before any planned downtime longer than it.
  - `--replay` deliberately ignores the window. A backlog is old by definition,
    so applying it there would match nothing and the queue would never drain.
- **Direct ATS boards do not have this problem.** Greenhouse's `first_published`
  is a true first-publish timestamp and Ashby/Lever/Workday all reflect the
  company board immediately. Every company moved from the aggregator into
  `BOARDS` is one whose postings arrive the day they go live — which is the
  structural fix for latency, and the argument for growing that list.
- **Assigning `.href` does not neutralize a `javascript:` URL.** Apply links come
  from third-party boards; the UI checks the scheme before making one clickable,
  and the poller drops non-http(s) URLs before that.
- **Sponsorship and clearance text is full of traps.** Both statements only ever
  appear in the description body, so `src/description.js` fetches it on demand —
  and the naive regex over that text is wrong in four separate ways, each found
  by harvesting real postings rather than guessing:
  - **The application form is not the job description.** A scraped board page
    carries both, and Greenhouse's form asks "Will you now or in the future
    require sponsorship for employment visa status (e.g., H-1B)?" — a question
    put to the candidate, not a policy. Interrogatives are dropped, and the
    Greenhouse API's `content` field is preferred precisely because it excludes
    the form.
  - **"sponsor" usually is not about visas.** JHU APL writes about "government
    sponsors" and "the research sponsor"; Prelim advertises "a sponsored 401K".
    The word only counts next to visa/immigration/work-authorization language.
  - **Page chrome scrapes as content.** Huntington Ingalls' careers page yields
    the literal text "Clearance Required All" — from a search filter dropdown.
    schema.org JSON-LD is preferred over stripping the document for this reason.
  - **Punctuation carries meaning.** Splitting sentences on ":" severed CACI's
    "Minimum Clearance Required to Start: None" and inverted it into a
    requirement; splitting on "." severed "U.S. Citizenship is required" into
    "U." / "S." / "Citizenship is required". Neither could then be matched.
- **Greenhouse returns `content` entity-escaped.** `&lt;p&gt;`, not `<p>`. Strip
  tags before decoding entities and the decode re-creates literal markup in the
  output — and, worse, `</p>` never becomes a sentence break, so the whole
  posting collapses into ONE sentence and a negation in one bullet binds to
  "sponsorship" in a distant one. `htmlToText` runs strip-then-decode twice.
- **Greenhouse has regional domains.** IMC posts on `job-boards.eu.greenhouse.io`;
  a pattern anchored to `<sub>.greenhouse.io` silently skips them.
- **iCIMS refuses programmatic reads.** `careers-*.icims.com` answers HTTP 405 to
  any GET regardless of headers, which covers General Dynamics, Peraton and
  Framatome. Simplify's own curated `sponsorship` field is the only signal left
  for those, and it is authoritative — but set on barely 100 of 20,000 rows, so
  it supplements the scrape rather than replacing it.
- **Total failure has to be loud.** If every post fails, or a third of the feeds
  fail, the run throws — a failing scheduled workflow emails you, which is the
  only free monitoring available here.
