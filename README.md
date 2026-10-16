# dsh-overall-mcp

**A DeepSeek Harness plugin that scans every MCP configuration on the machine on first install and registers what it finds; aggregates six open MCP catalogs (5,364 deduplicated entries measured 2026-10) into one browsable, one-click-installable panel; and keeps a local census index of MCP repositories on GitHub (1,758 rows measured), recovering install commands from repository evidence and labelling each recovered command with where it came from.**

[简体中文](README.zh-CN.md) · this file is the English entry point; `README.zh-CN.md` is the full engineering record (per-round rationale, measurements, and the reasoning behind each decision).

## Features

| | Capability | What it does |
|---|---|---|
| 🔍 | Scan on first install | Discovers and registers every MCP server configured in Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Windsurf, Codex CLI and Gemini CLI |
| 🌐 | MCP market | Six sources aggregated in parallel — official Registry, Smithery, Docker MCP Catalog, GitHub MCP, Awesome remote, Awesome list — **5,364 entries measured**. Browse with no keyword, filter by source, search. (The GitHub source reads the local census index and makes **zero requests** when an index exists; rows without install data get a command recovered from repository evidence, with the source named.) |
| ⚡ | One-click connect | npm package → `npx -y <pkg>`, Python package → `uvx`, hosted endpoint → streamable-http, Docker image → `docker run -i --rm mcp/<name>`; listing-only entries offer their repository link |
| 🛠️ | Native tool bridge | Each enabled server is mounted as one `dsh-mcp-client` instance; its tools register as native DSH tools named `mcp__<name>__<tool>` |
| 🖥️ | Sidebar panel | **Global MCP**, directly under *Plugins*: a **Registered** tab (grouped by source, collapsible, per-group switch, status filters) and an **MCP Market** tab |
| 🎛️ | Per-group switches | One switch per source group enables/disables every server from that source (also available as `overall_mcp_set_source_enabled`) |
| ⬆️ | Version check and update | Checks npm/PyPI for servers launched through `npx`/`uvx` (including Windows `cmd.exe /c` wrappers); a green `Update all (N)` runs them with per-row progress, and turns into `✓ done` when the queue has answered every row |
| 🪪 | Identity line | The panel's second line says **which code this process is running**: plugin version, pid, uptime, readable data files, log lines. When the files on disk are newer than the process it adds `⚠ code updated, restart DSH` — "still broken" and "not loaded yet" stop being the same sentence (`GET /status`) |
| 🧾 | Action log | The host writes its actions to `events.ndjson` (browse/per-source outcome/quota/scan/census/evidence/install/update/mount/registry repair), expandable from the header. Metadata only, never secrets, last 400 lines |
| 🔑 | GitHub credentials and census resume | A token can be pasted in the panel (or taken from `gh auth token`); it takes effect only after validation and is sent only to GitHub hosts. **Anonymous still works** — the budget is just 60/h instead of 5,000/h. One network failure no longer ends a census (per-repository retry with backoff, stop after repeated rejections), and the next run resumes from where it stopped (`GET\|POST\|DELETE /auth`) |
| ⏯️ | Start and stop the census yourself | The GitHub access card on the *Registered* tab states where the census stands (how many rows, when it last read, who stopped it) and offers the verb that matches: *start* (no waiting for the cache to expire) or *stop* with live progress. Stopping is safe — rows are written as they arrive, the next run resumes from the missing repositories, and a stopped run will not spend budget on install evidence afterwards (`GET\|POST /census`, round 22) |
| 🧮 | Every number and time states its meaning | Per-source counts use the same ruler as "N total" (deduplicated, with `deduped` shown separately); "listing read at" is local read time while "upstream updated" is the repository's last push; when sorting by usage, a card with no usage data says so instead of silently sorting by quality; inferred categories carry "(inferred)" on the card, in the detail panel and in the category dropdown |

## Quick start

```sh
dsh plugin --profile web add ./dsh-overall-mcp
```

Restart the profile: the first load scans the host's MCP configs. The entry appears in the sidebar under **Plugins**.

The page is a **global panel** in the sidebar (not a setting, not a plugin config area): the rail icon is registered in the `sidebar.panellist` slot (`order: 5`, between the official Plugins page at 0 and Tasks at 10) and the panel itself in the layout's keyed `main` slot — both under the same id `overall-mcp`. A keyed slot rejects an unknown key, so the two strings must agree; `tools/client-smoke.mjs` pins them together. The page is its own scroll container (centred, 1180px max) with `--dsh-frame-top-clearance` on top so it does not hide under the macOS traffic lights or a Windows title bar.

### The Registered tab

- Header counts: `N servers · M enabled · K disabled · C connected · X connection errors`
- Filters: source, status (enabled/disabled/connected/error), name search
- Groups by import source, each with its count and enabled count, a group switch, and a clickable header to collapse
- Each row: status dot, name, **purpose line**, facts line (transport · status · tool count · tool prefix `mcp__<serverName>__` · package version), enable/disable, remove
- **One writer at a time, atomic writes, and tools that tell the truth (round 12).** Every "read registry → await (scan / spawn npx / query npm) → write back" action is queued on one promise chain, because two interleaved read-modify-writes lose the earlier change. The registry is written through a temporary file plus `rename` (it is the one file whose loss unmounts every server). A registry that fails to parse is no longer treated as a first run: the original is copied to `registry.json.corrupt-<timestamp>`, the panel shows a red line with the reason, and the file is never overwritten with an empty registry. A scan no longer clears favourites (the merge preserves the top-level keys it does not own), installing over a hand-written `source: manual` entry returns **409** unless `overwrite: true`, a failed mount reports `counted: false` instead of looking like success, and the group switch disconnects by name so it cannot take another source's same-named row with it.
- **Purpose lines (round 11).** The host picks one human sentence by **strength of evidence** (`lib/about.js`, clamped to 150 characters and two lines): the server's own `instructions` from the MCP `initialize` result (`source: 'server'`), else the tools it registered (`source: 'tools'`), else its launch command (`source: 'command'`). The origin is labelled in the line's `title`, and if all three are missing the line is omitted rather than invented. Because dsh-mcp-client publishes `instructions` only while the server is connected, "not found" is not cached as final: the host remembers the liveness at last read and re-assembles only when it flips.
- **Orphan rows.** The registry records the evidence of each scan (`registry.scanned`); rows no longer defined by any configuration file are marked `source deleted` with one "Clean up N" action (`POST /forget-orphans`). A row that currently holds a mount is never cleaned up, and a configuration that could not be read is not evidence of absence.

### The Market tab

- Opening it loads **the whole catalog** (~5.4k entries; ~3MB — the upstream cost of a slice is identical). Each source has a 60-second TTL and a manual **Refresh**.
- **Fetching is conditional.** Each upstream URL remembers its `ETag` and body; the next request sends `If-None-Match` and a `304` reuses the stored body **without re-parsing JSON**. Inside the TTL nothing is asked at all. The meta line states which happened: `listing read at 12:34:56 (cached) · 3 sources unchanged`.
- **A fetch failure keeps the previous listing** (marked `stale`, entries still usable) and still reports the error; only a cold-start failure reports empty.
- Total shown compactly (`5.3k available MCPs`, truncated rather than rounded, so the headline never exceeds the real count).
- **Sorting** (view-only, no upstream request): `Default (recommended)` and `Best quality` use the same weighted score (certified 400 > official 300 > installable 120, plus log10 popularity up to +200, deprecated −500); `Most used` sums Smithery calls + Docker pulls + this panel's installs (different units, and both the tooltip and the hint row say so); plus `Most stars`, `Recently updated`, `Name A→Z`. Missing numbers never sort last: rows with a number beat rows without, and both fall back to quality.
- **Paging** 20/50/100 with first/prev/next/last.
- **Categories** are a dropdown, not a chip row: 75 upstream `###` headings collapse into **19 functional groups** on the host; the upstream heading stays on the entry for provenance. Sources that publish no category at all (official Registry and Smithery publish none) are **inferred** by keyword — 78 of 100 sampled official entries and 10/10 Smithery matched — and the result carries `groupSource: 'inferred'`, labelled everywhere it appears. Unmatched entries honestly say `Uncategorised`, which means "we don't know", not "the upstream said so".
- **Ranks are visible**: with a non-default sort every card's footer starts with `#1 #2 #3…`, active controls get an inked border, and the meta line names the sort.
- **Cards** show icon, title-as-link, GitHub mark, version, badges, three-line description, tags, facts printed on the face (stars · usage · updated) and a transport chip (the full command lives in the detail panel). The wall is a **row-major equal-width grid** (`display:grid` + `minmax(0,1fr)` per track), not a `column-count` waterfall: a column waterfall fills top-to-bottom, which made a `Most used` sort read as unsorted.
- **Favourites** persist to `registry.favorites`; the filter row has **Favourites only (N)**, a view filter that says how many are hidden by the current source/search rather than showing an empty list.
- **Submissions**: when a listing lives in a GitHub repository, that row gets a **Submit ↗** link that opens a pre-filled `issues/new` page (no token, no backend); a workflow in that repository validates the issue and writes `registry.json`.
- **Export log (⤓)** writes out everything this page knows — plugin version, the registry, per-source counts and each source's own time/cache/304 state, current filters, both errors. Assembled client-side; the host's logs are not this plugin's to export.
- **Only the card area scrolls**: the page is a fixed shell, the tab body and the card wall are the scrollers, and the chips/search/filter/meta rows are pinned. `tools/shot.mjs` measures that contract at four window widths.

### Automatic diagnosis of a failed install

`spawn npx ENOENT` and `MCP error -32000: Connection closed` are the failures users actually hit, and the raw line is barely actionable. The host hands **the entry's facts plus the original error** to the user's own model and shows the answer next to the error:

- **Silent**: `ctx.llm.stream` directly (`temperature: 0`, 20s timeout) — no session, no message in any conversation, nothing on disk.
- **No leakage**: name/source/transport/command/arguments (max 8)/url/repository/homepage/version/category plus the raw error. The entry's `env` and `headers` are **never sent** — those hold the credentials — and command/url pass through `redactSecrets`/`redactUrl` (labelled credentials such as `--api-key=…`, plus `sk-`, `ghp_`, `xoxb-`, `AKIA` and JWT shapes become `<redacted>`). Best effort, and the real defence is not sending `env`/`headers` at all.
- **Hard constraints in the system prompt**: at most three lines (cause / next step / a third only if the error alone is insufficient), never invent a URL, argument, version or config key, never claim to have run a command, never suggest disabling a sandbox or skipping a safety check.
- **Every "no explanation" says why**: `diagnosisSkipped: "no-llm"` or `"no-route"` (no request is made in either case), `diagnosisError` when the call fails — and a `200` response with `connect.ok === false` renders a failure block (raw error, then the diagnosis) instead of claiming success.
- Identical `(entry, error)` pairs are answered from a ten-minute memo (32 entries), and hosts **without** a model are unaffected: `llm` is injected optionally.

### Submitting to a community listing

The write direction needs no local service — whoever hosts the listing hosts the submission:

| Role | Artifact | Location |
| --- | --- | --- |
| Listing repo | the listings document the market reads | `registry.json` |
| Listing repo | validates an incoming issue and writes that file | `.github/workflows/registry-submission.yml` |
| Listing repo | all validation and write logic (no dependencies) | `tools/registry-submission.mjs` |
| Listing repo | the human form (fields match the parser) | `.github/ISSUE_TEMPLATE/mcp-listing.yml` |
| Panel | the row's **Submit ↗** pre-filled link | `lib/submission.js` |
| Host | listing URL → its GitHub coordinates | `index.js` |

The issue body is **untrusted input**: it is validated while parsing and re-checked before writing, and it reaches the shell only through `env:` (never interpolated into a script). Exit codes are the control flow: `0` listed/updated/no-op, `1` validation failed (a comment lists why, the file is untouched), `2` the tool itself failed.

```bash
node tools/registry-submission.mjs --body-file /tmp/issue.md                  # validate only
node tools/registry-submission.mjs --body-file /tmp/issue.md --write --comment /tmp/comment.md
node tools/registry-submission.mjs --check --registry registry.json
npm run test:registry
```

Rules: name and description are required (120/600 characters); **either** a stdio command **or** a streamable-http URL, never both; the command may not contain `|`, `;`, `&&`, backticks, redirection or `$()` — that line runs on **someone else's machine**, so an entry needing a shell is rejected rather than silently executed; repositories and homepages must be https. One listing keeps one row, keyed by repository, then URL, then name, and `updatedAt` does not move when nothing else did.

### The mirror chain when GitHub is unreachable

In this network github.com, raw.githubusercontent.com and hub.docker.com can time out entirely while both MCP registries answer normally — and the two Awesome sources (96% of the market) would disappear. Both listings therefore walk a trust-ordered mirror chain — `raw.githubusercontent.com` → `cdn.jsdelivr.net` → `fastly.jsdelivr.net` → `testingcf.jsdelivr.net` — with all four started **at once** and the first success winning (measured 450ms on a healthy network; serial waiting was the main cause of a slow first open, because raw and fastly each burn ~10s when GitHub is blocked). No per-URL retry inside the chain, per-mirror `ETag`s, 60-second per-source caching, and the Docker source degrades alone since there is no open mirror for its registry API.

### Popularity numbers: what each one counts

| Source | Field | Card shows | Meaning |
|---|---|---|---|
| Smithery | `useCount` | `87.6k launches` | launches on that platform |
| Docker MCP Catalog | `pull_count` | `1.9M pulls (cumulative)` | cumulative image pulls, not a rolling window |
| Official Registry | — | not shown | **publishes no popularity field** |
| Both Awesome lists | — | not shown | same |

Popularity is a weak signal in sorting (400 maximum against 1000 for "installable") and log10-scaled, so a 1.9M-pull image cannot flatten the rest. GitHub stars are separate: they are a local supplement (up to 30 visible repositories per pass, cached 6 hours), the host reads the rate-limit state and pauses when exhausted (`60/h` unauthenticated, no batch endpoint), and a failed image fetch is retried on a 5-minute TTL rather than cached as "this repository has no images".

### Compared with dshmarket's 4,508

dshmarket's plugin market reads `plugins.json` from the published `dsh-plugin-catalog` npm package — a daily pipeline product of awesome-dsh-plugin.com — so its entries carry `stars`, `downloads`, `capabilities` and bilingual descriptions. No equivalent exists for MCP (PulseMCP's public API has sunset, Glama needs a key), so this plugin aggregates the open APIs live: the numbers grow with the ecosystem and come from first-hand sources, at the cost of local star lookups and per-upstream rate limits.

## Model tools

- `overall_mcp_scan` — rescan the host's MCP configs and import (idempotent; same name with a changed contract is updated in place; hand-written entries are never overwritten, only reported as skipped; the reply includes `orphans`)
- `overall_mcp_list` — the local registry (source, transport, enabled state, connection state)
- `overall_mcp_catalog [query] [source] [limit] [refresh]` — browse the market; entries carry `installable` / `installed` / `author` / `tags` / `installs`
- `overall_mcp_search <query>` — keyword search over the same aggregation (server-side capped at 50)
- `overall_mcp_install <item> [overwrite]` — install and connect; refuses (409) to replace a **manual** entry without `overwrite: true`; a failed mount is not counted (`counted: false`)
- `overall_mcp_set_enabled <name> <bool> [slot] [from]` — enable/disable one server
- `overall_mcp_set_source_enabled <source> <bool>` — the group switch
- `overall_mcp_check_updates` / `overall_mcp_update <name> [slot] [from]` — npm/PyPI checks and update-with-reconnect
- `overall_mcp_remove <name> [slot] [from]` — delete this plugin's registry row and unmount its fiber

With **several rows sharing a name**, `update`/`remove`/`set_enabled` require `slot` (the row index from `overall_mcp_list`) or `from` (the version that row showed); without one they return 409 rather than guessing — updating the wrong row reports "already up to date" and removing the wrong row deletes an unrelated record. Rows reported as `provided-externally` (another mcp-client mounts those tools) return `stillProvided: true` and a note: disabling records this plugin's intent and removing deletes this plugin's row, but the `mcp__<name>__` tools do not disappear.

## Version check and update

The Registered tab has **Check updates**; rows with an update show a green `updatable → x.y.z` badge and an **Update** button. **"Cannot determine the latest version" is not "up to date"**: it has its own count, its own wording and a red `check failed` chip with the reason, because an offline user was previously told everything was current.

The queue runs **serially** (one writer: one registry file, one fiber per server) with a real `i / N` counter — not a download percentage, since the host answers only after rewriting and reconnecting. Each row's button is its own state (`updating…`, `queued`, disabled), a row that has been answered stops offering an update button and shows its result instead, and when nothing is left the position becomes a green `✓ done (N updated / no update needed)`. Closing the progress panel does not change the registry, and answered rows are remembered by row address so they do not reappear in the count unless the listing reports a **newer** version.

**A second row with the same name is a different record.** Names are not row identity — this machine has four `rea-cursor` rows, three with an empty `serverName` — so every update from the panel carries `slot` and `from`, and a check result is only shown when it describes the version that row currently pins (`checkDescribesEntry`).

**The plugin's own update** is the one thing that belongs next to the version number, and only `node_modules` installs get a button: a `link:`/local checkout (this repository's own development shape) resolves to the source directory, so npm's version is irrelevant and no button appears.

| Install shape | Verdict | Panel |
| --- | --- | --- |
| profile `node_modules/dsh-overall-mcp` | version owned by pnpm; compare npm `dist-tags.latest` | `Update to vX` next to the version, then "restart DSH" |
| `link:` / local checkout | the loaded code is the version | no button; the check says self-update is skipped |
| npm query failed (unpublished/404/timeout) | undecidable | no button; the reason is shown as-is |

`GET /api/overall-mcp/self` reports the plugin's own verdict without triggering server checks (10-minute memo); `POST /self-update` runs the install and returns the exact command line.

Detecting a version requires the entry to be launched through a package runner: `npx -y pkg@1.2.3` and its Windows `cmd.exe /d /c` wrapper ✅, `uvx`/`pipx` ✅, unpinned `npx -y pkg` is treated as always current ⚪, and direct commands such as `codegraph serve --mcp` report "not launched through a package runner" ❌ rather than guessing.

Install/connect uses **bounded waiting**: 8 seconds, after which the reply says `starting: true` and the connection continues in the background. A failed or timed-out attempt leaves **no ghost fiber** — only a real mount records a fiber and a `serverName`, and a late failure is reclaimed and disposed. Every panel request has a deadline (`api()`: 30s default, `/scan` and `/catalog` 120s, `/install` and update routes 300s, `/self-update` 600s) and times out with a message instead of freezing every button; the host distinguishes "the row you read has moved" (`stale entry`) and "several rows share this name" (`ambiguous server name`) as **409** — retry after refreshing, not an internal error.

## Schema guard

Some MCP servers publish tool JSON Schemas that a model API's regex validator rejects; REA v6.1.0's `"pattern": "^[^\\0]*$"` makes DeepSeek reject the **whole request** (`Invalid schema for function …: "^[^\\0]*$" is not a "regex"`). This plugin installs a narrow guard for `mcp__*` tools in this process (restored on unload): `\0` is rewritten to the equivalent `\x00`, and other non-portable constructs (backreferences, lookbehind, `\p{...}`) drop the `pattern` keyword — a looser schema, never a wrong one. Every repair is logged, and `GET /api/overall-mcp/tools` exposes the **registered** schema for forensics.

## Duplicate mounts

If a server name is already mounted by another mcp-client (for example `rea-mcp` from a harness home patch), this plugin does not mount it again: the row reads `provided-externally` (blue dot, "provided by another plugin, duplicate mount skipped"). That avoids both a duplicate tool set inflating the context and a duplicate connection bringing a bad schema into the request. Such a row has no fiber here, so the panel can still record intent or delete this plugin's row — and the tooltips, the action's `note` and the model tools all say the tools remain provided elsewhere rather than claiming a disconnect.

## Duplicate rows in the registry

The same `npx -y rea-agents@6.5.0 mcp` command once appeared as **five rows** (four `rea-cursor` + one `rea`): an older merge renamed conflicting imports to `name-<source>`, and because `serverName` made the renamed row look like a different record, the name-based orphan cleanup skipped it forever. `collapseDuplicateRows(registry)` now folds "name + command contract" into one row **before** the merge writes: the survivor is the row carrying `serverName` (the hardest field to re-derive), else one flagged `providedExternally`, else the first; `enabled` comes from the surviving row (folding must not change whether a server runs); `about`/`updateCheck`/`updatedAt` take the newest and `importedAt` the earliest. Folding runs at load time, around the merge, and the scan reply reports `collapsed: [{name, dropped}]`. This is distinct from the cross-plugin duplicate above: `rea` (the harness patch) and `rea-cursor` (this plugin's mount of the same command) are two different configurations, and this plugin will not delete either on the user's behalf.

## HTTP API (used by the panel; Connection-authenticated)

`GET /servers`, `GET /tools`, `GET /status`, `GET /events?limit=`,
`GET|POST|DELETE /auth`, `GET|POST /census` (read status / `{action:'start'|'stop'}`),
`GET|POST /updates`, `POST /update`,
`GET|POST /catalog?query=&source=&limit=&refresh=`,
`GET|POST /sources`, `POST /sources/remove`, `POST /scan`,
`POST /install`, `POST /set-enabled`, `POST /set-source-enabled`, `POST /remove`,
`POST /forget-orphans`, `POST /favorite`, `GET /favorites`,
`GET /repo-stats?repos=owner/name,...` — all under `/api/overall-mcp/`.

Status-code layering (`lib/http-status.js`, unit-tested): `unknown server`/`unknown source` → **404**; a missing parameter, `no installable transport`, `is not launched through a package runner`, a value that is present but unusable (`on must be a boolean`), an illegal verb out of an enum (`unknown census action`) → **400**; `ambiguous server name`, `stale entry`, `manual entry` → **409**; an upstream version lookup failure → **502**; everything else → **500** with a `log.warn` line (method, URL, message) — 500 means "we did not anticipate this path", which used to share 400 with "you typed something wrong".

Bodies: `/install` is `{ item, overwrite? }`; `/update`, `/remove`, `/set-enabled` are `{ name, slot?, from? }` (409 without `slot`/`from` when the name is ambiguous); `/sources` is `{ url, label? }`; `/sources/remove` is `{ id }`.

`/install`'s reply separates the two facts: `server` is the **server name** and `installed` is a **boolean** with the same meaning it has on a catalog entry (renamed in round 20 — one word used to carry two meanings). Then `connect` (`{ok:false, error}` means the entry was written but did not connect, with `counted:false`), optionally followed by `diagnosis`, `diagnosisSkipped` or `diagnosisError`.

### Favourites

`POST /favorite` with `{"key":"<source>:<id|title>","on":true|false}` writes the **desired end state**; without `on` it falls back to toggling (the older behaviour), and a non-boolean `on` is an error rather than a toggle. The key is the card's React key — official Registry ids move with versions, so source + title is the stable identity. Favourites live in `registry.favorites` and `/catalog` marks each entry. `GET /favorites` → `{"favorites":[...],"count":N}` exists because `/catalog` only marks what the current query returned: "what did I favourite?" needs an independent answer, and the panel's **Favourites only (N)** filter says how many the current source/search is hiding.

### `/catalog` caching

Two layers (`lib/catalog-cache.js`): the **URL layer** (per-URL `ETag` + body, `If-None-Match` → `304` reuses it without re-parsing; LRU 64 URLs / 8MB) and the **source layer** (60-second TTL keyed by source|query|cap, falling back to the previous result on failure with `stale` set). The cache is passed in explicitly, the query string is truncated to 200 characters before it enters the key (otherwise a caller can grow the key space without bound), and a manual refresh skips the TTL while **still** using the conditional request — a refresh is usually one `304`, and the meta line says `N sources unchanged`.

`counts[id]` and `sources[id].merged` are **post-merge** counts while `sources[id].items` remains what that source walked; `deduped` is how many rows were folded away, and a source that answered empty without error is `0` rather than absent.

## Identity line and action log (round 18)

Host plugin code is loaded **once, at DSH startup**, and no version number can answer "which code is this panel running". The header's second line now reads `GET /status`: `plugin v0.3.0 · pid 4242 · up 3h 12m · 5 data files · 2 log lines`. `/status` separates three groups because they fail differently — `plugin` (id/version from `package.json`/directory actually loaded/`loadedAt`, plus each source file's `mtime` and size and a `stale` flag when disk is newer), `host` (pid, startedAt, uptime, node, electron, platform, arch) and `data` (the directory, every file's bytes and time, plus `census`/`evidence`/`quota`/`errors`). When `stale` is set the header draws `⚠ code updated, restart DSH` — that state and "the bug is still there" look identical otherwise.

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

## Host locations scanned

| Application | Location (per platform) |
|---|---|
| Claude Desktop | `%APPDATA%/Claude/claude_desktop_config.json`, `~/Library/Application Support/Claude/...`, `~/.config/Claude/...` |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code (Copilot) | `.../Code/User/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex CLI | `~/.codex/config.toml` (`[mcp_servers.*]`) |
| Gemini CLI | `~/.gemini/settings.json` (`mcpServers`) |

Only these whitelisted paths are read: no recursive directory scanning, no telemetry.

## Interface accuracy and concurrency (round 20)

Six places where the interface said something the host was not doing. None of them broke usability; all of them made a number or a time mean something other than what it appeared to.

1. **Group switches and startup mounts are bounded-concurrent.** A mount spawns a subprocess and completes a handshake (8s cap), and the serial loop's worst case was `members × 8s` — measured on 2026-10-16: a five-member group switch sat at "switching…" for 40 seconds. `CONNECT_CONCURRENCY = 4` runs in flight (`mapLimited`, order-preserving because the client reads results by array index) and `connectEnabled`, the group switch and the post-scan connect all share it. This also removed a false assertion: duplicate same-name rows used to each attempt a mount, and the loser's name conflict was recorded as "provided by another mcp-client", which reads like a host fault. Now **each name mounts once**, same-name siblings share the first row's verdict, and a failure is recorded only on the row that actually attempted the mount.
2. **Per-source counts use the same ruler as the total** (`counts` is post-merge, `deduped` is reported).
3. **The two "updated at" times are separated**: the listing's read time is `listing read at`, a repository's last push is `upstream updated`, and each tooltip says which clock it is.
4. **`installed` has one meaning** (`server` is the name, `installed` is always a boolean).
5. **"No usage data" is stated** on cards sorted by usage instead of silently falling back to quality.
6. **Inferred categories say "(inferred)" everywhere** — the card tooltip already did, the detail panel and the category dropdown did not, so the same inference became a fact when read elsewhere.

## Market sources (measured 2026-10)

| Source | Endpoint | Notes |
|---|---|---|
| Official Registry | `registry.modelcontextprotocol.io/v0/servers` | Records are **per version** (~7,242 records ≈ 2,582 servers), deduplicated by `isLatest`, falling back to `updatedAt` then version. Install data comes from `packages` (npm → `npx`, otherwise `uvx`) or `remotes` (streamable-http) |
| Smithery | `registry.smithery.ai/servers` | `displayName`, `useCount`, `iconUrl`, `verified`; installs via `npx -y @smithery/cli run <qualifiedName>` |
| Docker MCP Catalog | `hub.docker.com/v2/repositories/mcp/` | ~245 images, `docker run -i --rm mcp/<name>`, `pull_count` as popularity. **Anonymous reads only page one**: page 2 returns `403 pagination offset too large for anonymous requests; sign in to page further`. That is an answer about *who is asking*, not a fault, so the source is not degraded — it returns the 100 rows it has with a note, and that 403 is never retried (a real 403 rate limit still is) |
| GitHub MCP | `api.github.com/search/repositories` (three queries, with a `User-Agent`) | A **discovery** source: 100 per query, three queries, deduplicated by `owner/repo`, top 200 by stars. The search response carries no install information, so `install: null`. With a census index present it reads the index instead — **zero requests**, up to 800 rows, keywords filtered over the whole census |
| Awesome remote | `raw.githubusercontent.com/punkpeye/awesome-remote-mcp-servers/main/README.md` | Hosted endpoints: the backticked URL installs as streamable-http |
| Awesome list | `raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md` | Community index (~4,224 rows parsed); discovery + repository link only, because a launch command cannot be inferred safely |

> PulseMCP's public API has sunset (`v0beta` returns 410 `API_SUNSET`), so its adapter is kept but disabled by default; Glama needs an API key and is not included. `npm search` was evaluated and rejected (unauthenticated `popularity` is a constant, so it cannot separate real MCP servers from packages that merely mention mcp), and the bare `topic:mcp-server` query mixes in n8n and gemini-cli, which is why the second query additionally requires `mcp` in the description.
>
> Cross-catalog merging uses the GitHub repository as the shared identity: the same repository from several catalogs keeps one row (preferring the installable one) and records all sources in `sources`. Docker images and remote endpoints stay independent.

## Data files

- `registry.json` — the authoritative registry. Written through a temp file + `rename`; if it fails to parse the original is copied to `registry.json.corrupt-<timestamp>` and the panel is told (`registryError`) instead of treating the state as a first run.
- `installs.json` — this market's install counts, incremented **only after a successful mount**.
- `scan-report.json` — the last scan report.
- `events.ndjson` — the action log (last 400 lines / 256KB). Metadata only; deleting it loses nothing but the log.
- `github-auth.json` — the pasted GitHub token (`0600`). **The only file holding a plaintext credential**: delete it (or press Clear) to return to anonymous immediately.
- `github-install.json` — commands recovered from repository evidence, each with the file it came from and the registry where the package was confirmed to exist. Derived data: deleting it just re-walks.
- `github-index.json` — the census index (`{version, at, minStars, queries, requests, complete, partial, rows}` with `firstSeen`/`lastSeen`). Written every 5 seconds while walking, so an interrupted run still leaves the rows it received. Derived data: corrupt → warn and treat as "no index" (not quarantined, not backed up).
- Catalog listings are cached per source for 60 seconds (the raw data only; "installed" is recomputed on every read), and upstream URL bodies + `ETag`s are stored in a second layer. Star lookups cache for 6 hours.

## Security

- The scanner reads whitelisted files only; stdio `env` references variable names rather than expanding host secrets.
- A catalog entry's launch command and source are visible before it is installed, and the user confirms.
- GitHub credentials (pasted token / `DSH_GITHUB_TOKEN` / `GITHUB_TOKEN` / `gh auth token`) are read in plaintext **only** inside `lib/github-auth.js` and sent, by host allowlist, only to `api.github.com` and `raw.githubusercontent.com` — Docker Hub, npm, PyPI, Smithery and the official registry never see a byte of it. The panel, `events.ndjson` and `/status` see only the mask and the login.
- A local plugin: it exposes no external HTTP surface.

## Development

```sh
npm test                 # unit tests (lib/ is dependency-free)
npm run test:registry    # validate the published registry.json
npm run test:probes      # render probes: build the real page and assert on the DOM
npm run test:layout      # needs a real Chromium via CHROME_PATH (local only)
npm run test:live        # needs a base URL + token (local, live instance)
npm run verify:ci        # lint + test + test:registry + test:probes
npm run verify           # verify:ci + test:layout
```

`npm run lint` is a syntax check of every source file, and `npm test` is an explicit file list — a new test file that is not listed is silently skipped.

Individual probes worth knowing:

```sh
node tools/client-smoke.mjs         # client registration contract; pins CLIENT_VERSION == package.json == newest CHANGELOG section
node tools/render-detail.mjs        # detail panel: facts, links, command, and the copy button really reaching the clipboard
node tools/render-card.mjs          # card: title is the link, body is not a button, no nested controls, command only in detail
node tools/render-market-tab.mjs    # whole market chrome: header, identity line, log box, tabs, search, filters, meta, cards, footer
node tools/probe-server-about.mjs   # purpose line placement, clamping, evidence-labelled title, no empty element without evidence
node tools/verify-css.mjs           # every className has a rule in the injected stylesheet
node tools/verify-sort-paging.mjs   # 6 sorts, 3 page sizes, out-of-range clamping, compact counts
node tools/verify-detail-links.mjs  # detail links: per-source coverage, zero dead ends, zero duplicate URLs
node tools/verify-group-row.mjs     # the chip row's show/hide decision
node tools/registry-submission.mjs --check --registry registry.json
node tools/probe-favorites.mjs <token>   # live favourite round trip
node tools/measure-sources.mjs           # per-source upstream counts (pagination and truncation, measured)
node tools/probe-mcp-schema.mjs -- <cmd> # inspect an MCP server's tool schemas
```

Two render probes read the **live** catalogs, so they exit **2** (not 1) when no source answers: with every source down their assertions are vacuously true, and a probe reporting "0 dead ends" over 0 entries is exactly the lie those files exist to prevent. Exit 2 means "the network was unreachable", and the CI matrix therefore cannot read an offline run as a pass.

| File | Responsibility |
|---|---|
| `lib/scanner.js` | host config scan and normalisation; registry merge (manual entries keep their name, a changed contract updates in place, byte-identical rows are skipped) and duplicate-row folding |
| `lib/catalog.js` | the six remote catalogs: fetch, normalise, merge, sort, GitHub supplement; the GitHub search source and rate-limit retry; custom-source parsing; the process-level anonymous search-quota state |
| `lib/github-index.js` | the census: star-window queries, throttled paging, cross-window dedup, merge with the previous index (30-day sliding window), freshness text, named stop reasons, and a progress payload every 5 seconds |
| `lib/repo-install.js` | install-command recovery from `package.json` `bin` / `pyproject.toml` scripts / `server.json` / fenced README commands, each confirmed against npm or PyPI, with its source named |
| `lib/catalog-cache.js` | the two cache layers (ETag/304 reuse, 60-second source TTL) and `forgetSourceId` |
| `lib/custom-sources.js` | custom source documents: https-only validation, id derivation, label inference, add/remove with tolerance for a corrupt file |
| `lib/submission.js` | the submission direction: parse an issue body, validate, dedupe key, pre-filled `issues/new` URL |
| `lib/install-diagnosis.js` | diagnosis text: system prompt, fact extraction (never `env`/`headers`), credential redaction, reading the model's answer |
| `lib/about.js` | "what is this MCP for": one sentence from `instructions` / registered tools / launch command, with markdown stripping and evidence labels |
| `lib/http-status.js` | internal errors → HTTP status codes |
| `lib/events.js` | the action log: `emit`, serialised bounded `appendEvents`, tail `readEvents`, `eventFileFacts` |
| `index.js` | the cordis host plugin: registry, one `ctx.plugin(mcpClient)` per server, `defineTool` management tools, HTTP routes |
| `client/client.js` | the `__ModuleLoader__` client plugin: the sidebar rail entry and the panel itself |

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

## Trade-offs copied from dshmarket

dshmarket's plugin market (4,508 entries from a daily build pipeline) was evaluated item by item. Copied: deprecated marking, popularity figures with their own unit and window, and — since round 17 — three disciplines: **staleness must be distinguishable**, **failures are reported per source** (with the reason and the recovery time), and **requests are accounted in two layers** (TTL for "how often do we work", ETag for "how much do we download"; GitHub's zero-request gate is a quota, not a cache).

Not copied: **capability tags**, because they come from statically scanning a plugin artifact, and MCP catalogs publish no such artifact — reproducing that would mean downloading every server before browsing it. This plugin instead shows the full launch command and its source **before** installation and leaves the judgement to the user. Also not copied: **bundled snapshots** — dshmarket removed its own (839 bundled rows against 1,367 live, with a median catalog lifetime of seven weeks), and no market data ships inside this package. One deliberate difference: dshmarket refuses to answer from cache after a failure, while this plugin answers from the previous result marked `stale` — the objection is to **indistinguishable** staleness, not to staleness, and GitHub is intermittent enough that the alternative is a blank screen.

## Published package contents

`package.json` has a `files` allowlist: `index.js`, `lib/` (17 `.js` files), `client/client.js`, `cordis.patch.yml`, `registry.json`, `README.md`, `README.zh-CN.md` and `CHANGELOG.md`. Everything else (`tools/`, `test/`, `prototype/`, `INTEGRATION-TODO.md`, `.github/`) is development material that no runtime path reads: `index.js` reads the registry from the data directory, not the repository root.

## FAQ

**The market shows `HTTP 404` or stays on "discovering…"**

Host plugin code is loaded once at DSH startup. If the plugin was updated while DSH was open (common with a `link:` install into a workspace), the front end is new and the host is old, so `/api/overall-mcp/catalog` does not exist yet.

- Quit DSH completely (on desktop, check the tray icon — closing the window is not quitting) and reopen.
- A newer page says "host plugin is an older version (missing /api/overall-mcp/catalog)" rather than only showing 404.
- Check the header's second line: a stable `pid` with a rising uptime is that same process, and the `⚠ code updated, restart DSH` marker next to it is the page recognising the situation itself.

**I changed the plugin's code and the panel behaves the same**

Same cause: the host loads once. `plugin.source.stale` in `GET /status` is the machine-readable version of that comparison, `plugin.source.files` lists each file's `mtime` and size, and `plugin.dir` is the directory the host actually loaded — which, with a `link:` install, is not the copy in `node_modules`.

**Why does a group switch take several seconds?**

Because every row in that source really does spawn a `dsh-mcp-client` subprocess and complete a handshake; it is not a boolean. Before round 20 this was serial, worst case `members × 8s` (40 seconds measured for five members); now at most four are in flight, so five members take about two waves. "switching…" is that work's progress, not a hang. The same round guarantees **one mount per name**: duplicate same-name rows used to each attempt a mount and the loser was recorded as "provided by another mcp-client", an artefact of the concurrency itself.

**The census stopped halfway ("request N failed")**

That is GitHub's quota or a network flap, not a broken plugin. Anonymous allows 10 searches/minute and 60 core requests/hour; a full census reads files from thousands of repositories and will not finish anonymously.

- Paste a token in the GitHub access card (or press *use my GitHub login*) to raise the budget to 5,000/hour.
- **You can also just continue**: pressing *census again* resumes from the breakpoint, because rows that already have evidence are skipped.
- `GET /status` (or the census line in `/events`) reports `planned / attempted / remaining / retries` — how far the walk got and how many retries it needed.

**I entered a token and the panel still says "anonymous"**

Only a **validated** token becomes active (checked once against `GET /user`), so a mistyped token falls back to anonymous instead of turning every request into a 401. The card's status line distinguishes `401 (invalid or expired)` from an unreachable network. A pasted token needs no restart, but the `/auth` route itself only exists after a restart if the running host predates it.

## License

MIT
