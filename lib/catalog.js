// lib/catalog.js — live aggregation of open MCP server catalogs (pure fetch, zero-dependency).
//
// Sources (verified against the live endpoints 2026-10-12):
//   - official-registry: registry.modelcontextprotocol.io/v0/servers
//     entries are `{ server: {...}, _meta: {...} }` (nested!) and install
//     information lives in `packages` (npm/pypi) or `remotes` (streamable-http).
//     Supports `?search=` and `?cursor=`; `limit` is capped at 100 upstream.
//   - smithery: registry.smithery.ai/servers (uses `displayName`, `useCount`,
//     `iconUrl`, `verified`).
//   - awesome-list: the community index punkpeye/awesome-mcp-servers README —
//     discovery + repository links (no run command can be inferred safely).
//   - pulsemcp: DEPRECATED upstream (API_SUNSET); kept for compatibility but no
//     longer part of the default source set.
// Each source adapter degrades independently; failures are reported per-source.
//
// Every adapter normalizes to the same "card" shape consumed by the settings
// page and the `overall_mcp_catalog` tool:
//   { id, title, description, source, author, version, transport, install,
//     repository, homepage, icon, tags, installs, verified, official }

const DEFAULT_TIMEOUT_MS = 15000;
/** The official registry is periodically slow on cold reads. */
const OFFICIAL_TIMEOUT_MS = 30000;

/**
 * Mirrors for the two awesome READMEs, in trust order.
 *
 * raw.githubusercontent.com is canonical but unreachable whenever GitHub is
 * blocked wholesale (measured on this network class: TCP connect timeout for
 * github.com, raw.githubusercontent.com AND hub.docker.com simultaneously,
 * while both MCP registries answer normally). The jsDelivr nodes serve the
 * same bytes from CDN POPs; `testingcf` was the reachable one when the others
 * were reset/timing out, so the chain is tried in order and the first ok
 * response wins. Mirror lag is harmless here: the lists change daily and the
 * result is cached for ten minutes anyway.
 */
function awesomeMirrors(owner, repo, branch, path) {
  const gh = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  return [
    gh,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    `https://testingcf.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
  ];
}

/**
 * Race every mirror simultaneously; the first successful body wins and the
 * losers are aborted.
 *
 * The chain used to walk mirrors in order, which is optimal on a healthy
 * network (raw answers in ~1s) but terrible exactly when mirrors matter: a
 * wholesale GitHub block fails raw and fastly with ~10s TCP connect *timeouts*
 * each, so the serial chain held the market request open ~25s before the
 * reachable CDN node even started. Racing keeps the canonical winner on a
 * healthy network (it resolves first and the rest abort mid-flight) while a
 * blocked network pays only the slowest *successful* mirror, not the sum of
 * the failures. Mirror lag is harmless: the lists change daily and the result
 * is cached for ten minutes anyway.
 */
async function fetchFirstText(urls, opts = {}) {
  const { fetchImpl = fetch } = opts;
  const MIRROR_TIMEOUT_MS = 30000;
  const entries = urls.map((url) => ({ url, ctl: new AbortController() }));
  const failures = [];
  // Fired in trust order (map is synchronous), so failure logs and injected
  // test fetchers both observe the canonical order.
  const attempts = entries.map(({ url, ctl }) => {
    const timer = setTimeout(() => ctl.abort(), MIRROR_TIMEOUT_MS);
    return fetchImpl(url, { signal: ctl.signal, headers: { accept: 'text/plain' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      })
      .catch((err) => {
        failures.push(`${new URL(url).hostname}: ${String(err?.message ?? err)}`);
        throw err;
      })
      .finally(() => clearTimeout(timer));
  });
  try {
    // Resolves after the winner's .text() completes, so aborting below never
    // cuts off a body we are about to return.
    return await Promise.any(attempts);
  } catch {
    throw new Error(`all mirrors failed — ${failures.join(' | ')}`);
  } finally {
    for (const { ctl } of entries) ctl.abort();
  }
}

// ---------------------------------------------------------------------------
// Functional taxonomy
// ---------------------------------------------------------------------------

/**
 * The functional groups the market's chip row offers.
 *
 * The two community lists carry ~75 `###` headings between them, with synonym
 * drift (Finance vs Finance & Fintech, two Multimedia, two Other Tools) and
 * near-neighbours split by upstream editorial choice (Education apart from
 * Research). A user shopping for an MCP thinks in functions, not in editorial
 * headings, so the market consolidates them into these groups. The upstream
 * heading stays on the item (`category`) and on the card's tags; `group` is
 * the consolidated layer and never overwrites it.
 *
 * A heading the table does not name falls into 其他 rather than being dropped,
 * so a new heading upstream degrades into a bigger 其他 instead of vanishing.
 */
const FUNCTIONAL_GROUPS = [
  ['开发工具', ['Developer Tools', 'Coding Agents', 'Code Execution', 'Command Line', 'Version Control']],
  ['数据与存储', ['Databases', 'Data Platforms', 'Data Science Tools', 'Data Visualization', 'File Systems', 'File Storage']],
  ['搜索与知识', ['Search & Data Extraction', 'end to end RAG platforms', 'Knowledge & Memory', 'Research', 'Science & Research', 'Conversational AI']],
  ['安全与身份', ['Security', 'Cryptography', 'Identity']],
  ['办公协作', ['Communication', 'Workplace & Productivity', 'Project Management', 'Product Management', 'Support & Service Management', 'Agreements & Coordination']],
  ['营销与客户', ['Marketing', 'Sales', 'CRM', 'Customer Data Platforms']],
  ['金融支付', ['Finance & Fintech', 'Finance', 'Payments']],
  ['商业与法律', ['E-Commerce', 'Legal', 'Real Estate']],
  ['云与运维', ['Cloud Platforms', 'Monitoring', 'OS Automation', 'Embedded System', 'Industrial & IoT']],
  ['浏览器自动化', ['Browser Automation']],
  ['社交媒体', ['Social Media']],
  ['多媒体创作', ['Multimedia Process', 'Multimedia', 'Art & Culture', 'Art & Design', 'Architecture & Design']],
  ['语音与语言', ['Text-to-Speech', 'Speech-to-Text', 'Translation Services', 'Translation & Localization', 'Podcasts']],
  ['出行与生活', ['Travel & Transportation', 'Location Services', 'Delivery', 'Food & Dining', 'Home Automation']],
  ['医疗健康', ['Biology, Medicine and Bioinformatics', 'Health & Fitness', 'Health & Wellness']],
  ['教育学术', ['Education', 'Aerospace & Astrodynamics']],
  ['游戏娱乐', ['Gaming', 'Sports', 'Spirituality & Esoterica']],
  ['自然环境', ['Environment', 'Environment & Nature', 'Agriculture']],
  ['聚合网关', ['Aggregators']],
  ['其他', ['Other Tools and Integrations', 'Other Tools & Integrations', 'Accessibility']],
];

/** heading -> group name, with 其他 as the total fallback. */
const HEADING_TO_GROUP = new Map(FUNCTIONAL_GROUPS.flatMap(([group, headings]) => headings.map((h) => [h, group])));

/** The consolidated functional group of one item, or undefined when uncategorized. */
export function functionalGroupOf(item) {
  if (!item?.category) return undefined;
  return HEADING_TO_GROUP.get(item.category) ?? '其他';
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, accept = 'application/json' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await withFastRetry(() => fetchImpl(url, { signal: ctl.signal, headers: { accept } }));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One retry for fast network-level failures only ("fetch failed": DNS, TCP
 * reset, proxy refusal — the lossy-path condition this host demonstrably has).
 *
 * Timeouts are deliberately NOT retried: the 90s awesome-README budget retried
 * once would hold a market request open for three minutes. An instant
 * `fetch failed` costs ~1.5s to retry and covers the transient case, which is
 * the one that actually recovers.
 */
async function withFastRetry(fn, { delayMs = 1500 } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!/fetch failed/i.test(String(err?.cause?.message ?? err?.message ?? ''))) throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}

const clampText = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** `ai.0si/disclosures` -> `ai.0si`; `owner/repo` -> `owner`. */
function authorFromQualified(qualified) {
  const s = String(qualified ?? '');
  const slash = s.indexOf('/');
  const scope = slash > 0 ? s.slice(0, slash) : '';
  return scope.replace(/^@/, '') || undefined;
}

// ---------------------------------------------------------------------------
// official modelcontextprotocol registry
// ---------------------------------------------------------------------------

/** Hard ceiling on upstream requests per source per browse. */
const MAX_UPSTREAM_PAGES = 4;

/**
 * Fetch a page (or several) of the official registry.
 *
 * The registry stores one record *per published version*, so a plain full walk
 * returns thousands of rows for a few thousand distinct servers. Pass
 * `dedupe: true` to keep only the newest record per `name`, which is what a
 * market listing wants — it turns ~7242 records into ~2582 servers and keeps
 * the page from being 70% duplicate versions of the same project.
 */
export async function fetchOfficialRegistry({ limit = 100, cursor, query = '', pages = 1, dedupe = false, ...opts } = {}) {
  const items = [];
  let nextCursor = cursor;
  let page = 0;
  do {
    const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    url.searchParams.set('limit', String(Math.min(limit, 100)));
    if (nextCursor) url.searchParams.set('cursor', nextCursor);
    if (query) url.searchParams.set('search', query);
    const data = await fetchJson(url.toString(), { timeoutMs: OFFICIAL_TIMEOUT_MS, ...opts });
    for (const entry of data.servers ?? []) {
      const item = normalizeOfficialItem(entry);
      if (item) items.push(item);
    }
    nextCursor = data.metadata?.nextCursor ?? null;
    page += 1;
  } while (nextCursor && page < Math.min(pages, MAX_UPSTREAM_PAGES));

  if (!dedupe) return { items, nextCursor };

  // Keep one record per server name. `isLatest` is the registry's own flag and
  // wins outright; otherwise fall back to the newest `updatedAt`, then the
  // highest version. Without this a full walk returns thousands of rows for a
  // few thousand servers and the page is mostly duplicate versions.
  const best = new Map();
  for (const item of items) {
    const key = item.raw?.name ?? item.id;
    const held = best.get(key);
    if (!held) { best.set(key, item); continue; }
    if (item.isLatest && !held.isLatest) { best.set(key, item); continue; }
    if (held.isLatest && !item.isLatest) continue;
    const rank = String(item.updatedAt ?? '');
    const heldRank = String(held.updatedAt ?? '');
    if (rank > heldRank) { best.set(key, item); continue; }
    if (rank === heldRank && compareVersions(item.version ?? '0', held.version ?? '0') > 0) best.set(key, item);
  }
  return { items: [...best.values()], nextCursor };
}

/** Loose semver-ish ordering, only used to break registry ties. */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Normalize one official-registry entry. The 2025-12 schema nests the record
 * under `server`; older payloads were flat, so both shapes are accepted.
 *
 * `_meta` (the outer wrapper) carries `io.modelcontextprotocol.registry/official`
 * with `status`, `publishedAt`, `updatedAt` and `isLatest` — the last of which
 * is the registry's own "this is the current version of this server" flag, so
 * it is the first choice when picking a representative record.
 */
function normalizeOfficialItem(entry) {
  const s = entry?.server ?? entry;
  if (!s?.name) return null;
  const meta = entry?._meta?.['io.modelcontextprotocol.registry/official'] ?? entry?._meta ?? {};

  const packages = s.packages ?? [];
  const pkg = packages.find((p) => (p.registry_type ?? p.registryType) === 'npm') ?? packages[0];
  const remote = (s.remotes ?? [])[0];
  const repoUrl = s.repository?.url ?? s.repository;
  const identifier = pkg?.identifier ?? pkg?.name;

  let install = null;
  if (identifier && (pkg.registry_type ?? pkg.registryType) === 'npm') {
    install = { transport: 'stdio', command: 'npx', args: ['-y', identifier] };
  } else if (identifier) {
    install = { transport: 'stdio', command: 'uvx', args: [identifier] };
  } else if (remote?.url) {
    install = { transport: 'streamable-http', url: remote.url };
  }

  const tags = [];
  if (identifier) tags.push((pkg.registry_type ?? pkg.registryType) === 'npm' ? 'npm' : 'pypi');

  // Most registry records are `namespace/name` with no title; the last segment
  // reads far better on a card than the raw reverse-DNS identifier.
  const lastSegment = String(s.name).split('/').filter(Boolean).pop() ?? s.name;

  return {
    id: `official:${s.name}`,
    title: s.title || lastSegment,
    description: clampText(s.description),
    source: 'official-registry',
    author: authorFromQualified(s.name),
    version: s.version ?? undefined,
    transport: install?.transport ?? 'unknown',
    install,
    repository: typeof repoUrl === 'string' ? repoUrl : undefined,
    homepage: typeof s.websiteUrl === 'string' ? s.websiteUrl : undefined,
    icon: undefined,
    tags,
    official: true,
    updatedAt: meta.updatedAt ?? meta.publishedAt ?? undefined,
    isLatest: meta.isLatest === true ? true : undefined,
    // The registry's own lifecycle flag, carried verbatim. Only `deprecated`
    // is acted on; anything else (including an unknown future status) is
    // surfaced as-is rather than guessed at.
    status: typeof meta.status === 'string' ? meta.status : undefined,
    statusMessage: typeof meta.statusMessage === 'string' ? meta.statusMessage : undefined,
    statusChangedAt: typeof meta.statusChangedAt === 'string' ? meta.statusChangedAt : undefined,
    deprecated: meta.status === 'deprecated' ? true : undefined,
    raw: s,
  };
}

// ---------------------------------------------------------------------------
// Smithery
// ---------------------------------------------------------------------------

export async function fetchSmithery({ query = '', page = 1, ...opts } = {}) {
  // Public registry listing; pagination via `page`.
  const url = new URL('https://registry.smithery.ai/servers');
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('page', String(page));
  const data = await fetchJson(url.toString(), opts);
  const list = data.servers ?? data ?? [];
  const items = (Array.isArray(list) ? list : []).map((s) => {
    const qualified = s.qualifiedName ?? s.name;
    return {
      id: `smithery:${qualified}`,
      title: s.displayName ?? s.name ?? qualified,
      description: clampText(s.description),
      source: 'smithery',
      author: s.namespace ?? authorFromQualified(qualified),
      version: s.version ?? undefined,
      // The card shows how *this* registry will launch it (through the Smithery
      // CLI), not how Smithery itself hosts it — the hosted/remote flag becomes
      // a tag instead, so the label and the install plan never disagree.
      transport: qualified ? 'stdio' : 'unknown',
      install: qualified
        ? { transport: 'stdio', command: 'npx', args: ['-y', '@smithery/cli', 'run', qualified] }
        : null,
      repository: s.repository?.url ?? s.homepage,
      homepage: s.homepage,
      icon: typeof s.iconUrl === 'string' ? s.iconUrl : undefined,
      tags: [s.remote ? '托管' : '本地'].filter(Boolean),
      installs: typeof s.useCount === 'number' ? s.useCount : undefined,
      // What `useCount` actually counts, so the card can say so rather than
      // presenting a platform-specific number as a universal popularity score.
      installsLabel: '次启动',
      installsWindow: undefined,
      verified: s.verified === true ? true : undefined,
      // Smithery's own lifecycle flags. `inactive` means the upstream no longer
      // serves it; `unlisted` means it is hidden from their directory but still
      // works. Only the first is a deprecation.
      status: s.inactive === true ? 'inactive' : s.unlisted === true ? 'unlisted' : 'active',
      deprecated: s.inactive === true ? true : undefined,
      raw: s,
    };
  }).filter((i) => i.title);
  return { items, hasNext: Boolean(data.nextPage ?? data.hasNext) };
}

// ---------------------------------------------------------------------------
// Docker MCP Catalog (hub.docker.com/v2/repositories/mcp/)
// ---------------------------------------------------------------------------

/**
 * Docker's MCP catalog: ~245 namespaced images under `mcp/<name>`, all of them
 * runnable via `docker run mcp/<name>`. Carries `pull_count` (a far better
 * popularity signal than stars for this list) and a description.
 *
 * `docker run` needs a Docker daemon, so these entries are reported with their
 * install plan and transport but are flagged as container-based; the caller
 * decides whether to expose them as one-click installs.
 */
export async function fetchDockerCatalog({ limit = 100, pages = 3, ...opts } = {}) {
  const items = [];
  let page = 1;
  while (items.length < limit && page <= Math.min(pages, MAX_UPSTREAM_PAGES)) {
    const url = new URL(`https://hub.docker.com/v2/repositories/mcp/`);
    url.searchParams.set('page_size', '100');
    url.searchParams.set('page', String(page));
    const data = await fetchJson(url.toString(), opts);
    const results = data.results ?? [];
    for (const repo of results) {
      const name = repo.name?.replace(/^mcp\//, '') ?? '';
      if (!name) continue;
      const namespace = repo.namespace ?? 'library';
      items.push({
        id: `docker:mcp/${name}`,
        title: name,
        description: clampText(repo.description),
        source: 'docker-catalog',
        author: namespace,
        transport: 'stdio',
        install: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', `mcp/${name}`] },
        repository: `https://hub.docker.com/r/mcp/${name}`,
        homepage: `https://hub.docker.com/r/mcp/${name}`,
        tags: namespace && namespace !== 'library' ? [`Docker · ${namespace}`] : ['Docker'],
        installs: typeof repo.pull_count === 'number' ? repo.pull_count : undefined,
        // Docker reports lifetime pulls, not a rolling window — a different
        // quantity from Smithery's use count and not comparable to it.
        installsLabel: '次拉取',
        installsWindow: '累计',
        verified: repo.is_official === true || repo.affiliation === 'OFFICIAL' ? true : undefined,
        official: repo.is_official === true || undefined,
        // Docker reports a numeric status (1 = active). Anything else means the
        // image is no longer published, which is a deprecation.
        status: repo.status === 1 || repo.status === undefined ? 'active' : `status:${repo.status}`,
        deprecated: repo.status !== undefined && repo.status !== 1 ? true : undefined,
        // `last_updated` is the only staleness signal Docker gives; an image
        // untouched for years is a maintenance signal, not a verdict.
        updatedAt: typeof repo.last_updated === 'string' ? repo.last_updated : undefined,
      });
    }
    if (!data.next) break;
    page += 1;
  }
  return { items: items.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// awesome-remote-mcp-servers (hosted remote endpoints)
// ---------------------------------------------------------------------------

/**
 * punkpeye/awesome-remote-mcp-servers — the companion list of *hosted* MCP
 * endpoints. Unlike the local-server list these rows carry a bare URL in
 * backticks, which is directly installable as streamable-http, so this source
 * is one-click rather than discovery-only.
 *
 * Row shape (description is a continuation line indented by two spaces):
 *   - [7Maps](https://7it.co.il/7maps/) `https://7it.co.il/7maps/mcp`
 *     [![badge](svg)](glama)  🔓 - Daily map of 22,000+ public MCP servers…
 *   🔓 means no auth, 🔐 requires a credential.
 */
export async function fetchAwesomeRemote({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors('punkpeye', 'awesome-remote-mcp-servers', 'main', 'README.md'),
    opts,
  );
  const lines = String(text).split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let category = '';
  let pending = null;   // a `- [name](home) \`url\`` row awaiting its description

  const flush = () => {
    if (!pending) return;
    if (pending.url && !seen.has(pending.url)) {
      seen.add(pending.url);
      items.push({
        id: `remote:${pending.url}`,
        title: pending.title,
        description: clampText(pending.description),
        source: 'awesome-remote',
        author: hostOf(pending.url),
        transport: 'streamable-http',
        install: { transport: 'streamable-http', url: pending.url },
        repository: undefined,
        homepage: pending.homepage,
        category: category || undefined,
        tags: [category, pending.auth === '🔐' ? '需登录' : '免登录'].filter(Boolean),
        // No lifecycle field ships with these rows either. Note that the list
        // itself is the only freshness evidence available for a hosted
        // endpoint: if the URL stops answering, nothing here says so.
        status: undefined,
        deprecated: undefined,
      });
    }
    pending = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { flush(); category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim(); continue; }
    if (/^##\s/.test(line)) { flush(); category = ''; continue; }

    // `- [Title](homepage) \`https://endpoint/mcp\`` — the backticked URL wins.
    const bullet = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s+`([^`]+)`/);
    if (bullet) {
      flush();
      pending = { title: bullet[1], homepage: bullet[2], url: bullet[3], description: '', auth: '' };
      const auth = line.match(/(🔓|🔐)/);
      if (auth) pending.auth = auth[1];
      continue;
    }

    // Continuation: indented badge + `<flag> - description`.
    if (pending) {
      const m = line.match(/(🔓|🔐)\s*[-–—]\s*(.+)$/);
      if (m) { pending.auth = m[1]; pending.description = m[2]; continue; }
      if (!/^\[?![^\]]*\]?\(/.test(line) && pending.description) { pending.description += ` ${line}`; continue; }
    }
  }
  flush();
  return { items: items.slice(0, limit) };
}

/** `https://api.linear.app/mcp` -> `api.linear.app`. */
function hostOf(url) {
  try { return new URL(String(url ?? '')).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// awesome-mcp-servers (community index)
// ---------------------------------------------------------------------------

/** Language / scope / OS emojis documented in the README "Legend" section. */
const LEGEND = {
  '🐍': 'Python', '📇': 'TypeScript', '🏎️': 'Go', '🏎': 'Go', '🦀': 'Rust',
  '#️⃣': 'C#', '☕': 'Java', '🌊': 'C/C++', '💎': 'Ruby',
  '☁️': '云服务', '☁': '云服务', '🏠': '本地', '📟': '嵌入式',
  '🍎': 'macOS', '🪟': 'Windows', '🐧': 'Linux',
  '🎖️': '官方实现', '🎖': '官方实现',
};

/** Pull the legend emojis present in a line, in legend order, deduped. */
function legendTags(text) {
  const found = [];
  for (const [emoji, label] of Object.entries(LEGEND)) {
    if (text.includes(emoji) && !found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * The first *non-image* markdown link on a line. Entries embed a glama badge
 * (`[![name MCP server](badge.svg)](glama-url)`) before the real repository
 * link, and matching naively picks the badge up as if it were the server.
 */
function firstRealLink(line) {
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === '!') continue; // image/badge
    return { text: m[2], url: m[3], index: m.index, length: m[0].length };
  }
  return null;
}

/** `https://github.com/owner/repo` -> `{ owner, repo }` (else null). */
function parseGitHub(url) {
  const m = String(url ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

const stripAnchorTags = (s) => String(s).replace(/<a\s+name="[^"]*"\s*><\/a>/gi, '').replace(/<[^>]+>/g, '');

/**
 * The community "awesome-mcp-servers" index. Discovery only: these rows link to
 * third-party repositories, so no run command is inferred (installing them
 * safely needs the row's own README). Parses the `### <emoji> <category>` +
 * `- [owner/repo](url) [badge] <flags> - <description>` structure.
 */
export async function fetchAwesomeList({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors('punkpeye', 'awesome-mcp-servers', 'main', 'README.md'),
    opts,
  );
  const items = [];
  const seen = new Set();
  let category = '';

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim();
      continue;
    }
    if (/^##\s/.test(line)) { category = ''; continue; }   // leave the server section

    // Legacy table shape: | [<name>](<url>) | <description> | ... |
    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 2) continue;
      const link0 = firstRealLink(cells[0]);
      if (!link0) continue;
      const entry = pushAwesome(items, seen, link0, cells.slice(1).join(' '), '', category);
      if (entry && items.length >= limit) break;
      continue;
    }

    if (!/^[-*]\s/.test(line)) continue;

    const link = firstRealLink(line);
    if (!link || !/^https?:\/\//i.test(link.url)) continue;

    // Everything except the links is either legend flags or the description.
    const rest = line.replace(/!?\[[^\]]*\]\([^)\s]+\)/g, ' ').replace(/^[-*]\s*/, '').trim();
    const parts = rest.split(/\s+[-–—]\s+/);
    const flags = parts.length > 1 ? parts[0] : '';
    const description = parts.length > 1 ? parts.slice(1).join(' - ') : rest;

    const entry = pushAwesome(items, seen, link, description, flags, category);
    if (entry && items.length >= limit) break;
  }
  return { items };
}

/**
 * Append one parsed awesome-list row (bullet or table shape) and report whether
 * it produced an item, so callers can stop at their limit.
 */
function pushAwesome(items, seen, link, rawDescription, flags, category) {
  const gh = parseGitHub(link.url);
  const key = (gh ? `${gh.owner}/${gh.repo}` : link.url).toLowerCase();
  if (seen.has(key)) return null;

  const description = clampText(rawDescription);
  if (!description && !gh) return null;    // table-of-contents / stray bullets

  seen.add(key);
  const legend = legendTags(flags);
  const tags = legend.slice();
  if (category) tags.unshift(category);

  items.push({
    id: `awesome:${key}`,
    title: gh ? gh.repo : link.text.replace(/^@/, ''),
    description,
    source: 'awesome-list',
    author: gh?.owner,
    // The `###` heading the row sat under. A first-class field rather than
    // tags[0] so the market's category filter survives tag merging and so the
    // two lists' taxonomies (65 + 40 headings, with synonym drift between
    // them) are shown exactly as the upstreams wrote them.
    category: category || undefined,
    transport: 'unknown',
    install: null,
    repository: gh ? `https://github.com/${gh.owner}/${gh.repo}` : link.url,
    homepage: gh ? `https://github.com/${gh.owner}/${gh.repo}` : undefined,
    icon: gh ? `https://github.com/${gh.owner}.png?size=80` : undefined,
    tags: tags.filter(Boolean),
    official: legend.includes('官方实现') || undefined,
    stars: undefined,
    // No lifecycle field is published with these rows, so none is invented:
    // `status` stays absent and the UI says "未扫描" rather than "active".
    status: undefined,
    deprecated: undefined,
  });
  return items[items.length - 1];
}

/**
 * @deprecated PulseMCP sunset its public API (`API_SUNSET`, v0beta returns 410
 * and the newer paths 404). Kept so an existing configuration keeps parsing if
 * the upstream returns; not part of the default source set.
 */
export async function fetchPulseMcp({ page = 1, ...opts } = {}) {
  const url = `https://api.pulsemcp.com/v0beta/servers?count_per_page=100&offset=${(page - 1) * 100}`;
  const data = await fetchJson(url, opts);
  const list = data.servers ?? [];
  const items = list.map((s) => ({
    id: `pulsemcp:${s.slug ?? s.name}`,
    title: s.name,
    description: clampText(s.short_description ?? s.description),
    source: 'pulsemcp',
    author: parseGitHub(s.source_code_url ?? s.url)?.owner,
    transport: 'unknown',
    install: null,
    repository: s.source_code_url ?? s.url,
    homepage: s.url,
    icon: parseGitHub(s.source_code_url ?? '') ? `https://github.com/${parseGitHub(s.source_code_url).owner}.png?size=80` : undefined,
    tags: [],
    raw: s,
  })).filter((i) => i.title);
  return { items };
}

/** The default market source set, in display order. */
export const CATALOG_SOURCES = [
  'official-registry',
  'smithery',
  'docker-catalog',
  'awesome-remote',
  'awesome-list',
];

/**
 * How much of each source a single *browse* reads, as `{ pages, items }`.
 *
 * `pages` bounds the upstream requests (the official registry and Docker are
 * paginated at 100 per page; the two awesome-lists are one README each).
 * `items` bounds how many rows of that source are kept.
 *
 * The two awesome-lists are read in full: together they hold ~5150 entries and
 * they are the reason a market built only on the official registry looks thin.
 * Reading them whole costs two requests, the same as reading a slice of them.
 */
const SOURCE_BROWSE_CAPS = {
  'official-registry': { pages: 8, items: 800 },   // 8 pages x 100 records, deduped to servers
  smithery: { pages: 1, items: 10 },               // the upstream listing caps at 10
  'docker-catalog': { pages: 3, items: 300 },
  'awesome-remote': { pages: 1, items: 1000 },
  'awesome-list': { pages: 1, items: 5000 },
};

/** Run one named source adapter, returning [id, items]. */
function runSource(id, { query = '', perSource = 100, ...opts } = {}) {
  const cap = SOURCE_BROWSE_CAPS[id] ?? { pages: 1, items: perSource };
  switch (id) {
    case 'official-registry':
      return fetchOfficialRegistry({ ...opts, query, limit: 100, pages: cap.pages, dedupe: true })
        .then((r) => [id, r.items.slice(0, cap.items)]);
    case 'smithery':
      return fetchSmithery({ ...opts, query }).then((r) => [id, r.items.slice(0, cap.items)]);
    case 'docker-catalog':
      return fetchDockerCatalog({ ...opts, limit: cap.items, pages: cap.pages }).then((r) => [id, r.items]);
    case 'awesome-remote':
      return fetchAwesomeRemote({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case 'awesome-list':
      return fetchAwesomeList({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case 'pulsemcp':
      return fetchPulseMcp(opts).then((r) => [id, r.items]);
    default: return Promise.reject(new Error(`unknown catalog source: ${id}`));
  }
}

function matchItem(item, query) {
  const q = query.toLowerCase();
  return (
    item.title?.toLowerCase().includes(q) ||
    item.description?.toLowerCase().includes(q) ||
    item.author?.toLowerCase().includes(q) ||
    // The install command is searchable too: "docker run mcp/fetch" should find
    // `fetch`, and an endpoint hostname should find its remote server.
    JSON.stringify(item.install ?? {}).toLowerCase().includes(q) ||
    (item.tags ?? []).some((t) => String(t).toLowerCase().includes(q))
  );
}

/**
 * Market relevance: installable first, then popularity, then provenance.
 *
 * Popularity is deliberately a weak signal (max 400 against 1000 for being
 * installable) because the two numbers that exist are NOT comparable: Smithery's
 * `useCount` counts launches on its platform, Docker's `pull_count` counts
 * lifetime image pulls, and the official registry publishes neither. A log10
 * scale keeps a 1.9M-pull image from flattening everything else, but it does
 * not make the two units the same unit — the card labels each one instead.
 */
function itemScore(item) {
  let score = 0;
  if (item.install) score += 1000;
  // A deprecated entry keeps its install plan but drops below every live one,
  // so it is still findable and installable (a user may need it) without being
  // offered first.
  if (item.deprecated) score -= 500;
  if (item.verified) score += 150;
  if (item.official) score += 80;
  if (typeof item.installs === 'number') score += Math.min(400, Math.log10(item.installs + 1) * 80);
  if (typeof item.stars === 'number') score += Math.min(400, Math.log10(item.stars + 1) * 80);
  if (item.source === 'official-registry') score += 30;
  if (item.source === 'smithery') score += 20;
  return score;
}

/**
 * Merge the same server seen through more than one catalog. GitHub repositories
 * are the reliable shared identity; anything without one stays keyed by id.
 * The surviving record is the highest scoring one (so an installable Smithery
 * row wins over the same repo's discovery-only awesome-list row).
 */
function mergeItems(collected) {
  const byKey = new Map();
  for (const item of collected) {
    const gh = parseGitHub(item.repository);
    const key = gh ? `repo:${gh.owner}/${gh.repo}`.toLowerCase() : `id:${item.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, sources: [item.source] });
      continue;
    }
    existing.sources = existing.sources.includes(item.source) ? existing.sources : [...existing.sources, item.source];
    if (itemScore(item) > itemScore(existing)) {
      const sources = existing.sources;
      Object.assign(existing, item, { sources });
    } else {
      // keep the richer half of the pair
      if (!existing.icon && item.icon) existing.icon = item.icon;
      if (existing.stars === undefined && item.stars !== undefined) existing.stars = item.stars;
      if (existing.installs === undefined && item.installs !== undefined) {
        existing.installs = item.installs;
        // The unit travels with the number: a merged record must not describe
        // Docker pulls with Smithery's label.
        existing.installsLabel = item.installsLabel;
        existing.installsWindow = item.installsWindow;
      }
      if (!existing.version && item.version) existing.version = item.version;
      if (!existing.author && item.author) existing.author = item.author;
      if (!existing.description && item.description) existing.description = item.description;
      if (!existing.repository && item.repository) existing.repository = item.repository;
      if (!existing.status && item.status) existing.status = item.status;
      if (existing.deprecated === undefined && item.deprecated !== undefined) existing.deprecated = item.deprecated;
      if (!existing.statusMessage && item.statusMessage) existing.statusMessage = item.statusMessage;
      // A category from the community index survives a merge that promoted a
      // registry record as the winner, so filtering still finds the entry.
      if (!existing.category && item.category) existing.category = item.category;
      for (const tag of item.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    }
  }
  return [...byKey.values()];
}

/** Search every source in parallel; degrade per-source. */
export async function searchOpenCatalogs(query, opts = {}) {
  const settled = await Promise.allSettled(CATALOG_SOURCES.map((id) => runSource(id, { ...opts, query })));
  const errors = [];
  const collected = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push({ source: CATALOG_SOURCES[i], message: String(r.reason?.message ?? r.reason) });
      return;
    }
    const [, items] = r.value;
    for (const item of items) {
      if (query && !matchItem(item, query)) continue;
      collected.push(item);
    }
  });
  const items = mergeItems(collected).sort((a, b) => itemScore(b) - itemScore(a) || a.title.localeCompare(b.title));
  return { items, errors };
}

/**
 * Browse the open MCP marketplaces without requiring a query: pulls one page
 * per source with a generous per-source cap, merges, dedupes and ranks the
 * result. This is what the settings page's "MCP 市场" tab lists on open, and
 * what `overall_mcp_catalog` returns for the agent.
 *
 * @param options.query - optional case-insensitive substring filter.
 * @param options.limit - maximum merged items returned (default 400).
 * @param options.perSource - per-source item cap (default: see SOURCE_BROWSE_CAPS).
 * @param options.source - optional single source id filter.
 * @param options.fetchImpl - injectable fetch (tests).
 * @returns { items, errors, counts, total } where counts is kept per source before merge.
 */
export async function browseCatalog({ query = '', limit = 400, perSource = 100, source = '', ...opts } = {}) {
  const ids = source ? [source] : CATALOG_SOURCES.slice();
  const settled = await Promise.allSettled(ids.map((id) => runSource(id, { ...opts, query, perSource })));
  const errors = [];
  const counts = {};
  const collected = [];

  settled.forEach((result, i) => {
    const sourceId = ids[i];
    if (result.status === 'rejected') {
      errors.push({ source: sourceId, message: String(result.reason?.message ?? result.reason) });
      return;
    }
    const [, items] = result.value;
    counts[sourceId] = items.length;
    for (const item of items) {
      if (query && !matchItem(item, query)) continue;
      collected.push(item);
    }
  });

  const merged = mergeItems(collected);
  // Derive the functional group after the merge, so a merged record whose
  // winning half came from a registry still gets a group from the community
  // heading the merge preserved.
  for (const item of merged) item.group = functionalGroupOf(item);
  const items = orderItems(merged, source).slice(0, limit);
  return { items, errors, counts, total: merged.length };
}

/**
 * Order the merged market listing.
 *
 * A single-source listing (or a keyword search) is simply ranked by relevance.
 * The combined "all markets" listing is interleaved round-robin per source
 * instead: the catalogs have very different sizes (the community index has
 * hundreds of rows, Smithery ten), so pure score ordering buries two of the
 * three catalogs entirely and the page stops showing what is actually on the
 * market. Within one source the relevance order is preserved.
 */
function orderItems(items, sourceFilter) {
  const byScore = (a, b) => itemScore(b) - itemScore(a) || a.title.localeCompare(b.title);
  if (sourceFilter) return items.slice().sort(byScore);

  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.source)) buckets.set(item.source, []);
    buckets.get(item.source).push(item);
  }
  const order = CATALOG_SOURCES.filter((id) => buckets.has(id));
  for (const id of buckets.keys()) if (!order.includes(id)) order.push(id);
  const queues = order.map((id) => buckets.get(id).sort(byScore));

  const out = [];
  for (let round = 0; out.length < items.length; round += 1) {
    let progressed = false;
    for (const queue of queues) {
      if (round < queue.length) { out.push(queue[round]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub star / author enrichment (used by the market cards, lazily)
// ---------------------------------------------------------------------------

/** Extract the distinct `owner/repo` pairs of a list of catalog items. */
export function githubReposOf(items, max = 40) {
  const out = [];
  const seen = new Set();
  for (const item of items ?? []) {
    const gh = parseGitHub(item?.repository);
    if (!gh) continue;
    const key = `${gh.owner}/${gh.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, owner: gh.owner, repo: gh.repo, url: item.repository });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Fetch GitHub stars/description for a bounded set of repositories. One request
 * per repo (the REST API has no batch endpoint), so callers keep the list short.
 *
 * Returns `{ [owner/repo]: stats, rateLimited }`. A repo that fails for any
 * reason is simply absent rather than fabricated, and once GitHub answers with
 * a rate-limit error the remaining repos are skipped and `rateLimited` is set,
 * so the caller stops spending its hour on guaranteed failures.
 */
export async function fetchRepoStats(repos, { fetchImpl = fetch } = {}) {
  const entries = await Promise.allSettled((repos ?? []).map(async ({ key, owner, repo, url }) => {
    const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, {
      timeoutMs: 12000,
      fetchImpl,
      accept: 'application/vnd.github+json',
    });
    return [key, {
      stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined,
      author: data.owner?.login ?? owner,
      avatar: data.owner?.avatar_url,
      description: clampText(data.description, 200) || undefined,
      homepage: data.homepage || url,
      topics: Array.isArray(data.topics) ? data.topics.slice(0, 6) : [],
      pushedAt: data.pushed_at,
      forks: typeof data.forks_count === 'number' ? data.forks_count : undefined,
      openIssues: typeof data.open_issues_count === 'number' ? data.open_issues_count : undefined,
      watchers: typeof data.subscribers_count === 'number' ? data.subscribers_count : undefined,
      language: data.language || undefined,
      license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : undefined,
      archived: data.archived === true || undefined,
      createdAt: data.created_at,
    }];
  }));
  const stats = {};
  let rateLimited = false;
  entries.forEach((r) => {
    if (r.status === 'fulfilled') stats[r.value[0]] = r.value[1];
    else if (isRateLimitError(r.reason)) rateLimited = true;
  });
  return { ...stats, rateLimited };
}

/** 403 with an empty/0 remaining header is GitHub's unauthenticated quota wall. */
function isRateLimitError(reason) {
  const message = String(reason?.message ?? reason ?? '');
  return /HTTP 403|HTTP 429|rate limit/i.test(message);
}

/** Build a registry entry from a catalog item's install plan (user-confirmed). */
export function catalogItemToEntry(item) {
  if (!item?.install) return null;
  const now = new Date().toISOString();
  const name = item.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'mcp';
  if (item.install.transport === 'stdio') {
    return {
      name,
      source: `catalog:${item.source}`,
      transport: 'stdio',
      command: item.install.command,
      args: item.install.args ?? [],
      env: {},
      enabled: true,
      notes: `installed from ${item.source}`,
      importedAt: now,
    };
  }
  if (item.install.transport === 'streamable-http') {
    return { name, source: `catalog:${item.source}`, transport: 'streamable-http', url: item.install.url, headers: {}, enabled: true, notes: `installed from ${item.source}`, importedAt: now };
  }
  return null; // unknown transport — needs manual wiring (repo link shown to user)
}
