// lib/catalog-cache.js — what the market remembers between two reads.
//
// Two different questions live here, and conflating them is how a market either
// hammers its upstreams or shows last week's listing:
//
//   - "have I seen these exact bytes?" — one entry per URL, holding the
//     response's ETag and the body that ETag labels. The next read of that URL
//     sends `if-none-match`, and a 304 answer hands back these bytes instead of
//     re-downloading them. The five open catalogs are ~3MB together and the two
//     community READMEs are the bulk of it; they change a few times a day, so
//     almost every reread of them is a 304.
//   - "is this source's result still current?" — one entry per (source, query)
//     with a TTL. Inside the TTL the market does not ask at all: opening the tab
//     twice in a minute is one walk, not two.
//
// The two layers answer different halves of the same budget. The TTL bounds how
// often we *work*; the ETag bounds how much we *download* when the TTL says the
// work is due. Neither replaces the other: without the TTL a 60-second refresh
// loop would re-walk eight paginated endpoints and re-parse two READMEs; without
// the ETag the freshness the TTL allows would cost full bodies every minute.
//
// The host owns one instance and passes it into `browseCatalog`. Without one,
// the catalog modules behave exactly as they did before — the cache is an
// explicit argument rather than module state, so the tests keep calling pure
// functions with their own fake fetch and never inherit a neighbour's bytes.

/** How long a source's result may be reused before the market asks upstream again. */
export const DEFAULT_SOURCE_TTL_MS = 60 * 1000;

// Bounds on the byte store. The working set is small and known: one body per
// URL, ~9 URLs for the two community lists, the official registry's pages and
// the two JSON catalogs. The caps exist so a pathological answer (a mirror that
// streams a huge file, a source that grows to thousands of pages) cannot sit in
// memory forever.
const DEFAULT_MAX_URLS = 64;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Approximate size of a remembered body, in characters-per-byte units. */
function sizeOf(body) {
  if (typeof body === 'string') return body.length;
  try {
    return JSON.stringify(body ?? null)?.length ?? 0;
  } catch {
    // A body we cannot measure is a body we should not hold indefinitely: treat
    // it as if it were the whole budget so the eviction pass drops it.
    return DEFAULT_MAX_BYTES;
  }
}

/**
 * One cache for the market's HTTP reads.
 *
 * @param options.sourceTtlMs - reuse window for a whole source walk.
 * @param options.maxUrls - most bodies to hold at once (oldest evicted first).
 * @param options.maxBytes - most bytes to hold at once.
 * @param options.now - injectable clock (tests).
 */
export function createCatalogCache({
  sourceTtlMs = DEFAULT_SOURCE_TTL_MS,
  maxUrls = DEFAULT_MAX_URLS,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now,
} = {}) {
  const urls = new Map(); // url -> { etag, body, bytes, at, reused }
  const sources = new Map(); // 'source|query' -> { items, at, hits }
  const counters = { requests: 0, notModified: 0, downloaded: 0, saved: 0 };
  let heldBytes = 0;

  function evict() {
    while (urls.size > maxUrls || heldBytes > maxBytes) {
      let oldestKey;
      let oldestAt = Infinity;
      for (const [key, entry] of urls) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      heldBytes -= urls.get(oldestKey).bytes;
      urls.delete(oldestKey);
    }
  }

  return {
    sourceTtlMs,

    /** The validator to send as `if-none-match`, when we have one for this URL. */
    etagFor(url) {
      return urls.get(url)?.etag;
    },

    /** The body a 304 for this URL would stand for, or undefined. */
    rememberedBody(url) {
      return urls.get(url)?.body;
    },

    /** Count a request we are about to make (the panel reports what it cost). */
    noteRequest() {
      counters.requests += 1;
    },

    /** Count bytes handed back by a 200. */
    noteDownload(bytes) {
      counters.downloaded += bytes;
    },

    /** Remember a 200 answer: its validator (when the server sent one) and body. */
    remember(url, { etag, body, bytes = sizeOf(body) } = {}) {
      const previous = urls.get(url);
      if (previous) heldBytes -= previous.bytes;
      urls.delete(url); // re-insert so eviction sees a true least-recently-used order
      urls.set(url, {
        etag: typeof etag === 'string' && etag ? etag : undefined,
        body,
        bytes,
        at: now(),
        reused: previous?.reused ?? 0,
      });
      heldBytes += bytes;
      evict();
    },

    /**
     * Use the remembered body for a 304: it is served again, so it counts as
     * recently used, and what it saved is the point of the whole exercise.
     */
    reuse(url) {
      const entry = urls.get(url);
      if (entry === undefined) return undefined;
      entry.at = now();
      entry.reused += 1;
      counters.notModified += 1;
      counters.saved += entry.bytes;
      return entry.body;
    },

    /**
     * A source's remembered result. `fresh: true` (the normal read) refuses an
     * entry past the TTL; `fresh: false` (a failed walk) takes any age, because
     * yesterday's listing beats an empty market.
     */
    sourceResult(key, { fresh = true } = {}) {
      const entry = sources.get(key);
      if (entry === undefined) return undefined;
      if (fresh && now() - entry.at >= sourceTtlMs) return undefined;
      entry.hits += 1;
      return entry;
    },

    /** Remember one source walk's items. */
    storeSourceResult(key, { items, at = now() } = {}) {
      sources.set(key, { items, at, hits: 0 });
    },

    /**
     * Drop every remembered result of one source (all queries). Called when a
     * user removes a source: its rows must not come back from a TTL entry, and
     * they must not be reachable as the "stale" fallback of a source that is no
     * longer configured. The URL layer is left alone: it is keyed by address and
     * ages out on its own, and a removed address is simply never asked again.
     */
    forgetSourceId(id) {
      const prefix = `${id}|`;
      let dropped = 0;
      for (const key of [...sources.keys()]) {
        if (key.startsWith(prefix)) {
          sources.delete(key);
          dropped += 1;
        }
      }
      return dropped;
    },

    /** Counters for the panel and the exported log. */
    stats() {
      return { ...counters, urls: urls.size, bytesHeld: heldBytes, sources: sources.size };
    },
  };
}
