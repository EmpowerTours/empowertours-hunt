/**
 * What a half-typed number box should commit.
 *
 * Split out of the input component so the rule can be tested without a DOM:
 * the bug was never in the rendering, it was in treating an empty box as a
 * number. `Number("")` is 0, so a controlled `value={number}` re-rendered a
 * cleared field as "0" and the next keystroke appended to it — typing 40 over
 * a cleared box produced "040". Every number field on the hunt settings form
 * had it.
 *
 * Returns the number to commit, or null to leave the committed value alone.
 */
export function commitNumberDraft(raw: string): number | null {
  // An empty box is someone mid-edit, not a zero. This is the whole fix.
  if (raw.trim() === "") return null;
  const parsed = Number(raw);
  // Rejects "abc" (NaN) and "1e999" (Infinity). A type="number" box can still
  // hand us "e" and "-" on the way to a real number.
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}
