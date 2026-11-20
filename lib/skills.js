/**
 * Skill space: what is installed on this machine.
 *
 * A skill is a directory with a SKILL.md whose frontmatter declares at least a
 * name and a description. Four roots are read, in this order:
 *
 *   plugin  $DSH_HOME/skills      what this plugin will install into
 *   user    ~/.agents/skills      the machine's shared library
 *   claude  ~/.claude/skills      what Claude Code brought along
 *   codex   ~/.codex/skills       what the Codex CLI brought along
 *
 * The three outside roots belong to other tools. Two of them overlap in practice
 * (`~/.claude/skills` is a strict subset of `~/.agents/skills` on this machine),
 * and the earlier root still wins, so those copies collapse into `duplicates`
 * instead of showing twice. They are listed anyway because "where does this come
 * from" is the question this page exists to answer, and answering it with three
 * of four directories would be a half-truth.
 *
 * Only `plugin` is ours. Nothing here deletes: `moveToTrash` renames a directory
 * into `<dataDir>/skills-trash/<stamp>/`, so a misplaced click costs a move, not
 * a skill.
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanPublisherIcons, declaredEmoji, declaredIcon, publisherIcons } from './item-icons.js';

export const SKILL_FILE = 'SKILL.md';
export const SKILL_ICON_METADATA = '.overall-mcp-icon.json';
const SKILL_ICON_BYTES = 64 * 1024;
const SKILL_ICON_TYPES = { '.png': 'png', '.webp': 'webp', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.gif': 'gif' };

function webSkillUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 2048 || !/^https?:\/\/[^/]/i.test(text) || /[\u0000-\u0020\u007f\\]/.test(text)) return null;
  const url = URL.parse(text);
  return url && !url.username && !url.password ? url : null;
}

export function skillSourcePage({ pageUrl, homepage, repository, source, marketId } = {}) {
  const id = typeof marketId === 'string' ? marketId : '';
  const url = webSkillUrl(pageUrl);
  if (url && (source === 'skillhub' || id.startsWith('skillhub:')) && url.host === 'api.skillhub.cn') {
    // Older SkillHub listings stored the API host's owner/slug URL.
    const listing = /^\/([\w-][\w.-]*)\/([\w-][\w.-]*)\/?$/.exec(url.pathname);
    if (listing) {
      const [, owner, slug] = listing;
      // ClawHub imports carry their original publisher under this namespace.
      const mirror = /^clawhub_([\w-][\w.-]*)$/.exec(owner);
      return mirror ? `https://clawhub.ai/${mirror[1]}/skills/${slug}` : `https://skillhub.cn/skills/${owner}/${slug}`;
    }
  } else if (url) {
    return url.href;
  }
  // For older installs, recover a destination from the exact saved identity.
  const claw = /^clawhub:([\w-][\w.-]*)\/([\w-][\w.-]*)$/.exec(id);
  if (claw) return `https://clawhub.ai/${claw[1]}/skills/${claw[2]}`;
  const official = /^official:([\w.-]+)$/.exec(id);
  if (official && official[1] !== '.' && official[1] !== '..') return `https://github.com/anthropics/skills/tree/main/skills/${official[1]}`;
  const github = /^github:([\w-]+)\/([\w.-]+)(?::.*)?$/.exec(id);
  if (github && github[2] !== '.' && github[2] !== '..') return `https://github.com/${github[1]}/${github[2]}`;
  return webSkillUrl(homepage)?.href ?? webSkillUrl(repository)?.href;
}

async function readSkillIconFile(dir, relative, fs, limit) {
  if (!relative || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('图标路径必须在技能目录内');
  }
  const root = await fs.realpath(dir);
  const file = await fs.realpath(path.join(dir, relative));
  const inside = path.relative(root, file);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('图标路径超出技能目录');
  }
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error('图标文件为空、不是普通文件或超过大小限制');
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(limit + 1), length: limit + 1 });
    if (!bytesRead || bytesRead > limit) throw new Error('图标文件为空或超过大小限制');
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function skillIconMeta(meta, dir, fs) {
  const issueText = error => error.code ? `读取技能图标失败：${error.code}` : error.message;
  const issues = [];
  let icon = declaredIcon(meta) ?? declaredIcon(meta.metadata);
  let emoji = declaredEmoji(meta);
  let marketId;
  let installedPage;
  const candidates = publisherIcons(meta.homepage, meta.metadata?.homepage, meta.repository, meta.metadata?.repository);
  if (!icon) {
    const rawPath = meta.icon ?? meta.logo ?? meta.metadata?.icon ?? meta.metadata?.logo;
    const relative = typeof rawPath === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) ? rawPath.trim().replace(/^\.\//, '') : '';
    try {
      for (const candidate of relative ? [relative] : ['icon.png', 'icon.webp', 'logo.png']) {
        const mime = SKILL_ICON_TYPES[path.extname(candidate).toLowerCase()];
        if (!mime) throw new Error('技能内的图标须为 PNG、WebP、JPEG 或 GIF');
        try {
          const data = await readSkillIconFile(dir, candidate, fs, SKILL_ICON_BYTES);
          icon = `data:image/${mime};base64,${data.toString('base64')}`;
          break;
        } catch (error) {
          if (relative || error.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      issues.push(issueText(error));
    }
  }
  {
    try {
      const raw = await readSkillIconFile(dir, SKILL_ICON_METADATA, fs, 16 * 1024);
      const stored = JSON.parse(raw.toString('utf8'));
      const savedIcon = declaredIcon(stored);
      const savedEmoji = declaredEmoji(stored);
      const savedCandidates = cleanPublisherIcons(stored?.iconCandidates);
      if (stored?.marketId != null) {
        if (typeof stored.marketId !== 'string' || !stored.marketId.trim() || stored.marketId.length > 512) throw new Error('安装来源标识无效');
        marketId = stored.marketId;
      }
      if (stored?.pageUrl != null) {
        installedPage = skillSourcePage({ pageUrl: stored.pageUrl, source: marketId?.split(':', 1)[0] });
        if (!installedPage) issues.push('安装时记录的来源网址无效');
      }
      if (!marketId && !installedPage && !savedIcon && !savedEmoji && !savedCandidates.length) throw new Error('安装时记录的图标信息无效');
      if (icon && savedIcon && icon !== savedIcon) candidates.push(savedIcon);
      icon ??= savedIcon;
      emoji ??= savedEmoji;
      candidates.push(...savedCandidates);
    } catch (error) {
      if (error.code !== 'ENOENT') issues.push(issueText(error));
    }
  }
  const pageUrl = installedPage ?? skillSourcePage({ marketId }) ?? [meta, meta.metadata].map(fields => skillSourcePage(fields ?? {})).find(Boolean);
  return { icon, emoji, ...(marketId ? { marketId } : {}), ...(pageUrl ? { pageUrl } : {}), iconCandidates: cleanPublisherIcons(candidates), ...(issues.length ? { iconIssue: issues.join('；') } : {}) };
}

/** Stop counting at this many files per skill: the panel shows a size, not an audit. */
export const MAX_FILES_PER_SKILL = 500;

/** The roots to read, as data, so a test can point them anywhere. */
export function skillRoots({ dshHome, home = os.homedir() } = {}) {
  const base = dshHome ?? process.env.DSH_HOME ?? path.join(home, '.dsh');
  return [
    { id: 'plugin', label: '本插件', dir: path.join(base, 'skills'), note: '本插件写入' },
    { id: 'user', label: '本机', dir: path.join(home, '.agents', 'skills'), note: '宿主启动时读取' },
    { id: 'claude', label: 'Claude', dir: path.join(home, '.claude', 'skills'), note: 'Claude Code 的目录' },
    { id: 'codex', label: 'Codex', dir: path.join(home, '.codex', 'skills'), note: 'Codex CLI 的目录' },
  ];
}

/** Where a removed skill goes: inside our own data directory, one folder per batch. */
export const TRASH_DIR = 'skills-trash';

/**
 * Parse the YAML that skills actually use: flat `key: value` pairs, with quoted
 * strings, folded/indented continuations, `|` / `>` block scalars, and one level
 * of nesting (`metadata:`). Nothing else is invented: an unreadable frontmatter
 * yields whatever keys survived, and a missing one yields {}.
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  let end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) end = lines.length;
  const body = lines.slice(1, end);

  const out = {};
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    const head = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!head) {
      index += 1;
      continue;
    }
    const key = head[1];
    const rest = head[2].trim();
    index += 1;

    // A block scalar keeps its own line structure; a nested map is read one level
    // deep (metadata.origin and friends), and anything else indented is a folded
    // continuation of the value above it.
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const block = [];
      while (index < body.length && (body[index].trim() === '' || /^\s/.test(body[index]))) {
        block.push(body[index].replace(/^\s{0,2}/, ''));
        index += 1;
      }
      out[key] = rest.startsWith('|') ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }

    if (rest === '') {
      const indented = [];
      while (index < body.length && /^\s+\S/.test(body[index])) {
        indented.push(body[index].trim());
        index += 1;
      }
      if (indented.length === 0) continue;
      const mapping = /^([A-Za-z][\w-]*):(?:\s+(.*)|$)/;
      if (mapping.test(indented[0])) {
        const nested = {};
        for (const entry of indented) {
          const inner = mapping.exec(entry);
          if (inner) nested[inner[1]] = unquote(inner[2] ?? '');
        }
        out[key] = nested;
      } else {
        out[key] = unquote(indented.join(' '));
      }
      continue;
    }

    let value = unquote(rest);
    const folded = [];
    while (index < body.length && /^\s+\S/.test(body[index])) {
      folded.push(body[index].trim());
      index += 1;
    }
    if (folded.length > 0) value = `${value} ${folded.join(' ')}`.replace(/\s+/g, ' ').trim();
    out[key] = value;
  }
  return out;
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Count the files and bytes below one skill, stopping at MAX_FILES_PER_SKILL. */
async function measure(dir, fs) {
  let files = 0;
  let bytes = 0;
  const queue = [dir];
  while (queue.length > 0 && files < MAX_FILES_PER_SKILL) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES_PER_SKILL) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile() || (current === dir && entry.name === SKILL_ICON_METADATA)) continue;
      files += 1;
      try {
        const stat = await fs.stat(full);
        bytes += stat?.size ?? 0;
      } catch {
        /* a file that vanished mid-walk is not worth failing the scan for */
      }
    }
  }
  return { files, bytes };
}

/**
 * Read one root. Unreadable directories are reported as an empty root rather
 * than as an error: a machine without Codex installed is normal.
 */
async function readRoot(root, fs) {
  const out = { ...root, skills: [], bytes: 0, error: null };
  let entries;
  try {
    entries = await fs.readdir(root.dir, { withFileTypes: true });
  } catch (err) {
    out.error = err?.code === 'ENOENT' ? 'missing' : String(err?.message ?? err);
    return out;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of dirs) {
    const dir = path.join(root.dir, name);
    const file = path.join(dir, SKILL_FILE);
    let text;
    let modifiedAt = null;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const issue = `${name}/${SKILL_FILE} 读取失败：${String(error?.message ?? error)}`;
        out.error = out.error ? `${out.error}；${issue}` : issue;
      }
      continue; // absence is normal; unreadable skills remain visible as a root error
    }
    try {
      const stat = await fs.stat(file);
      modifiedAt = stat?.mtime ? stat.mtime.toISOString() : null;
    } catch {
      modifiedAt = null;
    }
    const meta = parseFrontmatter(text);
    const { files, bytes } = await measure(dir, fs);
    out.bytes += bytes;
    out.skills.push({
      id: `${root.id}:${name}`,
      root: root.id,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : name,
      dirName: name,
      description: typeof meta.description === 'string' ? meta.description.trim() : '',
      version: typeof meta.version === 'string' ? meta.version.trim() : '',
      origin: originOf(meta),
      license: typeof meta.license === 'string' ? meta.license.trim() : '',
      author: typeof meta.author === 'string' ? meta.author.trim() : '',
      homepage: typeof meta.homepage === 'string' ? meta.homepage.trim() : '',
      ...await skillIconMeta(meta, dir, fs),
      tools: typeof meta.tools === 'string' ? meta.tools.trim() : '',
      toolsOff: meta['disable-model-invocation'] === 'true',
      files,
      bytes,
      modifiedAt,
      dir,
    });
  }
  return out;
}

/**
 * The badge a card shows. `origin` is the field the library actually uses
 * (ECC / community / an author's name); `metadata.origin` and `metadata.source`
 * are the same idea spelled by other tools. An unknown skill gets no badge at
 * all rather than a made-up one.
 */
function originOf(meta) {
  const direct = typeof meta.origin === 'string' ? meta.origin.trim() : '';
  if (direct) return direct;
  const nested = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {};
  for (const key of ['origin', 'source', 'sourceRepo']) {
    const value = nested[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Read every root and flatten the result.
 *
 * `roots` in the answer keeps the per-root counts for the group headers. Two
 * numbers per root matter and they are not the same one: `found` is what the
 * folder actually holds, `count` is how many rows survived the shadowing rules
 * below. A mirror folder (Claude's is usually a copy of the shared one) holds
 * 225 skills while contributing 21 rows — reporting only the second number
 * reads as "this folder is nearly empty".
 *
 * `duplicates` says how many rows were shadowed by an earlier root.
 */
export async function readSkills({ dshHome, home, roots, fs, now = () => Date.now() } = {}) {
  const impl = fs ?? (await import('node:fs')).promises;
  const wanted = roots ?? skillRoots({ dshHome, home });
  const groups = [];
  for (const root of wanted) groups.push(await readRoot(root, impl));

  const seen = new Set();
  const skills = [];
  const shadowed = new Map();
  const installedMarketIds = new Set();
  let duplicates = 0;
  for (const group of groups) {
    for (const skill of group.skills) {
      if (skill.marketId) installedMarketIds.add(skill.marketId);
      const key = skill.marketId
        ? `market\u0000${skill.marketId}`
        : `local\u0000${skill.name}\u0000${skill.description}`;
      if (seen.has(key)) {
        duplicates += 1;
        shadowed.set(group.id, (shadowed.get(group.id) ?? 0) + 1);
        continue;
      }
      seen.add(key);
      if (skill.marketId) seen.add(`local\u0000${skill.name}\u0000${skill.description}`);
      skills.push(skill);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    skills,
    installedMarketIds: [...installedMarketIds],
    duplicates,
    roots: groups.map((group) => ({
      id: group.id,
      label: group.label,
      dir: group.dir,
      note: group.note ?? '',
      count: skills.filter((skill) => skill.root === group.id).length,
      found: group.skills.length,
      folded: shadowed.get(group.id) ?? 0,
      bytes: group.bytes,
      error: group.error,
    })),
    totals: {
      count: skills.length,
      files: skills.reduce((sum, skill) => sum + skill.files, 0),
      bytes: skills.reduce((sum, skill) => sum + skill.bytes, 0),
    },
    scannedAt: new Date(now()).toISOString(),
  };
}

/**
 * Move one skill out of its root, into our own trash directory.
 *
 * Removal here is a rename, never a delete: a misplaced click costs a move, and
 * `skills-trash/<stamp>/` is a plain directory the user can restore from. Two
 * roots are other tools' directories, so this is also the only shape of removal
 * they get — we refuse to destroy something we did not create.
 */
const trashMoves = new Set();

export async function moveToTrash({ skill, trashRoot, stamp, fs } = {}) {
  if (!skill || typeof skill.dir !== 'string' || !skill.dir) return { ok: false, error: 'unknown skill' };
  if (!trashRoot || !stamp) return { ok: false, error: 'no trash directory' };
  const impl = fs ?? (await import('node:fs')).promises;
  const folder = path.join(String(trashRoot), String(stamp));
  let dest = path.join(folder, `${skill.root}-${skill.dirName}`);
  const source = path.resolve(skill.dir);
  const key = process.platform === 'win32' ? source.toLowerCase() : source;
  if (trashMoves.has(key)) return { ok: false, status: 409, error: '此 Skill 正在移除' };
  trashMoves.add(key);

  try {
    for (let suffix = 2; await statIfPresent(impl, dest); suffix += 1) {
      dest = path.join(folder, `${skill.root}-${skill.dirName}-${suffix}`);
    }
    await impl.mkdir(folder, { recursive: true });
    try {
      await impl.rename(source, dest);
      return { ok: true, dest };
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error;
    }

    // Freeze the registered path on its own volume. Work on the staged
    // directory so edits to a recreated source never get removed.
    const retirement = await impl.mkdtemp(path.join(path.dirname(source), '.skill-trash-'));
    const retired = path.join(retirement, 'skill');
    try {
      await impl.rename(source, retired);
    } catch (error) {
      try { await impl.rmdir(retirement); }
      catch (cleanup) { throw new Error(`${error.message}。临时目录未清理：${retirement}（${cleanup.message}）`, { cause: error }); }
      throw error;
    }
    const warnings = [];
    let stage;
    try {
      stage = await impl.mkdtemp(path.join(folder, '.copy-'));
      const copy = path.join(stage, 'skill');
      await impl.cp(retired, copy, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (await statIfPresent(impl, dest)) throw new Error('回收路径已被占用，请重试');
      await impl.rename(copy, dest);
    } catch (error) {
      const notes = [`跨盘回收失败：${error.message}`];
      if (stage) {
        try { await impl.rm(stage, { recursive: true, force: true }); }
        catch (cleanup) { notes.push(`临时目录未清理：${stage}（${cleanup.message}）`); }
      }
      try {
        if (await statIfPresent(impl, source)) throw new Error('源目录已重新创建');
        await impl.rename(retired, source);
      } catch (restore) {
        notes.push(`原目录未恢复：${restore.message}`);
        return { ok: false, dest: retired, error: notes.join('。') };
      }
      try { await impl.rmdir(retirement); }
      catch (cleanup) { notes.push(`临时目录未清理：${retirement}（${cleanup.message}）`); }
      return { ok: false, error: notes.join('。') };
    }

    try { await impl.rm(stage, { recursive: true, force: true }); }
    catch (error) { warnings.push(`回收临时目录未清理：${stage}（${error.message}）`); }
    try {
      await impl.rm(retirement, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`原目录的临时副本未清理：${retired}（${error.message}）`);
    }
    return { ok: true, dest, ...(warnings.length ? { warning: warnings.join('。') } : {}) };
  } finally {
    trashMoves.delete(key);
  }
}

async function statIfPresent(fs, target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function marketSkillTarget(root, folder, marketId, fs) {
  const primary = path.join(root, folder);
  const suffix = createHash('sha256').update(marketId).digest('hex').slice(0, 16);
  const alternate = path.join(root, `${folder.slice(0, 200)}--${suffix}`);
  const occupied = await statIfPresent(fs, alternate);
  if (occupied) throw Object.assign(new Error(`Skill 安装目录已存在：${alternate}`), { status: 409 });
  const current = await statIfPresent(fs, primary);
  if (!current) return primary;
  if (current.isDirectory()) {
    try {
      const raw = await readSkillIconFile(primary, SKILL_ICON_METADATA, fs, 16 * 1024);
      if (JSON.parse(raw.toString('utf8')).marketId === marketId) {
        throw Object.assign(new Error('这个 Skill 已安装到所选目录'), { status: 409 });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return alternate;
}
