/**
 * Repo media: the preview pictures a marketplace card can honestly show.
 *
 * The plugin market's cards carry screenshots, and MCP entries have none — no
 * catalogue publishes one, and inventing a picture would be decoration
 * pretending to be data. What every GitHub-backed entry DOES have is its own
 * repository: the README (where most projects keep a real screenshot or
 * diagram) and GitHub's generated social card for the repo. Both are fetched
 * here, ranked, and handed to the client as URLs; the client renders them
 * through a resize proxy exactly like the plugin market does, and degrades to
 * showing nothing at all when a repo has neither.
 *
 * Nothing is downloaded into the plugin: only URLs cross the boundary, so a
 * broken image costs a failed `<img>`, never a failed request.
 */

import { withGithubAuth } from './github-auth.js';

/**
 * Identify ourselves on the one request this module makes: the raw host
 * throttles an anonymous, unidentified client long before any published quota,
 * and a token (when the user has one) raises the ceiling further.
 */
const README_HEADERS = { 'user-agent': 'dsh-overall-mcp (DeepSeek Harness plugin)', accept: 'text/plain' };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i;

/**
 * Hosts whose images are generated badges / status cards rather than anything
 * a human would call a preview. Shields and friends make up the overwhelming
 * majority of every awesome-list README, so without this filter a "screenshot"
 * slot would fill with CI badges.
 *
 * Matched on the parsed hostname, not a substring of the URL: `badge.fury.io`
 * sits behind `https://`, so an "anything before the host" pattern misses it
 * while still catching `img.shields.io` — which is how this list first shipped
 * broken. The MCP-directory hosts are here for the same reason the CI ones
 * are: a live run of punkpeye/awesome-mcp-servers came back with four glama.ai
 * score badges in the preview slot, and a "score" is not a screenshot.
 *
 * Matched on the parsed hostname, not a substring of the URL: `badge.fury.io`
 * sits behind `https://`, so an "anything before the host" pattern misses it
 * while still catching `img.shields.io` — which is how this list first shipped
 * broken.
 */
const BADGE_HOSTS = new Set([
  'img.shields.io', 'shields.io', 'flat.badgen.net', 'badgen.net', 'badge.fury.io',
  'nodei.co', 'snyk.io', 'codecov.io', 'coveralls.io', 'travis-ci.com', 'travis-ci.org',
  'circleci.com', 'dependabot.com', 'github-readme-stats.vercel.app',
  'github-profile-trophy.vercel.app', 'repobeats.xyz', 'actions-badge.herokuapp.com',
  'opencollective.com', 'img.youtube.com',
  // MCP directories and CI hosts that publish "listed on" score cards.
  'glama.ai', 'mcpservers.org', 'mcp.so', 'smithery.io', 'sonarcloud.io',
  'codacy.com', 'codeclimate.com', 'deepscan.io', 'bettercodehub.com', 'lgtm.com',
  'fossa.io', 'dev.azure.com', 'visualstudio.com', 'gitlab.com', 'npmstack.com',
  'packagephobia.com', 'bundlephobia.com', 'apex.sh',
]);

/**
 * Badge-shaped paths, whichever host serves them.
 *
 * `logo` is deliberately absent: a project's own logo is a legitimate preview
 * and often the only picture a small server has, while `badge`/`score`/
 * `status` paths are generated cards no matter whose host serves them.
 */
const BADGE_URL = /\/(?:badges?|shields?|score|status)(?:[/.]|$)/i;

/** Badges GitHub renders from a repo's own paths rather than a badge service. */
const BADGE_PATH = /github\.com\/[^/]+\/[^/]+\/(?:badge|actions\/workflows)/i;

/** The hostname of an absolute URL, or '' when it is not parseable. */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** README paths that name a picture worth showing, strongest first. */
const STRONG_WORDS = /(screenshot|screen shot|demo|preview|overview|architecture|diagram|workflow|flow|banner|hero|cover|dashboard|ui|interface|terminal|cli|example|gallery)/i;

/** GitHub's own generated social card for a repository. Always exists. */
export function ogImageOf(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo ?? "").trim());
  return m ? `https://opengraph.githubassets.com/${m[1]}/${m[2]}` : null;
}

/**
 * Turn one README image reference into something renderable.
 *
 * READMEs are written for GitHub's own renderer, so three shapes have to be
 * normalised before a browser can fetch them: repo-relative blob links
 * (`/owner/repo/blob/main/x.png`), repository-relative paths (`./docs/x.png`,
 * `docs/x.png`), and angle-bracketed or titled markdown destinations.
 * Anything that is not http(s) after that is dropped — `data:` URIs in
 * particular are usually inline badge sprites.
 */
export function normalizeImageUrl(raw, repo) {
  let url = String(raw ?? "").trim();
  if (!url) return null;
  // Strip a markdown title: ![alt](url "title")
  url = url.replace(/\s+["'(].*$/, "").trim();
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    if (/^(?:data|mailto|javascript|blob):/i.test(url)) return null;
    const [owner, name] = String(repo ?? "").split("/");
    if (!owner || !name) return null;
    // A repo-absolute path (`/owner/repo/blob/main/x.png`) is a github.com
    // link with the host left off, exactly as the README renderer sees it.
    if (/^\/[^/]+\/[^/]+\/blob\//i.test(url)) url = `https://github.com${url}`;
    else url = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${url.replace(/^\.?\//, "")}`;
  }
  // A blob link on github.com is the same file the raw host serves, and the
  // raw host serves it without a redirect or a rate limit.
  const blob = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^/\s]+)\/(.+)$/i.exec(url);
  if (blob) url = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  if (!IMAGE_EXT.test(url)) return null;
  if (BADGE_HOSTS.has(hostOf(url)) || BADGE_PATH.test(url) || BADGE_URL.test(url)) return null;
  return url;
}

/**
 * Every image reference in a README, in document order.
 *
 * Three markdown shapes carry pictures: inline `![alt](url)`, raw HTML
 * `<img src>`, and reference-style `![alt][ref]` with `[ref]: url` defined
 * below. Awesome lists are almost entirely the first kind, project READMEs
 * mostly the second, and the third shows up in hand-written docs — all three
 * are cheap to collect, so all three are.
 *
 * Only the HTML form states its geometry, so only it yields width/height.
 * That matters: an `<img>` with no size and a markdown image with no size are
 * indistinguishable otherwise, and a generated badge is exactly the picture
 * that never states its size.
 */
export function collectImageRefs(markdown) {
  const out = [];
  const text = String(markdown ?? "");
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)/g)) {
    out.push({ alt: m[1] ?? "", url: m[2] });
  }
  for (const m of text.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
      ?? /\bsource\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    const width = Number(/(?:^|\s)width\s*=\s*["']?(\d+)/i.exec(attrs)?.[1]);
    const height = Number(/(?:^|\s)height\s*=\s*["']?(\d+)/i.exec(attrs)?.[1]);
    out.push({
      alt: /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "",
      url: src,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
    });
  }
  for (const m of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(https?:\/\/\S+)\s*$/gm)) {
    out.push({ alt: m[1] ?? "", url: m[2] });
  }
  return out;
}

/** What kind of picture this is, for ranking and for the slide's caption. */
export function imageKindOf(url, alt) {
  const hay = `${url} ${alt}`;
  if (/star-history|starchart/i.test(hay)) return "chart";
  if (STRONG_WORDS.test(hay)) return "screenshot";
  return "image";
}

/**
 * Rank the candidates and keep the best few.
 *
 * A README's first image is usually the project's logo or a CI badge, and its
 * screenshots sit wherever the author felt like putting them, so position is
 * the weakest signal and semantics the strongest: a file named
 * `docs/architecture.png` outranks `logo.png` no matter which comes first.
 * SVGs lose to rasters because in practice a README's SVGs are generated
 * cards, and duplicates are dropped so one screenshot cannot fill the strip.
 *
 * Size is the other half of the geometry, and only an `<img>` states it. An
 * SVG with no stated size is dropped outright rather than trusted: the badge
 * services all publish SVG, and the screenshots worth showing do not. A stated
 * size under 200px is dropped too — that is a badge's geometry, not a
 * screenshot's.
 */
export function rankImages(candidates, max = 6) {
  const scored = [];
  const seen = new Set();
  candidates.forEach((c, index) => {
    const url = normalizeImageUrl(c.url, c.repo);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const width = Number.isFinite(c.width) && c.width > 0 ? c.width : null;
    const height = Number.isFinite(c.height) && c.height > 0 ? c.height : null;
    if (width && height && Math.min(width, height) < 200) return;
    const svg = /\.svg(?:[?#]|$)/i.test(url);
    if (svg && !(width && height)) return;
    const kind = imageKindOf(url, c.alt);
    const raster = /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url);
    let score = 0;
    if (kind === "screenshot") score += 60;
    if (kind === "chart") score += 25;
    if (raster) score += 12;
    if (String(c.alt ?? "").trim()) score += 6;
    if (width && height) score += 8;
    score -= Math.min(index, 20) * 0.4;
    scored.push({ url, alt: String(c.alt ?? "").trim(), kind, score, width, height });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}

/** README filenames worth trying, in order. */
const README_NAMES = ["README.md", "readme.md", "Readme.md", "README.rst", "README.txt", "README"];

/**
 * Fetch one repository's README as text, or null when it has none.
 *
 * GitHub's API is the correct route but is rate-limited to nothing here, so
 * the raw host leads and a CDN mirror follows. Both are the same bytes: the
 * CDN caches the default branch, the raw host resolves HEAD itself.
 */
export async function fetchReadmeText(repo, fetchImpl = fetch) {
  for (const url of [
    `https://raw.githubusercontent.com/${repo}/HEAD/README.md`,
    `https://cdn.jsdelivr.net/gh/${repo}/README.md`,
  ]) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(10000),
        headers: withGithubAuth(url, README_HEADERS),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && !/^404: Not Found/i.test(text.trim())) return text;
    } catch { /* try the next carrier */ }
  }
  return null;
}

/**
 * Everything one card may show: README pictures first, GitHub's own social
 * card as the fallback. The fallback is only used when the README offered
 * nothing, so a project WITH screenshots never shows the generated card.
 */
export async function repoMediaFor(repo, fetchImpl = fetch, maxImages = 4) {
  const markdown = await fetchReadmeText(repo, fetchImpl);
  const images = markdown
    ? rankImages(collectImageRefs(markdown).map((c) => ({ ...c, repo })), maxImages)
    : [];
  const og = ogImageOf(repo);
  return { repo, images, og: images.length ? null : og };
}

/**
 * Resolve media for a bounded set of repositories, sequentially.
 *
 * Sequential on purpose: every repo costs at least one README fetch of up to a
 * megabyte, and GitHub answers a burst of thirty parallel requests with a
 * rate limit that would empty the whole page. A slow README delays the strip
 * by a moment; a rate limit would delay it for an hour.
 */
export async function collectRepoMedia(repos, { fetchImpl = fetch, max = 24, maxImages = 4 } = {}) {
  const media = {};
  const errors = [];
  let spent = 0;
  for (const repo of repos) {
    if (spent >= max) break;
    spent += 1;
    try {
      const entry = await repoMediaFor(repo, fetchImpl);
      media[repo] = { ...entry, images: entry.images.slice(0, maxImages) };
    } catch (err) {
      errors.push({ repo, error: String(err?.message ?? err) });
    }
  }
  return { media, errors };
}
