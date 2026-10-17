// lib/server-config.js — which settings an installed MCP server needs before it
// can actually work, and how a value gets into the entry.
//
// The failure this exists for: a server installs, mounts, and every tool call
// then fails with `401`, `unauthorized`, or `missing API key`. The plugin knew
// nothing about that — it wrote `env: {}` and reported 「已安装并连接」 — so the
// first person to find out was whoever tried to use a tool, reading an error
// from a process they never configured. The catalogue already knows the answer
// for the best sources: the official registry publishes, per package, an
// `environmentVariables` list with `isRequired`/`isSecret`/`description`. That is
// evidence, not a guess, and it is the reason this module takes the raw registry
// record rather than heuristics alone.
//
// Two rules shape everything here:
//
//   1. A missing *required* field is a fact (`missing`), and it is the only thing
//      that may be called 待配置. An optional field that is empty is a *hint*
//      (`pending`) — saying "this server needs configuration" about a server that
//      works fine is how a reminder becomes noise nobody reads.
//   2. Values never leave this process sideways. `maskedFields` is the only
//      projection the panel and the model get: a secret comes back as `••••` or
//      as nothing at all, never as the value, and never as its length.

/** Hard cap on how many fields one entry may declare (a wall of inputs is not a form). */
export const MAX_CONFIG_FIELDS = 24;
/** Hard cap on one value. A private key fits; a pasted file does not. */
export const MAX_VALUE_CHARS = 4096;
/** How much of a non-secret value a payload may carry back for display. */
export const MAX_ECHO_CHARS = 200;

/** A legal environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A legal HTTP header field name (RFC 7230 token). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Names that would write through to Object.prototype if used as object keys. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** HTTP transport-level headers that must not be overridden in mcp-client requests. */
export const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
]);

/**
 * Environment variables that trigger code execution or library preloading in child
 * runtimes. The model must not be allowed to set these via overall_mcp_configure.
 */
export const CODE_LOADING_ENV_VARS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'COMSPEC',
  'PATHEXT',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'PS4',
  'PROMPT_COMMAND',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
  'PERL5LIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
]);

/**
 * Field names that read as credentials when they appear as a bare argument
 * token. Deliberately narrow: an uppercase word alone is not evidence (every
 * `--read-only` and every `GITHUB` is uppercase), so the name must also end in a
 * suffix that names a secret or a connection target.
 */
const CREDENTIAL_SUFFIX = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PAT|CREDENTIALS?|AUTH|DSN|CONNECTION_STRING)$|API[_-]?KEY|ACCESS[_-]?TOKEN/i;
const TARGET_SUFFIX = /_(?:URL|URI|ENDPOINT|HOST|BASE_URL|SERVER)$/;

/**
 * What a mount error has to say before "you need to configure this" is the
 * honest reading. Kept as a speech act, not a diagnosis: these are the phrasings
 * MCP servers actually emit when a credential is absent or rejected.
 */
const AUTH_FAILURE = new RegExp([
  '\\b(?:401|403)\\b',
  'unauthori[sz]ed',
  '\\bforbidden\\b',
  'invalid[ _-]?(?:api[ _-]?)?(?:key|token|credential)',
  '\\bapi[ _-]?key\\b',
  '\\baccess[ _-]?token\\b',
  '(?:missing|required|no|without)\\s+(?:an?\\s+)?(?:env|environment variable|credential|token|api key|secret)',
  'authenticat\\w*',
  '\\bcredential\\w*',
  '\\bnot (?:logged|signed) in\\b',
  '请先(?:登录|配置|设置)',
  '未配置',
  '缺少(?:密钥|令牌|凭据|配置)',
].join('|'), 'i');
/** Errors that are about quota, not identity — a token would not fix these. */
const QUOTA_HINT = /\b(?:rate limit|quota|too many requests|\b429\b)/i;

/**
 * One field, normalised.
 *
 * @param input - `{ key, kind, label, help, required, secret, origin }` (only
 *   `key` is mandatory).
 * @param defaults - `{ kind, origin }` applied when the input omits them.
 * @returns the field, or `null` when the key is not legal for its kind.
 */
export function normalizeField(input, { kind = 'env', origin = 'manual' } = {}) {
  const key = typeof input?.key === 'string' ? input.key.trim() : '';
  if (key === '' || UNSAFE_KEYS.has(key)) return null;
  const fieldKind = input?.kind === 'header' ? 'header' : kind === 'header' ? 'header' : 'env';
  if (fieldKind === 'env' ? !ENV_NAME.test(key) : !HEADER_NAME.test(key)) return null;
  if (fieldKind === 'header' && RESERVED_HEADERS.has(key.toLowerCase())) return null;
  const help = typeof input?.help === 'string' ? input.help.trim() : '';
  return {
    key,
    kind: fieldKind,
    // The label is the key unless the catalogue published a human sentence; the
    // description goes in `help` either way, because a form field whose only
    // label is `GH_TOKEN` still needs to say what a GH_TOKEN is.
    label: typeof input?.label === 'string' && input.label.trim() !== '' ? input.label.trim() : key,
    ...(help === '' ? {} : { help: capText(help, 400) }),
    required: input?.required === true,
    secret: input?.secret === true || (input?.secret == null && CREDENTIAL_SUFFIX.test(key)),
    origin: typeof input?.origin === 'string' && input.origin !== '' ? input.origin : origin,
  };
}

/** Trim and cap one block of text, keeping the head (a description's first sentence carries it). */
function capText(text, max) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Redact userinfo and sensitive query params from a non-secret string before echo.
 * Even when a setting is marked non-secret (e.g. LLM_BASE_URL or CONFIG_URL),
 * a user might paste `https://user:password@host` or `https://host/?api_key=secret`.
 */
export function redactEchoValue(raw) {
  const str = String(raw ?? '');
  if (str === '') return '';
  const noUserInfo = str.replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/g, '$1$2:••••@');
  const noQuerySecret = noUserInfo.replace(/([?&](?:api[ _-]?key|(?:access[ _-]?)?token|secret|password|passwd|auth|credential)=)[^&#\s]*/gi, '$1••••');
  return capText(noQuerySecret, MAX_ECHO_CHARS);
}

/** Dedupe fields by `key`+`kind`, keeping the first (the more authoritative) one. */
function dedupe(fields) {
  const seen = new Set();
  const out = [];
  for (const field of fields) {
    const id = `${field.kind}:${field.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(field);
    if (out.length >= MAX_CONFIG_FIELDS) break;
  }
  return out;
}

/**
 * The fields the official registry publishes for one item, if it is from there.
 *
 * The record is read the way the schema defines it: every `packages[]` entry may
 * carry `environmentVariables[]`, and a `remotes[]` entry may carry `headers[]`.
 * Packages are unioned rather than picked: the panel installs whichever package
 * the catalogue already chose (`item.install`), and re-deriving that choice here
 * would be a second opinion about which package is meant. A variable required by
 * *any* of them is required, and any package marking it secret makes it secret.
 *
 * @param item - a catalogue item (`item.raw` is the registry record, verbatim).
 * @returns `{ fields, origin: 'official' }` or `null` when the item declares none.
 */
export function officialFields(item) {
  const raw = item?.raw;
  if (!raw || typeof raw !== 'object') return null;
  const fields = [];
  for (const pkg of Array.isArray(raw.packages) ? raw.packages : []) {
    const vars = Array.isArray(pkg?.environmentVariables) ? pkg.environmentVariables : [];
    for (const variable of vars) {
      const field = normalizeField({
        key: variable?.name,
        label: variable?.name,
        help: variable?.description,
        required: variable?.isRequired === true,
        secret: variable?.isSecret === true,
        origin: 'official',
      }, { kind: 'env', origin: 'official' });
      if (field) fields.push(field);
    }
  }
  for (const remote of Array.isArray(raw.remotes) ? raw.remotes : []) {
    for (const header of Array.isArray(remote?.headers) ? remote.headers : []) {
      const field = normalizeField({
        key: typeof header === 'string' ? header : header?.name,
        label: typeof header === 'string' ? header : header?.name,
        help: typeof header === 'string' ? '' : header?.description,
        required: (typeof header === 'object' && header?.isRequired === true),
        secret: (typeof header === 'object' && header?.isSecret !== false),
        origin: 'official',
      }, { kind: 'header', origin: 'official' });
      if (field) fields.push(field);
    }
  }
  return fields.length ? { fields: dedupe(fields), origin: 'official' } : null;
}

/**
 * The fields an entry's own command line implies.
 *
 * This is the fallback for every source that publishes no declaration (Smithery's
 * list API, the Docker catalogue, awesome lists, GitHub repos, hand-written
 * configs). Three shapes are read, all of them things a server's *own documented
 * launcher* contains:
 *
 *   - an env flag: `-e NAME`, `--env NAME`, `-e NAME=value`, `--env=NAME`;
 *   - a placeholder: `$NAME`, `${NAME}`, `{NAME}` in the command, an argument, or
 *     the URL;
 *   - a bare credential-shaped token: `GITHUB_PERSONAL_ACCESS_TOKEN` (this is
 *     exactly how the official GitHub image is launched), matched only when the
 *     name ends in a credential or target suffix.
 *
 * @param entry - `{ command, args, url }` as the registry stores it.
 * @returns `{ fields, origin: 'args' }` or `null` when nothing matched.
 */
export function argFields(entry) {
  const args = (Array.isArray(entry?.args) ? entry.args : []).map((a) => String(a));
  const command = typeof entry?.command === 'string' ? entry.command : '';
  const url = typeof entry?.url === 'string' ? entry.url : '';
  const found = [];
  const add = (key, { secret, required } = {}) => {
    const isSecret = secret ?? secretLooking(key);
    const isRequired = required ?? secretLooking(key);
    const field = normalizeField({ key, label: key, origin: 'args', secret: isSecret, required: isRequired }, { kind: 'env', origin: 'args' });
    if (field) found.push(field);
  };
  const secretLooking = (name) => CREDENTIAL_SUFFIX.test(name);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // Longest-first alternation: --environment, --env, -e.
    // -e must be followed by =, whitespace, or a capital/underscore variable name (not lowercase like -eslint).
    let envToken = null;
    const longMatch = arg.match(/^(?:--environment|--env)(?:=(.*)|$)/);
    if (longMatch) {
      envToken = longMatch[1] !== undefined ? longMatch[1] : (args[i + 1] ?? '');
    } else {
      const shortMatch = arg.match(/^-e(?:=(.*)|(?=[A-Z_])(.*)|$)/);
      if (shortMatch) {
        envToken = shortMatch[1] ?? shortMatch[2] ?? (args[i + 1] ?? '');
      }
    }
    if (envToken !== null) {
      const name = envToken.split('=')[0].trim();
      if (name !== '' && ENV_NAME.test(name)) {
        add(name, { secret: secretLooking(name), required: secretLooking(name) });
      }
    }
    // A bare credential-shaped token: `GITHUB_PERSONAL_ACCESS_TOKEN`.
    for (const token of arg.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []) {
      if (CREDENTIAL_SUFFIX.test(token) || TARGET_SUFFIX.test(token)) {
        add(token, { secret: CREDENTIAL_SUFFIX.test(token), required: CREDENTIAL_SUFFIX.test(token) });
      }
    }
    // Placeholders: `$NAME`, `${NAME}`, `{NAME}`.
    for (const match of arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|(?<![A-Za-z0-9_$])\{([A-Z][A-Z0-9_]*)\}/g)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name) add(name, { secret: secretLooking(name), required: secretLooking(name) });
    }
  }
  for (const text of [command, url]) {
    for (const match of String(text).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|(?<![A-Za-z0-9_$])\{([A-Z][A-Z0-9_]*)\}/g)) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name) add(name, { secret: secretLooking(name), required: secretLooking(name) });
    }
  }
  return found.length ? { fields: dedupe(found), origin: 'args' } : null;
}

/**
 * A streamable-http entry always gets one optional header field.
 *
 * Deliberately *optional*: most remote MCP endpoints are anonymous, and a
 * required field nobody can fill would make every remote server look broken.
 * What it buys is a place to put a bearer token that the server will actually
 * receive, next to the line that explains why it might be needed.
 *
 * @param entry - the registry entry.
 * @returns `{ fields }`, or `null` when the entry is not remote.
 */
export function remoteFields(entry) {
  if (entry?.transport !== 'streamable-http' && entry?.transport !== 'sse') return null;
  const field = normalizeField({
    key: 'Authorization',
    kind: 'header',
    label: 'Authorization',
    help: '如果这个远端服务需要令牌，按它文档要求的格式填进来（多数是 `Bearer <令牌>`）。公开端点留空即可。',
    required: false,
    secret: true,
    origin: 'manual',
  }, { kind: 'header', origin: 'manual' });
  return field ? { fields: [field], origin: 'manual' } : null;
}

/**
 * The complete spec for one entry: the declaration first, the command line
 * second, the remote-header affordance last, deduped by key.
 *
 * @param item - the catalogue item, when the entry came from one.
 * @param entry - the registry entry.
 * @returns `{ fields, origin }`; `origin` names the strongest evidence used
 *   (`official` > `args` > `manual`), and `null` when the entry needs nothing.
 */
export function configSpecFor(item, entry) {
  const sources = [officialFields(item), argFields(entry), remoteFields(entry)].filter(Boolean);
  if (sources.length === 0) return null;
  const rank = { official: 3, args: 2, manual: 1 };
  const fields = dedupe(sources.flatMap((source) => source.fields));
  const origin = sources
    .map((source) => source.origin)
    .sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0];
  return { fields, origin };
}

/** The stored spec for one entry, or a spec derived from the entry itself. */
export function specOf(entry) {
  const stored = entry?.config;
  if (stored && Array.isArray(stored.fields)) {
    const fields = dedupe(stored.fields
      .map((field) => normalizeField({ ...field, kind: field?.kind }, { kind: field?.kind === 'header' ? 'header' : 'env' }))
      .filter(Boolean));
    return fields.length ? { fields, origin: typeof stored.origin === 'string' ? stored.origin : 'manual' } : null;
  }
  return configSpecFor(null, entry);
}

/** The value currently stored for one field, or `''`. */
function valueOf(entry, field) {
  const bag = field.kind === 'header' ? entry?.headers : entry?.env;
  const value = bag && typeof bag === 'object' ? bag[field.key] : undefined;
  return typeof value === 'string' ? value : '';
}

/**
 * Split a spec's fields into what blocks the server and what merely could be
 * filled in.
 *
 * @param spec - `{ fields }`.
 * @param entry - the registry entry holding the values.
 * @returns `{ missing, pending }` — arrays of field keys.
 */
export function fieldGaps(spec, entry) {
  const missing = [];
  const pending = [];
  for (const field of spec?.fields ?? []) {
    if (valueOf(entry, field).trim() !== '') continue;
    if (field.required) missing.push(field.key);
    else pending.push(field.key);
  }
  return { missing, pending };
}

/**
 * The only projection of an entry's configuration that may leave the host.
 *
 * `value` is the masked echo: `••••` for a secret that has a value, `''` when it
 * does not, and the (capped) real value for a non-secret — a URL is not a secret
 * and echoing it back is what lets a reader see which environment this entry
 * points at.
 *
 * @param spec - `{ fields, origin }`.
 * @param entry - the registry entry.
 * @returns `{ fields: [...], missing, pending, origin }`; `null` when the entry
 *   declares nothing, so a plain server row carries no empty config object.
 */
export function maskedFields(spec, entry) {
  if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) return null;
  const gaps = fieldGaps(spec, entry);
  return {
    origin: spec.origin ?? 'manual',
    missing: gaps.missing,
    pending: gaps.pending,
    fields: spec.fields.map((field) => {
      const value = valueOf(entry, field);
      const hasValue = value.trim() !== '';
      return {
        key: field.key,
        kind: field.kind,
        label: field.label,
        ...(field.help ? { help: field.help } : {}),
        required: field.required === true,
        secret: field.secret === true,
        hasValue,
        value: field.secret ? (hasValue ? '••••' : '') : redactEchoValue(value),
      };
    }),
  };
}

/**
 * Write values into an entry.
 *
 * Unknown keys are accepted: the panel offers a key/value row for exactly the
 * case where the declaration missed something, and a host that rejected the
 * user's own environment would be lying about who owns this file. What is *not*
 * accepted is anything that cannot be sent literally — a header value with a
 * newline in it, an illegal name, or a name that would write through to
 * `Object.prototype` — because those are the shapes that turn a config form into
 * a request-splitting bug.
 *
 * An empty string *deletes* the key. That is how 清除 works, and it keeps the
 * stored document free of empty strings that look like values to every reader.
 *
 * @param entry - the registry entry (mutated).
 * @param values - `{ env?: {..}, headers?: {..} }` as the panel or the model sent.
 * @param options - `{ actor?: 'user' | 'model' }` (model calls reject code-loading env vars).
 * @returns `{ changed, rejected }` — `rejected` entries are `{ key, kind, reason }`.
 */
export function applyValues(entry, values = {}, { actor = 'user' } = {}) {
  const changed = [];
  const rejected = [];
  const target = (kind) => {
    if (kind === 'header') {
      if (!entry.headers || typeof entry.headers !== 'object') entry.headers = {};
      return entry.headers;
    }
    if (!entry.env || typeof entry.env !== 'object') entry.env = {};
    return entry.env;
  };
  const kinds = [['env', values?.env], ['header', values?.headers]];
  for (const [kind, bag] of kinds) {
    if (!bag || typeof bag !== 'object') continue;
    for (const [rawKey, rawValue] of Object.entries(bag)) {
      const key = String(rawKey).trim();
      const legal = kind === 'env' ? ENV_NAME.test(key) : HEADER_NAME.test(key);
      if (!legal || UNSAFE_KEYS.has(key)) {
        rejected.push({ key, kind, reason: kind === 'env' ? '不是合法的环境变量名' : '不是合法的请求头名' });
        continue;
      }
      if (kind === 'header' && RESERVED_HEADERS.has(key.toLowerCase())) {
        rejected.push({ key, kind, reason: '传输层保留请求头禁止配置' });
        continue;
      }
      if (actor === 'model' && kind === 'env' && CODE_LOADING_ENV_VARS.has(key.toUpperCase())) {
        rejected.push({ key, kind, reason: '该环境变量可能导致代码执行，禁止模型调用配置' });
        continue;
      }
      const value = typeof rawValue === 'string' ? rawValue : rawValue == null ? '' : String(rawValue);
      if (kind === 'header' && /[\r\n]/.test(value)) {
        // A newline in a header value is the classic request-splitting shape.
        rejected.push({ key, kind, reason: '请求头的值不能含换行' });
        continue;
      }
      const store = target(kind);
      const trimmed = value.trim();
      if (trimmed === '') {
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          delete store[key];
          changed.push({ key, kind, action: 'cleared' });
        }
        continue;
      }
      const isTruncated = trimmed.length > MAX_VALUE_CHARS;
      const capped = isTruncated ? trimmed.slice(0, MAX_VALUE_CHARS) : trimmed;
      if (store[key] === capped) continue;
      store[key] = capped;
      changed.push({ key, kind, action: isTruncated ? 'truncated' : 'set' });
    }
  }
  return { changed, rejected };
}

/**
 * Whether an error text reads as "a credential is missing or rejected".
 *
 * A quota error is not an identity error: a token would not fix `rate limit`, so
 * those are excluded even when they also mention one, unless the text names
 * authentication explicitly.
 *
 * @param errorText - whatever the mount reported.
 * @returns a boolean.
 */
export function looksLikeCredentialFailure(errorText) {
  const text = String(errorText ?? '');
  if (text.trim() === '') return false;
  if (!AUTH_FAILURE.test(text)) return false;
  if (QUOTA_HINT.test(text) && !/unauthori[sz]ed|authenticat|credential|api[ _-]?key|请先|未配置/i.test(text)) return false;
  return true;
}

/**
 * The one-line summary the panel puts on a row and the model gets in a list.
 *
 * @param spec - `{ fields }`.
 * @param entry - the registry entry.
 * @returns `{ needs: true, missing, pending }` when a required value is absent,
 *   `{ needs: false, pending }` when only hints are missing, `null` when the
 *   entry declares no configuration at all.
 */
export function configState(spec, entry) {
  if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) return null;
  const gaps = fieldGaps(spec, entry);
  if (gaps.missing.length === 0 && gaps.pending.length === 0) return { needs: false, missing: [], pending: [] };
  return { needs: gaps.missing.length > 0, missing: gaps.missing, pending: gaps.pending };
}
