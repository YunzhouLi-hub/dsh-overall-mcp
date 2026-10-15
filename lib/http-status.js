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

  // Lookups: the route is fine, the thing it names is not there. A submission id
  // goes stale the same way a server name does — someone else reviewed it while
  // this panel still showed it as pending.
  if (/^unknown (server|source|submission)\b/.test(message)) return 404;

  // The caller's own payload cannot be acted on: a missing key, an item with no
  // installable transport, or an entry that has no package to update.
  if (/^(item|key|name|source|enabled)\b[\s\S]*\brequired\b/.test(message)) return 400;
  if (/\bno installable transport\b/.test(message)) return 400;
  if (/\bis not launched through a package runner\b/.test(message)) return 400;
  // A submission the reviewer cannot act on: a missing name or link, a link that
  // is not an http(s) URL, a file over the size cap, or a name that cannot become
  // a server name.
  if (/^invalid submission\b/.test(message)) return 400;

  // A race the panel can retry, not a plugin fault: the row was removed or
  // re-scanned between the render and the click, so the name is ambiguous or the
  // row the request named is gone. Reported as 500 (and logged as a plugin
  // fault) before this, which sent the maintainer after a bug that is not one.
  if (/^ambiguous server name\b/.test(message)) return 409;
  if (/^stale entry\b/.test(message)) return 409;
  // A conflict with state the caller did not see — the name is already owned by
  // a hand-added record, so the install is refused instead of replacing it.
  if (/^manual entry\b/.test(message)) return 409;
  // Approving a submission under a name the registry already uses: a second row
  // would make every name-keyed action ambiguous, so it needs an explicit
  // rename or `overwrite`.
  if (/^duplicate contribution name\b/.test(message)) return 409;
  // The row exists only to carry a name and a link; there is nothing to mount.
  if (/^display-only entry\b/.test(message)) return 409;

  // A third party (the npm/PyPI registry) failed while answering us.
  if (/^version lookup failed\b/.test(message)) return 502;

  return 500;
}
