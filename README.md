<p align="center">
 <img src="https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/icon.png" width="112" height="112" alt="Overall MCP: one blue hub with five satellites">
</p>

<h1 align="center">dsh-overall-mcp</h1>

<p align="center">English | <a href="README.zh-CN.md">中文</a></p>

<p align="center">
 <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.6.0-4d6bfe" alt="version 0.6.0"></a>
</p>

**A DeepSeek Harness plugin that scans every MCP configuration on the machine on first install and registers what it finds; aggregates six open MCP catalogs (5,364 deduplicated entries measured 2026-10) into one browsable, one-click-installable panel; and keeps a local census index of MCP repositories on GitHub (1,758 rows measured), recovering install commands from repository evidence and labelling each recovered command with where it came from.**

`README.zh-CN.md` is the same document in Chinese. [docs/ENGINEERING.md](https://github.com/YunzhouLi-hub/dsh-overall-mcp/blob/main/docs/ENGINEERING.md) keeps the engineering record — the measurements, the alternatives that were rejected, and why each choice went the way it did. The README describes what the plugin does; that file describes how it got there.

## What it looks like

These are screenshots of the real panel: `tools/readme-shots.mjs` renders them from the **real client code** (the same `client/client.js`) over a fixed fixture, so the pictures cannot drift from what the code draws. `npm test` checks that every image referenced here exists.

### Registered: source groups, and the two walks on the GitHub card

![The Registered tab: servers grouped by where they came from, above a GitHub access card that names the census index, why the last walk stopped, and offers "继续恢复"](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/registered.png)

### Market: six catalogues behind one search box

![The MCP market tab: search, category and source filters, the per-source count line, and the card wall with stars, licence, tags and a media strip](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/market.png)

### Detail: everything behind one card

![The detail panel: repository stats (stars, forks, licence, language, last push), source and author, and the command that will be run with its copy button](https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/docs/images/detail.png)

## Features

| | Capability | What it does |
|---|---|---|
| 🔍 | Scan on first install | Discovers and registers every MCP server configured in Claude Desktop, Claude Code, Cursor, VS Code (Copilot), Windsurf, Codex CLI and Gemini CLI |
| 🌐 | MCP market | Six sources aggregated in parallel — official Registry, Smithery, Docker MCP Catalog, GitHub MCP, Awesome remote, Awesome list — **5,364 entries measured**. Browse with no keyword, filter by source, search. (The GitHub source reads the local census index and makes **zero requests** when an index exists; rows without install data get a command recovered from repository evidence, with the source named.) |
| ⚡ | One-click connect | npm package → `npx -y <pkg>`, Python package → `uvx`, hosted endpoint → streamable-http, Docker image → `docker run -i --rm mcp/<name>`; listing-only entries offer their repository link |
| 🧩 | Settings before it can work | A server that installs can still be unusable — a missing API key makes every tool call answer `401`. The declaration is read from the official Registry (or from the entry's own launcher), stored with the row, and shown as a **待配置** badge plus a one-line page banner; **配置** opens a masked form, saving remounts only a row that was already enabled, and the install reply opens the form for what it just wrote (`GET /servers`, `POST /configure`, `overall_mcp_configure`, round 25) |
| 🛠️ | Native tool bridge | Each enabled server is mounted as one `dsh-mcp-client` instance; its tools register as native DSH tools named `mcp__<name>__<tool>` |
| 🖥️ | Sidebar panel | **Global MCP**, directly under *Plugins*: a **Registered** tab (grouped by source, collapsible, per-group switch, status filters) and an **MCP Market** tab |
| 🎛️ | Per-group switches | One switch per source group enables/disables every server from that source (also available as `overall_mcp_set_source_enabled`) |
| ⬆️ | Version check and update | Checks npm/PyPI for servers launched through `npx`/`uvx` (including Windows `cmd.exe /c` wrappers); a green `Update all (N)` runs them with per-row progress, and turns into `✓ done` when the queue has answered every row |
| 🪪 | Identity line | The panel's second line says **which code this process is running**: plugin version, pid, uptime, readable data files, log lines. When the files on disk are newer than the process it adds `⚠ code updated, restart DSH` — "still broken" and "not loaded yet" stop being the same sentence (`GET /status`) |
| 🧾 | Action log | The host writes its actions to `events.ndjson` (browse/per-source outcome/quota/scan/census/evidence/install/update/mount/registry repair), expandable from the header. Metadata only, never secrets, last 400 lines |
| 🔑 | GitHub credentials and census resume | A token can be pasted in the panel (or taken from `gh auth token`); it takes effect only after validation and is sent only to GitHub hosts. **Anonymous still works** — the budget is just 60/h instead of 5,000/h. One network failure no longer ends a census (per-repository retry with backoff, stop after repeated rejections), and the next run resumes from where it stopped (`GET\|POST\|DELETE /auth`) |
| ⏯️ | Start and stop the census yourself | The GitHub access card on the *Registered* tab states where the census stands (how many rows, when it last read, who stopped it) and offers the verb that matches: *start* (no waiting for the cache to expire) or *stop* with live progress. Stopping is safe — rows are written as they arrive, the next run resumes from the missing repositories, and a stopped run will not spend budget on install evidence afterwards (`GET\|POST /census`, round 22) |
| 🔧 | Start and stop the recovery walk yourself | The same card carries a **second walk** (reading repository evidence to recover install commands) with its own state line and its own verb: `tried 78 / 2.1k repositories` while running, *resume recovery* when rows are left. It used to start by itself when the market opened and could only be ended by unloading the plugin — and a full pass is 150ms × more than two thousand repositories (`GET\|POST /install-evidence`, round 23) |
| 🗂️ | Read the local census as a source | The source filter offers *local census (index)* right beside *GitHub*: same index on disk, but **not one request spent**, and an old index is not quietly re-walked. It is not a seventh source — counts still belong to GitHub (one upstream, one number) — it just makes "I am reading the list I already have" a choice you can make (`?source=census`, round 24) |
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
- Each row: status dot, name, **purpose line**, facts line (transport · status · tool count · tool prefix `mcp__<serverName>__` · package version), enable/disable, remove, and **配置** when the row declares settings
- **One writer at a time, atomic writes, and tools that tell the truth.** Every "read registry → await (scan / spawn npx / query npm) → write back" action is queued on one promise chain, because two interleaved read-modify-writes lose the earlier change. The registry is written through a temporary file plus `rename` (it is the one file whose loss unmounts every server). A registry that fails to parse is no longer treated as a first run: the original is copied to `registry.json.corrupt-<timestamp>`, the panel shows a red line with the reason, and the file is never overwritten with an empty registry. A scan no longer clears favourites (the merge preserves the top-level keys it does not own), installing over a hand-written `source: manual` entry returns **409** unless `overwrite: true`, a failed mount reports `counted: false` instead of looking like success, and the group switch disconnects by name so it cannot take another source's same-named row with it.
- **Purpose lines.** The host picks one human sentence by **strength of evidence** (`lib/about.js`, clamped to 150 characters and two lines): the server's own `instructions` from the MCP `initialize` result (`source: 'server'`), else the tools it registered (`source: 'tools'`), else its launch command (`source: 'command'`). The origin is labelled in the line's `title`, and if all three are missing the line is omitted rather than invented. Because dsh-mcp-client publishes `instructions` only while the server is connected, "not found" is not cached as final: the host remembers the liveness at last read and re-assembles only when it flips.
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

### Settings a server needs before it can work

A server can install, mount, read `已连接` — and still answer every `tools/call` with `401`, because the token was never filled in. Until round 25 the first hint was the broken tool call. The declaration is now read at install time, stored with the row, and shown before anything is clicked.

- **Where the declaration comes from** (`lib/server-config.js`): the official Registry's `packages[].environmentVariables[]` (name, description, `isRequired`, `isSecret`) and `remotes[].headers[]`; for every other source, what the entry's own launcher implies — `-e NAME` / `--env NAME`, `$NAME` / `${NAME}` / `{NAME}` placeholders in the command, an argument or the URL, and a bare credential-shaped token such as `GITHUB_PERSONAL_ACCESS_TOKEN` (exactly how the official GitHub image is launched). A `streamable-http`/`sse` entry always gets one **optional** `Authorization` header: most remote endpoints are anonymous, and a required field nobody can fill would make every one of them look broken. Sources are unioned, `origin` records the strongest evidence (`official` > `args` > `manual`), and a row that declares nothing carries no `config` at all.
- **Stored, not re-derived**: the spec is written into the registry entry (`config: { origin, fields }`), so a badge survives a restart and a hand-edited config file is not second-guessed. The registry file is stored with `0o600` mode on POSIX and tightened on read; credentials are saved in plaintext locally and rely on filesystem permissions for security. Only a missing **required** value counts — an empty optional field is a hint, not a problem.
- **Masked on the way out**: `GET /servers` carries `config: { origin, fields: [{key, kind, label, help, required, secret, hasValue, value}], missing, pending }` and `needConfig: true` per row, plus the count of *enabled* rows that need it. A secret echoes `••••` when set and `''` when not; a non-secret (a base URL) echoes back so the reader can see which environment it points at. `env` and `headers` themselves never leave the host.
- **The form**: a row with a declaration gets **配置**; a row missing a required value also gets a `待配置` chip and the primary button style, and the page says it once above the filters (`有 N 台服务器装好了但还差配置`, with a `去配置` shortcut). The sheet lists the declared fields as masked inputs marked `必填`, adds one key/value row for anything the declaration missed, and saves with `POST /configure`. Saving writes the values and **remounts only a row that was already enabled** — a stopped row stays stopped. An empty string deletes the key (`清除`), and a save that changes nothing says so instead of claiming success.
- **Install opens the form**: a catalogue item whose declaration has a required value installs as 「待配置」, the reply carries `needConfig` and `config.missing`, and the panel opens the sheet on the row it just wrote. The model diagnosis is **skipped** for this case (`diagnosisSkipped: 'needs-config'`) and for credential-shaped mount errors: the catalogue already said which key is missing, so asking a model to re-derive it from `401` would be slower and worse.
- **For the model**: `overall_mcp_list` marks rows with `needConfig` and lists `config.missing`; `overall_mcp_configure` writes values keyed by field name (`{"env": {...}}` / `{"headers": {...}}`) and echoes secrets as `••••`.

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
node tools/registry-submission.mjs --body-file /tmp/issue.md # validate only
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

## Model tools

- `overall_mcp_scan` — rescan the host's MCP configs and import (idempotent; same name with a changed contract is updated in place; hand-written entries are never overwritten, only reported as skipped; the reply includes `orphans`)
- `overall_mcp_list` — the local registry (source, transport, enabled state, connection state)
- `overall_mcp_catalog [query] [source] [limit] [refresh]` — browse the market; entries carry `installable` / `installed` / `author` / `tags` / `installs`
- `overall_mcp_search <query>` — keyword search over the same aggregation (server-side capped at 50)
- `overall_mcp_install <item> [overwrite]` — install and connect; refuses (409) to replace a **manual** entry without `overwrite: true`; a failed mount is not counted (`counted: false`)
- `overall_mcp_configure <name> [env] [headers] [slot] [from]` — write the settings a server declared (secrets come back as `••••`); saving remounts an enabled row and leaves a stopped row stopped
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
`GET|POST /install-evidence` (the recovery walk: read status / `{action:'start'|'stop', force?}`),
`GET|POST /updates`, `POST /update`,
`GET|POST /catalog?query=&source=&limit=&refresh=` (`source=census` is the view over the local census index, see round 24),
`GET|POST /sources`, `POST /sources/remove`, `POST /scan`,
`POST /install`, `POST /configure`, `POST /set-enabled`, `POST /set-source-enabled`, `POST /remove`,
`POST /forget-orphans`, `POST /favorite`, `GET /favorites`,
`GET /repo-stats?repos=owner/name,...` — all under `/api/overall-mcp/`.

Status-code layering (`lib/http-status.js`, unit-tested): `unknown server`/`unknown source` → **404**; a missing parameter, `no installable transport`, `is not launched through a package runner`, a value that is present but unusable (`on must be a boolean`), an illegal verb out of an enum (`unknown census action`, `unknown evidence action`), a verb sent on a `GET` (`action must be sent as a POST`) → **400**; `ambiguous server name`, `stale entry`, `manual entry` → **409**; an upstream version lookup failure → **502**; everything else → **500** with a `log.warn` line (method, URL, message) — 500 means "we did not anticipate this path", which used to share 400 with "you typed something wrong".

Bodies: `/install` is `{ item, overwrite? }`; `/update`, `/remove`, `/set-enabled` are `{ name, slot?, from? }` (409 without `slot`/`from` when the name is ambiguous); `/sources` is `{ url, label? }`; `/sources/remove` is `{ id }`.

`/install`'s reply separates the two facts: `server` is the **server name** and `installed` is a **boolean** with the same meaning it has on a catalog entry (renamed in round 20 — one word used to carry two meanings). Then `connect` (`{ok:false, error}` means the entry was written but did not connect, with `counted:false`), optionally followed by `diagnosis`, `diagnosisSkipped` or `diagnosisError`.

### Favourites

`POST /favorite` with `{"key":"<source>:<id|title>","on":true|false}` writes the **desired end state**; without `on` it falls back to toggling (the older behaviour), and a non-boolean `on` is an error rather than a toggle. The key is the card's React key — official Registry ids move with versions, so source + title is the stable identity. Favourites live in `registry.favorites` and `/catalog` marks each entry. `GET /favorites` → `{"favorites":[...],"count":N}` exists because `/catalog` only marks what the current query returned: "what did I favourite?" needs an independent answer, and the panel's **Favourites only (N)** filter says how many the current source/search is hiding.

### `/catalog` caching

Two layers (`lib/catalog-cache.js`): the **URL layer** (per-URL `ETag` + body, `If-None-Match` → `304` reuses it without re-parsing; LRU 64 URLs / 8MB) and the **source layer** (60-second TTL keyed by source|query|cap, falling back to the previous result on failure with `stale` set). The cache is passed in explicitly, the query string is truncated to 200 characters before it enters the key (otherwise a caller can grow the key space without bound), and a manual refresh skips the TTL while **still** using the conditional request — a refresh is usually one `304`, and the meta line says `N sources unchanged`.

`counts[id]` and `sources[id].merged` are **post-merge** counts while `sources[id].items` remains what that source walked; `deduped` is how many rows were folded away, and a source that answered empty without error is `0` rather than absent.

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
npm test # unit tests (lib/ is dependency-free)
npm run test:registry # validate the published registry.json
npm run test:probes # render probes: build the real page and assert on the DOM
npm run test:layout # needs a real Chromium via CHROME_PATH (local only)
npm run test:live # needs a base URL + token (local, live instance)
npm run verify:ci # lint + test + test:registry + test:probes
npm run verify # verify:ci + test:layout
```

`npm run lint` is a syntax check of every source file, and `npm test` is an explicit file list — a new test file that is not listed is silently skipped.

Individual probes worth knowing:

```sh
node tools/client-smoke.mjs # client registration contract; pins CLIENT_VERSION == package.json == newest CHANGELOG section
node tools/render-detail.mjs # detail panel: facts, links, command, and the copy button really reaching the clipboard
node tools/render-card.mjs # card: title is the link, body is not a button, no nested controls, command only in detail
node tools/render-market-tab.mjs # whole market chrome: header, identity line, log box, tabs, search, filters, meta, cards, footer
node tools/probe-server-about.mjs # purpose line placement, clamping, evidence-labelled title, no empty element without evidence
node tools/verify-css.mjs # every className has a rule in the injected stylesheet
node tools/verify-sort-paging.mjs # 6 sorts, 3 page sizes, out-of-range clamping, compact counts
node tools/verify-detail-links.mjs # detail links: per-source coverage, zero dead ends, zero duplicate URLs
node tools/verify-group-row.mjs # the chip row's show/hide decision
node tools/registry-submission.mjs --check --registry registry.json
node tools/probe-favorites.mjs <token> # live favourite round trip
node tools/measure-sources.mjs # per-source upstream counts (pagination and truncation, measured)
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

**I only want the repositories this machine already censused, without spending requests**

Pick *local census (index)* in the market page's source filter (right beside *GitHub*):

- It reads the local census index and **spends no requests**; an old index is not quietly re-walked — refreshing it is the *start* verb on the GitHub card.
- It is **not a new source**: counts still belong to GitHub (one upstream, one number), and only the name on the numbers line follows your choice (`local census (index) 1.8k`), so the filter and the line cannot disagree.
- With no index yet it says so and points at *start* on the GitHub card; the view is read-only and will not start anything for you.
- Command line equivalent: `POST /catalog {"source":"census"}`.

**I want to run the install-command recovery now, or stop it**

Same card, one line below the census: it states `tried N repositories · recovered M install commands` and offers *resume recovery* or *stop recovery*.

- This walk reads `package.json` / `pyproject.toml` / `server.json` / README from each repository over `raw.githubusercontent.com` (no API budget), paced at 150ms per request, capped at 6000 requests / 25 minutes.
- *Stop recovery* takes effect between two requests: the repository being read finishes, everything already recovered stays in `github-install.json`, and the line says `stopped by hand (tried N repositories, continues next time)`.
- The command-line equivalent is `POST /install-evidence` with `{"action":"start"|"stop"}` (`{"force":true}` skips the freshness check); `GET` on the same route only reads status and triggers nothing.
- A `dispose` stop (the plugin was unloaded) is recorded as a different reason than `user`, because "I pressed it" and "the host was unloaded" are not the same fact.

**The census stopped halfway ("request N failed")**

That is GitHub's quota or a network flap, not a broken plugin. Anonymous allows 10 searches/minute and 60 core requests/hour; a full census reads files from thousands of repositories and will not finish anonymously.

- Paste a token in the GitHub access card (or press *use my GitHub login*) to raise the budget to 5,000/hour.
- **You can also just continue**: pressing *census again* resumes from the breakpoint, because rows that already have evidence are skipped. The recovery walk below it works the same way.
- `GET /status` (or the census line in `/events`) reports `planned / attempted / remaining / retries` — how far the walk got and how many retries it needed.

**I entered a token and the panel still says "anonymous"**

Only a **validated** token becomes active (checked once against `GET /user`), so a mistyped token falls back to anonymous instead of turning every request into a 401. The card's status line distinguishes `401 (invalid or expired)` from an unreachable network. A pasted token needs no restart, but the `/auth` route itself only exists after a restart if the running host predates it.

## License

MIT
