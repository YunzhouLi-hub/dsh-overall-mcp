/**
 * The GitHub uplink: one issue in, one row in a published `registry.json` out.
 *
 * A community list needs a place to be *written* that is not this machine. The
 * design keeps it that way:
 *
 *   - **The submission travels as an issue, not as a request.** The panel opens
 *     a prefilled `issues/new` page in the user's browser; the repo runs a
 *     GitHub Action on `issues`, validates the body with the functions below and
 *     commits the row back. No token lives on anyone's machine, nothing listens
 *     on a port, and the review that decides what lands is a normal pull request
 *     view of `registry.json`.
 *   - **One shape for both inputs.** The Action parses the body GitHub's issue
 *     form renders (`### 名称` followed by the value) *and* the `名称: …` lines
 *     the panel's prefilled URL produces, so the same issue works whether the
 *     author came from the panel or from the repo's own 「New issue」 button.
 *   - **A submission is not trusted.** These rows are read by every panel that
 *     points at the list, and their command becomes an install `command` there.
 *     So a row is refused here unless it is a single command plus an argument
 *     list (never a shell program), an https endpoint, and text of bounded
 *     length — the vetting is the same one the panel applies to its own sources.
 *
 * The published document is exactly what `lib/catalog.js` already reads for a
 * custom source (`{ servers: [...] }`), which is what makes the loop work: add
 * the repo's `registry.json` as a custom source and its rows appear in the
 * market beside the built-in five.
 */

import { URL_MAX, normalizeSourceUrl } from './custom-sources.js';

export const SUBMISSION_VERSION = 1;

/** The label the Action looks for when it has to explain a refusal. */
export const SUBMISSION_LABEL = 'mcp-listing';

/** The issue-form file a human picks in GitHub's UI (kept in `.github/`). */
export const SUBMISSION_TEMPLATE = 'mcp-listing.yml';

/** The published document, at the repository root. */
export const REGISTRY_FILE = 'registry.json';

const NAME_MAX = 120;
const DESCRIPTION_MAX = 600;
const COMMAND_MAX = 200;
const ARG_MAX = 120;
const ARGS_MAX = 32;
const TAG_MAX = 24;
const TAGS_MAX = 8;
const CATEGORY_MAX = 40;

/**
 * A command that is *one* program plus arguments. `|`, `;`, `&&`, backticks,
 * redirects and `$( )` turn a command into a small program, and this row is
 * executed on someone else's machine: a listing that needs a shell is a listing
 * this format cannot carry, so it is refused rather than silently executed.
 */
const SHELL_META = /[|;&`<>]|\$\(|\r|\n/;

/** The document as it is published. `servers` is what `mapCustomEntries` reads. */
export function emptyRegistry() {
  return { version: SUBMISSION_VERSION, updatedAt: null, servers: [] };
}

/**
 * The issue-body vocabulary. One list drives the template the panel prefills,
 * the form the repository ships, and the parser — a field renamed here cannot
 * drift out of sync with the thing that reads it.
 */
export const SUBMISSION_FIELDS = [
  { key: 'name', label: '名称', required: true, hint: '这个 MCP 服务叫什么（列表里显示的名字）' },
  { key: 'description', label: '说明', required: true, hint: '一两句话：它能做什么' },
  { key: 'command', label: '启动命令', required: false, hint: 'stdio 型填这一个：npx、uvx、docker 等可执行文件' },
  { key: 'args', label: '命令参数', required: false, hint: '传给上面那条命令的参数，用空格分隔' },
  { key: 'url', label: '服务地址', required: false, hint: 'streamable-http 型填这一个：https 端点' },
  { key: 'repository', label: '仓库', required: false, hint: '源码地址（https://github.com/owner/repo）' },
  { key: 'homepage', label: '主页', required: false, hint: '文档或主页地址' },
  { key: 'tags', label: '标签', required: false, hint: '逗号分隔，最多 8 个' },
  { key: 'category', label: '分类', required: false, hint: '例如：开发者工具' },
];

const FIELD_BY_LABEL = new Map(SUBMISSION_FIELDS.map((f) => [f.label, f]));

/** Strip C0 controls (and collapse runs) so one field cannot forge extra lines. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ');
  return text.trim().slice(0, max);
}

/** GitHub writes this into optional form fields the author left blank. */
function isPlaceholder(value) {
  const text = value.trim();
  return text === '_No response_' || text === 'No response' || text === '无回复' || text === '无';
}

function splitArgs(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((a) => clean(a, ARG_MAX))
    .filter(Boolean)
    .slice(0, ARGS_MAX);
}

function splitTags(value) {
  return String(value ?? '')
    .split(/[,，\s]+/)
    .map((t) => clean(t, TAG_MAX))
    .filter(Boolean)
    .slice(0, TAGS_MAX);
}

/** `owner/repo` for a repository URL, lowercased; null when it is not one. */
export function githubRepoSlug(raw) {
  const text = clean(raw, 300);
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.host !== 'github.com' && parsed.host !== 'www.github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`.toLowerCase();
}

/**
 * Which repository a *catalogue document* belongs to. The panel derives the
 * submit target from a custom source the user already added, so this reads the
 * three URL shapes such a source takes rather than asking for a new setting.
 */
export function githubRepoOfSourceUrl(raw) {
  const text = clean(raw, URL_MAX);
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.host === 'raw.githubusercontent.com' && parts.length >= 2) {
    return { owner: parts[0], repo: parts[1] };
  }
  if (parsed.host.endsWith('jsdelivr.net') && parts[0] === 'gh' && parts.length >= 3) {
    return { owner: parts[1], repo: parts[2].replace(/@.*$/, '') };
  }
  // Case is kept here: this value is shown back to the user ("投稿到 Acme/…"),
  // and GitHub treats owner/repo case-insensitively anyway. `githubRepoSlug` is
  // the lowercasing one, used where identity matters (dedupe keys, URLs).
  if (parsed.protocol === 'https:' && (parsed.host === 'github.com' || parsed.host === 'www.github.com') && parts.length >= 2) {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  }
  return null;
}

/**
 * The registry row for a submission, or the reasons it cannot become one.
 *
 * Returns `{ row }` or `{ errors: [...] }` — never both, so a caller cannot
 * half-accept a row.
 */
export function rowFromFields(fields = {}) {
  const errors = [];
  const name = clean(fields.name, NAME_MAX);
  const description = clean(fields.description, DESCRIPTION_MAX);
  if (!name) errors.push('缺少名称');
  if (!description) errors.push('缺少说明');

  const command = clean(fields.command, COMMAND_MAX);
  const args = splitArgs(fields.args);
  let url = '';
  if (clean(fields.url, URL_MAX)) {
    const vetted = normalizeSourceUrl(clean(fields.url, URL_MAX));
    if (vetted.error) errors.push(`服务地址不可用：${vetted.error}`);
    else url = vetted.url;
  }
  if (!command && !url) errors.push('启动命令与服务地址至少填一个：没有它就装不了');
  if (command && url) errors.push('启动命令与服务地址只能填一个（列表只按一种方式安装）');
  if (command && SHELL_META.test(command)) errors.push('启动命令只能是可执行文件本身，不能带 | ; && 反引号 重定向 或 $()');
  if (args.some((a) => SHELL_META.test(a))) errors.push('命令参数里不能出现 | ; && 反引号 重定向 或 $()');
  if (command && command.includes(' ') && !args.length) errors.push('启动命令请只填可执行文件，其余参数写进「命令参数」');

  const repository = clean(fields.repository, 300);
  const homepage = clean(fields.homepage, 300);
  for (const [label, value] of [['仓库', repository], ['主页', homepage]]) {
    if (!value) continue;
    try {
      if (new URL(value).protocol !== 'https:') errors.push(`${label}只接受 https 地址`);
    } catch {
      errors.push(`${label}不是一个合法的 URL`);
    }
  }
  if (errors.length) return { errors };

  const row = { name };
  if (description) row.description = description;
  if (command) {
    row.command = command;
    if (args.length) row.args = args;
  } else {
    row.url = url;
  }
  if (repository) row.repository = repository;
  if (homepage) row.homepage = homepage;
  const tags = splitTags(fields.tags);
  if (tags.length) row.tags = tags;
  const category = clean(fields.category, CATEGORY_MAX);
  if (category) row.category = category;
  return { row };
}

/**
 * Vet a row that is already in the document. A hand-edited `registry.json` is
 * as untrusted as an issue: this is the same gate, applied on the way out of
 * the file rather than on the way in.
 */
export function normalizeRegistryRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['不是一行对象'] };
  return rowFromFields({
    name: raw.name ?? raw.title,
    description: raw.description ?? '',
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.join(' ') : raw.args,
    url: raw.url,
    repository: raw.repository,
    homepage: raw.homepage,
    tags: Array.isArray(raw.tags) ? raw.tags.join(',') : raw.tags,
    category: raw.category,
  });
}

/**
 * Coerce whatever was on disk into a usable document. Unusable rows are dropped
 * rather than published: a broken row would surface in every subscriber's panel
 * as an entry nobody can install.
 */
export function normalizeRegistryDocument(raw) {
  const doc = emptyRegistry();
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : [];
  const seen = new Set();
  for (const raw2 of rows) {
    const checked = normalizeRegistryRow(raw2);
    if (checked.errors) continue;
    const key = submissionKeyOf(checked.row);
    if (seen.has(key)) continue;
    seen.add(key);
    doc.servers.push(checked.row);
  }
  if (typeof raw?.updatedAt === 'string' && raw.updatedAt) doc.updatedAt = raw.updatedAt;
  return doc;
}

/**
 * What makes two submissions "the same listing": its repository when it has one,
 * else its endpoint, else its name. Editing an issue should update the row it
 * created, not add a second copy of it.
 */
export function submissionKeyOf(row = {}) {
  const slug = githubRepoSlug(row.repository);
  if (slug) return `repo:${slug}`;
  if (clean(row.url, URL_MAX)) return `url:${clean(row.url, URL_MAX).toLowerCase()}`;
  return `name:${clean(row.name, NAME_MAX).toLowerCase()}`;
}

/**
 * Append or update one row and return the document plus what happened, so the
 * Action can decide whether there is anything to commit. `updatedAt` only moves
 * on a real change: an edit that changes nothing must not create a commit.
 */
export function appendSubmission(doc, row, { now = Date.now() } = {}) {
  const registry = normalizeRegistryDocument(doc);
  const key = submissionKeyOf(row);
  const servers = registry.servers.slice();
  const at = servers.findIndex((s) => submissionKeyOf(s) === key);
  let action = 'added';
  if (at >= 0) {
    const before = JSON.stringify(servers[at]);
    const after = JSON.stringify(row);
    servers[at] = row;
    action = before === after ? 'unchanged' : 'updated';
  } else {
    servers.push(row);
  }
  servers.sort((a, b) => (submissionKeyOf(a) < submissionKeyOf(b) ? -1 : 1));
  const updatedAt = action === 'unchanged' && registry.updatedAt ? registry.updatedAt : new Date(now).toISOString();
  return { doc: { version: SUBMISSION_VERSION, updatedAt, servers }, action };
}

/** The published document as text: two-space indent, trailing newline. */
export function registryTextOf(doc) {
  return `${JSON.stringify(normalizeRegistryDocument(doc), null, 2)}\n`;
}

/** The issue body the panel prefills and the repository's form renders. */
export function buildSubmissionBody(fields = {}) {
  const lines = [];
  for (const field of SUBMISSION_FIELDS) {
    lines.push(`### ${field.label}`, '');
    const value = fields[field.key];
    lines.push(typeof value === 'string' && value.trim() ? value.trim() : '_No response_', '');
  }
  return lines.join('\n').trimEnd();
}

/** The inverse of `buildSubmissionBody`, for the Action's comment on a refusal. */
export function fieldsOfRow(row = {}) {
  return {
    name: row.name ?? '',
    description: row.description ?? '',
    command: row.command ?? '',
    args: Array.isArray(row.args) ? row.args.join(' ') : '',
    url: row.url ?? '',
    repository: row.repository ?? '',
    homepage: row.homepage ?? '',
    tags: Array.isArray(row.tags) ? row.tags.join(', ') : '',
    category: row.category ?? '',
  };
}

/**
 * Parse an issue body into fields. Two shapes are accepted because two producers
 * exist: the form GitHub renders (`### 名称`) and plain `名称: …` lines (what a
 * hand-typed issue or a prefilled `body=` URL looks like when the form is not
 * used).
 */
export function parseSubmissionBody(text) {
  const fields = {};
  if (typeof text !== 'string' || !text.trim()) return fields;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = null;
  const buffer = [];
  const flush = () => {
    if (!current) return;
    const value = buffer.join('\n').trim();
    if (value && !isPlaceholder(value)) fields[current] = value;
    buffer.length = 0;
  };
  for (const line of lines) {
    // Any heading ends the field being read, known or not: a section the form
    // does not declare must not be swallowed as the previous field's value.
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = FIELD_BY_LABEL.get(heading[1].replace(/[:：]\s*$/, ''))?.key ?? null;
      continue;
    }
    if (!current) {
      const inline = /^\s*([^:：]{1,20})\s*[:：]\s*(.*)$/.exec(line);
      const field = inline && FIELD_BY_LABEL.get(inline[1].trim());
      if (field) {
        fields[field.key] = inline[2].trim();
        current = null;
        continue;
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return fields;
}

/**
 * A prefilled `issues/new` URL for one row. `body` carries the same headings the
 * form would produce, so the Action needs no knowledge of where the author came
 * from. Returns null when the repository coordinates are unusable.
 */
export function buildIssueUrl({ repo, row = {}, title } = {}) {
  const slug = githubRepoSlug(/^https?:/.test(String(repo)) ? repo : `https://github.com/${String(repo ?? '')}`);
  if (!slug) return null;
  const name = clean(title ?? row.name, NAME_MAX);
  const body = buildSubmissionBody(fieldsOfRow(row));
  const params = new URLSearchParams();
  if (name) params.set('title', `[MCP 收录] ${name}`);
  params.set('body', body);
  return `https://github.com/${slug}/issues/new?${params.toString()}`;
}

export const SUBMISSION_LIMITS = { NAME_MAX, DESCRIPTION_MAX, COMMAND_MAX, ARGS_MAX, ARG_MAX, TAGS_MAX, TAG_MAX, CATEGORY_MAX };
