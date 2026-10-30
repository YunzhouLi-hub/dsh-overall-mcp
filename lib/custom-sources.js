/**
 * User-managed catalogue sources.
 *
 * The built-in five sources are hard-coded in `lib/catalog.js`; this module owns
 * the ones a user adds, so a team can point the market at its own registry
 * document (a `registry.json` in a repository, an internal mirror, a CDN copy)
 * without patching this plugin.
 *
 * Two decisions are deliberate:
 *
 *   - **https only.** The document's rows become install commands that DSH will
 *     later execute. Fetched over plain http, anyone on the path could rewrite
 *     as「curl … | sh」. A local file would be safer still, but the point of a
 *     remote source is that it is maintained somewhere else.
 *   - **No credentials in the URL.** `https://user:token@host/…` would be
 *     persisted verbatim into `$DSH_HOME/overall-mcp/sources.json` and echoed
 *     into payloads and logs. A private catalog needs a different mechanism
 *     (a local file, or a host with its own auth), not a secret in this list.
 *
 * The document itself is validated only for shape; whether the URL actually
 * answers, parses and yields rows is reported per source in the panel, where a
 * failure is visible next to the source that caused it.
 */

export const SOURCES_VERSION = 1;

/**
 * Cap on stored sources. Each one costs at least one upstream request per browse
 * (and a 304 on the next), so this is a request budget as much as a UI limit.
 */
export const SOURCES_MAX = 8;

export const LABEL_MAX = 40;
export const URL_MAX = 600;
/** The id ends up in cache keys, counts and the panel, so keep it short. */
const ID_MAX = 48;

export function emptySources() {
  return { version: SOURCES_VERSION, sources: [] };
}

/** Coerce whatever was on disk into a usable document; unusable rows are dropped. */
export function normalizeSourcesDocument(raw) {
  const doc = emptySources();
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [];
  const seen = new Set();
  for (const row of rows) {
    if (doc.sources.length >= SOURCES_MAX) break;
    const typed = typeof row?.url === 'string' ? row.url.trim() : '';
    if (!typed) continue;
    // Same vetting as a fresh addition: this file is editable by hand and it
    // holds addresses whose rows become commands, so a plain-http or
    // credentialed row typed in directly is dropped here too rather than only
    // on the way in through the panel.
    const vetted = normalizeSourceUrl(typed);
    if (vetted.error) continue;
    const url = vetted.url;
    const id = typeof row?.id === 'string' && row.id.startsWith('custom:') ? row.id : sourceIdFor(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row?.label === 'string' && row.label.trim()
      ? row.label.trim().slice(0, LABEL_MAX)
      : defaultLabelFor(url);
    doc.sources.push({ id, label, url });
  }
  return doc;
}

/**
 * Read the document, keeping "no file yet" apart from "a file that does not
 * parse": the second one is quarantined by the caller before anything is saved
 * over it, exactly like a damaged registry.
 */
export async function readSourcesDocument(file, readFileImpl) {
  let raw;
  try {
    raw = await readFileImpl(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { sources: [], damaged: null };
    return { sources: [], damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { sources: [], damaged: 'JSON 顶层不是对象或数组' };
    return { sources: normalizeSourcesDocument(parsed).sources, damaged: null };
  } catch (err) {
    return { sources: [], damaged: String(err?.message ?? err) };
  }
}

/**
 * The document as it is written to disk. Takes either the array of sources or a
 * document that already carries one, so a caller round-tripping what it read
 * cannot hand in the wrong shape by accident.
 */
export function sourcesDocumentOf(sources) {
  const rows = Array.isArray(sources) ? sources : Array.isArray(sources?.sources) ? sources.sources : [];
  return { version: SOURCES_VERSION, sources: rows.map((s) => ({ id: s.id, label: s.label, url: s.url })) };
}

/**
 * Parse and vet one address. Returns a normalized URL or null; the reason is
 * kept separate so the panel can say *why* an address was refused, and it
 * carries the HTTP status the route should answer with so a refused address is
 * not reported as a plugin fault.
 */
export function normalizeSourceUrl(raw) {
  if (typeof raw !== 'string') return { error: '地址必须是字符串', status: 400 };
  const text = raw.trim();
  if (!text) return { error: '地址不能为空', status: 400 };
  if (text.length > URL_MAX) return { error: `地址过长（上限 ${URL_MAX} 字符）`, status: 400 };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: '不是一个合法的 URL（需要 http(s)://…）', status: 400 };
  }
  if (parsed.protocol !== 'https:') {
    return { error: `只接受 https 地址（当前是 ${parsed.protocol.replace(':', '')}）——这个文件里的安装命令会被本机执行，明文传输等于把它们交给路径上的任何人`, status: 400 };
  }
  if (parsed.username || parsed.password) {
    return { error: '地址里不能带用户名/密码：它会被明文存进 sources.json 并出现在日志里', status: 400 };
  }
  parsed.hash = '';
  return { url: parsed.toString() };
}

/**
 * A stable id for one address. Deterministic, because it keys the cache, the
 * counts and the panel's rows: the same URL must not become a new source after
 * a restart.
 */
export function sourceIdFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const slug = `${parsed.host}${parsed.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX - 'custom:'.length);
  return slug ? `custom:${slug}` : null;
}

/**
 * A human label for an address nobody labelled. GitHub and jsDelivr paths start
 * with the owner/repo, which is the name a user recognises; anything else falls
 * back to the host.
 */
export function defaultLabelFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '自定义源';
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.host === 'raw.githubusercontent.com' && parts.length >= 2) return `${parts[0]}/${parts[1]}`.slice(0, LABEL_MAX);
  if (parsed.host.endsWith('jsdelivr.net') && parts[0] === 'gh' && parts.length >= 3) {
    return `${parts[1]}/${parts[2].replace(/@.*$/, '')}`.slice(0, LABEL_MAX);
  }
  return (parts.length ? `${parsed.host}/${parts[0]}` : parsed.host).slice(0, LABEL_MAX);
}

/**
 * Check one proposed source against the list already configured. `selfId` lets
 * an edit keep its own row without tripping the duplicate check. A refusal
 * carries the status the route should answer with: a malformed address is the
 * caller's mistake (400), an address already in the list is a conflict with
 * state the caller did not see (409).
 */
export function validateSourceInput(input = {}, { existing = [], selfId = null } = {}) {
  const vetted = normalizeSourceUrl(input.url);
  if (vetted.error) return { ok: false, error: vetted.error, status: vetted.status ?? 400 };
  const url = vetted.url;
  const id = sourceIdFor(url);
  if (!id) return { ok: false, error: '无法从地址生成一个稳定的来源 id', status: 400 };
  const clash = (existing ?? []).find((s) => s.id !== selfId && (s.url === url || s.id === id));
  if (clash) return { ok: false, error: `这个地址已经添加过了（${clash.label}）`, status: 409 };
  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim().slice(0, LABEL_MAX)
    : defaultLabelFor(url);
  return { ok: true, source: { id, label, url } };
}

/** Append one source. Throws with a user-facing reason when it is refused. */
export function addSourceTo(doc, input) {
  const sources = doc?.sources ?? [];
  if (sources.length >= SOURCES_MAX) {
    const err = new Error(`自定义目录源最多 ${SOURCES_MAX} 个`);
    err.code = 'too-many-sources';
    // A conflict with the list as it stands, not a malformed request.
    err.status = 409;
    throw err;
  }
  const checked = validateSourceInput(input, { existing: sources });
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.code = 'invalid-source';
    err.status = checked.status ?? 400;
    throw err;
  }
  return { doc: { version: SOURCES_VERSION, sources: [...sources, checked.source] }, source: checked.source };
}

/** Remove one source by id. `removed` is null when the id was not configured. */
export function removeSourceFrom(doc, id) {
  const sources = doc?.sources ?? [];
  const removed = sources.find((s) => s.id === id) ?? null;
  return {
    doc: { version: SOURCES_VERSION, sources: sources.filter((s) => s.id !== id) },
    removed,
  };
}
