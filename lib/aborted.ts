/**
 * Did this failure just mean "the client went away"?
 *
 * A browser aborting a fetch is normal and constant here: every scan tick,
 * every unmounted screen and every navigation cancels an in-flight request via
 * AbortController. Node surfaces that as `ECONNRESET` / "aborted", which looks
 * exactly like a server fault in the logs.
 *
 * Logging it as an error is not harmless. Railway's log view fills with
 * [checkin] and [hunt/hint] failures that nobody caused and nobody can fix,
 * and the one real stack trace that matters is somewhere underneath them.
 * A log nobody trusts is a log nobody reads.
 */
export function isClientAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "ECONNRESET" || e.code === "ABORT_ERR") return true;
  return typeof e.message === "string" && e.message.toLowerCase() === "aborted";
}
