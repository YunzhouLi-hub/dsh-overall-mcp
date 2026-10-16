/**
 * HTTP status for an error thrown while serving one of the plugin's routes.
 *
 * The route guard used to answer `400` to every throw, which made three very
 * different things look identical to the caller: "no such server" (404), a
 * caller-side mistake (400) and the plugin or an upstream breaking (500/502).
 * The status is also what decides whether the guard writes a log line, so the
 * one failure a maintainer needs to see was the one that was silent.
 *
 * An explicit numeric `status` on the error wins — that is the seam for a
 * caller that knows better. Otherwise the message decides, and anything
 * unrecognised is a 500: it means we did not anticipate this path, which is
 * exactly what a 500 says.
 */
export function httpStatusFor(err) {
  const explicit = Number(err?.status);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;

  const message = String(err?.message ?? err ?? '');

  // Lookups: the route is fine, the thing it names is not there.
  if (/^unknown (server|source)\b/.test(message)) return 404;

  // The caller's own payload cannot be acted on: a missing key, an item with no
  // installable transport, or an entry that has no package to update.
  if (/^(item|key|name|source|enabled)\b[\s\S]*\brequired\b/.test(message)) return 400;
  // …or it is there and unusable: `on: "yes"` where a boolean decides which way
  // a toggle goes. Same blame, same status — the value never reached any state
  // we could act on. (Distinct from the required case, which is about absence.)
  if (/\bmust be a boolean\b/.test(message)) return 400;
  if (/\bno installable transport\b/.test(message)) return 400;
  if (/\bis not launched through a package runner\b/.test(message)) return 400;
  // …or it names a verb outside the set the route accepts (`action: "stats"`).
  // This is the mirror image of the lookup rule above: the route exists and the
  // value is what is wrong, so the blame is the caller's, not the map's.
  if (/^unknown \w+ action\b/.test(message)) return 400;

  // A race the panel can retry, not a plugin fault: the row was removed or
  // re-scanned between the render and the click, so the name is ambiguous or the
  // row the request named is gone. Reported as 500 (and logged as a plugin
  // fault) before this, which sent the maintainer after a bug that is not one.
  if (/^ambiguous server name\b/.test(message)) return 409;
  if (/^stale entry\b/.test(message)) return 409;
  // A conflict with state the caller did not see — the name is already owned by
  // a hand-added record, so the install is refused instead of replacing it.
  if (/^manual entry\b/.test(message)) return 409;

  // A third party (the npm/PyPI registry) failed while answering us.
  if (/^version lookup failed\b/.test(message)) return 502;

  return 500;
}
