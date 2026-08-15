// Pagination for every admin list.
//
// ClaimAttempt, HintRequest and CreditLedger all grow without bound — one busy
// hunt day is tens of thousands of attempt rows. An unpaginated `findMany` on
// any of them is a query that works fine in staging and takes the console down
// in production, so `take` is clamped here and there is no "all" option.

export interface PageSpec {
  page: number;
  take: number;
  skip: number;
}

const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

/**
 * Read `?page=` and `?take=` off a resolved searchParams object.
 *
 * Written as `!(valid)` rather than `(invalid)` so a NaN from a junk query
 * string falls back to the default instead of reaching Prisma as `skip: NaN`.
 */
export function parsePage(
  searchParams: Record<string, string | string[] | undefined>,
  defaultTake = DEFAULT_TAKE,
): PageSpec {
  const rawPage = first(searchParams.page);
  const rawTake = first(searchParams.take);

  const pageNum = Number(rawPage);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1;

  const takeNum = Number(rawTake);
  const take =
    Number.isInteger(takeNum) && takeNum >= 1 && takeNum <= MAX_TAKE
      ? takeNum
      : defaultTake;

  return { page, take, skip: (page - 1) * take };
}

export function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Build a `?page=n` href preserving the rest of the current query. */
export function pageHref(
  base: string,
  searchParams: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (k === "page") continue;
    const value = first(v);
    if (value !== undefined && value !== "") params.set(k, value);
  }
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
