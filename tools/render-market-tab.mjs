// tools/render-market-tab.mjs — render the market tab against a fake React.
//
// MarketCard/MarketDetail have their own render tests, but the tab chrome
// around them (stat line, filters, the masonry wrapper, the favourite wiring
// between Section and both cards) exists only in Section, and Section is what
// throws when a state name or a prop is wrong. This renders the real Section
// with stubbed hooks + fetch and walks the tree it produces.
//
// The stub runs effects and honours setState, so the tab is driven the way a
// user drives it: render, click 市场, let the fetch settle, render again. An
// earlier version seeded state by hook INDEX, which silently broke every time
// Section gained a useState — the market payload landed in the wrong slot and
// the assertions passed against a half-loaded tab. Interactions do not rot.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { querySkillRows } from '../lib/skill-index.js';
import { summarize } from '../lib/calls.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

// --- fake React ------------------------------------------------------------
// Function components are invoked here, each with its OWN hook frame — a
// shared frame would let a child component's useState steal a slot from the
// parent that renders it, which is exactly the class of bug this file exists
// to catch. Frames are keyed per component INSTANCE (name + ordinal within a
// render) and kept across renders, so a setState in one pass is still visible
// in the next — otherwise nothing an effect loads would ever stick.
const frames = [];
const effects = [];
const frameStore = new Map();
const ordinals = new Map();
const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    // Expand function components: a stub that only records the element type
    // hides everything the component renders (MarketCard's preview strip).
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState(initial) {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.hooks)) frame.hooks[i] = typeof initial === 'function' ? initial() : initial;
    const write = (next) => {
      frame.hooks[i] = typeof next === 'function' ? next(frame.hooks[i]) : next;
    };
    return [frame.hooks[i], write];
  },
  useEffect(fn) { effects.push(fn); },
  useMemo: (fn) => fn(),
  useRef(initial) { return reactStub.useState(() => ({ current: initial }))[0]; },
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

const MARKET = {
  items: [
    {
      id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
      description: 'Evidence capture for agents.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
      repository: 'https://github.com/snag/mcp', version: '1.0.0', group: '开发工具',
      installable: true, installed: true, favorite: true,
      // No upstream installs figure (the official registry publishes none) but
      // installed from this panel five thousand times ⇒ it must outrank the
      // entry whose *source* reports 1200.
      official: true, group: '开发工具', groupSource: 'upstream',
      localInstalls: 5000, localInstallLastAt: '2026-10-14T08:00:00.000Z',
    },
    {
      id: 'awesome:Gatyh/3dtexel-mcp', title: '3dtexel-mcp', source: 'awesome-list', author: 'Gatyh',
      description: '3D texture search over MCP.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '3dtexel-mcp'] },
      repository: 'https://github.com/Gatyh/3dtexel-mcp', version: null, group: '搜索与知识',
      installable: true, installed: false, favorite: false,
      installs: 1200, installsLabel: '次启动',
      // No source published a category for this one, so 分类 is our reading of
      // its own words — and it is the ONLY entry in that group, which is what
      // makes the dropdown mark the whole option as （推断）.
      groupSource: 'inferred',
      // The repository's own last push. The card has to keep this apart from
      // the listing's read time: one is upstream's clock, the other is ours.
      updatedAt: '2026-09-30T12:00:00.000Z',
    },
    {
      id: 'remote:example.com/mcp', title: 'example-mcp', source: 'awesome-remote', author: 'example.com',
      description: 'A hosted endpoint.', transport: 'unknown', install: null,
      installable: false, installed: false, favorite: false,
      // Deliberately no usage figure at all: neither upstream nor this machine
      // ever counted one, so under 使用量 ordering it sorts last — and the card
      // is the only place that can say why.
    },
  ],
  counts: { 'official-registry': 1, 'awesome-list': 1, 'awesome-remote': 1, 'github-mcp': 2 },
  total: 3, cached: true, fetchedAt: Date.now(),
  // Two of the sources answered 304 on the last walk, so the freshness line has
  // something honest to say beyond the timestamp.
  notModified: 2,
  // One repository was reached through two sources, so the per-source figures
  // sum to one more than the listing holds. The line states the overlap instead
  // of leaving the reader to find the arithmetic broken.
  deduped: 1,
  sources: {
    'official-registry': { at: new Date().toISOString(), cached: true, stale: false, notModified: 1, items: 1 },
    // Walked three rows, credited with two cards after the merge: the number
    // beside the source name is the second one.
    'awesome-list': { at: new Date().toISOString(), cached: true, stale: false, notModified: 1, items: 3, merged: 2 },
    'awesome-remote': { at: new Date().toISOString(), cached: false, stale: false, notModified: 0, items: 1 },
    // The GitHub census contributed rows, and Docker answered nothing: a rate
    // limit has to be visible as a reason, not as a bare zero.
    // GitHub also carries a coverage note here, so the panel's "部分" marker and
    // the reason behind it — how big the census is, how old, and how much of it
    // this listing took — are all exercised by this probe.
    'github-mcp': {
      at: new Date().toISOString(), cached: false, stale: false, notModified: 0, items: 2,
      note: '本地索引 1758 行・3 小时前；本次列出 2 条',
      index: { rows: 1758, matched: 2, at: new Date().toISOString(), ageMs: 3 * 3600_000, stale: false, complete: true, partial: null },
      // How many of those repositories the recovery walk turned into installable
      // rows — a different number from the census size, so the line states both.
      install: { rows: 400, withCommand: 320, at: new Date().toISOString(), walking: false },
    },
    'docker-catalog': { error: 'HTTP 403' },
  },
  // The host reports one entry per failed source, and it already carries the
  // reason. Two shapes are exercised together: a source with nothing to show,
  // and one that failed but answered from its last walk (`stale`) — the second
  // is a rate limit that lifts by itself, and calling it 不可用 would be wrong.
  errors: [
    { source: 'docker-catalog', message: 'HTTP 403' },
    { source: 'github-mcp', message: '搜索配额已用完（约 42 秒后恢复）', stale: true },
  ],
};

// The custom catalogue sources the host reports. One is configured, and it is
// deliberately NOT part of the listing below: a source that is pointed at but
// did not contribute rows must still appear in the manager, with its own zero,
// instead of looking like it was never added.
const CUSTOM_SOURCE = {
  id: 'custom:raw-githubusercontent-com-acme-mcp-registry-main-registry-json',
  label: 'acme/mcp-registry',
  url: 'https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json',
  // The host derives this from the address (a GitHub-hosted list can take
  // submissions through an issue); a source hosted anywhere else reports null.
  submission: {
    repo: 'acme/mcp-registry',
    url: 'https://github.com/acme/mcp-registry/issues/new?title=%5BMCP%20%E6%94%B6%E5%BD%95%5D&body=%23%23%23%20%E5%90%8D%E7%A7%B0%0A%0A_No%20response_',
  },
};
// The stub host keeps its own copy of the configured sources and answers the
// page from it: the effect that lists them re-runs on every pass here (the
// shim has no dependency arrays), so a GET that ignored the page's own removal
// would put the row back and hide the empty state the page really shows.
let liveSources = [CUSTOM_SOURCE];

// What the host answers when the entry was written and nothing mounted: its own
// error, the explanation the user's model produced, and the note about the
// install counter. All three are rendered together (the panel used to answer
// 「已安装并连接」 for exactly this reply).
const INSTALL_FAILURE = {
  server: '3dtexel-mcp',
  installed: true,
  connect: { ok: false, error: 'spawn npx ENOENT' },
  counted: false,
  note: '3dtexel-mcp 已写入注册表，但挂载没有成功，因此没有计入本市场安装数；修好后可用「更新」或重新启用来重试。',
  diagnosis: {
    text: 'npx 不在 PATH 里。\n先运行 where npx（Windows）确认 Node 已安装并在 PATH 中。',
    route: 'deepseek/deepseek-chat',
  },
};

// What the host answers when the panel asks who it is and what it has done.
// Two data files, one of them not written yet: the identity line counts the
// ones that exist. The events carry fields the panel knows (`items`, `ms`) and
// fields it has never heard of (`mounted`, `total`), because the log must not
// hide what a newer host chose to record.
const STATUS = {
  plugin: {
    id: 'dsh-overall-mcp',
    version: '0.1.0',
    dir: 'C:/plugins/dsh-overall-mcp',
    loadedAt: '2026-01-01T00:00:00.000Z',
    source: { newestAt: '2026-01-01T00:00:00.000Z', stale: false, files: [{ name: 'index.js', at: '2026-01-01T00:00:00.000Z', bytes: 120 }] },
  },
  host: {
    pid: 4242,
    startedAt: '2026-01-01T07:00:00.000Z',
    uptimeMs: (3 * 3600 + 12 * 60) * 1000,
    node: 'v24.15.0',
    electron: '38.0.0',
    platform: 'win32',
    arch: 'x64',
  },
  data: {
    dir: 'C:/dsh/overall-mcp',
    files: [
      { name: 'registry.json', bytes: 128, at: '2026-01-01T09:00:00.000Z' },
      { name: 'github-index.json', bytes: null, at: null },
    ],
  },
  // `census` and `auth` are supplied by the /status handler below, from the live
  // objects the sections mutate — the same reason a panel needs a host: these
  // two change while the page is open.
  // A census that stopped at the anonymous rate limit: the panel has to say so,
  // because 15 of 77 rows read looks exactly like a finished walk otherwise.
  evidence: {
    rows: 15, withCommand: 3, at: '2026-01-01T09:30:00.000Z', walking: false,
    requests: 60,
    partial: '第 60 次请求失败：rate limit exceeded（匿名访问：在已注册标签页里填一个 GitHub token，上限从 60 次/小时升到 5000 次/小时）',
  },
  quota: { remaining: 60, limit: 60, resetMs: 0 },
  events: { bytes: 512, at: '2026-01-01T10:00:02.000Z', lines: 2, damaged: 1, lastAt: '2026-01-01T10:00:02.000Z' },
  errors: { registry: '', sources: '' },
};
const EVENTS = {
  total: 5,
  damaged: 1,
  events: [
    { at: '2026-01-01T10:00:00.000Z', kind: 'browse', source: 'docker-catalog', query: 'mcp', items: 12, ms: 340, cached: true, total: 12 },
    { at: '2026-01-01T10:00:02.000Z', kind: 'install', server: 'codegraph', source: 'claude-code', itemId: 'official:ac.snag/snag', mounted: true, counted: false },
  ],
};

let captured = null;
// The two states of the GitHub credential, and the token the panel is given.
// The host answers with a mask and never with the token, so the page can only
// ever show what is in these objects.
const TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const ANONYMOUS = {
  source: 'anonymous', inUse: false, masked: null, login: null,
  note: '匿名访问：每小时 60 次请求，GitHub 按出口 IP 计算',
  checkedAt: '2026-01-01T09:00:00.000Z',
};
const AUTHENTICATED = {
  source: 'panel', inUse: true, masked: 'ghp_01…wxyz', login: 'harness-user',
  scopes: ['read:user'], rateLimit: { limit: 5000, remaining: 4999, resetAt: '2026-01-01T11:00:00.000Z' },
  storedAt: '2026-01-01T10:00:00.000Z', checkedAt: '2026-01-01T10:00:00.000Z',
};
let liveAuth = ANONYMOUS;
// The census, as /status reports it and as the two verbs change it. A finished
// walk of the size the docs quote, so the row says something a reader can check
// against the index file rather than a placeholder zero.
let liveCensus = {
  rows: 1758,
  at: '2026-01-01T09:30:00.000Z',
  complete: true,
  partial: null,
  requests: 41,
  walking: false,
  progress: null,
  ended: null,
  loaded: true,
  damaged: null,
};
// The recovery walk, as /status reports it and as the two verbs change it. The
// numbers are the shape the docs quote (77 of 2111 read before a stop), so the
// row says something a reader can check against install-evidence.json.
let liveEvidence = {
  rows: 77,
  withCommand: 54,
  at: '2026-01-01T09:40:00.000Z',
  requests: 260,
  partial: '已手动停止（已试 77 个仓库，下次接着走）',
  walking: false,
  progress: null,
  ended: { reason: 'user', at: '2026-01-01T09:40:00.000Z' },
  plan: { at: '2026-01-01T09:40:00.000Z', planned: 2111, attempted: 77, remaining: 2034, retries: 3, requests: 260, stopped: 'user' },
  complete: false,
  damaged: null,
};
// A host older than the panel has no /events route at all. Flipped for the
// first half of section 6c, which is the only way to reach that branch: the
// page only re-reads the log when the box is opened.
let eventsFails = false;
const calls = [];
// The host remembers the fold window between runs; the panel seeds from it.
let storedMerge = 5 * 60 * 1000;
const styleElements = [];
// The skill space's answer: two readable roots, one that has never been created
// (so the panel must say so instead of looking empty), and a shadowed duplicate.

// The 调用 feed: already summarized by the host, so the probe checks what the
// page does with the answer — not how rows are counted (lib/calls.js is tested
// on its own). Two spaces, one failed call, one running call.
const CALL_ROWS = {
  mcp: [
    { id: 'a#1', space: 'mcp', name: 'mcp__gh__search', tool: 'search', server: 'gh', status: 'ok', startedAt: '2026-10-28T09:41:07.000+08:00', ms: 120, session: 's7a2f1', req: '{"q":"keep"}', res: 'done', note: null },
    { id: 'a#2', space: 'mcp', name: 'mcp__s2__fetch', tool: 'fetch', server: 's2', status: 'fail', startedAt: '2026-10-28T09:44:31.000+08:00', ms: 40, session: 's7a2f1', req: '{}', res: 'boom', note: null },
    { id: 'a#3', space: 'mcp', name: 'mcp__gh__issue', tool: 'issue', server: 'gh', status: 'running', startedAt: '2026-10-28T09:45:02.000+08:00', ms: null, session: 's9b0c2', req: '{"n":7}', res: '', note: null },
  ],
  skill: [
    { id: 'b#2', space: 'skill', kind: '触发', name: 'skill', tool: 'skill', skill: 'pdf', status: 'ok', startedAt: '2026-10-28T09:41:40.000+08:00', ms: 18, session: 's7a2f1', req: '{\"name\":\"pdf\"}', res: 'loaded', note: null },
    { id: 'b#1', space: 'skill', kind: '触发', name: 'skill', tool: 'skill', skill: 'gzh-design', status: 'ok', startedAt: '2026-10-28T09:40:00.000+08:00', ms: 11, session: 's1a90b', req: '{\"name\":\"gzh-design\"}', res: 'loaded', note: 'agent 读了 gzh-design 的全文说明' },
    { id: 'b#3', space: 'skill', kind: '触发', name: 'skill', tool: 'skill', skill: 'skill-router', via: '用户引用', count: 2, status: 'ok', startedAt: '2026-10-28T09:42:10.000+08:00', ms: null, session: 's7a2f1', req: '', res: null, note: '你在输入框里用斜杠命令引用了这个技能（宿主把它展开注入本次请求）' },
  ],
};
// The spark lines are real 24-bucket counts, so the fixture carries numbers and
// the panel draws a line instead of the "-" it shows when there is nothing.
const CALL_STATS = {
  mcp: { today: 3, inRange: 3, ok: 1, fail: 1, settled: 2, rate: 50, avgMs: 80, shown: 3, total: 3, spark: [0,0,0,0,0,1,0,2,0,0,1,0,0,0,0,1,0,0,0,0,0,1,0,0] },
  skill: { today: 3, inRange: 4, ok: 3, fail: 0, settled: 3, rate: 100, avgMs: 15, shown: 3, total: 3, spark: [0,0,0,0,0,1,0,3,0,0,1,0,0,0,0,1,0,0,0,0,0,1,0,0] },
};
const CALL_RAIL = {
  mcp: [
    { id: 'gh', today: 2, total: 2, spark: [0,0,0,0,0,1,0,2,0,0,1,0,0,0,0,1,0,0,0,0,0,1,0,0] },
    { id: 's2', today: 1, total: 1, spark: [0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  ],
  skill: [
    { id: 'skill-router', today: 1, total: 1, spark: [0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0] },
    { id: 'pdf', today: 1, total: 1, spark: [0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0] },
    { id: 'gzh-design', today: 1, total: 1, spark: [0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
  ],
};
let callScenario = null;

// The skill market: several sources, one of them refusing, so the per-source
// chips have something other than "all fine" to say.
const SKILL_MARKET_HITS = {
  items: [
    {
      id: 'clawhub:pskoett/self-improving-agent', source: 'clawhub',
      name: 'self-improving-agent', title: 'self-improving agent', summary: 'Keeps notes between runs.',
      version: '4.0.5', downloads: 489160, stars: 4005, category: null, installable: true,
      install: { kind: 'clawhub-zip', owner: 'pskoett', slug: 'self-improving-agent', version: '4.0.5' },
      pageUrl: 'https://clawhub.ai/pskoett/skills/self-improving-agent',
    },
    {
      id: 'official:pdf', source: 'official',
      name: 'pdf', title: 'pdf', summary: 'Read, split and fill PDFs.',
      version: null, downloads: null, category: null, installable: true,
      install: { kind: 'github-dir', repo: 'anthropics/skills', dir: 'skills/pdf' },
      pageUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    },
    {
      id: 'skillhub:dev-god', source: 'skillhub',
      name: 'dev-god', title: '编程大神.Skill', summary: '中文技能，带引用与脚本。',
      version: '1.2.4', downloads: 10281075, stars: 3120, category: 'dev-programming', installable: true,
      install: { kind: 'skillhub-zip', slug: 'dev-god', version: '1.2.4' },
      pageUrl: 'https://skillhub.cn/skills/ake/dev-god',
    },
    {
      id: 'official:docx', source: 'official',
      name: 'docx', title: 'docx', summary: 'Word documents: create, read, edit.',
      version: '1.9.4', downloads: 217000, category: null, installable: true,
      install: { kind: 'github-dir', repo: 'anthropics/skills', dir: 'skills/docx' },
      pageUrl: 'https://github.com/anthropics/skills/tree/main/skills/docx',
    },
    {
      id: 'clawhub:obra/superpowers', source: 'clawhub',
      name: 'superpowers', title: 'obra/superpowers', summary: 'Skills for planning and review loops.',
      version: '0.8.2', downloads: 96100, category: null, installable: true,
      install: { kind: 'clawhub-zip', owner: 'obra', slug: 'superpowers', version: '0.8.2' },
      pageUrl: 'https://clawhub.ai/obra/skills/superpowers',
    },
  ],
  // `total` is what the upstream claims to hold; ClawHub pages by cursor and
  // reports none, which is exactly the case the count line has to admit.
  sources: [
    { id: 'clawhub', label: 'ClawHub', count: 20, error: null },
    { id: 'official', label: 'anthropics', count: 19, total: 19, error: null },
    { id: 'skillhub', label: 'SkillHub', count: 20, total: 209323, error: null },
    { id: 'github', label: 'GitHub', count: 0, featured: 63, error: '403 API rate limit exceeded' },
  ],
};

// Enough rows to need a second page: 20 items, two of which become spotlights.
for (let i = 0; i < 40; i += 1) {
  SKILL_MARKET_HITS.items.push({
    id: `clawhub:demo/skill-${i}`, source: 'clawhub',
    name: `skill-${i}`, title: `demo skill ${i}`, summary: 'A generated row for paging.',
    version: '1.0.0', downloads: 1000 - i, stars: i, category: null, installable: true,
    install: { kind: 'clawhub-zip', owner: 'demo', slug: `skill-${i}`, version: '1.0.0' },
    pageUrl: `https://clawhub.ai/demo/skills/skill-${i}`,
  });
}

const SKILLS = {
  skills: [
    {
      id: 'user:ab-test-analysis', root: 'user', name: 'ab-test-analysis', dirName: 'ab-test-analysis',
      description: '分析 A/B 实验结果：显著性、样本量校验、置信区间，以及「上线 / 延长 / 停掉」的建议。',
      version: 'v1.0.0', origin: 'ECC', icon: 'data:image/png;base64,aGVsbG8=', iconIssue: '审计图标读取错误', license: 'MIT', author: '', homepage: '', tools: '', toolsOff: false,
      files: 1, bytes: 6359, modifiedAt: '2026-10-21T01:12:00.000Z',
      dir: 'C:\\Users\\tester\\.agents\\skills\\ab-test-analysis',
    },
    {
      id: 'user:gzh-design', root: 'user', name: 'gzh-design', dirName: 'gzh-design',
      pageUrl: 'https://skillhub.cn/skills/demo/gzh-design',
      description: '微信公众号排版：Markdown → 可直接粘贴的 HTML，自动章节编号、关键词下划线、目录与签名。',
      version: 'v0.9.2', origin: 'SkillHub', license: '', author: '', homepage: '', tools: '', toolsOff: false,
      files: 12, bytes: 225280, modifiedAt: '2026-10-25T03:40:00.000Z',
      dir: 'C:\\Users\\tester\\.agents\\skills\\gzh-design',
    },
    {
      id: 'plugin:release-notes-zh', root: 'plugin', name: 'release-notes-zh', dirName: 'release-notes-zh',
      pageUrl: 'javascript:alert(1)',
      description: '把本批提交整理成给人读的更新日志：只写用户可见的后果，不写实现细节。',
      version: 'v0.1.0', origin: '', license: '', author: '', homepage: '', tools: '', toolsOff: false,
      files: 3, bytes: 18432, modifiedAt: '2026-10-27T02:05:00.000Z',
      dir: 'C:\\Users\\tester\\.dsh\\skills\\release-notes-zh',
    },
  ],
  duplicates: 2,
  roots: [
    {
      id: 'plugin', label: '本插件', dir: 'C:\\Users\\tester\\.dsh\\skills',
      note: '本插件写入，适合放自建 skill', count: 1, found: 1, folded: 0, bytes: 18432, error: null,
    },
    {
      id: 'user', label: '本机', dir: 'C:\\Users\\tester\\.agents\\skills',
      note: '宿主启动时读取', count: 2, found: 2, folded: 0, bytes: 231639, error: null,
    },
    {
      // On a real machine this is often the same skills as `user`, so the user
      // root wins and the copies here count as shadowed duplicates.
      id: 'claude', label: 'Claude', dir: 'C:\\Users\\tester\\.claude\\skills',
      note: 'Claude Code 的目录', count: 2, found: 6, folded: 4, bytes: 231639, error: null,
    },
    {
      id: 'codex', label: 'Codex', dir: 'C:\\Users\\tester\\.codex\\skills',
      note: 'Codex CLI 的目录', count: 0, found: 0, folded: 0, bytes: 0, error: 'missing',
    },
  ],
  totals: { count: 3, files: 16, bytes: 250071 },
  scannedAt: '2026-10-27T10:00:00.000Z',
};

// The drawer and the removal dialog subscribe Escape through window; the probe
// never dispatches a key, so empty listeners are all they need to mount.
globalThis.window = {
  matchMedia: () => ({ matches: true }),
  __ModuleLoader__: { load(spec) { captured = spec; } },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};
let repoStatsResponder = null;
let skillMetricsResponder = null;
let selfInstallGate = null;
let registryPagingRows = null;
let registrySourceAction = null;
let registryRowAction = null;
let catalogGate = null;
const catalogBodies = [];
globalThis.fetch = async (url, init) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const path = String(url).replace('/api/overall-mcp', '');
  if (path.startsWith('/catalog')) {
    // The source filter travels in the POST body, not the query string.
    let source = '';
    let refresh = false;
    try {
      const body = JSON.parse(init?.body ?? '{}');
      source = body.source ?? '';
      refresh = body.refresh === true;
    } catch { source = ''; }
    const request = JSON.parse(init?.body ?? '{}');
    catalogBodies.push(request);
    if (catalogGate) return catalogGate(request);
    calls.push(`POST /catalog${source ? ` source=${source}` : ''}${refresh ? ' refresh' : ''}`);
    // A view answers under its upstream's key — the listing below carries one
    // number, `github-mcp` — and names the upstream it borrowed. That pair is the
    // whole shape `?source=census` sends, so the panel is exercised on it.
    if (source === 'census') return ok({ ...MARKET, aliasOf: 'github-mcp' });
    return ok(MARKET);
  }
  // The user's own sources: GET lists them, POST adds one, /remove drops one.
  // Adding is answered with the list the host would send back afterwards.
  if (path.startsWith('/sources/remove')) {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(`POST /sources/remove id=${body.id}`);
    liveSources = liveSources.filter((s) => s.id !== body.id);
    return ok({ removed: CUSTOM_SOURCE, dropped: 1, sources: liveSources, max: 8, error: '' });
  }
  if (path.startsWith('/sources')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      calls.push(`POST /sources url=${body.url}`);
      return ok({ source: CUSTOM_SOURCE, sources: liveSources, max: 8, error: '' });
    }
    calls.push('GET /sources');
    return ok({ sources: liveSources, max: 8, error: '' });
  }
  // The GitHub credential: one path, three methods, and a reply that carries the
  // credential's own state (never the token).
  if (path.startsWith('/auth')) {
    const method = init?.method ?? 'GET';
    if (method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      calls.push(`POST /auth token=${body.token}`);
      if (!String(body.token ?? '').trim()) {
        return { ok: false, status: 400, json: async () => ({ error: 'token 不能为空', status: 400 }) };
      }
      liveAuth = { ...AUTHENTICATED, storedAt: '2026-01-01T10:00:00.000Z' };
      return ok(liveAuth);
    }
    if (method === 'DELETE') {
      calls.push('DELETE /auth');
      liveAuth = ANONYMOUS;
      return ok({ ...liveAuth, removed: true });
    }
    calls.push('GET /auth');
    return ok(liveAuth);
  }
  // The census, and the two verbs the reader owns. The reply is the state right
  // after the call: `started` says *this* call started a walk, `walking` says
  // one is running, and `stopping` says there was one to stop.
  if (path.startsWith('/census')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      calls.push(`POST /census action=${body.action}`);
      if (body.action === 'stop') {
        liveCensus = { ...liveCensus, walking: false, ended: { reason: 'user', at: '2026-01-01T10:05:00.000Z' } };
        return ok({ ...liveCensus, stopping: true, started: false });
      }
      liveCensus = { ...liveCensus, walking: true, progress: { requests: 0, rows: liveCensus.rows } };
      return ok({ ...liveCensus, started: true, stopping: false });
    }
    calls.push('GET /census');
    return ok({ ...liveCensus, started: false, stopping: false });
  }
  // The recovery walk behind the GitHub rows, with the same three shapes: a GET
  // reads, `start` begins (and says whether *this* call was the one that did),
  // `stop` ends what is running.
  if (path.startsWith('/install-evidence')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      calls.push(`POST /install-evidence action=${body.action ?? 'start'}`);
      if (body.action === 'stop') {
        liveEvidence = {
          ...liveEvidence,
          walking: false,
          progress: null,
          ended: { reason: 'user', at: '2026-01-01T10:06:00.000Z' },
          partial: '已手动停止（已试 78 个仓库，下次接着走）',
        };
        return ok({ ...liveEvidence, stopping: true, started: false });
      }
      liveEvidence = {
        ...liveEvidence,
        walking: true,
        partial: null,
        progress: { requests: 261, attempted: 78, planned: 2111 },
      };
      return ok({ ...liveEvidence, started: true, stopping: false });
    }
    calls.push('GET /install-evidence');
    return ok({ ...liveEvidence, started: false, stopping: false });
  }
  // The install that reached the registry and did not mount — the reply the
  // panel must not summarise as success.
  if (path.startsWith('/install')) {
    calls.push('POST /install');
    return ok(INSTALL_FAILURE);
  }
  // The Skill space: list, then reveal one folder. The reveal route is tested
  // first — `startsWith('/skills')` would otherwise swallow it.
  if (path.startsWith('/skills/reveal')) {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(`POST /skills/reveal id=${body.id}`);
    assert.equal(init?.method, 'POST', 'revealing a skill folder is a POST');
    const hit = SKILLS.skills.find((skill) => skill.id === body.id);
    return hit ? ok({ ok: true, dir: hit.dir }) : { ok: false, status: 404, json: async () => ({ ok: false, error: 'not scanned' }) };
  }
  // Removal is a move, so the page must send `confirm: true` in the same
  // request and the host answers with where the folder went.
  if (path.startsWith('/skills/remove')) {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(`POST /skills/remove id=${body.id}`);
    assert.equal(init?.method, 'POST', 'removing a skill is a POST');
    assert.equal(body.confirm, true, 'the remove request must say confirm: true');
    const hit = SKILLS.skills.find((skill) => skill.id === body.id);
    if (!hit) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unknown skill' }) };
    SKILLS.skills = SKILLS.skills.filter((skill) => skill.id !== body.id);
    SKILLS.roots = SKILLS.roots.map((root) => (root.id === hit.root
      ? { ...root, count: root.count - 1, bytes: root.bytes - hit.bytes }
      : root));
    SKILLS.totals = { ...SKILLS.totals, count: SKILLS.totals.count - 1 };
    return ok({
      ok: true,
      name: hit.name,
      dir: hit.dir,
      trashedTo: `C:\\Users\\tester\\.dsh\\overall-mcp\\skills-trash\\2026-10-27T11-20-00\\${hit.root}-${hit.dirName}`,
    });
  }
  // The 调用 feed. Filtering is the host's job, so the branch filters the same
  // way the host does and echoes what it was asked.
  if (path.startsWith('/prefs')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      storedMerge = Number(body.merge);
      calls.push(`POST /prefs merge=${storedMerge}`);
      return ok({ merge: storedMerge });
    }
    calls.push('GET /prefs');
    return ok({ merge: storedMerge });
  }
  if (path.startsWith('/calls')) {
    const query = new URL(path, 'http://127.0.0.1').searchParams;
    const space = query.get('space') === 'skill' ? 'skill' : 'mcp';
    const filter = query.get('filter') ?? '';
    const wanted = query.get('q') ?? '';
    if (callScenario) return ok(summarize(callScenario.rows, { space, range: query.get('range') ?? '24h', filter, q: wanted, now: callScenario.now }));
    // The fold window is a reading rule the panel chooses; record it so the
    // probe can see the panel ask for a different one.
    const merge = query.get('merge');
    calls.push(`GET /calls space=${space} range=${query.get('range') ?? ''}${merge === null ? '' : ` merge=${merge}`}${filter ? ` filter=${filter}` : ''}${wanted ? ` q=${wanted}` : ''}`);
    const keyOf = (row) => (space === 'mcp' ? row.server : (row.skill || '会话加载'));
    let rows = CALL_ROWS[space].filter((row) => !filter || keyOf(row) === filter);
    if (wanted === 'nothing') rows = [];
    else if (wanted) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(wanted.toLowerCase()));
    return ok({ merge: merge === null ? storedMerge : Number(merge), rows, stats: CALL_STATS[space], rail: CALL_RAIL[space], coverage: { since: '2026-10-21T00:00:00.000Z', kept: rows.length, dropped: 0, damaged: 0, running: 0 } });
  }
  // The market: four upstreams, one of which is down. Installing moves bytes,
  // so the fixture counts the call and answers with where it landed.
  if (path.startsWith('/skills/market/metrics')) {
    const body = JSON.parse(init.body);
    calls.push('POST /skill-metrics');
    if (skillMetricsResponder) return skillMetricsResponder(body);
    return ok({ items: Object.fromEntries(body.ids.map(id => [id, { metrics: { at: new Date().toISOString(), stale: false } }])), updated: body.ids.length, errors: [] });
  }
  if (path.startsWith('/skills/market/install')) {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(`POST /skills/market/install id=${body.id} root=${body.root ?? ''}`);
    assert.equal(init?.method, 'POST', 'installing from the market is a POST');
    const hit = SKILL_MARKET_HITS.items.find((item) => item.id === body.id);
    if (!hit) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'unknown skill id, list the market first' }) };
    SKILLS.skills.push({ id: `plugin:${hit.name}`, name: hit.name, root: 'plugin', marketId: hit.id,
      dir: `C:/preview/skills/${hit.name}`, description: hit.summary, files: 4, bytes: 1024 });
    SKILLS.totals.count++;

    return ok({
      ok: true, name: hit.name, source: hit.source, files: 4,
      dir: `C:\\Users\\tester\\.dsh\\skills\\${hit.name}`,
    });
  }
  if (path.startsWith('/skills/market')) {
    const body = JSON.parse(init?.body ?? '{}');
    if (init?.method === 'POST') calls.push(`POST /skills/market query=${body.query ?? ''} category=${body.category} offset=${body.offset} refresh=${body.refresh}`);
    else calls.push('GET /skills/market');
    const { items, ...page } = querySkillRows(SKILL_MARKET_HITS.items, body);
    return ok({ ...SKILL_MARKET_HITS, items, paging: { mode: 'live', rows: SKILL_MARKET_HITS.items.length, ...page } });
  }
  if (path === '/skills/updates') {
    calls.push('POST /skills/updates');
    assert.equal(init?.method, 'POST');
    return ok({ checked: 0, updatable: 0, failed: 0, entries: [], skipped: { '未记录市场来源': 3 }, rootErrors: [] });
  }
  if (path.startsWith('/skills')) {
    calls.push('GET /skills');
    return ok(SKILLS);
  }
  if (path.startsWith('/servers')) return ok({ servers: registryPagingRows ?? [{ name: 'codegraph', source: 'claude-code', enabled: true }] });
  if (registryPagingRows && path.startsWith('/set-source-enabled')) {
    registrySourceAction = JSON.parse(init.body);
    registryPagingRows.forEach(row => { if (row.source === registrySourceAction.source) row.enabled = registrySourceAction.enabled; });
    return ok({ ...registrySourceAction, changed: registryPagingRows.length });
  }
  if (registryPagingRows && path.startsWith('/remove')) {
    registryRowAction = JSON.parse(init.body);
    return ok({ removed: registryRowAction.name });
  }
  if (path.startsWith('/repo-stats')) return repoStatsResponder ? repoStatsResponder(JSON.parse(init.body)) : ok({ stats: {} });
  if (path.startsWith('/repo-media')) return ok({ media: {} });
  // The favourites filter asks the host for the whole set, because /catalog
  // only marks the entries the current query returned.
  if (path.startsWith('/favorites')) {
    calls.push('GET /favorites');
    return ok({ favorites: ['official-registry:official:ac.snag/snag', 'smithery:brave-search'], count: 2 });
  }
  if (path === '/mcp/updates') {
    calls.push('POST /mcp/updates');
    assert.equal(init?.method, 'POST');
    return ok({ checked: 2, updatable: 0, failed: 1, entries: [
      { name: 'test-mcp', detectable: true, error: 'lookup failed' },
      { name: 'floating-mcp', detectable: true, unpinned: true, current: '1.1.0', latest: '1.1.0' },
      { name: 'remote-mcp', detectable: false, reason: 'not launched through a package runner' },
    ] });
  }
  if (path === '/self?refresh=1') {
    calls.push('GET /self');
    assert.equal(init?.method, 'GET');
    return ok({
        name: 'dsh-overall-mcp',
        version: '0.1.0',
        latest: '0.2.0',
        install: 'registry',
        profileName: 'desktop',
        checked: true,
        updateAvailable: true,
        reason: 'newer-published',
    });
  }
  if (path.startsWith('/self-update')) {
    calls.push('POST /self-update');
    if (selfInstallGate) await selfInstallGate;
    return ok({ ok: true, updated: true, from: '0.1.0', to: '0.2.0', command: 'dsh plugin --profile desktop add dsh-overall-mcp@0.2.0', restartRequired: true });
  }
  // Which build this panel is talking to, and what that build has been doing.
  if (path.startsWith('/status')) {
    calls.push('GET /status');
    return ok({ ...STATUS, auth: liveAuth, census: liveCensus, evidence: liveEvidence });
  }
  if (path.startsWith('/events/retry')) { EVENTS.persistence = { ok: true }; return ok({ ok: true }); }
  if (path.startsWith('/events')) {
    calls.push('GET /events');
    if (eventsFails) return { ok: false, status: 404, json: async () => ({}) };
    return ok(EVENTS);
  }
  return ok({});
};

const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);
assert.ok(mod.__test?.MarketCard, 'client exports __test.MarketCard');
assert.equal(typeof mod.Section, 'function', 'client exports Section');
const openedSourcePages = [];
mod.apply({ slots: { inject() {} }, get: name => ({
  sidebarRightTabs: { get: type => type === 'browser' ? {} : undefined },
  sidebarRight: { openTab: (type, { params }) => openedSourcePages.push([type, params.url]) },
})[name] });

/** Render a descriptor tree, invoking function components bottom-up. */
function renderNode(node) {
  if (node == null || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous';
    const ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    const key = `${name}#${ordinal}`;
    let frame = frameStore.get(key);
    if (!frame) { frame = { hooks: [], cursor: 0 }; frameStore.set(key, frame); }
    frame.cursor = 0;
    frames.push(frame);
    let out;
    try { out = node.type(node.props ?? {}); } finally { frames.pop(); }
    return renderNode(out);
  }
  const props = { ...(node.props ?? {}) };
  if ('children' in props) props.children = renderNode(props.children);
  return { type: node.type, props, children: (node.children ?? []).map(renderNode) };
}

/** Let the promise chains the effects started settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Render Section, run the effects it registered, and keep rendering until the
 * tree stops changing — the same loop a real commit + async state update does.
 */
/** A single pass with no effects run: what the first paint looks like. */
function renderOnce() {
  ordinals.clear();
  return renderNode({ type: mod.Section, props: {} });
}

/**
 * Render Section, run the effects it registered, and keep rendering until the
 * tree stops changing — the same loop a real commit + async state update does.
 */
async function render() {
  for (let pass = 0; pass < 6; pass += 1) {
    ordinals.clear();
    renderNode({ type: mod.Section, props: {} });
    const pending = effects.splice(0, effects.length);
    for (const fn of pending) {
      try { fn(); } catch (err) { throw new Error(`effect threw: ${err.message}`); }
    }
    await settle();
    await settle();
  }
  ordinals.clear();
  return renderNode({ type: mod.Section, props: {} });
}

function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if ('type' in node) {
    out.push(node);
    walk(node.children, out);
    walk(node.props?.children, out);
  }
  return out;
}
function textOf(node) {
  const parts = [];
  const collect = (n) => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (typeof n === 'object' && 'type' in n) { collect(n.children); collect(n.props?.children); }
  };
  collect(node);
  return parts.join('');
}
function findByKey(nodes, key) { return nodes.filter((n) => n.props?.key === key); }
function buttonByText(nodes, label) {
  return nodes.find((n) => n.type === 'button' && textOf(n) === label);
}

// --- 1. first paint: the host has not answered yet -------------------------
const nodes = walk(renderOnce());
const tabs = findByKey(nodes, 'tabs');
assert.equal(tabs.length, 1, 'tab bar present');
let tabButtons = walk(tabs[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册', '市场', '调用记录'], 'tab labels before the host answers');

// --- 2. loaded: the registry tab counts its servers ------------------------
let loadedNodes = walk(await render());
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册 (1)', '市场', '调用记录 (3)'], 'tab labels carry live counts');

// --- 3. clicking into the market loads the listings ------------------------
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');

const openMarket = buttonByText(tabButtons, '市场');
assert.ok(openMarket, 'the market tab is clickable');
openMarket.props.onClick();
loadedNodes = walk(await render());
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册 (1)', '市场', '调用记录 (3)'], 'market tab counts the listings');

// The approved UI uses one search/facet row and a second quick-category row.
function directChildren(node) {
  const out = [];
  const push = c => { if(Array.isArray(c))c.forEach(push);else if(c!=null && c!==false && c!==true)out.push(c); };
  (node.children ?? []).forEach(push);if(node.props?.children)push(node.props.children);return out;
}
const marketPage = findByKey(loadedNodes, 'mkt')[0];
assert.ok(marketPage, 'market page container present');
const marketOwn = directChildren(marketPage);
const searchRow = walk(marketPage).filter(n => n.props?.className === 'omkt-market-search');
assert.equal(searchRow.length, 1, 'one market search/facet row');
assert.ok(walk(searchRow[0]).some(n => n.type==='button' && n.props['aria-label']==='搜索'), 'explicit search trigger');
assert.ok(walk(searchRow[0]).some(n => n.type==='button' && n.props['aria-label']==='刷新市场'), 'refresh remains in the search row');
const metaText = textOf(marketPage);
assert.ok(metaText.includes('3 个可用连接器'), 'heading names the catalogue total');
const pager = findByKey(loadedNodes,'pager')[0];
assert.ok(walk(pager).some(n=>n.props?.['aria-current']==='page' && textOf(n)==='1'), 'numbered pager marks current page');
assert.ok(textOf(pager).includes('每页 20 条'), 'page size stays reachable');
const filters = searchRow;
const filterRow = walk(searchRow[0]);
const groupSelect = filterRow.find(n=>n.type==='select' && n.props['aria-label']==='按分类筛选市场');
assert.ok(groupSelect, 'all categories reachable in a select');
const groupOptions = walk(groupSelect).filter(n=>n.type==='option');
assert.equal(groupOptions.length,4,'all plus every loaded category');
assert.equal(textOf(groupOptions[0]),'全部分类');
assert.deepEqual(groupOptions.slice(1).map(textOf), ['开发工具','搜索与知识','未分类']);
assert.ok(walk(marketPage).some(n=>n.props?.className==='omkt-market-categories'), 'quick categories under the search row');

const sourceLine = walk(marketPage).filter((n) => n.props?.key === 'srcline');
assert.equal(sourceLine.length, 1, 'per-source line present');
const sourceText = textOf(sourceLine[0]);
assert.ok(sourceText.includes('官方 1'), 'per-source line names the sources');
// The figure beside a source is what it is *credited with in this listing*
// (`merged`), not the rows it walked — otherwise the parts add up to more than
// 「共 N 条」 and the panel's own arithmetic looks broken.
assert.ok(sourceText.includes('Awesome 2'), `a source shows the cards it contributed (got ${sourceText})`);
assert.ok(sourceText.includes('去重合并 1 条（同一仓库被多个来源收录）'),
  `the overlap is stated once, in words (got ${sourceText})`);
// A source carrying a coverage note is marked "部分" on this line, and the
// reason itself is spelled out in the manager box below.
assert.ok(sourceText.includes('GitHub 2（部分'), `a partially-read source is marked (got ${sourceText})`);
assert.ok(sourceText.includes('其中 1 个已安装'), 'per-source line names the installed count');

// --- 3c-2. a failed source says why, and whether its rows are old ------------
// The line used to name the failed sources and stop there, which made a rate
// limit ("HTTP 403") look exactly like a typo'd custom URL — the host had the
// reason all along. Both facts have to reach the reader, and a source that
// answered from its last walk is a different fact from one with nothing to
// show: the first is behind, the second is missing.
const warnLine = marketOwn.filter((n) => n.props?.key === 'warn');
assert.equal(warnLine.length, 1, 'the failure line appears when a source failed');
const warnText = textOf(warnLine[0]);
assert.ok(warnText.includes('部分来源不可用：'), `failure line names its subject (got ${warnText})`);
assert.ok(warnText.includes('Docker（不可用：HTTP 403）'), `a failure carries its reason (got ${warnText})`);
assert.ok(warnText.includes('GitHub（旧数据：搜索配额已用完（约 42 秒后恢复））'),
  `a source that answered from its last walk says so (got ${warnText})`);
// The untruncated text stays on the line: a long upstream message must not cost
// the reader the part that tells them what to do about it.
assert.ok(String(warnLine[0].props.title).includes('搜索配额已用完（约 42 秒后恢复）'),
  'the full reason stays available even when the line shortens it');

// --- 3d. the user's own catalogue sources -----------------------------------
// A source the user pointed at is a first-class source: it must be reachable
// from the filter, listed with its own numbers in the manager, and removable
// from there. The host reports it as contributing nothing to this listing,
// which is exactly the state that used to be invisible — 「我加了但它好像没生效」.
{
  const srcSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'smithery'));
  const customOption = directChildren(srcSelect).find((o) => o.props?.value === CUSTOM_SOURCE.id);
  assert.ok(customOption, 'the source filter lists a user-added source');
  assert.equal(textOf(customOption), 'acme/mcp-registry', 'and names it by its label, not its machine id');

  const box = findByKey(loadedNodes, 'srcedit');
  assert.equal(box.length, 1, 'the source manager is present');
  assert.ok(textOf(box[0]).includes('自定义 1 / 8'), 'the manager states how many are configured');

  const manage = buttonByText(walk(box[0]), '管理');
  assert.ok(manage, 'the manager has a toggle instead of always taking space');
  manage.props.onClick();
  const opened = walk(await render());
  const openBox = findByKey(opened, 'srcedit')[0];
  const rowText = textOf(openBox);
  assert.ok(rowText.includes('acme/mcp-registry'), 'the row names the source');
  assert.ok(rowText.includes(CUSTOM_SOURCE.url), 'and shows the address it reads');
  assert.ok(/0 条/.test(rowText), `a source that contributed nothing says so instead of vanishing (got ${rowText})`);
  assert.ok(rowText.includes('内置：'), 'the built-in sources are listed beside the user\'s own');
  // The GitHub search source is one of them now, and a source that answered
  // nothing shows the reason — a bare `0` would read as "this catalog is empty".
  assert.ok(rowText.includes('GitHub MCP 2'), `the GitHub source and its row count are on the line (got ${rowText})`);
  // A source that only read part of its list says so beside the count: the
  // number alone would overstate what the market actually holds. For the GitHub
  // census that means the size of the census and its age, not just the slice.
  assert.ok(rowText.includes('本地索引 1758 行'), `the census size is on the line, not only the slice (got ${rowText})`);
  assert.ok(rowText.includes('3 小时前'), 'and how old it is');
  assert.ok(rowText.includes('本次列出 2 条'), 'and how much of it this listing took');
  assert.ok(rowText.includes('Docker MCP Catalog 不可用：HTTP 403'), `a failed source shows why (got ${rowText})`);
  // How many rows the recovery walk turned into installable rows is a second
  // number, not a restatement of the census: the line has to carry both.
  assert.ok(rowText.includes('已从仓库恢复 320 条安装命令'), `recovered install commands are counted (got ${rowText})`);
  assert.ok(textOf(srcSelect).includes('GitHub MCP'), 'and the new source is offered as a filter');
  assert.ok(rowText.includes('最多 8 个'), 'the cap and the https rule are stated where the URL is typed');

  // Where the list accepts entries, the row offers the uplink — and it opens the
  // prefilled issue, not the repository (the point is that nobody has to know
  // how the list is fed).
  const submitLink = walk(openBox).find((n) => n.type === 'a' && String(n.props?.href ?? '').includes('/issues/new'));
  assert.ok(submitLink, 'a GitHub-hosted list offers a 投稿 link');
  assert.equal(textOf(submitLink), '投稿 ↗', 'and says what it does');
  assert.equal(submitLink.props.href, CUSTOM_SOURCE.submission.url, 'opening the prefilled issue the host derived');
  assert.equal(submitLink.props.target, '_blank', 'outside the panel, in a browser tab');

  // Typing an address and adding it must reach the host, and the page must then
  // re-read the listing: the rows of a source added a moment ago are not in the
  // listing the page is holding.
  const input = walk(openBox).find((n) => n.type === 'input' && String(n.props?.placeholder ?? '').includes('raw.githubusercontent'));
  assert.ok(input, 'the manager has a URL field');
  input.props.onChange({ target: { value: 'https://example.com/other.json' } });
  const withDraft = walk(await render());
  const addBtn = buttonByText(findByKey(withDraft, 'srcedit').length ? walk(findByKey(withDraft, 'srcedit')[0]) : [], '添加');
  assert.ok(addBtn, 'the add button appears beside the field');
  assert.equal(addBtn.props.disabled, false, 'a typed address can be submitted');
  const beforeAdd = calls.length;
  addBtn.props.onClick();
  await render();
  const addCalls = calls.slice(beforeAdd).join(' ');
  assert.ok(addCalls.includes('POST /sources url=https://example.com/other.json'),
    `adding must post the address (got: ${addCalls || 'nothing'})`);
  assert.ok(addCalls.includes('POST /catalog') && addCalls.includes('refresh'),
    `and re-read the listing, or the new source looks empty (got: ${addCalls || 'nothing'})`);

  // Removing must name the source by its id, and the row must go.
  const removed = walk(await render());
  const body = findByKey(removed, 'srcedit')[0];
  const del = buttonByText(walk(body), '移除');
  assert.ok(del, 'each user-added row has a remove control');
  const beforeRemove = calls.length;
  del.props.onClick();
  // Removing ends in two awaits (the host's answer, then the re-read listing),
  // so give the page a tick before reading the tree again.
  await settle();
  const afterRemove = walk(await render());
  assert.ok(calls.slice(beforeRemove).join(' ').includes(`POST /sources/remove id=${CUSTOM_SOURCE.id}`),
    'removing posts the id the host issued, not the label');
  assert.ok(textOf(findByKey(afterRemove, 'srcedit')[0]).includes('还没有自定义源'),
    'and the manager falls back to its empty copy');
  console.log('custom sources: filter option, manager rows, add/remove and the 投稿 uplink ✓');
}

// Conditional requests are invisible unless the page says so: "refreshed" and
// "asked and told nothing changed" look identical without this. The span lives
// inside the meta line, so read the line's own text.
const freshnessLine = walk(marketPage).filter((n) => n.props?.key === 'pager');
assert.equal(freshnessLine.length, 1, 'freshness meta line present');
const freshnessText = textOf(freshnessLine[0]);
assert.ok(freshnessText.includes('列表读取于 '), 'freshness line leads with the timestamp');
assert.ok(freshnessText.includes('（缓存）'), 'freshness line marks a cached listing');
assert.ok(freshnessText.includes('2 源未变'), 'freshness line reports how many sources answered 304');
// The listing's own read time is a different fact from the repository's last
// push, and the two used to share the word 更新于: this clock says when *we*
// looked, so it must not be read as upstream's.
assert.equal(freshnessText.includes('更新于'), false, 'the local clock is not spelled 更新于');

const search = loadedNodes.find((n) => n.type === 'input'
  && String(n.props?.placeholder ?? '').includes('搜索'));
assert.ok(search, 'market search input present');
// The placeholder names the thing being searched (MCP), not the catalogue's
// provenance: 「搜索 MCP 来源」 reads as a filter over sources.
assert.equal(search.props.placeholder, '搜索名称、用途或开发者…', 'search names useful attributes');
assert.equal(search.props['aria-label'], '搜索市场', 'search has an accessible name');

// --- 3e. an install that did not mount says so, and adds what it can -------
// The reply carries `connect.ok === false` plus whatever the host could add.
// Rendering it as a success was the panel's own lie about its own work; the
// interesting part now is that all three layers survive to the screen.
{
  const tree = walk(await render());
  const install = buttonByText(tree, '安装');
  assert.ok(install, 'the installable card offers 安装');
  const beforeInstall = calls.length;
  // The CTA stops the click from reaching the card body (which opens 详情), so
  // the handler expects the event it always gets in a browser.
  install.props.onClick({ stopPropagation() {} });
  // Two awaits before the message appears (the host's answer, then the refresh
  // of both the registry and the listing).
  await settle();
  await settle();
  const after = walk(await render());
  assert.ok(calls.slice(beforeInstall).join(' ').includes('POST /install'), 'the click posts an install');

  const block = findByKey(after, 'installfail');
  assert.equal(block.length, 1, 'the failed install gets its own block, not a success line');
  assert.equal(block[0].props.style?.whiteSpace, 'pre-wrap', 'three facts on three lines need pre-wrap');
  const failureText = textOf(block[0]);
  assert.ok(failureText.includes('3dtexel-mcp 已写入注册表，但挂载没有成功：spawn npx ENOENT'),
    `the host's own error leads and is quoted verbatim (got: ${failureText})`);
  assert.ok(failureText.includes('npx 不在 PATH 里。'), 'the model explanation is shown');
  assert.ok(failureText.includes('先运行 where npx'), 'and its next step too');
  assert.ok(failureText.includes('（由 deepseek/deepseek-chat 诊断）'), 'the explanation names the route that made it');
  assert.ok(failureText.includes('没有计入本市场安装数'), 'and the note about the install counter survives');
  assert.equal(textOf(after).includes('已安装并连接'), false, 'a failed mount is never reported as a success');
  console.log('failed install: raw error + model explanation + retry note ✓');
}

// --- 4. the masonry wrapper holds one rendered card per entry --------------
const grids = findByKey(loadedNodes, 'grid');
assert.equal(grids.length, 1, 'card grid present');
// The column count is a media query in the injected sheet (inline styles
// cannot express one), so the class is the hook that makes it bite. Without
// it the grid falls back to two columns on a wide pane.
assert.equal(grids[0].props?.className, 'omkt-grid', 'grid carries the breakpoint class');
const cards = walk(marketPage).filter((n) => n.type === 'article');
assert.equal(cards.length, 3, `one card per listing (got ${cards.length})`);
const ctaButtonsAll = [];
const ctaTexts = [];
for (const card of cards) {
  const inner = walk(card);
  const cta = findByKey(inner, 'cta');
  assert.equal(cta.length, 1, 'card has a CTA column');
  const ctaButtons = walk(cta[0]).filter((n) => n.type === 'button' && n.props?.key !== 'fav');
  // Every card offers 详情; only installable ones offer a button, and a
  // manual-only entry must say so instead of showing a dead 安装.
  assert.ok(inner.some(n=>String(n.props?.['aria-label'] ?? '').endsWith('详情')), 'card offers an accessible detail control');
  ctaButtonsAll.push(...ctaButtons.map(textOf));
  ctaTexts.push(textOf(cta[0]));
  // The favourite control must sit outside the clickable body, or a star
  // would also open the detail panel.
  const body = findByKey(inner, 'body')[0];
  assert.ok(body, 'card has a body surface');
  const fav = findByKey(inner, 'fav')[0];
  if (!String(card.props.className).includes('omkt-featured')) {
    assert.ok(fav, 'ordinary card has a favourite control');
    assert.equal(containsNode(body, fav), false, 'favourite control is outside the body surface');
  }
}
assert.deepEqual(ctaButtonsAll.sort(), ['安装', '需手动配置'].sort(), 'CTA set: one install and one manual configuration');
assert.ok(ctaTexts.some((t) => t.includes('需手动配置')), 'manual-only entry says so in place of a button');
assert.ok(ctaTexts.some((t) => t.includes('已安装')), 'installed entry is marked instead of installable');
// Every card states a category — including the entries whose source publishes
// none, which must read 未分类 rather than silently dropping the chip. (The
// fixture used to give all three cards a `group`, so this gap shipped.) Both
// spellings count: `分类：…` for what the source published, `分类（按名称与描述
// 推断）：…` for the ones this panel read off the entry's own words.
for (const card of cards.filter(card=>!String(card.props.className).includes('omkt-featured'))) {
  const kinds = walk(card).filter((n) => n.type === 'span'
    && typeof n.props?.title === 'string' && /^分类/.test(n.props.title));
  assert.equal(kinds.length, 1, 'every card carries exactly one 分类 chip');
}
{
  const remoteCard = cards.find((c) => String(c.props.title ?? '').startsWith('example-mcp'));
  assert.ok(remoteCard, 'the uncategorized entry renders');
  const chip = walk(remoteCard).find((n) => n.type === 'span'
    && typeof n.props?.title === 'string' && /^分类：/.test(n.props.title));
  assert.equal(textOf(chip), '未分类', 'an entry with no upstream category says 未分类');
}
function containsNode(root, target) {
  let found = false;
  const visit = (n) => {
    if (found || n === target) { found = true; return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n && typeof n === 'object') { visit(n.children); visit(n.props?.children); }
  };
  visit(root.children);
  visit(root.props?.children);
  return found;
}

// --- 4c. choosing an order actually reorders, and says so -------------------
// 「我选择了使用量最多，没有按我选择的筛选」: the comparator was right, but the
// wall is CSS multi-column, so a ranked list reads DOWN each column and looked
// unsorted; and a select looked the same whether or not it was filtering. This
// drives the real select and checks the document order, the rank chips, the
// active style and the meta line.
{
  const isSortSelect = (n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'installs');
  // `loadedNodes` is already the flat list (re-walking it would duplicate every
  // ancestor once per descendant path).
  const selects = loadedNodes.filter(isSortSelect);
  assert.equal(selects.length, 1, 'the sort select is present exactly once');
  const sortSelect = selects[0];
  assert.ok(!String(sortSelect.props.className).includes('omkt-select-on'),
    'the default order must not be marked as an active filter');
  assert.equal(findByKey(loadedNodes, 'rank').length, 0,
    'no rank chips before a ranking order is chosen');

  sortSelect.props.onChange({ target: { value: 'installs' } });
  const sorted = walk(await render());
  const sortedSelect = sorted.filter(isSortSelect)[0];
  assert.ok(String(sortedSelect.props.className).includes('omkt-select-on'),
    'an active order carries the marker class');
  assert.notEqual(sortedSelect.props.style.background, 'transparent', 'active order has a visible tint');

  const grid = findByKey(sorted, 'grid')[0];
  // Read the cards themselves (the article's title attribute), not the title
  // anchors: an entry with no repository renders its title as plain text.
  const titleOrder = walk(grid).filter((n) => n.type === 'article')
    .map((n) => String(n.props.title ?? '').split(' · ')[0])
    .filter((t) => ['snag', '3dtexel-mcp', 'example-mcp'].includes(t));
  // 使用量最多 = upstream figure + installs made from this panel: snag (0
  // upstream + 5000 local) then 3dtexel (1200). example-mcp publishes no figure
  // at all, so it belongs last and the card says why (see 4c-2).
  assert.deepEqual(titleOrder, ['snag', '3dtexel-mcp', 'example-mcp'],
    `使用量最多 must add our own installs in (got ${JSON.stringify(titleOrder)})`);
  const snagCard = walk(grid).filter((n) => n.type === 'article')
    .find((n) => String(n.props.title ?? '').startsWith('snag'));
  assert.ok(textOf(snagCard).includes('本机安装'),
    'the local install count is shown as its own series on the card');

  assert.deepEqual(findByKey(sorted, 'rank').map(textOf), ['#1', '#2', '#3'], 'explicit ranking follows document order');
  const meta = textOf(findByKey(sorted, 'meta')[0] ?? { props: {} });
  assert.ok(meta.includes('按使用量最多排序'), `the meta line names the order (got ${meta})`);
  console.log('sorting: 使用量最多 reorders the wall, ranks it, and marks the control ✓');

  // Back to the default so the later sections see the page as first painted.
  sortedSelect.props.onChange({ target: { value: 'default' } });
  await render();
}

// --- 4c-2. what a card says about its own numbers and its own age -----------
// Three facts that were missing or ambiguous: an entry no source ever counted
// (under 使用量 it sorts last, which looks arbitrary unless the card says why),
// the repository's last push as distinct from the listing's read time, and a
// category this panel read out of the entry's own words rather than the source
// publishing it.
{
  // The sorting block above scopes its own predicate, so this one carries its
  // own: the point here is the card's own words, not the comparator again.
  const pickSort = (nodes) => nodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'installs'));
  const again = walk(await render());
  const sortAgain = pickSort(again);
  assert.ok(sortAgain, 'the sort select is still there for the second ranking');
  sortAgain.props.onChange({ target: { value: 'installs' } });
  const sorted = walk(await render());
  const cardsSorted = walk(findByKey(sorted, 'mkt')[0]).filter((n) => n.type === 'article');
  const titleOf = (n) => String(n.props.title ?? '').split(' · ')[0];
  assert.equal(titleOf(cardsSorted[2]), 'example-mcp', 'an entry with no usage data sorts last');
  const noData = findByKey(sorted, 'nouse');
  assert.equal(noData.length, 1, 'the reason for that place is on the card itself');
  assert.equal(textOf(noData[0]), '无使用量数据');
  assert.ok(String(noData[0].props.title).includes('按使用量排序时它排在后面'),
    'and the hover says what this ordering did with it');

  const texel = cardsSorted.find((n) => titleOf(n) === '3dtexel-mcp');
  assert.ok(!textOf(texel).includes('上游更新于 2026-09-30'),
    `a card states the repository's own last push (got ${textOf(texel)})`);
  const chip = walk(texel).find((n) => n.type === 'span'
    && typeof n.props?.title === 'string' && /^分类/.test(n.props.title));
  assert.equal(textOf(chip), '搜索与知识', 'an inferred category is displayed without a suffix');
  assert.equal(chip.props.title, '分类：搜索与知识');

  sortAgain.props.onChange({ target: { value: 'default' } });
  await render();
  console.log('card facts: no-usage data, upstream push time and clean category labels ✓');
}

// --- 4d. the other two filters narrow the list too --------------------------
// The user's follow-up: "其他的筛选条件应该也有同样的问题". 分类 filters in place;
// 全部市场 re-asks the host with the chosen source.
{
  const groupSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === '开发工具'));
  assert.ok(groupSelect, 'the 分类 select exists');
  groupSelect.props.onChange({ target: { value: '开发工具' } });
  const filtered = walk(await render());
  const cards = walk(findByKey(filtered, 'mkt')[0]).filter((n) => n.type === 'article');
  assert.equal(cards.length, 1, `分类清单一开就该只剩该组（got ${cards.length} cards）`);
  assert.ok(textOf(findByKey(filtered, 'srcline')[0]).includes('筛选后 1 条'),
    'the provenance line states how many entries survived the filter');

  const srcSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'smithery'));
  assert.ok(srcSelect, 'the source select exists');
  const before = calls.length;
  srcSelect.props.onChange({ target: { value: 'smithery' } });
  await render();
  const asked = calls.slice(before).join(' ');
  assert.ok(asked.includes('source=smithery'),
    `choosing a source must re-query the host for it (asked: ${asked || 'nothing'})`);
  console.log('filters: 分类 narrows in place, 全部市场 re-queries the host ✓');

  groupSelect.props.onChange({ target: { value: '' } });
  srcSelect.props.onChange({ target: { value: '' } });
  await render();
}

// --- 4d-2. the census view: one upstream, named as the reader asked ---------
// `census` is not a seventh source. It is the GitHub read under a name that says
// "the local index, not a live search", so the line above 「共 N 条」 has to keep
// ONE number for it — labelled by the choice the reader made rather than by the
// upstream it borrowed, or the filter said 本地普查 and the line answered GitHub.
{
  const srcSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'census'));
  assert.ok(srcSelect, 'the source select offers the census view');
  const options = directChildren(srcSelect);
  const values = options.map((o) => o.props?.value);
  const at = values.indexOf('github-mcp');
  assert.deepEqual(values.slice(at, at + 2), ['github-mcp', 'census'],
    'the view sits beside the source it reads');
  assert.equal(textOf(options.find((o) => o.props?.value === 'census')), '本地普查（索引）');

  const before = calls.length;
  srcSelect.props.onChange({ target: { value: 'census' } });
  const viewed = walk(await render());
  const asked = calls.slice(before).join(' ');
  assert.ok(asked.includes('source=census'), `the view is its own request (asked: ${asked || 'nothing'})`);

  const srcline = textOf(findByKey(viewed, 'srcline')[0]);
  assert.ok(srcline.includes('本地普查（索引）'), `the number is named by the choice (got ${srcline})`);
  assert.ok(!/GitHub \d/.test(srcline), `and not by the upstream it borrowed (got ${srcline})`);
  console.log('the census view: one number for the rows, named as the reader asked ✓');

  srcSelect.props.onChange({ target: { value: '' } });
  await render();
}

// --- 4e. 仅看收藏 narrows in place and admits what it is hiding -------------
// The whole point of asking the host for a count is that the filter is a view
// over the loaded listing: a bookmark kept under another source (or hidden by
// the search box) must not look like an empty set, and an active control must
// not look like the inactive one — that was true of the two selects above.
{
  const market = walk(await render());
  const off = market.find(n=>n.type==='button' && n.props['aria-label']==='仅看收藏');
  assert.ok(off, 'the favourites filter is in the filter row');
  assert.equal(off.props['aria-pressed'], false,
    'it must not look active before it is chosen');

  off.props.onClick();
  const filtered = walk(await render());
  assert.ok(calls.includes('GET /favorites'), 'turning it on asks the host for the total');
  const on = filtered.find(n=>n.type==='button' && n.props['aria-label']==='仅看收藏');
  assert.equal(on.props['aria-pressed'], true, 'the active filter is marked');
  const cards = walk(findByKey(filtered, 'mkt')[0]).filter((n) => n.type === 'article');
  assert.deepEqual(cards.map((n) => String(n.props.title ?? '').split(' · ')[0]), ['snag'],
    `only the starred entry survives the filter (got ${cards.length} cards)`);
  const note = textOf(findByKey(filtered, 'favnote')[0] ?? { props: {} });
  assert.ok(note.includes('共 2 条收藏'),
    `the filter states how many favourites it is hiding (got ${note})`);

  on.props.onClick();
  const restored = walk(await render());
  assert.equal(findByKey(restored, 'favnote').length, 0, 'turning it off drops the note');
  assert.equal(walk(findByKey(restored, 'mkt')[0]).filter((n) => n.type === 'article').length, 3,
    'and the whole listing is back');
  console.log('favourites: 仅看收藏 filters the listing and admits the hidden ones ✓');
}

// The page is a fixed shell now: scrolling belongs to the card box alone, so
// the search pill, the 分类 dropdown, the filter row and the meta lines must
// all live OUTSIDE it — otherwise dragging the wall carries the controls away.
{
  const scroller = findByKey(loadedNodes, 'scroll');
  assert.equal(scroller.length, 1, 'the market tab has exactly one card scroller');
  const scrollerStyle = scroller[0].props.style;
  assert.equal(scrollerStyle.overflowY, 'auto', 'the card region is the scrolling box');
  assert.match(String(scrollerStyle.flex), /^1 1 /, 'and it is the box that gives height back');
  assert.equal(containsNode(scroller[0], searchRow[0]), false, 'search row is pinned above the scroller');
  assert.equal(containsNode(scroller[0], filters[0]), false, 'filter row is pinned above the scroller');
  assert.equal(containsNode(scroller[0], pager), false, 'pager is pinned outside the scroller');
  assert.equal(containsNode(scroller[0], grids[0]), true, 'the card grid is what scrolls');
  assert.equal(marketPage.props.style.overflow, 'hidden', 'the market body itself must not scroll');
  assert.match(String(marketPage.props.style.flex), /^1 1 /, 'the market body takes the leftover height');
  // The page is the shell: it never scrolls itself, which is what keeps the
  // head and the tab bar from sliding under the top edge.
  const pageNode = loadedNodes.find((n) => n.props?.className === 'omkt-page');
  assert.ok(pageNode, 'page shell present');
  assert.equal(pageNode.props.style.overflow, 'hidden', 'the page shell must not scroll');
  console.log('market scrolling: only the card box scrolls, the chrome is pinned ✓');
}

// --- 5. the registry tab still renders (no regression) ---------------------
const backToRegistry = buttonByText(tabButtons, '已注册 (1)');
assert.ok(backToRegistry, 'the registry tab is clickable');
backToRegistry.props.onClick();
const registryNodes = walk(await render());
assert.ok(registryNodes.some((n) => n.type === 'button' && textOf(n) === '重新扫描宿主机'),
  'registry tab keeps its scan button');
// Same shape as the skill tab: the filter row is chrome *outside* the list's
// scrolling box, so the scrollbar spans the list and starts below the header
// instead of running up beside it.
const regBody = findByKey(registryNodes, 'reg')[0];
assert.equal(String(regBody.props.style.overflow), 'hidden',
  'the registry body itself must not scroll — the list has its own box');
const regScroll = findByKey(registryNodes, 'regscroll')[0];
assert.ok(regScroll, 'the registry list has no scrolling box');
assert.equal(regScroll.props['data-omkt'], 'scroller',
  'the return-to-top button binds to this hook');
assert.equal(containsNode(regScroll, findByKey(registryNodes, 'filters')[0]), false,
  'the filter row is inside the scroller and would scroll away');
assert.doesNotMatch(textOf(regScroll), /台服务器/,
  'the stats line is inside the scroller');

// The GitHub access box is a fold: the header keeps the state (已认证 / 匿名 ·
// 剩余次数) and the token + census + recovery rows hide behind it. A walk in
// flight forces it open (progress and its stop button must stay reachable), so
// here the only invariant is that the control and the body agree — the folded
// default and the click are asserted where nothing is walking (GitHub access).
const regAuthBox = findByKey(registryNodes, 'authbox')[0];
const authToggle = walk(regAuthBox).find((n) => n.props?.['aria-expanded'] !== undefined);
assert.ok(authToggle, 'the GitHub access box has no fold control');
assert.match(textOf(regAuthBox), /GitHub 访问/, 'the fold control lost the box title');
assert.equal(String(findByKey(registryNodes, 'authbody')[0]?.props?.style?.display),
  authToggle.props['aria-expanded'] === 'true' ? 'block' : 'none',
  'the fold control and the body disagree');

// --- 6. the page head, ported from the v4 prototype ------------------------
// Identity (brand mark + title + version) and the sub-line exist on BOTH tabs,
// and the primary action follows the tab — two primary buttons is none.
{
  // We are on the registry tab here (section 5 clicked back to it).
  const registry = walk(await render());
  const regHead = findByKey(registry, 'head')[0];
  assert.ok(regHead, 'page head missing');
  const regText = textOf(regHead);
  assert.ok(regText.includes('全局 MCP'), `head names the page — got: ${regText}`);
  assert.match(regText, /全局 MCP\s*&\s*Skill/, 'the head lost the "& Skill" half of its name');
  assert.match(regText, /v\d+\.\d+\.\d+/, 'version chip missing from the head');
  assert.match(String(findByKey(registry, 'hd-events')[0]?.props?.title ?? ''), /插件 v\d+\.\d+\.\d+/,
    'nothing on the head says which build is running');
  assert.ok(!regText.includes('申请收录'), 'no contribution flow is advertised from the page head');
  assert.ok(walk(regHead).some((n) => n.type === 'svg'), 'brand mark is not drawn');
  // `findByKey` walks the flattened tree, so the keyed button itself is a hit.
  assert.equal(textOf(walk(regHead).find(n=>n.type==='button'&&textOf(n)==='重新扫描宿主机')), '重新扫描宿主机',
    'registry tab primary action is wrong');
  // The tabs already switch tabs: a button whose only job is what a tab does
  // is furniture, and this page is not allowed to grow it back.
  assert.equal(findByKey(registry, 'hd-secondary').length, 0,
    'the registry tab grew a second door to the market tab');
  assert.equal(textOf(findByKey(registry, 'hd-log')[0]), '⤓ 导出日志', 'export button missing');

  // No return-to-top before there is anything to scroll back from.
  assert.equal(findByKey(registry, 'top').length, 0, 'return-to-top shown on an unscrolled page');

  // The market tab has NO always-on primary button: refreshing the catalogue is
  // what 刷新 in the 分类 row already does, and a filled button that duplicates
  // a small one is noise. It appears only when 检查更新 reports that this plugin
  // itself has a newer release, and then it installs that release.
  const regTabs = walk(findByKey(registry, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('市场')).props.onClick();
  const market = walk(await render());
  assert.equal(findByKey(market, 'hd-primary').length, 0,
    'the market tab shows no primary button before an update is known');
  assert.equal(textOf(walk(findByKey(market,'head')[0]).find(n=>n.type==='button'&&textOf(n)==='重新扫描宿主机')), '重新扫描宿主机',
    'market tab loses the rescan door');
  const mcpCheck = buttonByText(market, '检查 MCP 更新');
  assert.ok(mcpCheck, 'MCP has its own visible check');
  await mcpCheck.props.onClick();
  const afterMcpCheck = walk(await render());
  assert.ok(calls.includes('POST /mcp/updates'));
  assert.ok(!calls.includes('GET /self'));
  assert.match(textOf(afterMcpCheck), /MCP 更新检查完成.*1 项失败/);
  assert.match(textOf(afterMcpCheck), /1 项未固定版本/);
  assert.match(textOf(afterMcpCheck), /floating-mcp：启动配置未固定版本/);
  assert.match(textOf(afterMcpCheck), /test-mcp：lookup failed/);
  assert.match(textOf(afterMcpCheck), /1 项跳过/);
  assert.match(textOf(afterMcpCheck), /remote-mcp：已跳过 · 启动配置未使用可比较版本的软件包运行器/);
  assert.equal(findByKey(afterMcpCheck, 'hd-self').length, 0);

  const check = buttonByText(afterMcpCheck, '检查插件更新');
  assert.ok(check, 'plugin has its own check');
  await check.props.onClick();
  const afterCheck = walk(await render());
  assert.ok(calls.includes('GET /self'), 'plugin check only asked the self endpoint');
  const updateBtn = findByKey(afterCheck, 'hd-self')[0];
  assert.ok(updateBtn, 'an available plugin update surfaces a button beside the version chip');
  assert.equal(textOf(updateBtn), '更新到 v0.2.0', 'and it names the version it installs');
  assert.match(String(updateBtn.props.title ?? ''), /0\.2\.0/, 'the target version is in the title');
  // One action, one place: the chip carries the self-update on both tabs, so
  // the market tab must not grow a second filled button for the same click.
  assert.equal(findByKey(afterCheck, 'hd-primary').length, 0,
    'the market tab does not duplicate the self-update as a primary button');
  // 「点个 star」 is the one invitation on the page: beside the version it
  // would be starring, a real link (the renderer's own navigation rules
  // apply), opening beside the panel rather than replacing it.
  for (const [tabName, tree] of [['registry', registry], ['market', market]]) {
    const star = findByKey(tree, 'hd-star')[0];
    assert.ok(star, `the ${tabName} tab loses 点个 star`);
    assert.equal(star.type, 'a', 'the star is a link, not a button with a handler');
    assert.equal(star.props.href, 'https://github.com/YunzhouLi-hub/dsh-overall-mcp',
      'the star points at this plugin repository');
    assert.equal(star.props.target, '_blank', 'the star opens beside the panel');
    assert.equal(star.props.rel, 'noreferrer', 'and does not leak the panel URL to GitHub');
    assert.equal(textOf(star), '点个 star', 'the label says what the click does');
  }
  console.log('page head renders: brand mark, title + version, sub-line, chip self-update, star ✓');
}

// --- 6c. which build is running, and what it has been doing ----------------
// A version string cannot answer either question. The identity line has to name
// the process and its uptime (a panel served by a process started before the
// fix on disk is the "still broken" / "not loaded yet" distinction), and the
// log has to fold out on demand, count what it is showing, and keep fields it
// has no template for.
{
  const market = walk(await render());
  assert.ok(calls.includes('GET /status'), 'the page asks the host who it is');
  // The identity line is gone from the page (one line of chrome), so the same
  // facts live in the log toggle's tooltip: still reachable, no longer printed.
  const sub = String(findByKey(market, 'hd-events')[0]?.props?.title ?? '');
  assert.match(sub, /插件 v0\.1\.0/, `the log toggle names the running build — got: ${sub}`);
  assert.match(sub, /pid 4242/, 'and the process');
  assert.match(sub, /已运行 3 小时 12 分/, `and how long it has been up — got: ${sub}`);
  assert.match(sub, /1 个数据文件/, `counting only the data files that exist — got: ${sub}`);
  assert.match(sub, /日志 2 条/, `and how many lines the log holds — got: ${sub}`);

  assert.equal(findByKey(market, 'log').length, 0, 'the log stays folded until asked for');
  const toggle = buttonByText(market, '运行诊断');
  assert.ok(toggle, 'the head offers a 运行日志 toggle');

  // First open, against a host that does not have the route: the box has to
  // say why in its own words, and the page must not grow a red error line for
  // what is only a version difference.
  eventsFails = true;
  const msgBefore = findByKey(market, 'message').length ? textOf(findByKey(market, 'message')[0]) : '';
  toggle.props.onClick();
  const old = walk(await render());
  const oldBody = textOf(findByKey(old, 'log')[0]);
  assert.match(oldBody, /宿主插件还是旧版本（没有 \/api\/overall-mcp\/events）/, `the log reports an old host — got: ${oldBody}`);
  const msgAfter = findByKey(old, 'message').length ? textOf(findByKey(old, 'message')[0]) : '';
  assert.equal(msgAfter, msgBefore, 'an old host is reported in the log box, not as a page-wide failure');

  // Second open against a host that has it: same button, real rows.
  buttonByText(old, '收起诊断').props.onClick();
  eventsFails = false;
  const folded = walk(await render());
  buttonByText(folded, '运行诊断').props.onClick();
  const opened = walk(await render());
  assert.ok(calls.includes('GET /events'), 'opening the log asks the host for it');
  const head = textOf(findByKey(opened, 'log-hd')[0]);
  assert.match(head, /运行日志 · 显示 2 条（共 5 条）/, `the log head counts what it shows — got: ${head}`);
  assert.match(head, /1 行损坏/, `and admits the lines it could not read — got: ${head}`);
  const logText = textOf(findByKey(opened, 'log-body')[0]);
  assert.match(logText, /browse · docker-catalog · “mcp” · 12 条 · 340 ms · 缓存/,
    `a browse row reads as one line — got: ${logText}`);
  assert.match(logText, /total=12/, `a field the panel has no column for still shows — got: ${logText}`);
  assert.match(logText, /server=codegraph/, 'an install row keeps the server it installed');
  assert.match(logText, /mounted=true/, 'and whether the mount actually worked');

  const refresh = buttonByText(opened, '刷新');
  assert.ok(refresh, 'the open log offers a refresh');
  refresh.props.onClick();
  const again = walk(await render());
  assert.equal(findByKey(again, 'log').length, 1, 'the log stays open across renders');
  assert.equal(buttonByText(again, '收起诊断') != null, true, 'and the toggle now offers to fold it away');

  EVENTS.persistence = { ok: false, error: '操作日志写入失败：测试磁盘故障', pending: 1 };
  buttonByText(again, '刷新').props.onClick();
  const warning = walk(await render());
  assert.match(textOf(findByKey(warning, 'log-note')[0]), /测试磁盘故障/);
  assert.match(textOf(findByKey(warning, 'log-body')[0]), /server=codegraph/, 'storage warning must not hide saved history');
  buttonByText(warning, '重试保存日志').props.onClick();
  const recovered = walk(await render());
  assert.equal(findByKey(recovered, 'log-note').length, 0);
  delete EVENTS.persistence;

  // The branch a single render cannot reach: the host has no /status route yet
  // (or answers half of it), so the tagline has to stay rather than the line
  // emptying itself and taking the page's only identity with it.
  assert.equal(typeof mod.__test?.subLineText, 'function', 'client exports __test.subLineText');
  const TAGLINE = '宿主机扫描 · 市场发现 · 一键接入';
  assert.equal(mod.__test.subLineText(null), TAGLINE, 'a host without /status keeps the tagline');
  assert.equal(mod.__test.subLineText({}), TAGLINE, 'a host that answers nothing keeps the tagline');
  assert.equal(mod.__test.subLineText({ plugin: { version: '0.1.0' } }), TAGLINE,
    'half an answer (no host block) keeps the tagline');
  console.log('identity line + action log: names the build, folds out what it did ✓');
}

// --- 6d. the GitHub credential, and the census it unblocks -----------------
// Anonymous GitHub is 60 requests an hour for the whole machine, and a census
// that stops there is indistinguishable from a finished one unless the page says
// otherwise. The box has to show where the credential came from, take one, and
// offer the single action a credential changes: carrying the walk on from where
// it stopped.
{
  // A half-read index is the state this box exists to admit: the walk is paced,
  // anonymous GitHub is 60 requests an hour, and a reader coming back to it has
  // to be able to tell a stopped pass from a finished one. The fixture starts
  // finished, so this section puts the unfinished walk on disk itself.
  liveCensus = {
    ...liveCensus,
    rows: 900,
    complete: false,
    partial: '停在 900 行：第 42 次请求失败：fetch failed',
    ended: { reason: 'user', at: '2026-01-01T09:35:00.000Z' },
  };
  const market = walk(await render());
  const regTabs = walk(findByKey(market, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('已注册')).props.onClick();
  const registry = walk(await render());
  const box = findByKey(registry, 'authbox')[0];
  assert.ok(box, 'the registry tab carries the GitHub access box');
  const boxText = textOf(box);
  assert.ok(boxText.includes('GitHub 访问'), `the box names itself — got: ${boxText}`);
  assert.ok(boxText.includes('匿名访问 · 60 次/小时'), `and says where the credential stands — got: ${boxText}`);
  assert.ok(boxText.includes('不填也能跑'), 'the hint says anonymity is a supported state, not a broken one');
  assert.ok(boxText.includes('没读完'),
    `a partial census is admitted in the box — got: ${boxText}`);
  assert.equal(findByKey(registry, 'autherr').length, 0, 'no error line before anything went wrong');
  // Nothing is walking here, so the fold is closed: the token field, the census
  // verb and the recovery verb all sit behind the header, and the header alone
  // still says where the credential stands (read above).
  // A walk in flight forces this box open, so stop anything running first: the
  // folded default is what is under test, not the walk state.
  for (const label of ['停止普查', '停止恢复']) {
    const stop = buttonByText(walk(await render()), label);
    if (stop) { stop.props.onClick(); await settle(); }
  }
  const closedBox = walk(findByKey(walk(await render()), 'authbox')[0]);
  const closedToggle = walk(closedBox).find((n) => n.props?.['aria-expanded'] !== undefined);
  assert.ok(closedToggle, 'the box has no fold control');
  assert.equal(closedToggle.props['aria-expanded'], 'false',
    'a box with nothing walking must start folded');
  assert.equal(String(findByKey(walk(await render()), 'authbody')[0].props.style.display), 'none',
    'the folded body is still laid out');
  closedToggle.props.onClick();
  const unfoldedBox = walk(await render());
  const openToggle = walk(findByKey(unfoldedBox, 'authbox')[0])
    .find((n) => n.props?.['aria-expanded'] !== undefined);
  assert.equal(openToggle.props['aria-expanded'], 'true', 'clicking the header does not open the box');
  assert.equal(String(findByKey(unfoldedBox, 'authbody')[0].props.style.display), 'block',
    'the opened body is still hidden');
  openToggle.props.onClick();
  await settle();

  // The one secret the panel accepts: rendered as a password, and held as a
  // draft the host never sees until 保存.
  const field = walk(box).find((n) => n.type === 'input');
  assert.ok(field, 'the box has a token field');
  assert.equal(field.props.type, 'password', 'the token is not rendered in clear text');
  assert.equal(field.props.value, '', 'and the box starts empty: the host has no token to hand back');
  field.props.onChange({ target: { value: TOKEN } });
  const typed = walk(await render());
  const saveBtn = buttonByText(walk(findByKey(typed, 'authbox')[0]), '保存');
  assert.ok(saveBtn, 'a 保存 button appears beside the field');
  assert.equal(saveBtn.props.disabled, false, 'a typed token can be submitted');
  const beforeAuth = calls.length;
  saveBtn.props.onClick();
  await settle();
  const authCalls = calls.slice(beforeAuth).join(' ');
  assert.ok(authCalls.includes(`POST /auth token=${TOKEN}`), `saving posts the token (got: ${authCalls})`);
  assert.ok(authCalls.includes('GET /status'), 'and re-reads the status it just changed');
  const saved = walk(await render());
  const savedText = textOf(findByKey(saved, 'authbox')[0]);
  assert.ok(savedText.includes('已认证：harness-user'), `the line names the account — got: ${savedText}`);
  assert.ok(savedText.includes(AUTHENTICATED.masked), 'and shows only the mask');
  assert.match(savedText, /剩余 [\d.]+k?\/[\d.]+k?/, 'plus what the credential bought');
  assert.equal(walk(findByKey(saved, 'authbox')[0]).find((n) => n.type === 'input').props.value, '',
    'the draft is cleared, accepted or not');
  assert.ok(!savedText.includes(TOKEN), 'the token itself never lands in the page');
  assert.ok(textOf(findByKey(saved, 'note')[0]).includes('已启用'), 'the outcome is reported beside the box');
  // 移除 appears only once there is something to remove, and its title says which
  // credential it is about to drop.
  const remove = buttonByText(walk(findByKey(saved, 'authbox')[0]), '移除');
  assert.ok(remove, 'an authenticated box offers 移除');
  assert.match(String(remove.props.title ?? ''), /github-auth\.json/, 'and says what it deletes');

  const beforeClear = calls.length;
  remove.props.onClick();
  await settle();
  const cleared = walk(await render());
  assert.ok(calls.slice(beforeClear).join(' ').includes('DELETE /auth'), 'removing asks the host to drop it');
  assert.ok(textOf(findByKey(cleared, 'authbox')[0]).includes('匿名访问 · 60 次/小时'),
    'and the box goes back to anonymous');

  // Carrying the census on is no longer a separate button with its own idea of
  // what "resume" meant: it is the census line's own verb, and section 6e is
  // where it is pressed. What this section still owes the reader is that the box
  // keeps saying the walk is unfinished — the reason the verb is worth pressing.
  assert.ok(textOf(findByKey(cleared, 'authbox')[0]).includes('上次是手动停止的'),
    'and the box still says the last census ended early');

  // A detection that finds nothing must not leave the same verb in place: the
  // slot switches to the path that cannot fail for lack of a local `gh`, and
  // that path is a real link to the token page (not a button that pretends).
  const detect = buttonByText(walk(findByKey(cleared, 'authbox')[0]), '检测本机登录');
  assert.ok(detect, 'with no credential the box offers 检测本机登录');
  const beforeDetect = calls.length;
  detect.props.onClick();
  await settle();
  assert.ok(calls.slice(beforeDetect).join(' ').includes('GET /auth'),
    'the detection asks the host, rather than guessing');
  const webBox = walk(findByKey(walk(await render()), 'authbox')[0]);
  assert.equal(buttonByText(webBox, '检测本机登录'), undefined,
    'the verb that just found nothing is not left dangling');
  const webLink = webBox.find((n) => n.type === 'a'
    && String(n.props?.href ?? '').includes('github.com/settings/tokens/new'));
  assert.ok(webLink, 'an empty detection turns the slot into the web login path');
  assert.ok(String(webLink.props.href).includes('scopes=read:user'),
    'the token page asks for the one scope the plugin uses');
  assert.ok(textOf(webBox).includes('本机没有可用的 gh 登录'), 'and the box says why the web path is there');
  assert.ok(buttonByText(webBox, '再检测一次'), 'a later `gh auth login` is still one click away');
  console.log('GitHub access: anonymous cost, a pasted token, and the unfinished census it admits ✓');
}

// --- 6e. the census itself: a state line, and the two verbs a reader owns --
// Before this, a walk only started because someone happened to browse the GitHub
// source, and once running it could only be ended by unloading the plugin — a
// walk paces itself at 6.5s per request for up to 48 of them. The row has to
// answer "is one running?", and the button beside it has to be the verb that
// matches the answer.
{
  // 6d left the index half-read on purpose, because that is what its box is
  // about. A finished walk is what *this* section describes, so the census goes
  // back to the way a completed pass leaves it.
  liveCensus = { ...liveCensus, rows: 1758, complete: true, partial: null, ended: null };
  const market = walk(await render());
  const regTabs = walk(findByKey(market, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('已注册')).props.onClick();
  const registry = walk(await render());
  const box = findByKey(registry, 'authbox')[0];
  const row = findByKey(registry, 'censusline')[0];
  assert.ok(row, 'the GitHub box carries a census row');
  const rowText = textOf(row);
  assert.match(rowText, /普查索引\s*[\d.]+k?\s*行/, `the row counts the index — got: ${rowText}`);
  assert.ok(rowText.includes('读完于'), `and dates it as read rather than as running — got: ${rowText}`);
  // A finished census offers a start, not a stop: the verb has to match the
  // state, or a reader presses a button that cannot do what it says.
  const start = buttonByText(walk(row), '开始普查');
  assert.ok(start, 'a finished census offers 开始普查');
  assert.equal(buttonByText(walk(row), '停止普查'), undefined, 'and not 停止普查');
  assert.equal(start.props.disabled, false, 'the button is live');

  const beforeStart = calls.length;
  start.props.onClick();
  await settle();
  const startCalls = calls.slice(beforeStart).join(' ');
  assert.ok(startCalls.includes('POST /census action=start'), `starting posts the verb (got: ${startCalls})`);
  assert.ok(startCalls.includes('GET /status'), 'and re-reads the state it just changed');
  const walking = walk(await render());
  const walkingRow = findByKey(walking, 'censusline')[0];
  const walkingText = textOf(walkingRow);
  assert.match(walkingText, /正在普查：已收/, `the row says a walk is running — got: ${walkingText}`);
  assert.ok(!walkingText.includes('读完于'), 'a running walk is not also described as read');
  assert.ok(textOf(findByKey(walking, 'note')[0]).includes('普查已开始'),
    'and the outcome is reported in the box');
  const stop = buttonByText(walk(walkingRow), '停止普查');
  assert.ok(stop, 'a running census offers 停止普查 instead');
  assert.equal(stop.props.disabled, false, 'stopping is available while it runs');

  const beforeStop = calls.length;
  stop.props.onClick();
  await settle();
  assert.ok(calls.slice(beforeStop).join(' ').includes('POST /census action=stop'), 'stopping posts its verb');
  const stopped = walk(await render());
  const stoppedText = textOf(findByKey(stopped, 'censusline')[0]);
  assert.ok(stoppedText.includes('上次是手动停止的'),
    `the host's reason is shown, not the walk's own flat "已中止" — got: ${stoppedText}`);
  assert.ok(buttonByText(walk(findByKey(stopped, 'censusline')[0]), '开始普查'),
    'and the button goes back to the verb that matches the state');
  console.log('the census: one state line, and the verb that matches it ✓');
}

// --- 6f. the recovery walk: its own line, its own verbs ---------------------
// The second background walk, and the one that reads two thousand repositories
// at 150ms each. It used to be started by opening the market and stopped by
// unloading the plugin; now it has the same pair of verbs the census has, on its
// own line, and the line has to say which of the two it is (including when the
// last pass stopped early, which is why a reader would press start again).
{
  const market = walk(await render());
  const regTabs = walk(findByKey(market, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('已注册')).props.onClick();
  // Rendering the market is what fires the panel's own fire-and-forget ask, so
  // the fixture is walking by now. The reader this section is about has just
  // stopped a pass: put the walk back the way a stop leaves it, which is the
  // state whose verb the row has to offer.
  liveEvidence = {
    ...liveEvidence,
    walking: false,
    progress: null,
    partial: '已手动停止（已试 77 个仓库，下次接着走）',
    ended: { reason: 'user', at: '2026-01-01T09:40:00.000Z' },
    plan: { ...liveEvidence.plan, attempted: 77, remaining: 2034, requests: 260, stopped: 'user' },
  };
  const registry = walk(await render());
  assert.ok(findByKey(registry, 'authbox')[0], 'the GitHub box is where these verbs live');
  const row = findByKey(registry, 'evidenceline')[0];
  assert.ok(row, 'the GitHub box carries a recovery row of its own');
  const rowText = textOf(row);
  assert.match(rowText, /查过 77 个仓库/, `the row counts what has been looked at — got: ${rowText}`);
  assert.ok(rowText.includes('恢复出 54 条安装命令'), `and how many commands came back — got: ${rowText}`);
  assert.ok(rowText.includes('上次是手动停止的'),
    `the host's reason is shown rather than the walk's flat "已中止" — got: ${rowText}`);
  assert.ok(rowText.includes('没读完'),
    `and the unfinished pass is stated, because it is the reason the button is worth pressing — got: ${rowText}`);
  // The census above already ended, so the *only* thing 开始普查 in this box means
  // is the census; the recovery line must name its own verb or the two collide.
  // The label is 接着恢复 while the walk still has rows left to try — the walk
  // itself skips what it has, so "接着" is the honest word for it.
  const start = buttonByText(walk(row), '接着恢复');
  assert.ok(start, 'a stopped walk with rows left offers 接着恢复');
  assert.ok(buttonByText(walk(registry), '开始普查'), 'and the census keeps its own verb');
  assert.equal(buttonByText(walk(row), '停止恢复'), undefined, 'a stopped walk does not offer a stop');

  const beforeStart = calls.length;
  start.props.onClick();
  await settle();
  const startCalls = calls.slice(beforeStart).join(' ');
  assert.ok(startCalls.includes('POST /install-evidence action=start'), `starting posts the verb (got: ${startCalls})`);
  assert.ok(startCalls.includes('GET /status'), 'and re-reads the state it just changed');
  const walking = walk(await render());
  const walkingRow = findByKey(walking, 'evidenceline')[0];
  const walkingText = textOf(walkingRow);
  assert.match(walkingText, /正在恢复安装命令：已试 78 \/ 2\.1k 个仓库/,
    `a running walk reports progress against its own plan — got: ${walkingText}`);
  assert.ok(!walkingText.includes('没读完'), 'a running walk does not also read as unfinished');
  assert.ok(textOf(findByKey(walking, 'note')[0]).includes('开始恢复安装命令'),
    'and the outcome is reported in the box');
  const stop = buttonByText(walk(walkingRow), '停止恢复');
  assert.ok(stop, 'a running walk offers 停止恢复 instead');
  assert.equal(stop.props.disabled, false, 'stopping is available while it runs');

  const beforeStop = calls.length;
  stop.props.onClick();
  await settle();
  assert.ok(calls.slice(beforeStop).join(' ').includes('POST /install-evidence action=stop'), 'stopping posts its verb');
  const stopped = walk(await render());
  const stoppedRow = findByKey(stopped, 'evidenceline')[0];
  const stoppedText = textOf(stoppedRow);
  assert.ok(stoppedText.includes('上次是手动停止的'), `the stop is recorded with its reason — got: ${stoppedText}`);
  assert.ok(stoppedText.includes('已试 78 个仓库'),
    `and the walk's own count of what it tried survives into the line — got: ${stoppedText}`);
  assert.ok(buttonByText(walk(stoppedRow), '接着恢复'), 'and the button goes back to the verb that matches the state');
  console.log('the recovery walk: one line, its own verbs, and a stop that says where it got ✓');
}

// --- 6b. clicking that button installs the plugin and says a restart is due --
{
  const market = walk(await render());
  const updateBtn = findByKey(market, 'hd-self')[0];
  assert.ok(updateBtn, 'the update button is still there to click');
  let finishInstall;
  selfInstallGate = new Promise(resolve => { finishInstall = resolve; });
  const pendingInstall = updateBtn.props.onClick();
  await settle();
  const duringInstall = walk(await render());
  const pluginChecksSoFar = calls.filter(call => call === 'GET /self').length;
  const duringCheck = buttonByText(duringInstall, '检查插件更新');
  assert.equal(duringCheck.props.disabled, true);
  await duringCheck.props.onClick();
  assert.equal(calls.filter(call => call === 'GET /self').length, pluginChecksSoFar);
  finishInstall();
  await pendingInstall;
  selfInstallGate = null;
  const afterUpdate = walk(await render());
  assert.ok(calls.includes('POST /self-update'), 'the button ran the self-update route');
  assert.equal(findByKey(afterUpdate, 'hd-self').length, 0, 'the button clears once installed');
  const message = findByKey(afterUpdate, 'message')[0];
  assert.ok(message, 'an outcome message is shown');
  assert.match(textOf(message), /重启 DSH/, 'and it says the change lands after a restart');
  const needsRestart = buttonByText(afterUpdate, '检查插件更新');
  assert.equal(needsRestart.props.disabled, true);
  await needsRestart.props.onClick();
  assert.equal(calls.filter(call => call === 'GET /self').length, pluginChecksSoFar);
  console.log('plugin update: button runs /self-update, reports the restart ✓');
}

// --- 7. the rail row: page owns its head, glyph stays decorative -----------
// This page is the centre column itself, so its identity row and sub-line must
// be there (the frame draws no page title). The rail, on the other hand, labels
// the button and wraps the glyph in an `aria-hidden` span — so the glyph must
// not carry a second accessible name. Neither fact is visible to a smoke test
// of the registration shape, and both regress silently.
{
  const standalone = walk(await render());
  const compactHead = findByKey(standalone, 'head')[0];
  assert.ok(compactHead, 'page owns its compact identity header');
  assert.match(textOf(compactHead), /全局 MCP & Skill/);
  assert.ok(findByKey(standalone, 'hd-events')[0], 'diagnostics stays directly accessible');
  const menu = walk(compactHead).find(n => n.type === 'details');
  assert.ok(menu, 'secondary plugin actions live in a native disclosure');
  for (const label of ['重新扫描宿主机', '检查插件更新', '⤓ 导出日志']) {
    assert.ok(walk(menu).some(n => n.type === 'button' && textOf(n) === label), label + ' remains available');
  }
  assert.doesNotMatch(textOf(compactHead), /pid 4242/, 'process metadata is disclosed through diagnostics');
  assert.equal(typeof mod.__test?.PanelGlyph, 'function', 'client exports __test.PanelGlyph');
  const glyph = mod.__test.PanelGlyph({ size: 16 });
  assert.equal(glyph.type, 'svg', 'rail glyph is not an svg');
  assert.equal(glyph.props.width, 16, 'rail glyph ignores the size the sidebar asks for');
  assert.equal(glyph.props.height, 16, 'rail glyph is not square');
  assert.equal(glyph.props.role, 'presentation', 'rail glyph announces itself as an image');
  assert.equal(glyph.props['aria-label'], null, 'rail glyph carries a second accessible name');
  assert.equal(glyph.props['aria-hidden'], 'true', 'rail glyph is not hidden from assistive tech');
  assert.equal(walk(glyph).filter((n) => n.type === 'circle').length, 6,
    'rail glyph lost the constellation (hub + five satellites)');

  // Collapsed rail: the sidebar asks for 18 instead of 16.
  const collapsed = mod.__test.PanelGlyph({ size: 18 });
  assert.equal(collapsed.props.width, 18, 'collapsed rail glyph ignores its size');
  // No size at all (a host that renders the entry outside the rail) still has
  // to produce a drawable icon rather than width=undefined.
  assert.equal(mod.__test.PanelGlyph({}).props.width, 18, 'rail glyph has no fallback size');

  // The page's head mark keeps its accessible name: it is the only heading
  // this page has.
  const headMark = walk(compactHead).find((n) => n.type === 'svg');
  assert.equal(headMark.props.role, 'img', 'the page head mark lost its accessible name');
  assert.equal(headMark.props['aria-label'], 'Overall MCP', 'the page head mark is unlabelled');
  console.log('rail row renders: page head kept, decorative glyph at both rail sizes ✓');
}

// MCP searches can finish out of order. Only the newest submitted filters
// may render; refresh must not submit text that the user has only drafted.
{
  walk(await render()).find(n => n.props?.className?.includes('omkt-spacep') && textOf(n).startsWith('MCP')).props.onClick();
  walk(await render()).find(n => n.props?.role === 'tab' && textOf(n) === '市场').props.onClick();
  await settle();
  const controls = async () => walk(await render());
  const submit = async value => {
    (await controls()).find(n => n.type === 'input' && n.props?.['aria-label'] === '搜索市场').props.onChange({ target: { value } });
    (await controls()).find(n => n.type === 'form' && n.props?.className === 'omkt-market-search').props.onSubmit({ preventDefault() {} });
    await settle();
  };
  const pending = new Map();
  catalogGate = request => new Promise(resolve => pending.set(request.query, resolve));
  await submit('audit-older');
  await submit('audit-newer');
  const reply = title => ({ ok: true, status: 200, json: async () => ({ ...MARKET, items: [{ ...MARKET.items[1], id: title, title }] }) });
  pending.get('audit-newer')(reply('audit-newer-result')); await settle();
  pending.get('audit-older')(reply('audit-older-result')); await settle();
  assert.match(textOf(await render()), /audit-newer-result/);
  assert.doesNotMatch(textOf(await render()), /audit-older-result/);
  // Supply enough results to verify refresh stays on the second page.
  const many = Array.from({ length: 45 }, (_, i) => ({ ...MARKET.items[1], id: `audit:${i}`, title: `audit-row-${i}` }));
  catalogGate = async () => ({ ok: true, status: 200, json: async () => ({ ...MARKET, items: many }) });
  await submit('audit-paged');
  (await controls()).find(n => n.props?.['aria-label'] === '第 2 页').props.onClick(); await settle();
  (await controls()).find(n => n.type === 'input' && n.props?.['aria-label'] === '搜索市场').props.onChange({ target: { value: 'not-submitted' } });
  (await controls()).find(n => n.props?.['aria-label'] === '刷新市场').props.onClick(); await settle();
  assert.equal(catalogBodies.at(-1).query, 'audit-paged');
  assert.equal((await controls()).find(n => n.props?.['aria-label'] === '第 2 页').props['aria-current'], 'page');
  assert.equal((await controls()).find(n => n.type === 'input' && n.props?.['aria-label'] === '搜索市场').props.value, 'audit-paged');
  // Restore fixtures for the remaining six-view interaction contracts.
  catalogGate = null;
  await submit('');
  walk(await render()).find(n => n.props?.role === 'tab' && textOf(n).startsWith('已注册')).props.onClick(); await settle();
  console.log('MCP search: out-of-order results ignored; refresh retains applied query and page ✓');
}

// --- 8. the skill space: switch, groups, cards, drawer, reveal -------------
// The two spaces share one page, so everything below is about what the switch
// actually changes: the active labels, which bodies exist, and whether the other
// space's numbers survive the switch (they must not).
{
  const page = walk(await render());
  const spaces = findByKey(page, 'spaces')[0];
  assert.ok(spaces, 'the space switch is missing');
  const pills = directChildren(spaces).filter((n) => n.props?.className?.includes('omkt-spacep'));
  assert.equal(pills.length, 2, 'the switch must offer exactly two spaces');
  assert.equal(pills[0].props['aria-selected'], 'true', 'MCP is not selected on first paint');
  assert.equal(pills[1].props['aria-selected'], 'false', 'Skill starts selected');
  assert.deepEqual(pills.map(textOf), ['MCP', 'Skill'], 'resource buttons use short text labels');
  assert.ok(directChildren(findByKey(page, 'navigation')[0]).includes(spaces), 'resource switch belongs in the shared navigation row');

  // Switching reads the host once and then shows its groups.
  await pills[1].props.onClick();
  await settle();
  const skillPage = walk(await render());
  const skillCheck = buttonByText(skillPage, '检查 Skill 更新');
  assert.ok(skillCheck);
  assert.equal(buttonByText(skillPage, '检查 MCP 更新'), undefined);
  assert.ok(buttonByText(skillPage, '检查插件更新'));
  const recentCalls = calls.length;
  await skillCheck.props.onClick();
  const afterSkillCheck = walk(await render());
  assert.deepEqual(calls.slice(recentCalls).filter(call => /\/(?:updates|self)/.test(call)), ['POST /skills/updates']);
  assert.match(textOf(afterSkillCheck), /Skill 更新检查完成.*3 项跳过/);
  assert.doesNotMatch(textOf(afterSkillCheck), /MCP 更新检查完成/);
  assert.ok(calls.filter((c) => c === 'GET /skills').length >= 1, 'switching to Skill never asked the host');
  assert.equal(findByKey(skillPage, 'skillbody').length, 1, 'the skill body did not render');
  assert.equal(findByKey(skillPage, 'reg').length, 0, 'the registry body stayed on screen under Skill');
  assert.equal(findByKey(skillPage, 'tabs').length, 1, 'the tab bar disappeared');

  const tabLabels = directChildren(findByKey(skillPage, 'tabs')[0])
    .filter((n) => n.type === 'button').map((n) => textOf(n));
  // The tab counts what the market is currently holding: all five fixture rows,
  // because the catalogue total is not knowable while one source pages by cursor.
  assert.deepEqual(tabLabels, ['已注册 (3)', '市场', '调用记录 (3)'],
    'the skill tabs are wrong — 市场 must carry its count before the tab is opened');
  const marketTab = directChildren(findByKey(skillPage, 'tabs')[0])
    .filter((n) => n.type === 'button')[1];
  assert.equal(marketTab.props.disabled, undefined, 'the skill market tab must be clickable now');

  const skillText = textOf(findByKey(skillPage, 'skillbody')[0]);
  assert.ok(walk(skillPage).some(n => n.type === 'img' && n.props?.title === '审计图标读取错误'), 'backup artwork must retain the primary icon warning');
  // The filter row is chrome *outside* the list's scrolling box: that is what
  // keeps the scrollbar to the list instead of letting it run up beside the
  // header. The market tab does the same thing with its card region.
  const skillBody = findByKey(skillPage, 'skillbody')[0];
  assert.equal(String(skillBody.props.style.overflow), 'hidden',
    'the skill body itself must not scroll — the list has its own box');
  const skillScroll = findByKey(skillPage, 'scroll')[0];
  assert.ok(skillScroll, 'the skill list has no scrolling box');
  assert.equal(skillScroll.props['data-omkt'], 'scroller', 'the return-to-top button binds to this hook');
  assert.equal(containsNode(skillScroll, findByKey(skillPage, 'header')[0]), false,
    'the filter row is inside the scroller and would scroll away');
  assert.equal(containsNode(skillScroll, findByKey(skillPage, 'filters')[0]), false,
    'the search box is inside the scroller');
  assert.equal(containsNode(skillScroll, findByKey(skillPage, 'stats')[0]), false,
    'the count line is inside the scroller');
  assert.match(textOf(skillScroll), /ab-test-analysis/, 'the list is not what scrolls');
  assert.match(skillText, /3 个 Skill/, 'the skill count line is missing');
  assert.match(skillText, /已合并 2 个重复副本/, 'the duplicate count is missing');
  assert.match(skillText, /需重启 DSH/, 'the restart hint is missing');
  assert.match(skillText, /ab-test-analysis/, 'the first card is missing');
  assert.match(skillText, /gzh-design/, 'the second card is missing');
  assert.match(skillText, /release-notes-zh/, 'the plugin root card is missing');
  const directories = walk(findByKey(skillPage, 'skillbody')[0]).find(n => n.props?.key === 'directories');
  directories.props.onClick();
  const openedDirectories = textOf(findByKey(walk(await render()), 'skillbody')[0]);
  assert.match(openedDirectories, /目录尚未创建/, 'directory details explain a missing root');
  assert.match(openedDirectories, /4 个重复副本已折叠/, 'directory details retain folded duplicates');
  walk(findByKey(walk(await render()), 'skillbody')[0]).find(n => n.props?.key === 'directories').props.onClick();
  // All four roots are named, and the one whose skills were all folded into an
  // earlier root still explains itself instead of looking empty.
  for (const label of ['本插件', '本机', 'Claude', 'Codex']) {
    assert.match(skillText, new RegExp(label), `the ${label} root is not grouped`);
  }
  const sourceChips = walk(findByKey(skillPage, 'skillbody')[0]).filter(n => n.type === 'button' && n.props?.['aria-pressed'] !== undefined);
  assert.equal(sourceChips.length, 5, 'all sources remain directly filterable');
  const pluginSource = sourceChips.find(n => /^本插件/.test(textOf(n)));
  pluginSource.props.onClick();
  let sourceBody = findByKey(walk(await render()), 'skillbody')[0];
  assert.match(textOf(sourceBody), /release-notes-zh/);
  assert.equal(walk(sourceBody).filter(n => n.props?.className?.split(' ').includes('omkt-skillcard')).length, 1);
  walk(sourceBody).find(n => n.type === 'button' && /^全部 /.test(textOf(n))).props.onClick();
  await render();

  const rootOptions = walk(findByKey(skillPage, 'skillbody')[0])
    .filter((n) => n.type === 'select' && n.props['aria-label'] === '按来源筛选 skill')
    .flatMap((n) => directChildren(n))
    .map((n) => textOf(n));
  // The filter counts what each folder holds, so a mirrored folder cannot read
  // as "nearly empty".
  assert.deepEqual(rootOptions,
    ['全部来源', '本插件（1）', '本机（2）', 'Claude（6）', 'Codex（0）'],
    'the source filter does not count what each folder holds');

  // Origin, version and size are the three facts a card has to carry.
  const cards = walk(findByKey(skillPage, 'skillbody')[0])
    .filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard'));
  assert.equal(cards.length, 3, 'one card per scanned skill');
  // v5 stacks the card name -> what it does -> where it came from, so the
  // name and version share a row and the origin badge owns its own.
  const gzh = textOf(cards.find((c) => textOf(c).includes('gzh-design')));
  assert.match(gzh, /gzh-design/, 'the compact row names the skill');
  assert.match(gzh, /本机/, 'the compact row states its actual scan source');
  const registeredLink = walk(cards).find(n => n.type === 'a' && textOf(n) === 'gzh-design');
  assert.equal(registeredLink?.props.href, 'https://skillhub.cn/skills/demo/gzh-design');
  assert.ok(walk(cards).some(n => n.type === 'button' && textOf(n) === 'release-notes-zh'), 'unsafe URLs cannot replace local details');
  assert.match(textOf(cards.find((c) => textOf(c).includes('ab-test-analysis'))), /220\.0 KB|6\.2 KB/,
    'a card dropped its size');

  // The drawer opens from a card and closes on its own button.
  const abCard = cards.find((c) => textOf(c).includes('ab-test-analysis'));
  const openBtn = walk(abCard).find((n) => n.type === 'button' && textOf(n) === '查看');
  assert.ok(openBtn, 'a card has no 查看 button');
  await openBtn.props.onClick();
  await settle();
  const withDrawer = walk(await render());
  const drawer = withDrawer.find((n) => n.props?.role === 'dialog');
  assert.ok(drawer, '查看 did not open a drawer');
  const drawerText = textOf(drawer);
  assert.match(drawerText, /ab-test-analysis/, 'the drawer does not name the skill');
  assert.match(drawerText, /本机 · ECC/, 'the drawer does not say which root it came from');
  assert.match(drawerText, /1 个 · 6\.2 KB/, 'the drawer does not report size');

  // Reveal goes through the host, which is the only thing that knows the path.
  const revealBtn = walk(drawer).find((n) => n.type === 'button' && textOf(n) === '打开目录');
  assert.ok(revealBtn, 'the drawer has no 打开目录 button');
  await revealBtn.props.onClick();
  await settle();
  const afterReveal = walk(await render());
  assert.ok(calls.includes('POST /skills/reveal id=user:ab-test-analysis'),
    'reveal did not send the scanned id');
  assert.match(textOf(findByKey(afterReveal, 'skillbody')[0]), /已在文件管理器里打开/,
    'reveal did not report where it opened');

  // Removal is a move to the plugin's own trash folder, and it asks first:
  // the card says 移除, the dialog names the exact directory, and only the
  // dialog's own button sends the request.
  const abCardAfter = walk(findByKey(afterReveal, 'skillbody')[0])
    .filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard'))
    .find((c) => textOf(c).includes('ab-test-analysis'));
  const cardRemove = walk(abCardAfter).filter((n) => n.type === 'button' && textOf(n) === '移除');
  assert.equal(cardRemove.length, 1, 'a skill card has no 移除 button');
  const removesBefore = calls.filter((c) => c.startsWith('POST /skills/remove')).length;
  await cardRemove[0].props.onClick();
  await settle();
  const askPage = walk(await render());
  const ask = askPage.find((n) => n.props?.role === 'dialog' && /移除 skill/.test(n.props?.['aria-label'] ?? ''));
  assert.ok(ask, '移除 did not open a confirmation');
  const askText = textOf(ask);
  assert.match(askText, /只移动，不删除/, 'the dialog does not say it only moves');
  assert.match(askText, /skills-trash/, 'the dialog does not name the trash folder');
  assert.match(askText, /重启 DSH/, 'the dialog does not say when the skill disappears');
  assert.equal(calls.filter((c) => c.startsWith('POST /skills/remove')).length, removesBefore,
    'opening the confirmation already sent the request');

  const cancel = walk(ask).find((n) => n.type === 'button' && textOf(n) === '取消');
  await cancel.props.onClick();
  await settle();
  assert.equal(walk(await render()).filter((n) => /移除 skill/.test(n.props?.['aria-label'] ?? '')).length, 0,
    '取消 did not close the confirmation');
  assert.equal(walk(await render()).filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard')).length, 3,
    'cancelling still removed a card');

  const againCard = walk(findByKey(walk(await render()), 'skillbody')[0])
    .filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard'))
    .find((c) => textOf(c).includes('ab-test-analysis'));
  const again = walk(againCard).filter((n) => n.type === 'button' && textOf(n) === '移除');
  await again[0].props.onClick();
  await settle();
  const confirmBtn = walk(walk(await render()).find((n) => /移除 skill/.test(n.props?.['aria-label'] ?? '')))
    .find((n) => n.type === 'button' && textOf(n) === '移到回收目录');
  assert.ok(confirmBtn, 'the confirmation has no 移到回收目录 button');
  await confirmBtn.props.onClick();
  await settle();
  const donePage = walk(await render());
  assert.ok(calls.includes('POST /skills/remove id=user:ab-test-analysis'),
    'the confirmed removal did not reach the host');
  assert.match(textOf(findByKey(donePage, 'skillbody')[0]), /已移到回收目录/,
    'the page did not say where the folder went');
  assert.equal(donePage.filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard')).length, 2,
    'the removed skill is still on the page');
  // The refresh must come after the move, not before it: a stale list would
  // still show the skill with a fresh note next to it.
  assert.ok(calls.lastIndexOf('GET /skills') > calls.lastIndexOf('POST /skills/remove'),
    'the page did not re-read the host after the move');

  // The market tab is a real listing now: four upstreams reported separately, so
  // one of them being down is visible instead of silencing the whole wall.
  const marketTabNow = directChildren(findByKey(walk(await render()), 'tabs')[0])
    .filter((n) => n.type === 'button')[1];
  await marketTabNow.props.onClick();
  await settle();
  const marketPage = walk(await render());
  assert.equal(findByKey(marketPage, 'skillmarketbody').length, 1, 'the market body did not render');
  assert.equal(findByKey(marketPage, 'skillbody').length, 0, 'the installed list stayed on screen under the market');
  assert.ok(calls.some(c => /^(GET|POST) \/skills\/market(?: |$)/.test(c)), 'opening the market never asked the host');

  const marketBody = findByKey(marketPage, 'skillmarketbody')[0];
  for (const [cardClass, expectedHost] of [['omkt-skillhero', 'clawhub.ai'], ['omkt-skillcard', null]]) {
    const card = walk(marketBody).find(n => n.props?.className === cardClass && walk(n).some(x => x.type === 'a'));
    const link = walk(card).find(n => n.type === 'a');
    assert.ok(link?.props.href, `${cardClass} must expose the upstream link on its name`);
    if (expectedHost) assert.equal(new URL(link.props.href).hostname, expectedHost);
    const opened = openedSourcePages.length;
    link.props.onClick({ button: 0, ctrlKey: true, preventDefault: () => assert.fail('modified click was intercepted') });
    assert.equal(openedSourcePages.length, opened, 'modified click uses the normal anchor');
    let intercepted = false;
    link.props.onClick({ button: 0, preventDefault: () => { intercepted = true; } });
    assert.deepEqual(openedSourcePages.at(-1), ['browser', link.props.href]);
    assert.equal(intercepted, true);
  }
  const marketText = textOf(marketBody);
  // One upstream (ClawHub) reports no total, so the line says what it is: the
  // first screen of each source, not the size of the catalogue.
  assert.match(marketText, /45 个已列出（各源首屏）/, 'the market count line is missing');
  assert.match(marketText, /带 \+ 的来源按页给，没有总数/, 'the count line does not admit the paged source');
  assert.match(marketText, /ClawHub 20\+/, 'the paged source is not marked with "+"');
  assert.match(marketText, /Anthropic 官方技能 19/, 'a source that reports a total is not shown as a total');
  for (const label of ['ClawHub', 'Anthropic 官方技能', 'SkillHub', 'GitHub']) {
    assert.match(marketText, new RegExp(label), `the market does not report the ${label} source`);
  }
  assert.match(marketText, /暂不可用/, 'a source that failed is not marked as failed');
  // The local index is a separate fact from the sources: with no index on
  // disk the line has to say so, because "no index" and "an index with 0 rows"
  // would otherwise look the same (and a walk can only be started from here).
  assert.match(marketText, /还没有本地索引/, 'the market does not say whether a local index exists');
  const brokenChip = walk(marketBody).find((n) => String(n.props?.title ?? '').includes('GitHub 的访问次数已用完'));
  assert.ok(brokenChip, 'the failed source does not carry its reason');
  assert.match(textOf(brokenChip), /暂不可用/, 'the failed chip does not say it failed');

  const marketCards = walk(marketBody).filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard'));
  assert.equal(marketCards.length + walk(marketBody).filter(n => n.props?.className === 'omkt-skillhero').length, 20, 'the first page did not hold a full page of rows');

  // Twenty items per host page; featured cards count toward that limit.
  assert.match(marketText, /每页 20 条/, 'the pager has no page-size control');
  assert.equal(textOf(walk(marketBody).find(n=>n.props?.['aria-current']==='page')), '1', 'current first page is marked');
  assert.equal(walk(marketBody).filter(n=>/^第 \d+ 页$/.test(n.props?.['aria-label'] ?? '')).length,3,'three numbered pages are reachable');
  const postsBeforePaging = calls.filter((c) => c.startsWith('POST /skills/market')).length;
  const nextBtn = walk(marketBody).find((n) => n.type === 'button' && textOf(n) === '下一页 ›');
  assert.ok(nextBtn, 'the market has no next-page button');
  nextBtn.props.onClick();
  await settle();
  const secondPage = findByKey(walk(await render()), 'skillmarketbody')[0];
  assert.doesNotMatch(marketText, /编程大神\.Skill/, 'SkillHub must not appear in ranks 1–20');
  assert.match(textOf(secondPage), /编程大神\.Skill/, 'a popular SkillHub item can appear from rank 21');
  assert.equal(
    walk(secondPage).filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard')).length,
    20,
    'the second page does not hold a full page either',
  );
  assert.equal(textOf(walk(secondPage).find(n=>n.props?.['aria-current']==='page')), '2', 'pager moved to page two');
  assert.equal(
    calls.filter((c) => c.startsWith('POST /skills/market')).length,
    postsBeforePaging + 1,
    'turning a page must request the next host slice',
  );
  const prevBtn = walk(secondPage).find((n) => n.type === 'button' && textOf(n) === '‹ 上一页');
  assert.ok(prevBtn, 'the market has no previous-page button');
  prevBtn.props.onClick();
  await settle();
  // The two wide cards carry the official pick and the most-downloaded rest.
  assert.match(marketText, /热门排序（默认）/, 'the toolbar must identify default popularity');
  assert.match(marketText, /精选技能[\s\S]*self-improving agent[\s\S]*推荐技能[\s\S]*docx/, 'the spotlights must keep the ranked order');
  assert.match(marketText, /self-improving agent/, 'the ClawHub row is missing its title');
  assert.ok(walk(marketBody).some(n=>String(n.props?.title).includes('ClawHub · v4.0.5')), 'source and version stay available in card metadata');
  assert.match(marketText, /↓ 96\.1k 次下载/, 'the ClawHub download count is missing');
  // Stars ride along when the source reports them; the official repo list has none.
  assert.match(marketText, /↓ 96\.1k 次下载/, 'the compact card displays its primary usage metric');
  assert.ok(walk(marketBody).some(n=>String(n.props?.title).includes('anthropics/skills · v1.9.4')), 'official card retains full source/version metadata');
  // The spotlight card keeps the prototype's tighter `↓ N · ★ N · vX` foot.
  assert.match(marketText, /精选技能[\s\S]*self-improving agent[\s\S]*ClawHub/, 'horizontal spotlight names its real source');
  assert.match(marketText, /安装到本插件目录/, 'installation destination is stated');
  const sourceWarning = walk(marketBody).find(n => n.props?.key === 'source-error:github');
  const friendlyWarning = walk(sourceWarning).find(n => n.props?.role === 'alert');
  assert.match(textOf(friendlyWarning), /GitHub 的访问次数已用完/);
  assert.match(textOf(friendlyWarning), /检测本机登录或配置 Token/);
  assert.doesNotMatch(textOf(friendlyWarning), /API rate limit exceeded|\{"message"/);
  const rawDetails = walk(sourceWarning).find(n => n.type === 'details');
  assert.equal(rawDetails.props.open, undefined, 'technical details are collapsed initially');
  assert.match(textOf(rawDetails), /403 API rate limit exceeded/, 'original diagnostic is preserved');


  // A search is a filtered page, not the browse page with matches somewhere below
  // it. The two spotlight cards belong to browsing; on a result page they pushed
  // the matches under the fold, and a one-row search looked like "nothing
  // happened" (the bug that sent us here: a cached anthropics listing answered
  // every query with all nineteen rows).
  const skillSearchInput = walk(marketBody).find((n) => n.type === 'input'
    && n.props?.['aria-label'] === '搜索市场');
  assert.ok(skillSearchInput, 'the skill market has no search box');
  const submitSearch = async (term) => {
    skillSearchInput.props.onChange({ target: { value: term } });
    await settle();
    const body = findByKey(walk(await render()), 'skillmarketbody')[0];
    const form = walk(body).find((n) => n.type === 'form' && typeof n.props?.onSubmit === 'function');
    assert.ok(form, 'the skill search has no submit handler');
    form.props.onSubmit({ preventDefault() {} });
    await settle();
    return findByKey(walk(await render()), 'skillmarketbody')[0];
  };

  const pdfPage = await submitSearch('pdf');
  assert.equal(walk(pdfPage).filter((n) => n.props?.className === 'omkt-skillhero').length, 0,
    'a search result page still shows the spotlight cards');
  const pdfCards = walk(pdfPage).filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard'));
  assert.ok(pdfCards.length > 0, 'the search matched nothing in the fixture');
  assert.ok(pdfCards.length < 20, 'the search did not narrow the wall');
  assert.ok(calls.some((c) => c.startsWith('POST /skills/market query=pdf')), 'the search never asked the host');

  const refreshButton = walk(pdfPage).find(n => n.props?.['aria-label'] === '刷新市场');
  refreshButton.props.onClick();
  await settle();
  assert.ok(calls.some(c => c.startsWith('POST /skills/market query=pdf category=all offset=0 refresh=true')),
    'refresh must preserve the submitted search and send the refresh flag');
  const mixedPage = await submitSearch('dev-god');
  assert.match(textOf(mixedPage), /编程大神\.Skill/, 'the mixed keyword search shows a match from SkillHub');
  assert.doesNotMatch(textOf(mixedPage), /当前混排未显示/);
  const marketSource = walk(mixedPage).find(n => n.props?.['aria-label'] === '按来源筛选市场');
  assert.ok(marketSource, 'source filter remains available');
  await marketSource.props.onChange({ target: { value: 'skillhub' } });
  await settle();
  const skillHubPage = findByKey(walk(await render()), 'skillmarketbody')[0];
  assert.match(textOf(skillHubPage), /编程大神\.Skill/, 'source-only search preserves the keyword');
  await marketSource.props.onChange({ target: { value: 'all' } });
  await settle();

  const collection = 'obra/superpowers';
  const repository = `https://github.com/${collection}`;
  const pageUrl = `${repository}/tree/main/skills/using-superpowers`;
  SKILL_MARKET_HITS.items.push({
    id: `github:${collection}:skills/using-superpowers`, source: 'github', collection, repository, pageUrl,
    name: 'using-superpowers', title: 'using-superpowers', summary: 'Use the collection workflow.',
    installable: true, install: { kind: 'github-dir', repo: collection, dir: 'skills/using-superpowers' },
  });
  const priorMetricCalls = calls.filter(call => call === 'POST /skill-metrics').length;
  const collectionPage = await submitSearch('using-superpowers');
  SKILL_MARKET_HITS.items.pop();
  const collectionCard = walk(collectionPage).find(node => node.props?.className === 'omkt-skillcard');
  assert.deepEqual(walk(collectionCard).filter(node => node.type === 'a').map(node => node.props.href), [pageUrl, repository]);
  assert.match(textOf(collectionCard), /安装当前技能/);
  assert.match(textOf(collectionPage), /实时查询暂不可用 · 内置 63/);
  assert.equal(calls.filter(call => call === 'POST /skill-metrics').length, priorMetricCalls, 'bundled skills have no individual Star counter');

  const nonePage = await submitSearch('agent-search');
  assert.match(textOf(nonePage), /没有匹配「agent-search」的 Skill/, 'an empty result set says nothing');
  assert.equal(walk(nonePage).filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard')).length, 0,
    'an empty result set still rendered cards');
  assert.equal(walk(nonePage).filter((n) => n.props?.className === 'omkt-skillhero').length, 0,
    'an empty result set still showed a spotlight card');

  // Back to browsing: the spotlights are a browse affordance, so clearing the
  // query has to bring them back.
  const restored = await submitSearch('');
  assert.equal(walk(restored).filter((n) => n.props?.className === 'omkt-skillhero').length, 2,
    'clearing the search did not bring the spotlight cards back');
  const sourceFilter = walk(restored).find(n => n.props?.['aria-label'] === '按来源筛选市场');
  assert.ok(walk(sourceFilter).some(n => n.type === 'option' && n.props.value === 'skillhub'));
  assert.ok(!walk(sourceFilter).some(n => n.type === 'option' && n.props.value === 'tencent-official'));

  // The full category list remains stable across server-side pages.
  const catSelect = walk(marketBody).find((n) => n.props?.['aria-label'] === '按分类筛选市场');
  assert.ok(catSelect, 'the market has no category filter');
  const catOptions = directChildren(catSelect).filter((n) => n.type === 'option');
  assert.equal(catOptions[0].props.value, 'all', 'the category filter has no "all" option');
  assert.ok(catOptions.length >= 3, 'the category filter only offers "all"');
  // The listing is one grid of the picked rows — the old per-bucket block heads
  // are gone, so a bucket name lives only in the filter.
  assert.match(marketText, /全部分类/, 'the category filter is missing');
  assert.ok(
    !/办公与文档[\s\S]{0,40}?\n?\s*\d+\s*页/.test(marketText),
    'the listing still prints a category block head above a grid',
  );
  // Picking a category requests the filtered first page.
  const postsBefore = calls.filter((c) => c.startsWith('POST /skills/market')).length;
  catSelect.props.onChange({ target: { value: 'office' } });
  await settle();
  const officePage = findByKey(walk(await render()), 'skillmarketbody')[0];
  const officeText = textOf(officePage);
  assert.match(officeText, /pdf|docx/, 'picking a category dropped the rows in it');
  assert.equal(walk(officePage).find(n=>n.type==='button'&&textOf(n)==='下一页 ›').props.disabled,true,'one-page result has a disabled next control');
  assert.ok(!officeText.includes('self-improving agent'), 'picking a category left the other rows on screen');
  assert.equal(calls.filter((c) => c.startsWith('POST /skills/market')).length, postsBefore + 1,
    'picking a category must query the host before paging');
  const officeSelect = walk(officePage).find((n) => n.props?.['aria-label'] === '按分类筛选市场');
  officeSelect.props.onChange({ target: { value: 'all' } });
  await settle();
  assert.match(textOf(findByKey(walk(await render()), 'skillmarketbody')[0]), /self-improving agent/,
    'going back to "全部分类" did not restore the listing');

  // Installing is a POST that names only an id: the host decides the directory.
  const installBtn = walk(walk(marketBody).find(n => n.props?.className === 'omkt-skillhero' && textOf(n).includes('self-improving agent')))
    .find((n) => n.type === 'button' && textOf(n) === '安装');
  assert.ok(installBtn, 'the ClawHub row has no install button');
  await installBtn.props.onClick();
  await settle();
  const installedPage = walk(await render());
  assert.ok(calls.includes('POST /skills/market/install id=clawhub:pskoett/self-improving-agent root=plugin'),
    '安装 never reached the host');
  assert.match(textOf(findByKey(installedPage, 'skillmarketbody')[0]), /已安装到/,
    'the page did not say where the skill was installed');
  assert.ok(calls.lastIndexOf('GET /skills') > calls.lastIndexOf('POST /skills/market/install'),
    'the installed list was not refreshed after the install');

  // The search box turns the listing into a query, which the host only accepts
  // as a POST body.
  const installedHero = walk(findByKey(installedPage, 'skillmarketbody')[0]).find(n => n.props?.className === 'omkt-skillhero' && textOf(n).includes('self-improving agent'));
  assert.match(textOf(installedHero), /已安装/, 'market uses scanned install provenance');
  const scanRow = SKILLS.skills.find(row => row.marketId === 'clawhub:pskoett/self-improving-agent');
  assert.ok(scanRow);
  // The API move removes that exact on-disk installation. A new scan must
  // release the catalog install state, including after re-entering the view.
  await globalThis.fetch('/api/overall-mcp/skills/remove', { method: 'POST', body: JSON.stringify({ id: scanRow.id, confirm: true }) });
  const registryTab = walk(await render()).find(n => n.props?.role === 'tab' && textOf(n).startsWith('已注册'));
  registryTab.props.onClick(); await settle();
  const rescan = walk(await render()).find(n => n.type === 'button' && textOf(n) === '重新扫描');
  assert.ok(rescan); await rescan.props.onClick(); await settle();
  walk(await render()).find(n => n.props?.role === 'tab' && textOf(n) === '市场').props.onClick(); await settle();
  const uninstalledHero = walk(await render()).find(n => n.props?.className === 'omkt-skillhero' && textOf(n).includes('self-improving agent'));
  assert.ok(walk(uninstalledHero).some(n => n.type === 'button' && textOf(n) === '安装'), 'removed Skill must be installable again');

  const searchInput = walk(findByKey(installedPage, 'skillmarketbody')[0])
    .find((n) => n.props?.['aria-label'] === '搜索市场');
  assert.ok(searchInput, 'the market has no search box');
  searchInput.props.onChange({ target: { value: 'pdf' } });
  await settle();
  // 搜索 is a submit button: the form's own handler is what runs, so the probe
  // submits the form the way the browser would.
  const searchForm = walk(findByKey(walk(await render()), 'skillmarketbody')[0])
    .find((n) => n.type === 'form' && n.props?.className === 'omkt-market-search');
  assert.ok(searchForm && typeof searchForm.props.onSubmit === 'function', 'the market search is not a form');
  await searchForm.props.onSubmit({ preventDefault() {} });
  await settle();
  assert.ok(calls.some(c => c.startsWith('POST /skills/market query=pdf ')), 'the search never reached the host');
  const searched = walk(findByKey(walk(await render()), 'skillmarketbody')[0])
    .filter((n) => n.props?.className?.split(' ').includes('omkt-skillcard') || n.props?.className === 'omkt-skillhero');
  assert.equal(searched.length, 1, 'the search results did not replace the listing');
  assert.match(textOf(searched[0]), /pdf/, 'the search result is not the row that was asked for');

  console.log('skill space: pills switch, groups + cards + drawer, reveal says where, remove moves it ✓');
  console.log('skill market: platform filter, retired source hidden, failure reason, install and search ✓');
}

// --- 8d. Call tables: filters, expansion, metrics, and current-view export ---
{
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => copied.push(text) } }, configurable: true });
  const selectSpace = async label => { const pill=walk(await render()).find(n=>n.props?.className?.includes('omkt-spacep')&&textOf(n).startsWith(label)); assert.ok(pill); pill.props.onClick(); await settle(); };
  await selectSpace('MCP');
  walk(await render()).find(n=>n.type==='button'&&n.props?.role==='tab'&&textOf(n).startsWith('调用')).props.onClick();
  await settle();
  const body = async () => findByKey(walk(await render()), 'callsbody')[0];
  let feed=await body();
  assert.match(textOf(feed), /工具调用/); assert.match(textOf(feed), /50%/); assert.match(textOf(feed), /80 ms/);
  assert.equal(walk(feed).filter(n=>n.props?.['data-omkt']==='scroller').length,1,'one content scroller');
  assert.equal(walk(feed).filter(n=>n.props?.className==='omkt-calltoggle').length,3,'one detail toggle per event');
  walk(feed).find(n=>n.props?.className==='omkt-calltoggle' && n.props['aria-label'].includes('fetch')).props.onClick();
  feed=await body(); assert.match(textOf(feed),/请求参数/); assert.match(textOf(feed),/错误响应/); assert.match(textOf(feed),/boom/);
  walk(feed).find(n=>n.props?.className==='omkt-calltoggle' && n.props['aria-label'].includes('issue')).props.onClick();
  feed=await body(); assert.match(textOf(feed),/正在等待结果/);
  const stateSelect=walk(feed).find(n=>n.props?.['aria-label']==='按调用状态筛选');
  assert.ok(stateSelect,'status filter is available'); stateSelect.props.onChange({target:{value:'fail'}});
  feed=await body(); assert.equal(walk(feed).filter(n=>n.props?.className==='omkt-calltoggle').length,1,'failure filter narrows events');
  walk(feed).find(n=>n.type==='button'&&textOf(n)==='导出记录').props.onClick(); await settle();
  const payload=JSON.parse(copied.at(-1)); assert.equal(payload.rows.length,1,'export matches visible failure filter'); assert.equal(payload.eventFilter,'fail');
  walk(feed).find(n=>n.props?.['aria-label']==='按调用状态筛选').props.onChange({target:{value:'all'}});
  feed=await body();
  const resourceSelect = walk(feed).find(n => n.props?.['aria-label'] === '按连接器筛选调用');
  assert.ok(resourceSelect, 'the resource filter is available');
  resourceSelect.props.onChange({ target: { value: 'gh' } }); await settle(); await body();
  assert.ok(calls.includes('GET /calls space=mcp range=24h filter=gh'));
  feed=await body(); walk(feed).find(n=>n.type==='button'&&textOf(n)==='近1小时').props.onClick(); await settle();
  assert.ok(calls.includes('GET /calls space=mcp range=1h filter=gh') || (await body()&&calls.includes('GET /calls space=mcp range=1h filter=gh')));
  feed=await body(); const search=walk(feed).find(n=>n.props?.['aria-label']==='搜索调用记录'); search.props.onChange({target:{value:'nothing'}});
  feed=await body(); assert.match(textOf(feed),/没有匹配的调用记录/); assert.ok(!calls.some(c=>c.includes('q=nothing')),'search stays local');
  walk(feed).find(n=>n.type==='button'&&textOf(n)==='清空搜索').props.onClick(); feed=await body(); assert.match(textOf(feed),/显示 3 条/);
  assert.equal(walk(feed).find(n=>n.props?.key==='resourceFilter').props.value, '', 'the empty-state action clears resource filters too');
  await selectSpace('Skill');
  walk(await render()).find(n=>n.type==='button'&&n.props?.role==='tab'&&textOf(n).startsWith('调用')).props.onClick(); await settle(); feed=await body();
  assert.match(textOf(feed),/触发事件/); assert.match(textOf(feed),/斜杠命令引用计入触发完成数/); assert.match(textOf(feed),/需重启 DSH/);
  assert.match(textOf(feed),/用户引用 ×2/); assert.match(textOf(feed),/pdf/); assert.match(textOf(feed),/gzh-design/);
  walk(feed).find(n=>n.props?.['aria-label']==='按事件类型筛选').props.onChange({target:{value:'reference'}});
  feed=await body(); assert.equal(walk(feed).filter(n=>n.props?.className==='omkt-calltoggle').length,1,'event filter isolates references');
  assert.match(textOf(feed),/已记录/);
  assert.ok(textOf(feed).includes('触发完成2 / 2'));
  const mergeSelect=walk(feed).find(n=>n.type==='select' && n.props['aria-label']==='合并命令引用');
  assert.equal(walk(mergeSelect).filter(n=>n.type==='option').length,3);
  mergeSelect.props.onChange({target:{value:'1800000'}}); await settle(); await body();
  assert.ok(calls.includes('POST /prefs merge=1800000'));
  for(const label of ['Skill','MCP']) { await selectSpace(label); walk(await render()).find(n=>n.type==='button'&&n.props?.role==='tab'&&textOf(n).startsWith('调用')).props.onClick(); const page=walk(await render()); const tabs=walk(findByKey(page,'tabs')[0]).filter(n=>n.props?.role==='tab'); assert.equal(tabs.filter(n=>n.props['aria-selected']==='true').length,1); }
  console.log('call tables: status/event/resource filters, detail expansion, current-view export, local search and merge persistence ✓');
}

// --- 9. the stylesheet was injected once -----------------------------------
assert.ok(styleElements.length >= 1, 'ensureStyles injects the hover/animation sheet');

// The pills are divs now, so the ring lives on the tablist wrapper. A stray
// leading `+` once turned these rules into `NaN.omkt-…`, so assert on the text
// that actually ships.
const injectedCss = styleElements.map((el) => el.textContent ?? '').join('\n');
assert.ok(
  injectedCss.includes('.omkt-spaceswitch:focus-visible{'),
  'the space-tablist focus rules did not reach the stylesheet',
);
assert.ok(
  !/NaN\s*\.omkt-/.test(injectedCss),
  'a stylesheet array element starts with a unary `+`, which evaluates to NaN',
);

console.log('market tab renders: tabs, stat line, search, 3 cards, CTA + footer split ✓');
console.log('registry tab renders: scan button present ✓');

for (const [row, expected] of [
  [{ id: 'official', error: 'Official skills listing returned 403: {"message":"API rate limit exceeded for 192.0.2.1"}' }, /GitHub 的访问次数已用完/],
  [{ id: 'official', error: 'HTTP 403 forbidden' }, /来源拒绝/],
  [{ id: 'github', error: '403 secondary rate limit' }, /请求过于频繁/],
  [{ id: 'clawhub', error: 'HTTP 429' }, /请求过于频繁/],
  [{ id: 'official', error: '401 bad credentials' }, /身份验证未通过/],
  [{ id: 'skillhub', error: 'HTTP 503' }, /服务器暂时异常/],
  [{ id: 'official', error: 'request timed out' }, /连接来源超时/],
  [{ id: 'official', error: 'fetch failed: ENOTFOUND' }, /网络或代理/],
  [{ id: 'official', error: 'unexpected upstream payload' }, /获取技能列表失败/],
]) assert.match(mod.__test.skillSourceErrorMessage(row), expected);
console.log('Skill source failures: Chinese cause/action, precise 403 classification, original details preserved ✓');


// Registered paging uses complete filtered data, not the first fetched slice.
{
  const saved = structuredClone(SKILLS);
  const selectSpace = async label => {
    walk(await render()).find(n => n.props?.className?.includes('omkt-spacep') && textOf(n) === label).props.onClick(); await settle();
    walk(await render()).find(n => n.props?.role === 'tab' && textOf(n).startsWith('已注册')).props.onClick(); await settle();
  };
  await selectSpace('Skill');
  SKILLS.skills = Array.from({ length: 125 }, (_, i) => ({ id: `user:qa-${i}`, name: i === 124 ? 'zz-final' : `qa-${String(i).padStart(3, '0')}`, description: 'Paging audit fixture', root: 'user', files: 1, bytes: 32 }));
  SKILLS.totals.count = 125;
  const rescan = async () => { walk(await render()).find(n => n.type === 'button' && textOf(n) === '重新扫描').props.onClick(); await settle(); };
  await rescan();
  const body = async () => findByKey(walk(await render()), 'skillbody')[0];
  const rowCount = page => walk(page).filter(n => n.props?.className?.split(' ').includes('omkt-skillcard')).length;
  const sizeControl = page => walk(page).find(n => n.props?.['aria-label'] === '每页条数');
  assert.equal(sizeControl(await body()).props.value, 20);
  assert.equal(rowCount(await body()), 20);
  sizeControl(await body()).props.onChange({ target: { value: '50' } });
  assert.equal(rowCount(await body()), 50);
  walk(await body()).find(n => n.props?.['aria-label'] === '第 3 页').props.onClick();
  assert.equal(rowCount(await body()), 25);
  assert.match(textOf(await body()), /显示 101–125 项，共 125 项/);
  sizeControl(await body()).props.onChange({ target: { value: '100' } });
  assert.equal(rowCount(await body()), 100);
  assert.equal(textOf(walk(await body()).find(n => n.props?.['aria-current'] === 'page')), '1');
  sizeControl(await body()).props.onChange({ target: { value: '50' } });
  walk(await body()).find(n => n.props?.title === '跳转到 Z').props.onClick({ currentTarget: null });
  assert.equal(rowCount(await body()), 25);
  assert.match(textOf(await body()), /zz-final/);
  SKILLS.skills = SKILLS.skills.slice(0, 64); SKILLS.totals.count = 64;
  await rescan();
  assert.equal(rowCount(await body()), 14, 'a shrinking dataset clamps to the last remaining page');
  assert.match(textOf(await body()), /显示 51–64 项，共 64 项/);
  walk(await body()).find(n => n.props?.['aria-label'] === '搜索 skill').props.onChange({ target: { value: 'qa-002' } });
  assert.equal(rowCount(await body()), 1);
  assert.match(textOf(await body()), /显示 1–1 项，共 1 项/);
  walk(await body()).find(n => n.props?.['aria-label'] === '搜索 skill').props.onChange({ target: { value: 'no-matching-skill' } });
  assert.equal(rowCount(await body()), 0);
  assert.equal(walk(await body()).find(n => textOf(n) === '下一页 ›').props.disabled, true);
  walk(await body()).find(n => n.props?.['aria-label'] === '搜索 skill').props.onChange({ target: { value: '' } });
  await selectSpace('MCP');
  await selectSpace('Skill');
  assert.equal(sizeControl(await body()).props.value, 50, 'page-size selection survives resource switching');
  Object.assign(SKILLS, saved); await rescan();
  console.log('Registered Skill: 20/50/100, paging ranges, size/filter reset, alphabet and shrinking data ✓');
}

{
  walk(await render()).find(n => n.props?.className?.includes('omkt-spacep') && textOf(n) === 'MCP').props.onClick(); await settle();
  walk(await render()).find(n => n.props?.role === 'tab' && textOf(n).startsWith('已注册')).props.onClick(); await settle();
  registryPagingRows = Array.from({ length: 125 }, (_, i) => ({ name: `paging-${String(i).padStart(3, '0')}`, slot: i, source: 'manual', enabled: i !== 124 }));
  const body = async () => findByKey(walk(await render()), 'reg')[0];
  const reload = async () => { walk(await body()).find(n => n.props?.key === 'scan').props.onClick(); await settle(); await settle(); };
  const count = page => walk(page).filter(n => n.props?.className?.split(' ').includes('omkt-srow')).length;
  const size = page => walk(page).find(n => n.props?.['aria-label'] === '每页条数');
  await reload();
  assert.equal(size(await body()).props.value, 20);
  assert.equal(count(await body()), 20);
  size(await body()).props.onChange({ target: { value: '50' } });
  assert.equal(count(await body()), 50);
  walk(await body()).find(n => n.props?.['aria-label'] === '第 2 页').props.onClick();
  assert.match(textOf(await body()), /显示 51–100 项，共 125 项/);
  const firstVisible = walk(await body()).find(n => n.props?.className?.split(' ').includes('omkt-srow'));
  walk(firstVisible).find(n => n.type === 'button' && textOf(n) === '移除').props.onClick(); await settle();
  assert.equal(registryRowAction.slot, 50, 'row action must retain the original registry slot');
  assert.equal(registryRowAction.name, 'paging-050');
  walk(await body()).find(n => n.props?.key === 'grouping').props.onClick();
  assert.equal(count(await body()), 50);
  assert.match(textOf(await body()), /本页 50 个 · 共 125 个 · 124 已启用/);
  const sourceSwitch = walk(await body()).find(n => n.props?.title === '启用该来源的全部服务器');
  assert.equal(sourceSwitch.props['aria-checked'], 'false', 'disabled row on another page affects full-source state');
  sourceSwitch.props.onClick({ stopPropagation() {} }); await settle(); await settle();
  assert.deepEqual(registrySourceAction, { source: 'manual', enabled: true });
  assert.equal(registryPagingRows.filter(row => row.enabled).length, 125);
  walk(await body()).find(n => n.props?.['aria-label'] === '第 3 页').props.onClick();
  assert.equal(count(await body()), 25);
  const search = walk(await body()).find(n => n.props?.['aria-label'] === '搜索 MCP');
  search.props.onChange({ target: { value: 'paging-002' } });
  assert.equal(count(await body()), 1);
  assert.match(textOf(await body()), /显示 1–1 项，共 1 项/);
  walk(await body()).find(n => n.props?.['aria-label'] === '搜索 MCP').props.onChange({ target: { value: '' } });
  walk(await body()).find(n => n.props?.key === 'state' && n.type === 'select').props.onChange({ target: { value: 'disabled' } });
  assert.equal(count(await body()), 0);
  assert.match(textOf(await body()), /显示 0 项/);
  walk(await body()).find(n => n.props?.key === 'state' && n.type === 'select').props.onChange({ target: { value: '' } });
  registryPagingRows = null; await reload();
  console.log('Registered MCP: multi-page rows, original-slot actions, filter reset, full-source bulk scope ✓');
}


// Refresh must re-measure existing values, including repositories after the
// global first 30, and a late older measurement must not replace the new one.
{
  const ok = value => ({ ok: true, status: 200, json: async () => value });
  let stars = 100; let pulls = 10; let fail = false; let hold = false;
  const held = []; const requests = [];
  catalogGate = async () => ok({ ...MARKET, items: Array.from({ length: 45 }, (_, i) => ({
    ...MARKET.items[1], id: `metric:${i}`, title: `metric-server-${i}`, repository: `https://github.com/audit/r${i}`, statsAt: new Date(Date.now() + 1000).toISOString(), stars: 1, installs: i % 2 ? pulls : undefined, installsLabel: '次拉取',
  })) });
  repoStatsResponder = async body => {
    requests.push(body);
    if (hold) return new Promise(resolve => held.push({ body, resolve }));
    return ok({ stats: fail ? {} : Object.fromEntries(body.repos.map(repo => [repo, { stars, fetchedAt: new Date().toISOString() }])),
      errors: fail ? body.repos.map(repo => ({ repo, message: 'test quota', rateLimited: true })) : [], rateLimited: fail });
  };
  const page = async () => walk(await render());
  walk(await render()).find(n => n.props?.role === 'tab' && textOf(n) === '市场').props.onClick(); await settle();
  const category = (await page()).find(n => n.props?.['aria-label'] === '按分类筛选市场');
  category.props.onChange({ target: { value: '' } });
  (await page()).find(n => n.props?.['aria-label'] === '市场排序').props.onChange({ target: { value: 'default' } });
  (await page()).find(n => n.props?.['aria-label'] === '搜索市场').props.onChange({ target: { value: '' } });
  (await page()).find(n => n.type === 'form' && n.props?.className === 'omkt-market-search').props.onSubmit({ preventDefault() {} }); await settle();
  await render(); await settle();
  assert.match(textOf(await render()), /★ 100/);
  const refresh = async () => { (await page()).find(n => n.props?.['aria-label'] === '刷新市场').props.onClick(); await settle(); await render(); await settle(); };
  stars = 200; pulls = 20; await refresh();
  assert.match(textOf(await render()), /★ 200/);
  assert.match(textOf(await render()), /20 次拉取/);
  assert.ok(requests.some(request => request.refresh && request.repos.includes('audit/r0')), 'refresh bypasses an existing browser measurement');
  (await page()).find(n => n.props?.['aria-label'] === '第 2 页').props.onClick(); await render(); await settle();
  assert.ok(requests.some(request => request.repos.includes('audit/r35')), 'the second visible page is enriched beyond the initial global cap');
  hold = true; await refresh();
  assert.ok(held.length);
  hold = false; stars = 300; await refresh();
  for (const pending of held) pending.resolve(ok({ stats: Object.fromEntries(pending.body.repos.map(repo => [repo, { stars: 50, fetchedAt: new Date().toISOString() }])), errors: [] }));
  await settle();
  assert.match(textOf(await render()), /★ 300/);
  assert.doesNotMatch(textOf(await render()), /★ 50/);
  fail = true; await refresh();
  assert.match(textOf(await render()), /统计未能更新/);
  assert.match(textOf(await render()), /★ 300/);
  fail = false; stars = 400; await refresh();
  assert.match(textOf(await render()), /★ 400/);
  assert.doesNotMatch(textOf(await render()), /统计未能更新/);
  const open = (await page()).find(n => n.props?.['aria-label'] === '查看 metric-server-21 详情' && n.props?.onClick);
  open.props.onClick();
  const backgroundRefresh = (await page()).find(n => n.props?.['aria-label'] === '刷新市场').props.onClick;
  pulls = 37; backgroundRefresh(); await settle(); await render(); await settle();
  const dialog = (await page()).find(n => n.props?.role === 'dialog' && n.props?.['aria-label'] === 'metric-server-21 详情');
  assert.match(textOf(dialog), /37 次拉取/, 'an open detail follows the new catalog record');
  (await page()).find(n => n.props?.title === '关闭' && n.type === 'button' && n.props?.onClick)?.props.onClick();
  catalogGate = null; repoStatsResponder = null;
  console.log('Dynamic MCP metrics: changed Stars/pulls, visible-page coverage, refresh races, recovery and detail coherence ✓');
}

{
  let downloads = 123; let fail = false;
  skillMetricsResponder = async body => ({ ok: true, status: 200, json: async () => ({
    items: Object.fromEntries(body.ids.map(id => [id, { downloads, metrics: { at: new Date().toISOString(), stale: fail, ...(fail ? { error: 'test unavailable' } : {}) } }])),
    updated: fail ? 0 : body.ids.length, errors: fail ? [{ message: 'test unavailable' }] : [],
  }) });
  walk(await render()).find(n => n.type === 'button' && textOf(n) === 'Skill').props.onClick(); await settle();
  await render(); await settle();
  walk(await render()).find(n => n.props?.['aria-label'] === '刷新市场').props.onClick(); await settle(); await render(); await settle();
  walk(await render()).find(n => n.props?.['aria-label'] === '按分类筛选市场').props.onChange({ target: { value: 'all' } }); await settle();
  walk(await render()).find(n => n.props?.['aria-label'] === '搜索市场').props.onChange({ target: { value: 'self-improving-agent' } });
  walk(await render()).find(n => n.type === 'form' && n.props?.className === 'omkt-market-search').props.onSubmit({ preventDefault() {} }); await settle(); await render(); await settle();
  assert.match(textOf(await render()), /123 次下载/);
  downloads = 456;
  const refresh = async () => { walk(await render()).find(n => n.props?.['aria-label'] === '刷新市场').props.onClick(); await settle(); await render(); await settle(); };
  await refresh();
  assert.match(textOf(await render()), /456 次下载/);
  fail = true; await refresh();
  assert.match(textOf(await render()), /统计更新失败/);
  fail = false; downloads = 789; await refresh();
  assert.match(textOf(await render()), /789 次下载/);
  skillMetricsResponder = null;
  console.log('Dynamic Skill metrics: changed downloads, refresh, visible failures and recovery ✓');
}

{
  const now = Date.parse('2026-11-09T12:00:00Z');
  callScenario = { now, rows: ['mcp', 'skill'].map(space => ({ id: `historical-${space}`, space, server: 'historical-connector', skill: 'historical-skill', tool: 'historical-tool', status: 'ok', ms: 12, startedAt: new Date(now - 3 * 86400000).toISOString() })) };
  for (const [space, label] of [['mcp', 'MCP'], ['skill', 'Skill']]) {
    walk(await render()).find(n => n.props?.className?.includes('omkt-spacep') && textOf(n) === label).props.onClick(); await settle();
    walk(await render()).find(n => n.props?.role === 'tab' && textOf(n).startsWith('调用记录')).props.onClick(); await settle();
    const control = () => space === 'mcp' ? '按连接器筛选调用' : '按 Skill 筛选事件';
    walk(await render()).find(n => n.type === 'button' && textOf(n) === '近7天').props.onClick(); await settle();
    let tree = walk(await render());
    assert.ok(tree.some(n => n.props?.className === 'omkt-callrail'));
    const rail = tree.find(n => n.props?.className === 'omkt-callrail');
    assert.match(textOf(rail), /近7天/);
    assert.match(textOf(rail), space === 'mcp' ? /historical-connector1/ : /historical-skill1/);
    tree.find(n => n.props?.['aria-label'] === control()).props.onChange({ target: { value: space === 'mcp' ? 'historical-connector' : 'historical-skill' } }); await settle();
    walk(await render()).find(n => n.type === 'button' && textOf(n) === '近24小时').props.onClick(); await settle();
    tree = walk(await render());
    assert.ok(!tree.some(n => n.props?.className === 'omkt-callrail'), 'out-of-window resources must not remain in the rail');
    assert.equal(tree.find(n => n.props?.['aria-label'] === control()).props.value, '', 'the expired resource selection is cleared');
    assert.match(textOf(await render()), /这段时间还没有调用/);
  }
  callScenario = null;
  console.log('Calls time scope: historical MCP/Skill appear only in their window; rail counts, labels and expired selections follow the range ✓');
}
