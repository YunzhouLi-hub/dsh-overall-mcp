# Engineering record

The round-by-round reasoning behind what the plugin does: what each change cost, what was measured, and which alternative was rejected. The README states the behaviour; this file states how it got there. Kept out of the README so a reader who only wants the feature list is not walked through the debate.

(moved out of the README, kept in round order)

## Identity line and action log (round 18)

Host plugin code is loaded **once, at DSH startup**, and no version number can answer "which code is this panel running". The header's second line now reads `GET /status`: `plugin v0.5.0 · pid 4242 · up 3h 12m · 5 data files · 2 log lines`. `/status` separates three groups because they fail differently — `plugin` (id/version from `package.json`/directory actually loaded/`loadedAt`, plus each source file's `mtime` and size and a `stale` flag when disk is newer), `host` (pid, startedAt, uptime, node, electron, platform, arch) and `data` (the directory, every file's bytes and time, plus `census`/`evidence`/`quota`/`errors`). When `stale` is set the header draws `⚠ code updated, restart DSH` — that state and "the bug is still there" look identical otherwise.

`GET /events?limit=` reads the tail of `events.ndjson` (default 100, max 500, oldest first, with `total` and `damaged`). It records **actions, not conversations**: which source answered how many rows in how long, quota exhaustion, scan results, census progress, install/mount outcome, registry repair. Only metadata — server names, source ids, counts, durations, error text — and never a credential. An older host without the route says so instead of pretending "nothing has been recorded this run".

Implementation choices (`lib/events.js`): a failed log write must never fail a scan or an install (no sink = no-op, sink errors swallowed, appends serialised, failures return `null`); the log is bounded to 400 lines / 256KB with a leading `{"kind":"log","action":"trim"}` line naming what was dropped; a field over 600 characters truncates, an array over 20 items folds to a count, and an unserialisable line is itself recorded; the renderer appends unknown fields as `key=value` so a newer host's extra field is still visible to an older panel.


## GitHub credentials and census resume (round 19)

The census (repository discovery plus install-command recovery) always worked anonymously; this round makes it finish, and much faster with a token.


### Where credentials come from

Five levels, and **only a validated token becomes active** — a mistyped token would turn every request into a 401, which is worse than anonymous:

| Order | Source | Notes |
|---|---|---|
| 1 | a token pasted in the panel | `$DSH_HOME/overall-mcp/github-auth.json`, mode `0600`, temp file + `rename` |
| 2 | `DSH_GITHUB_TOKEN` | host process environment |
| 3 | `GITHUB_TOKEN` | conventional environment variable |
| 4 | `gh auth token` | no need to paste again if GitHub CLI is already logged in (finds `gh.cmd` on Windows) |
| 5 | anonymous | the final fallback when none of the above works |

The card shows the active source, the masked token (`ghp_ab…6789`), the login, the remaining budget (`4999/5000`) and the next reset, with buttons for *use my GitHub login*, *enter a token*, *clear*, *re-check*. `gh` is invoked **only** when you press that button, never at startup.


### Why not the OAuth device flow

A device flow needs a client_id **belonging to the registrant**: it is printed in the code, anyone could reuse it elsewhere, and this plugin neither holds nor forwards anyone's third-party application identity. `gh auth token` is an honest reading of "a human already logged in on this machine" without keeping credentials for them.


### The token only goes to GitHub

Credentials **never leave `lib/github-auth.js`**: callers get a mask, a login and a budget, and the only code that sees the plaintext is `withGithubAuth(url, headers)`, which applies a **host allowlist** — only `api.github.com` and `raw.githubusercontent.com` receive `Authorization`. The plugin also talks to Docker Hub, npm, PyPI, Smithery and the official registry, and sending a GitHub token there would hand a credential to a third party.


### The census no longer dies on one network failure

The walk used to `break` on the first failure. The live log showed **260 requests / 124 seconds covering 77 of 2,111 rows (3.6%)**, ending with "request 260 failed: fetch failed" — the other 2,034 rows were never attempted. Now network errors, upstream 5xx and rejections (403/429) are **retried per repository** (2 attempts, backoff from 400ms doubling to 5s, and the pre-retry wait skips that repository's next throttle window), the walk gives up only after three consecutive rejections, and the report carries `{requests, planned, attempted, remaining, retries, partial}` so `/status`, `/events` and the panel can say "3 repositories planned, 1 attempted, 2 remaining, 2 retries" instead of "failed". **Resume already existed** — the next census only selects rows with no evidence or stale evidence — so re-running continues from the breakpoint; this round explains why it broke. A 401 from the upstream drops the token and returns to anonymous immediately, recording one log line, and the walk continues.


### Anonymous is not crippled, only slower

Anonymous `search/repositories` allows **10 requests/minute** and the core API **60/hour**; with a token that becomes 30/minute and 5,000/hour. Fetching repository files over `raw.githubusercontent.com` works anonymously too, with a tighter budget. The panel therefore says "anonymous: paste a GitHub token below to raise the limit from 60/h to 5,000/h", not "sign-in required".


## Census: start it and stop it (round 22)

The census used to have exactly one trigger — somebody browsing the GitHub source after the cached index went stale — and **no way to stop it short of restarting DSH**: the abort handle existed (plugin disposal used it) but nothing called it. One round of discovery is 6.5s per request, up to 48 requests, so "stop it" mattered.

`GET|POST /census` is the new surface. `GET` reports status and triggers nothing (the index is a local file — reading it costs no request). `POST {"action":"start"}` walks now instead of waiting for the cache to expire; if a walk is already running it does not start a second one (`started:false` with `walking:true` is the honest answer), and while the search budget is still recovering it declines with `skipped:'quota'` plus `waitMs` rather than spending a request to collect a 403. `POST {"action":"stop"}` aborts the run in flight.

Stopping is safe by construction: rows are written to `github-index.json` as they arrive (marked `complete:false`, `partial: "fetching (N rows so far)"`), so nothing already collected is lost and the next `start` resumes from the missing repositories. The in-flight throttle wait is interruptible too — the plugin passes its own `sleep` into `crawlGithubRepos`, so stopping takes effect immediately instead of after the current 6.5-second gap. A run that was stopped **does not** go on to crawl install evidence (`maybeCrawlInstallEvidence` only fires on a natural finish): if you pressed stop, the plugin should not keep spending budget elsewhere.

`/status` and `/census` share one `censusState()`: `rows`/`at`/`complete`/`partial`/`requests` from the index file, `walking`/`progress` that only the running process knows (the file says "fetching", never "request 12 of 48"), and `ended: {reason, at}` recording **who** stopped it (`user` or `dispose`). That last field exists because `crawlGithubRepos` itself can only report "aborted" — distinguishing "I pressed stop" from "the plugin was unloaded" is knowledge only the host has, so the host writes it down.

In the panel, the GitHub access card on the *Registered* tab carries the state line (rows, when it last read, who stopped it) and swaps its verb with the state: *start census* when idle, *stop census* with live progress while walking. An unknown verb (`{"action":"stpo"}`) is a **400**, not a state read-back that would look like success to the caller.


## Install-command recovery: start it and stop it (round 23)

The same card carries a **second walk**. Round 22 gave the census its own verbs; the walk that reads repository evidence to recover install commands still started by itself whenever the market page opened and could only be ended by unloading the plugin — and a full pass is 150ms per repository across more than two thousand of them (up to 6000 requests / 25 minutes). The census answers "which MCP servers are on GitHub"; this walk answers "how do I install them", and it had no button.

`GET|POST /install-evidence` is the surface. `GET` reports status and triggers nothing. `POST {"action":"start"}` begins a pass or resumes the stopped one; `{"force":true}` skips the freshness check (without it, a pass that is still fresh answers `skipped:'nothing-to-do'`, and a machine with no index yet answers `skipped:'no-census'` — neither is an error). A `POST` **without** an `action` still means *start*, because that is what the market page has always sent when it opens. `POST {"action":"stop"}` aborts the run in flight and records `ended:{reason:'user'}`; with nothing running it answers `stopping:false`, which is "there was nothing to stop", not a failure.

Stopping happens **between two requests**, not after two thousand: the walk checks its stop handle before each repository and threads the `signal` down through `readRepoFile`/`fetchText`, so the repository being read finishes and then the walk puts its pen down. Recovered commands are already on disk (`partial` says where it stopped: "stopped by hand (tried 78 repositories, continues next time)"), so a stop loses nothing and the next `start` resumes.

`progressOf(id, kind)` in `lib/repo-install.js` lets the loop record which repository is being read and how many have been tried, so progress is reported against **the walk's own plan** (`tried 78 / 2.1k repositories`) rather than a flat "fetching". `/status` and `/install-evidence` share one `evidenceState()`: file facts (`rows`/`withCommand`/`requests`/`partial`/`plan`) plus what only the process knows (`walking`/`progress`), and `ended.reason` again distinguishes `user` from `dispose`.

In the panel, a second line sits under the census line and swaps its own verb with its own state: *resume recovery* while rows are left (the walk skips what it already tried), *stop recovery* with live progress while it runs. The two lines keep separate verbs because the two walks share no budget and no clock — calling both of them "census" is exactly how a reader came to press the wrong button. The line also states the unfinished pass (`not finished: stopped at 900 rows: …`), which is the reason the verb is worth pressing.

Reading never changes state: `GET /census?action=…` and `GET /install-evidence?action=…` are both a **400** (`action must be sent as a POST`, a new `lib/http-status.js` rule), and so is an unknown verb (`unknown evidence action`). An innocent prefetch should not be the difference between a running recovery and a stopped one.


## The local census is a source you can read (round 24)

Rounds 22 and 23 handed the reader the verbs for both walks. What was still missing was the cheapest thing of all: **looking at the index they built**. The market page had one GitHub source, and it already read the local census file — so "I just asked GitHub" and "I am reading the list this machine already has" looked identical in the panel, even though the second one costs nothing.

`/catalog?source=census` is that view, and it is a **view, not a seventh source**. `lib/catalog.js` exports it as `CENSUS_SOURCE`; `browseCatalog` normalises the pass to `github-mcp`, so counts still land in the one `github-mcp` key and the reply carries `aliasOf:'github-mcp'` only to say "these rows were borrowed". The reason is arithmetic, not taste: those ~1.8k rows were already counted as `github-mcp`, so a source of its own would make "N total" count them twice — and the source list is a public contract. **One upstream, one number** still holds.

The view reads the index and **spends nothing**. With `indexOnly` set, `fetchGithubMcp` takes the index branch and returns immediately: with no index yet it answers "no census index on this machine: start one from the GitHub access card and this will read it directly, spending no requests", and it never falls through to the "index is old, walk it while I am here" path — under the view `githubWalk` is pinned to `null`. An index older than 24 hours only decides whether it is *marked* old, not whether it can be read: looking at a list must not turn into up to 48 requests.

In the panel the filter offers *local census (index)* right beside *GitHub* (same dropdown; `MARKET_SOURCES` is untouched because those are the count keys), and the numbers line is relabelled by the choice — `local census (index) 1.8k` instead of `GitHub 1.8k`. The number does not move: the name comes from the option's own label, so the filter and the line cannot drift apart. Cache entries are separate too (the key gains a `|census` suffix), so reading the view and then GitHub cannot pass one off as the other. The view changes no state at all: it starts no census, advances no recovery walk, and does not count as "somebody looked at GitHub".

Command line equivalent: `POST /catalog {"source":"census","query":"filesystem","limit":50}` — same `aliasOf`, `transient` and `counts` the panel sees.


## Interface accuracy and concurrency (round 20)

Six places where the interface said something the host was not doing. None of them broke usability; all of them made a number or a time mean something other than what it appeared to.

1. **Group switches and startup mounts are bounded-concurrent.** A mount spawns a subprocess and completes a handshake (8s cap), and the serial loop's worst case was `members × 8s` — measured on 2026-10-16: a five-member group switch sat at "switching…" for 40 seconds. `CONNECT_CONCURRENCY = 4` runs in flight (`mapLimited`, order-preserving because the client reads results by array index) and `connectEnabled`, the group switch and the post-scan connect all share it. This also removed a false assertion: duplicate same-name rows used to each attempt a mount, and the loser's name conflict was recorded as "provided by another mcp-client", which reads like a host fault. Now **each name mounts once**, same-name siblings share the first row's verdict, and a failure is recorded only on the row that actually attempted the mount.
2. **Per-source counts use the same ruler as the total** (`counts` is post-merge, `deduped` is reported).
3. **The two "updated at" times are separated**: the listing's read time is `listing read at`, a repository's last push is `upstream updated`, and each tooltip says which clock it is.
4. **`installed` has one meaning** (`server` is the name, `installed` is always a boolean).
5. **"No usage data" is stated** on cards sorted by usage instead of silently falling back to quality.
6. **Inferred categories say "(inferred)" everywhere** — the card tooltip already did, the detail panel and the category dropdown did not, so the same inference became a fact when read elsewhere.


## Per-source budgets (what one browse actually costs)

| Source | Requests | Rows read | Notes |
|---|---|---|---|
| Official Registry | 8 | 800 (~220 servers after dedup) | 100 per page, `nextCursor`, dedup by `isLatest` |
| Smithery | 1 | 10 | the upstream list itself returns ten |
| Docker MCP Catalog | 3 | 300 | paging until `next` is empty; anonymous stops at page one with a note |
| GitHub MCP | 3 | 300 → top 200 | the budget is counted in **requests**, not pages, because anonymous search allows 10/minute. **0 requests** when a census index exists, and **0 requests** while the search quota is spent or while the background census is walking |
| Awesome remote | 1 (+mirror chain) | 1,000 | single README, 928 lines measured |
| Awesome list | 1 (+mirror chain) | 5,000 | single README, **4,224** lines measured |
| Census (background) | ≤48 per round, every 24h | index ≤ 20,000 rows | 6.5s per request, ≤10 pages per query, ≤8 windows, stars ≥100; progress written every 5s |
| Install evidence (background) | ≤6,000 per round | one command per row | reads `package.json`/`pyproject.toml`/`server.json`/README over raw.githubusercontent.com at 150ms, plus npm/PyPI existence checks; 25-minute cap |

A default browse is about 18 upstream requests (~3 of them GitHub, **0 with a local index**) and aggregates **5,364 deduplicated MCPs**. Most repeat browses are `304`s, and a second browse inside 60 seconds sends nothing at all. Both READMEs must be read whole: 200 rows and the full listing cost the same single request, and truncating them to 200 is exactly why the market once showed only 551 entries.
