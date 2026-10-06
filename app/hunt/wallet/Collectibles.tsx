"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/ui/primitives";
import type { Collectible } from "@/lib/hunt/collectibles";

/**
 * NFTs the chain says this wallet holds.
 *
 * Renders nothing at all when there are none. A hunter with no NFTs should not
 * be shown an empty shelf captioned "NFTs" — it reads as something missing
 * rather than something not yet earned.
 */
export function Collectibles() {
  const [items, setItems] = useState<Collectible[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/hunt/collectibles", {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items?: Collectible[] }) => setItems(d.items ?? []))
      .catch(() => {
        // Signed out, offline, or the scan failed. Silence is right: this
        // panel is additive and must never push the balance down the page
        // with an error about something nobody asked for.
      });
    return () => controller.abort();
  }, []);

  if (items === null || items.length === 0) return null;

  return (
    <Panel className="space-y-3">
      <p className="text-ink-dim font-mono text-[11px] tracking-[0.18em] uppercase">
        Collected
      </p>
      <ul className="grid grid-cols-2 gap-3">
        {items.map((item) => (
          <li
            key={`${item.contract}-${item.tokenId}`}
            className="border-hull-line overflow-hidden rounded-xl border"
          >
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image}
                alt={item.name ?? `${item.collection} #${item.tokenId}`}
                className="aspect-square w-full bg-black/40 object-cover"
                loading="lazy"
              />
            ) : (
              <div className="text-ink-faint flex aspect-square w-full items-center justify-center bg-black/40 font-mono text-xs">
                #{item.tokenId}
              </div>
            )}
            <div className="p-2">
              <p className="text-ink truncate text-xs font-semibold">
                {item.name ?? `#${item.tokenId}`}
              </p>
              <p className="text-ink-faint truncate font-mono text-[11px]">
                {item.collection}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
