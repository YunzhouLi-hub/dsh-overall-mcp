/**
 * Recovering an install command from the repository itself.
 *
 * The GitHub source is a *discovery* source: a repository listing carries no
 * install information, so its rows ship `install: null` and the panel says
 * "需手动配置". That is honest but unhelpful for the thousands of MCP servers
 * whose only publication *is* a repository — the author did write down how to
 * run it, just not in a registry.
 *
 * This module reads that evidence and only that evidence, in order of strength:
 *
 *   `server.json`     the MCP registry's own manifest; the author states the
 *                     package and its registry themselves
 *   `package.json`    an npm package (needs a `bin` or `mcpName`: a library
 *                     with neither is not something `npx` can start)
 *   `pyproject.toml`  a PyPI package
 *   `README.md`       the author's own command line, quoted from the docs
 *
 * Every plan must be *confirmed* against the registry the command would fetch
 * from (npm / PyPI). An unconfirmed command is not an install button: a `npx`
 * line that 404s is a button that always fails, and this plugin would rather
 * show "需手动配置" than a command nobody has ever been able to run.
 *
 * Nothing here does I/O: the caller injects `fetchText` and `verifyPackage`.
 * That is what keeps the walk testable and the parsing reviewable.
 */

export const EVIDENCE_VERSION = 1;
export const EVIDENCE_FILE = 'install-evidence.json';

/** The files a repository might answer with, in the order they are asked. */
export const EVIDENCE_PATH = 'HEAD';
export const REPO_FILES = ['server.json', 'package.json', 'pyproject.toml', 'README.md'];

/**
 * Budget per background walk. Every file read and every registry confirmation
 * is one request; the walk is resumable (it writes what it found), so a run that
 * spends its budget simply continues next time rather than starting over.
 *
 * The walk reads `raw.githubusercontent.com`, which is a CDN rather than the
 * rate-limited API: a live probe sustained 18.5 requests a second with no
 * pushback at all. It still paces itself, because a plugin has no business
 * hammering a host it does not own, and because a census of ~1,800 rows costs
 * ~5,800 requests (measured: 3.3 per row). At this pacing a full pass takes
 * about fifteen minutes, so one nightly run covers the whole census.
 */
export const MAX_REQUESTS = 6000;
/** ~6.7 requests a second — deliberately below what the CDN tolerates. */
export const MIN_INTERVAL_MS = 150;
/** A run stops here even with budget left, so a background walk is bounded. */
export const MAX_WALK_MS = 25 * 60 * 1000;
/**
 * How many times one request is repeated before the walk gives up on it.
 *
 * Measured on this host: a census run died at request 260 with `fetch failed`
 * and covered 77 of 2111 repositories — one dropped connection ended the pass
 * for the other 2034. `fetch failed` is precisely the error a second attempt
 * usually answers, so the walk repeats the transient kinds (a dropped
 * connection, a 5xx) and stops on everything else: a 404 is an answer, and
 * budget, deadline and abort are decisions this walk already made.
 */
export const MAX_ATTEMPTS = 3;
/** First wait added after a failure; doubles per failure up to the cap below. */
export const BACKOFF_MS = 400;
export const MAX_BACKOFF_MS = 5000;
/**
 * Consecutive upstream refusals (403/429) that end the pass.
 *
 * Retrying a refusal once is right — these are often per-second limits that a
 * short wait clears. Retrying it forever is not: a 403 that survives three
 * attempts with a widening interval means the host wants us gone, and the next
 * run (which continues from here) is the polite answer.
 */
export const MAX_REFUSALS = 3;
/** A repository that yielded nothing is re-checked after this long. */
export const RETRY_NONE_MS = 14 * 24 * 60 * 60 * 1000;
/** A confirmed plan is re-confirmed this often (packages do get unpublished). */
export const REFRESH_PLAN_MS = 30 * 24 * 60 * 60 * 1000;
/** Evidence for a repository not seen by the index for this long is dropped. */
export const EVIDENCE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
export const EVIDENCE_MAX_ROWS = 20000;

const NPM_NAME = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i;
/** npm subcommands and flags that look like package names but are not. */
const NOT_A_PACKAGE = new Set(['install', 'i', 'init', 'create', 'run', 'exec', 'test', 'update', 'add', '-y', '--yes', '--package', '-p']);

function clampText(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** `npx -y <name>` — the npm runner form this plugin already installs. */
export function npmInstall(name) {
  return { transport: 'stdio', command: 'npx', args: ['-y', String(name)] };
}

/** `uvx <name>` — the same for a PyPI package. */
export function pypiInstall(name) {
  return { transport: 'stdio', command: 'uvx', args: [String(name)] };
}

/**
 * `package.json` → the npm package it publishes.
 *
 * `bin` or `mcpName` is required: without a binary entry `npx <pkg>` has
 * nothing to run, and a `private: true` package is by definition not on npm.
 */
export function packageJsonPlan(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const name = typeof json?.name === 'string' ? json.name.trim() : '';
  if (!name || !NPM_NAME.test(name)) return null;
  if (json.private === true) return { name, rejected: '仓库声明这是私有包（private: true），没有发布到 npm' };
  const bin = json.bin;
  const hasBin = typeof bin === 'string' ? Boolean(bin) : Boolean(bin && typeof bin === 'object' && Object.keys(bin).length);
  const mcpName = typeof json.mcpName === 'string' ? json.mcpName.trim() : '';
  if (!hasBin && !mcpName) return { name, rejected: 'package.json 里没有 bin（npx 没有可执行入口）' };
  return { name, registry: 'npm', install: npmInstall(name), kind: 'package.json', mcpName: mcpName || undefined };
}

/**
 * `pyproject.toml` → the PyPI project name. Only the two spellings that mean
 * "this project's name" are read; anything else is left alone rather than
 * guessed at with a TOML parser for one field.
 */
export function pyprojectPlan(text) {
  const source = String(text ?? '');
  const patterns = [
    /^\[project\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m,
    /^\[tool\.poetry\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const name = match?.[1]?.trim();
    if (name && NPM_NAME.test(name)) return { name, registry: 'pypi', install: pypiInstall(name), kind: 'pyproject.toml' };
  }
  return null;
}

/**
 * `server.json` → the registry manifest's package list (the same shape the
 * official registry serves). An npm package installs with `npx -y`, anything
 * else that declares an identifier with `uvx`; a remote-only manifest has no
 * command to recover, so it is not an install plan.
 */
export function serverJsonPlan(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const packages = Array.isArray(json?.packages) ? json.packages : [];
  const pkg = packages.find((p) => (p?.registry_type ?? p?.registryType) === 'npm') ?? packages[0];
  const identifier = String(pkg?.identifier ?? pkg?.name ?? '').trim();
  const registry = (pkg?.registry_type ?? pkg?.registryType) === 'npm' ? 'npm' : identifier ? 'pypi' : null;
  if (identifier && NPM_NAME.test(identifier)) {
    return {
      name: identifier,
      registry,
      install: registry === 'npm' ? npmInstall(identifier) : pypiInstall(identifier),
      kind: 'server.json',
    };
  }
  const remote = Array.isArray(json?.remotes) ? json.remotes[0] : null;
  if (typeof remote?.url === 'string' && remote.url) {
    return {
      name: null,
      registry: null,
      install: { transport: 'streamable-http', url: remote.url },
      kind: 'server.json',
    };
  }
  return null;
}

/**
 * The strongest plan the files alone can give. `readme` is deliberately not
 * consulted here: a README candidate has to be confirmed against a registry,
 * which is I/O, and the walk does that step by step.
 */
export function installPlanFromFiles({ serverJson, packageJson, pyproject } = {}) {
  let rejection = null;
  for (const [text, parse] of [[serverJson, serverJsonPlan], [packageJson, packageJsonPlan], [pyproject, pyprojectPlan]]) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const plan = parse(text);
    if (plan?.install) return plan;
    // A manifest that refuses is worth reporting, but only if nothing else in
    // the repository can produce a command: a private `package.json` says
    // nothing about whether the `pyproject.toml` beside it is published.
    if (plan?.rejected && !rejection) rejection = plan.rejected;
  }
  return rejection ? { install: null, kind: null, rejected: rejection } : null;
}

/**
 * Command lines a README shows, as package names to confirm.
 *
 * Only `npx`/`uvx` forms are read. A `docker run` in a README is *not* turned
 * into a button: the image may live on a registry we cannot confirm, and an
 * unconfirmed `docker run` fails the same way an unconfirmed `npx` does.
 */
export function readmeCommands(text) {
  const source = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (registry, name) => {
    const clean = String(name ?? '').replace(/[),.;:`'"]+$/, '');
    if (!clean || !NPM_NAME.test(clean) || NOT_A_PACKAGE.has(clean.toLowerCase())) return;
    const key = `${registry}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      registry,
      name: clean,
      install: registry === 'npm' ? npmInstall(clean) : pypiInstall(clean),
      kind: 'readme',
    });
  };

  for (const match of source.matchAll(/\bnpx\s+((?:-y|--yes)\s+)?((?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+)/gi)) {
    push('npm', match[2]);
  }
  for (const match of source.matchAll(/\buvx\s+(?:--from\s+((?:[a-z0-9-_.]+))|\s*((?:[a-z0-9-_.]+)))/gi)) {
    push('pypi', match[1] ?? match[2]);
  }
  return out;
}

/** One evidence row, shaped like the index's rows so the panel reads both alike. */
export function evidenceRowOf(id, plan, { at }) {
  return {
    id,
    at,
    kind: plan?.kind ?? 'none',
    registry: plan?.registry ?? null,
    name: plan?.name ?? null,
    install: plan?.install ?? null,
    reason: plan?.install ? null : clampText(plan?.rejected ?? '仓库里没有可识别的清单文件（server.json / package.json / pyproject.toml / README）', 200),
  };
}

/** This item's evidence, or null. */
export function installEvidenceOf(doc, itemId) {
  const id = String(itemId ?? '');
  if (!id || !Array.isArray(doc?.rows)) return null;
  return doc.rows.find((row) => row.id === id) ?? null;
}

/**
 * Fold a walk into what the file already held. Fresh rows win; rows the walk did
 * not reach are kept until they are older than `keepMs`, so an interrupted walk
 * does not throw away what earlier ones found.
 */
export function mergeInstallEvidence(previous, fresh, { at = new Date().toISOString(), keepMs = EVIDENCE_KEEP_MS, maxRows = EVIDENCE_MAX_ROWS, now = Date.now } = {}) {
  const merged = new Map();
  const cutoff = now() - keepMs;
  for (const row of previous ?? []) {
    const id = String(row?.id ?? '');
    if (!id) continue;
    const seen = Date.parse(row.at ?? '') || 0;
    if (seen && seen < cutoff) continue;
    merged.set(id, row);
  }
  for (const row of fresh ?? []) {
    const id = String(row?.id ?? '');
    if (!id) continue;
    merged.set(id, { ...row, firstSeen: merged.get(id)?.firstSeen ?? row.firstSeen ?? at });
  }
  return [...merged.values()].slice(0, maxRows);
}

/** Read-time document shape; tolerant of everything a hand-edited file can be. */
export function normalizeEvidenceDocument(raw) {
  const rows = Array.isArray(raw?.rows) ? raw.rows.filter((row) => row && typeof row.id === 'string') : [];
  return {
    version: EVIDENCE_VERSION,
    at: typeof raw?.at === 'string' ? raw.at : null,
    requests: Number.isFinite(raw?.requests) ? raw.requests : 0,
    partial: typeof raw?.partial === 'string' ? raw.partial : null,
    rows,
  };
}

export function evidenceDocumentOf({ at, rows, requests = 0, partial = null }) {
  return { version: EVIDENCE_VERSION, at, rows, requests, partial };
}

/**
 * Read the evidence file. A missing file is "nothing checked yet"; a damaged one
 * is reported and treated the same way — like the GitHub index this is derived
 * data, so the recovery is a re-walk, not a quarantine.
 */
export async function readEvidenceDocument(file, readFileImpl) {
  let text;
  try {
    text = await readFileImpl(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { doc: null, damaged: null };
    return { doc: null, damaged: `install evidence unreadable: ${String(err?.message ?? err)}` };
  }
  try {
    const doc = normalizeEvidenceDocument(JSON.parse(text));
    return { doc: doc.rows.length ? doc : null, damaged: null };
  } catch (err) {
    return { doc: null, damaged: `install evidence damaged: ${String(err?.message ?? err)}` };
  }
}

/** Does this row still need a look? */
export function needsInstallEvidence(row, evidence, { now = Date.now, retryNoneMs = RETRY_NONE_MS, refreshPlanMs = REFRESH_PLAN_MS } = {}) {
  if (!row?.id) return false;
  if (!evidence) return true;
  const checked = Date.parse(evidence.at ?? '') || 0;
  if (!checked) return true;
  if (evidence.install) return now() - checked > refreshPlanMs;
  return now() - checked > retryNoneMs;
}

/** Merge a confirmed plan into a discovery row, with its provenance attached. */
export function applyInstallEvidence(item, evidence) {
  if (!item || !evidence?.install) return item;
  return {
    ...item,
    transport: evidence.install.transport,
    install: evidence.install,
    // The sentence is computed here rather than in the panel: the panel is a
    // browser bundle and cannot import this module, and the one thing the reader
    // must not lose is *where the command came from*.
    installSource: {
      kind: evidence.kind,
      registry: evidence.registry ?? null,
      name: evidence.name ?? null,
      at: evidence.at ?? null,
      text: describeInstallSource(evidence),
    },
  };
}

/** The provenance sentence the panel shows next to a recovered command. */
export function describeInstallSource(evidence) {
  if (!evidence?.install) return '';
  const registry = evidence.registry === 'npm' ? 'npm' : evidence.registry === 'pypi' ? 'PyPI' : null;
  switch (evidence.kind) {
    case 'server.json':
      return registry ? `命令来自仓库 server.json，作者自己声明；${registry} 上已确认这个包存在` : '命令来自仓库 server.json，作者自己声明';
    case 'package.json':
      return '命令来自仓库 package.json；npm 上已确认这个包存在';
    case 'pyproject.toml':
      return '命令来自仓库 pyproject.toml；PyPI 上已确认这个包存在';
    case 'readme':
      return registry
        ? `命令来自仓库 README 里作者自己写的命令；${registry} 上已确认这个包存在`
        : '命令来自仓库 README 里作者自己写的命令';
    default:
      return '命令来自仓库证据';
  }
}

/**
 * Recover install commands for as many rows as the budget allows.
 *
 * Per row the walk asks the repository for its manifest files; the first file
 * that yields a plan is confirmed against its registry, and only a confirmed
 * plan is written down. A README is only consulted when no manifest answered,
 * and then only its `npx`/`uvx` lines are tried, in the order they appear, until
 * one confirms. Rows are processed in the order given (the caller sorts by
 * stars), so a spent budget lands on the rows that matter least.
 *
 * @param options.rows          candidate rows (`{id, repository}`)
 * @param options.previous      evidence rows already on disk
 * @param options.fetchText     async (url) => text | null (null = 404 / unreadable)
 * @param options.verifyPackage async ({registry, name}) => boolean
 */
export async function crawlInstallEvidence({
  rows = [],
  previous = [],
  fetchText,
  verifyPackage,
  rawBase = 'https://raw.githubusercontent.com',
  maxRequests = MAX_REQUESTS,
  minIntervalMs = MIN_INTERVAL_MS,
  maxMs = MAX_WALK_MS,
  maxAttempts = MAX_ATTEMPTS,
  backoffMs = BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  maxRefusals = MAX_REFUSALS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  now = Date.now,
  onProgress,
} = {}) {
  const fresh = [];
  const spent = { requests: 0 };
  const retried = { count: 0 };
  let refusals = 0;
  let partial = null;
  const startedAt = now();
  // How much of the plan this pass got through. `planned` counts the rows the
  // caller asked for that carry both halves of an identity; `attempted` counts
  // the ones it actually reached, so the panel can say "77 of 2111" without
  // re-deriving anything from the evidence file.
  const planned = rows.filter((row) => row?.id && row?.repository).length;
  let attempted = 0;
  const aborted = () => signal?.aborted === true;
  const exhausted = () => spent.requests >= maxRequests;
  const overDeadline = () => maxMs > 0 && now() - startedAt >= maxMs;
  const deadlineNote = () => `本次时间用完（约 ${Math.round(maxMs / 60000)} 分钟），下次继续`;
  const budgetNote = () => `请求预算用完（${maxRequests} 次），下次继续`;
  const retryNote = () => (retried.count > 0 ? `（重试 ${retried.count} 次仍失败）` : '');
  const stopNote = (err) => {
    if (err?.code === 'aborted') return '已中止';
    if (err?.code === 'deadline') return deadlineNote();
    if (err?.code === 'budget') return budgetNote();
    if (err?.code === 'refused') return `上游要求降速：${String(err.message ?? err)}${retryNote()}`;
    return `第 ${spent.requests} 次请求失败：${String(err?.message ?? err)}${retryNote()}`;
  };
  // Politeness is the walk's own business: the interval that keeps us below the
  // raw host's burst detection is decided here, where the request count and the
  // clock are, not in a fetch wrapper that only sees one URL. `extraMs` is the
  // widening applied on top of the base interval after a failure; it halves on
  // every success rather than resetting, because a host that just dropped one
  // request for going too fast is usually still unhappy a moment later.
  const pacing = { extraMs: 0 };
  const pace = async () => {
    const wait = Math.max(0, minIntervalMs) + pacing.extraMs;
    if (wait > 0) await sleep(wait);
  };
  const ease = () => { if (pacing.extraMs > 0) pacing.extraMs = Math.floor(pacing.extraMs / 2); };
  const harden = () => {
    const start = Math.max(0, backoffMs);
    pacing.extraMs = Math.min(pacing.extraMs > 0 ? pacing.extraMs * 2 : start, Math.max(0, maxBackoffMs));
  };
  /** The kinds worth repeating. Everything else is an answer or a decision. */
  const retryable = (err) => err?.code === 'network' || err?.code === 'upstream' || err?.code === 'refused';
  const canRetry = (tries) => tries < maxAttempts
    && refusals < maxRefusals
    && !aborted() && !exhausted() && !overDeadline();

  /** One counted, paced request. The guards run in the order that names the stop. */
  const readOnce = async (url) => {
    if (spent.requests > 0) await pace();
    if (aborted()) {
      const err = new Error('install evidence walk aborted');
      err.code = 'aborted';
      throw err;
    }
    if (exhausted()) {
      const err = new Error(`install evidence request budget spent (${maxRequests})`);
      err.code = 'budget';
      throw err;
    }
    if (overDeadline()) {
      const err = new Error(`install evidence walk deadline reached (${maxMs}ms)`);
      err.code = 'deadline';
      throw err;
    }
    spent.requests += 1;
    return fetchText(url);
  };

  /**
   * Repeat a transient failure, or rethrow the original error.
   *
   * The original error is what survives a give-up: if the retry is refused
   * because the budget or the deadline ran out, the note has to name the
   * dropped connection, not the budget it could not try again within.
   */
  const patient = async (send) => {
    for (let tries = 1; ; tries += 1) {
      try {
        const value = await send();
        refusals = 0;
        ease();
        return value;
      } catch (err) {
        if (!retryable(err)) throw err;
        if (err.code === 'refused') refusals += 1;
        harden();
        if (!canRetry(tries)) throw err;
        retried.count += 1;
      }
    }
  };

  const read = (url) => patient(() => readOnce(url));

  const confirm = async (plan) => {
    if (!plan?.install) return null;
    if (!plan.registry) return plan; // a remote-only server.json needs no package
    const verifyOnce = async () => {
      if (spent.requests > 0) await pace();
      if (aborted()) {
        const err = new Error('install evidence walk aborted');
        err.code = 'aborted';
        throw err;
      }
      if (exhausted()) {
        const err = new Error(`install evidence request budget spent (${maxRequests})`);
        err.code = 'budget';
        throw err;
      }
      if (overDeadline()) {
        const err = new Error(`install evidence walk deadline reached (${maxMs}ms)`);
        err.code = 'deadline';
        throw err;
      }
      spent.requests += 1;
      return verifyPackage({ registry: plan.registry, name: plan.name });
    };
    // The package registry is a second host with its own opinion about speed,
    // and a refusal there ends the pass just as surely as one from GitHub: the
    // confirmation gets the same patience as the file read above.
    const ok = await patient(verifyOnce);
    return ok ? plan : { ...plan, install: null, rejected: `${plan.registry === 'npm' ? 'npm' : 'PyPI'} 上没有这个包（${plan.name}）` };
  };

  for (const row of rows) {
    if (aborted() || exhausted() || overDeadline()) break;
    const id = String(row?.id ?? '');
    const repository = String(row?.repository ?? '');
    if (!id || !repository) continue;
    attempted += 1;
    const files = {};
    const slug = repository.replace(/^https?:\/\/github\.com\//, '');
    let plan = null;
    let rejection = null;
    try {
      for (const name of REPO_FILES) {
        const text = await read(`${rawBase}/${slug}/${EVIDENCE_PATH}/${name}`);
        files[name] = text;
        // The README is handled below: its command lines have to be confirmed
        // one by one, which is a decision this loop cannot make.
        if (name === 'README.md' || typeof text !== 'string' || !text.trim()) continue;
        const candidate = installPlanFromFiles({
          serverJson: name === 'server.json' ? text : undefined,
          packageJson: name === 'package.json' ? text : undefined,
          pyproject: name === 'pyproject.toml' ? text : undefined,
        });
        if (candidate?.install) { plan = candidate; break; }
        // A manifest that *refuses* (private package, no `bin`) is worth saying
        // out loud, but it does not stop the search: the README may still name a
        // package this repository publishes.
        if (candidate?.rejected && !rejection) rejection = candidate.rejected;
      }
      if (plan) {
        fresh.push(evidenceRowOf(id, await confirm(plan), { at: new Date(now()).toISOString() }));
        onProgress?.({ id, requests: spent.requests, kind: plan.kind });
        continue;
      }
    } catch (err) {
      partial = stopNote(err);
      break;
    }

    // No manifest answered with a runnable plan: the README's own command lines
    // are the last evidence, and each candidate has to confirm before it counts.
    if (typeof files['README.md'] === 'string' && files['README.md'].trim()) {
      let settled = null;
      let failure = null;
      for (const candidate of readmeCommands(files['README.md'])) {
        let confirmed;
        try {
          confirmed = await confirm(candidate);
        } catch (err) {
          failure = err;
          break;
        }
        if (confirmed?.install) { settled = confirmed; break; }
      }
      if (failure) {
        partial = partial ?? stopNote(failure);
        break;
      }
      if (settled) {
        fresh.push(evidenceRowOf(id, settled, { at: new Date(now()).toISOString() }));
        onProgress?.({ id, requests: spent.requests, kind: 'readme' });
      } else {
        fresh.push(evidenceRowOf(id, rejection ? { install: null, rejected: rejection } : null, { at: new Date(now()).toISOString() }));
        onProgress?.({ id, requests: spent.requests, kind: 'none' });
      }
      continue;
    }

    fresh.push(evidenceRowOf(id, rejection ? { install: null, rejected: rejection } : null, { at: new Date(now()).toISOString() }));
    onProgress?.({ id, requests: spent.requests, kind: 'none' });
  }

  const at = new Date(now()).toISOString();
  // Running out of budget or time is not a failure of any request — it is the
  // walk stopping where it planned to stop, and the next run continues from here.
  if (!partial && exhausted()) partial = budgetNote();
  if (!partial && overDeadline()) partial = deadlineNote();
  if (!partial && aborted()) partial = '已中止';
  return {
    rows: mergeInstallEvidence(previous, fresh, { at, now }),
    checked: fresh.length,
    requests: spent.requests,
    // `requests` counts retries and confirmations; `checked` counts repositories
    // that produced evidence. The caller shows both, because "6000 requests for
    // 1500 repositories" is only alarming until you see it is 4 per row.
    retries: retried.count,
    planned,
    attempted,
    remaining: Math.max(0, planned - attempted),
    at,
    partial,
    complete: !partial,
  };
}
