/**
 * Local contribution queue for 「申请收录 MCP 服务」.
 *
 * The panel's 「申请收录」 used to be a link out to the awesome-mcp-servers
 * index: the only way into a catalogue was a pull request upstream. The user
 * asked for the local version of that flow — fill in a name and a link (a file
 * may be attached), the submission lands here, and a reviewer on this machine
 * either rejects it or lets it into the registry with the source
 * `contribution`.
 *
 * Everything is local and nothing leaves the machine:
 *   `$DSH_HOME/overall-mcp/submissions.json`   the queue itself
 *   `$DSH_HOME/overall-mcp/submissions/<id>/`  an uploaded file, stored as-is
 *
 * The uploaded file is deliberately **not** parsed or inspected: the review is
 * a human decision, and "we opened your archive" is not something this plugin
 * should do behind the reviewer's back. Only the file's name and size are
 * recorded, plus a path relative to the data directory so the queue stays
 * readable after a move.
 *
 * An approved submission becomes a registry row. When the reviewer supplied a
 * `command` or an `url` it is a normal mountable entry; when they did not, the
 * row is written with `displayOnly: true` — it carries the name and the link so
 * it is visible in the list, and it can never be mounted (the panel says 仅展示
 * rather than offering a switch that would spawn `undefined`).
 */

const SUBMISSIONS_VERSION = 1;

/** An upload travels inside one request body, so it stays small on purpose. */
export const MAX_UPLOAD_BYTES = 512 * 1024;
export const MAX_NAME = 80;
export const MAX_LINK = 500;
export const MAX_NOTE = 400;
export const MAX_CONTRIBUTOR = 40;
export const MAX_FILE_NAME = 120;

const STATUSES = new Set(['pending', 'approved', 'rejected']);

export function emptySubmissions() {
  return { version: SUBMISSIONS_VERSION, items: [] };
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Coerce whatever was on disk into a usable queue; unusable rows are dropped. */
export function normalizeSubmissions(raw) {
  const store = emptySubmissions();
  const items = Array.isArray(raw?.items) ? raw.items : null;
  if (!items) return store;
  for (const raw_item of items) {
    const id = clip(raw_item?.id, 64);
    const name = clip(raw_item?.name, MAX_NAME);
    if (!id || !name) continue;
    const status = STATUSES.has(raw_item?.status) ? raw_item.status : 'pending';
    const item = { id, name, link: clip(raw_item?.link, MAX_LINK), status };
    const at = clip(raw_item?.at, 40);
    if (at) item.at = at;
    const contributor = clip(raw_item?.contributor, MAX_CONTRIBUTOR);
    if (contributor) item.contributor = contributor;
    const note = clip(raw_item?.note, MAX_NOTE);
    if (note) item.note = note;
    const file = raw_item?.file;
    if (file && typeof file === 'object') {
      const fileName = clip(file.name, MAX_FILE_NAME);
      const bytes = Number(file.bytes);
      const stored = { name: fileName || 'upload.bin', bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0 };
      const filePath = clip(file.path, MAX_LINK);
      if (filePath) stored.path = filePath;
      const mediaType = clip(file.type, 120);
      if (mediaType) stored.type = mediaType;
      item.file = stored;
    }
    if (status !== 'pending') {
      const reviewedAt = clip(raw_item?.reviewedAt, 40);
      if (reviewedAt) item.reviewedAt = reviewedAt;
      const reason = clip(raw_item?.reason, MAX_NOTE);
      if (reason) item.reason = reason;
    }
    if (status === 'approved') {
      const entry = clip(raw_item?.entry, MAX_NAME);
      if (entry) item.entry = entry;
      const install = raw_item?.install;
      if (install && typeof install === 'object') {
        const transport = install.transport === 'stdio' ? 'stdio' : install.transport === 'streamable-http' ? 'streamable-http' : null;
        if (transport === 'stdio' && clip(install.command, MAX_LINK)) {
          const args = Array.isArray(install.args) ? install.args.map((a) => clip(a, MAX_LINK)).filter(Boolean).slice(0, 32) : [];
          item.install = { transport, command: clip(install.command, MAX_LINK), args };
        } else if (transport === 'streamable-http' && clip(install.url, MAX_LINK)) {
          item.install = { transport, url: clip(install.url, MAX_LINK) };
        }
      }
    }
    store.items.push(item);
  }
  return store;
}

/** Read the queue; a missing or corrupt file is an empty queue, never a throw. */
export async function readSubmissions(file, readFileImpl = null) {
  const read = readFileImpl ?? (await import('node:fs/promises')).readFile;
  try {
    return normalizeSubmissions(JSON.parse(await read(file, 'utf8')));
  } catch {
    return emptySubmissions();
  }
}

/** Persist through a temp file + rename, like the install counter. */
export async function writeSubmissions(file, store, fsImpl = null) {
  const fsp = fsImpl ?? (await import('node:fs/promises'));
  const { dirname } = await import('node:path');
  await fsp.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: SUBMISSIONS_VERSION, items: store?.items ?? [] }, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * A filename that cannot escape its own directory and cannot be empty. The name
 * comes from a remote submitter, so it is never trusted as a path.
 */
export function safeFileName(name) {
  const raw = typeof name === 'string' ? name : '';
  const base = raw.split(/[\\/]+/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!cleaned) return 'upload.bin';
  return cleaned.slice(0, MAX_FILE_NAME);
}

/** What is wrong with a submission, or null when nothing is. */
export function submissionProblem(input) {
  const name = clip(input?.name, MAX_NAME);
  if (!name) return 'name is required';
  const link = clip(input?.link, MAX_LINK);
  if (!link) return 'link is required';
  if (!/^https?:\/\/\S+$/i.test(link)) return 'link must be an http(s) URL';
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (note.length > MAX_NOTE) return `note is longer than ${MAX_NOTE} characters`;
  const contributor = typeof input?.contributor === 'string' ? input.contributor.trim() : '';
  if (contributor.length > MAX_CONTRIBUTOR) return `contributor is longer than ${MAX_CONTRIBUTOR} characters`;
  return null;
}

export function newSubmissionId(now = null) {
  const stamp = (now instanceof Date ? now.getTime() : Date.now()).toString(36);
  let suffix = '';
  if (typeof Math.random === 'function') suffix = Math.random().toString(36).slice(2, 6);
  return `s${stamp}${suffix}`.slice(0, 64);
}

/**
 * Build one queued submission. `file` is metadata already written to disk by the
 * caller (this module never touches the upload bytes).
 */
export function newSubmission(input, { id = null, at = null } = {}) {
  const iso = typeof at === 'string' && at ? at : new Date().toISOString();
  const item = {
    id: id ?? newSubmissionId(),
    name: clip(input?.name, MAX_NAME),
    link: clip(input?.link, MAX_LINK),
    status: 'pending',
    at: iso,
  };
  const contributor = clip(input?.contributor, MAX_CONTRIBUTOR);
  if (contributor) item.contributor = contributor;
  const note = clip(input?.note, MAX_NOTE);
  if (note) item.note = note;
  const file = input?.file;
  if (file && typeof file === 'object' && clip(file.name, MAX_FILE_NAME)) {
    const stored = { name: safeFileName(file.name), bytes: Number.isFinite(Number(file.bytes)) ? Math.max(0, Math.floor(Number(file.bytes))) : 0 };
    const filePath = clip(file.path, MAX_LINK);
    if (filePath) stored.path = filePath;
    const mediaType = clip(file.type, 120);
    if (mediaType) stored.type = mediaType;
    item.file = stored;
  }
  return item;
}

export function findSubmission(store, id) {
  const key = clip(id, 64);
  if (!key) return null;
  return (store?.items ?? []).find((item) => item.id === key) ?? null;
}

/**
 * Record a review decision on one submission and return it.
 *
 * `approve` may carry the mountable information the reviewer added
 * (`{ transport: 'stdio', command, args }` or `{ transport: 'streamable-http',
 * url }`); without it the entry is approved as a display-only row.
 */
export function reviewSubmissionIn(store, { id, decision, reason = '', install = null, entry = null, at = null } = {}) {
  const item = findSubmission(store, id);
  if (!item) throw new Error(`unknown submission: ${clip(id, 64) || '(none)'}`);
  if (decision !== 'approve' && decision !== 'reject') throw new Error(`invalid submission decision: ${decision}`);
  const iso = typeof at === 'string' && at ? at : new Date().toISOString();
  item.status = decision === 'approve' ? 'approved' : 'rejected';
  item.reviewedAt = iso;
  const why = clip(reason, MAX_NOTE);
  if (why) item.reason = why;
  else delete item.reason;
  if (decision === 'approve') {
    if (entry) item.entry = clip(entry, MAX_NAME);
    if (install?.transport === 'stdio' && clip(install.command, MAX_LINK)) {
      item.install = {
        transport: 'stdio',
        command: clip(install.command, MAX_LINK),
        args: Array.isArray(install.args) ? install.args.map((a) => clip(a, MAX_LINK)).filter(Boolean).slice(0, 32) : [],
      };
    } else if (install?.transport === 'streamable-http' && clip(install.url, MAX_LINK)) {
      item.install = { transport: 'streamable-http', url: clip(install.url, MAX_LINK) };
    } else {
      delete item.install;
    }
  } else {
    delete item.install;
    delete item.entry;
  }
  return item;
}

/**
 * The queue as the panel and the agent read it: newest first, with the pending
 * count that decides whether the review section is shown at all.
 */
export function submissionsPayload(store, { limit = 100 } = {}) {
  const items = [...(store?.items ?? [])].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { items: items.slice(0, limit), pending: items.filter((item) => item.status === 'pending').length };
}

/**
 * The registry row an approved submission becomes.
 *
 * With no mountable transport the row is written `enabled: false` and marked
 * `displayOnly`: `toMcpConfig()` turns anything that is not HTTP into a stdio
 * config, so an entry with no command would try to spawn `undefined` — the
 * marker is what lets the panel refuse instead of failing at mount time.
 */
export function submissionEntry(item, { install = null, name = null, at = null } = {}) {
  const iso = typeof at === 'string' && at ? at : new Date().toISOString();
  const row = {
    name: clip(name, MAX_NAME) || item.name,
    source: 'contribution',
    enabled: false,
    link: item.link,
    submission: item.id,
    addedAt: iso,
  };
  if (item.contributor) row.contributor = item.contributor;
  if (item.note) row.note = item.note;
  const chosen = install ?? item.install ?? null;
  if (chosen?.transport === 'stdio' && chosen.command) {
    return { ...row, transport: 'stdio', command: chosen.command, args: chosen.args ?? [], env: {}, enabled: true };
  }
  if (chosen?.transport === 'streamable-http' && chosen.url) {
    return { ...row, transport: 'streamable-http', url: chosen.url, headers: {}, enabled: true };
  }
  return { ...row, transport: 'discovery', displayOnly: true };
}
