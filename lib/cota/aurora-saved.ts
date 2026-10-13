// Which saved Aurora deposit address to hand back when a hunter asks for one.
//
// The default destination asset moved from USDC to MON (37b7199). Hunters who
// were issued a USDC address before that still have it, and it still works —
// asking Aurora for a second (MON) one is both unnecessary and, for keys
// without persistent-address creation enabled, a 403. So: prefer the asset
// asked for, then USDC, then whatever exists. Pure, so it is testable.

export interface SavedAddressLike {
  destinationAsset: string;
  recipient: string;
}

export function pickSavedAddress<T extends SavedAddressLike>(
  rows: readonly T[],
  requestedAsset: string,
  recipient?: string,
): T | null {
  const usable =
    recipient === undefined
      ? rows
      : rows.filter((r) => r.recipient === recipient);
  return (
    usable.find((r) => r.destinationAsset === requestedAsset) ??
    usable.find((r) => r.destinationAsset === "USDC") ??
    usable[0] ??
    null
  );
}

/** Where to swap what this address delivers into AUSD. */
export function swapHrefFor(asset: string | undefined): string {
  return asset === "USDC" ? "/cota/swap/usdc" : "/cota/swap";
}
