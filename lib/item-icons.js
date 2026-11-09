import { isIP } from 'node:net';

// Return display metadata only. The host never fetches arbitrary icon URLs.
export function publicIcon(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value)) return undefined;
  let url;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.replace(/\.$/, '');
  if (url.username || url.password || !host.includes('.') || isIP(host) ||
      /\.(?:localhost|local|internal|test|invalid)$/.test(host)) return undefined;
  return url.href;
}

export function declaredIcon(metadata) {
  const records = Array.isArray(metadata?.icons) ? metadata.icons : [];
  const neutral = records.find(icon => !icon?.theme && publicIcon(icon?.src));
  return publicIcon(neutral?.src)
    ?? publicIcon(records.find(icon => publicIcon(icon?.src))?.src)
    ?? [metadata?.iconUrl, metadata?.icon, metadata?.logoUrl, metadata?.logo]
      .map(publicIcon).find(Boolean);
}

export function declaredEmoji(metadata) {
  const value = metadata?.emoji ?? metadata?.metadata?.emoji;
  return typeof value === 'string' && value.length <= 24 &&
    /^(?=.*\p{Emoji_Presentation}|.*\uFE0F)[\p{Emoji}\p{Emoji_Component}\u200D]+$/u.test(value)
    ? value : undefined;
}

export function githubOwnerIcon(owner) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner ?? '')
    ? `https://github.com/${owner}.png?size=80` : undefined;
}

/** Repository avatars are safe to try even when a separate homepage is present. */
export function publisherIcons(...publishedPages) {
  const owners = new Set();
  for (const page of publishedPages) {
    const safe = publicIcon(page);
    if (!safe) continue;
    const url = new URL(safe);
    if (url.port || !['github.com', 'www.github.com'].includes(url.hostname)) continue;
    const [, owner, repo] = url.pathname.split('/');
    if (repo && githubOwnerIcon(owner)) owners.add(githubOwnerIcon(owner));
  }
  return cleanPublisherIcons([...owners]);
}

export function cleanPublisherIcons(value) {
  return Array.isArray(value) ? [...new Set(value.slice(0, 12).map(publicIcon).filter(Boolean))].slice(0, 3) : [];
}

// Only exact, verified catalog or publisher identities select bundled artwork.
// These keys cannot cause a network request, and titles never select a logo.
const MCP_ARTWORK_KEYS = new Map([
  ['official:uk.co.0sand1s/cis', 'cis'],
  ['remote:https://0sand1s.co.uk/mcp', 'cis'],
  ['https://0sand1s.co.uk/mcp', 'cis'],
  ['official:ai.0si/disclosures', 'disclosures'],
  ['official:com.3dtexel/mcp', 'texel'],
  ['awesome:gatyh/3dtexel-mcp', 'texel'],
  ['https://github.com/gatyh/3dtexel-mcp', 'texel'],
  ['awesome:4everland/4everland-hosting-mcp', 'hosting'],
  ['https://github.com/4everland/4everland-hosting-mcp', 'hosting'],
  ['official:ai.1325/mcp', 'business'],
  ['https://github.com/1325ai/1325ai', 'business'],
  ['smithery:gmail', 'gmail'],
  ['smithery:googlesheets', 'sheets'],
]);

export function mcpArtworkKey(catalogId, repository, endpoint) {
  return MCP_ARTWORK_KEYS.get(catalogId)
    ?? (typeof repository === 'string' ? MCP_ARTWORK_KEYS.get(repository.toLowerCase().replace(/\/$/, '')) : undefined)
    ?? MCP_ARTWORK_KEYS.get(endpoint);
}
