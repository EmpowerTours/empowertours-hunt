/**
 * Moving between a `datetime-local` input and the ISO string the API stores.
 *
 * Split out so the timezone arithmetic can be tested. A hunt's `endsAt` is the
 * control that retires it from a worldwide, un-geofenced hunt list, so an hour
 * in the wrong direction is not cosmetic — it either kills the hunt during the
 * event or leaves it live after everyone has gone home.
 *
 * The input speaks LOCAL time with no zone. The store speaks UTC.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO (UTC) -> what the picker shows, in the viewer's own timezone. */
export function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** What the picker returned -> ISO (UTC). Empty stays empty, not epoch. */
export function fromLocalInput(raw: string): string {
  if (!raw) return "";
  // `new Date("2026-10-06T21:00")` with no zone is parsed as LOCAL time, which
  // is the whole point: the operator picked 9pm on their own watch.
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

/** Today at a given local hour, as UTC. Used by the "Today 9pm" shortcut. */
export function todayAtLocalHour(hour: number, now = new Date()): string {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
