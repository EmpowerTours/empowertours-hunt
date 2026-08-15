"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, fetchHunts } from "@/components/hunt/client";
import type { PublicHunt } from "@/components/hunt/types";
import { Note } from "@/components/ui/primitives";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; hunts: PublicHunt[] }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function HuntList() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHunts(controller.signal)
      .then((hunts) => setState({ kind: "ready", hunts }))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.notImplemented) {
          setState({ kind: "missing" });
          return;
        }
        if (e instanceof ApiError && e.status === 401) {
          setState({ kind: "error", message: "Sign in to see live hunts." });
          return;
        }
        setState({
          kind: "error",
          message:
            e instanceof ApiError ? e.message : "Could not reach the server.",
        });
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="border-hull-line bg-hull text-ink-dim rounded-2xl border p-4 font-mono text-sm">
        Scanning…
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <Note title="Hunt list not built">
        <code className="font-mono">GET /api/hunts</code> does not exist yet.
        Open a hunt directly at{" "}
        <code className="font-mono">/hunt/&lt;huntId&gt;</code> — the scope
        works without this list.
      </Note>
    );
  }

  if (state.kind === "error") {
    return (
      <Note tone="warn" title="Could not load hunts">
        {state.message}
      </Note>
    );
  }

  if (state.hunts.length === 0) {
    return (
      <Note title="No hunts running">
        Nothing is live right now. Check back — hunts open and close on a
        schedule.
      </Note>
    );
  }

  return (
    <ul className="space-y-3">
      {state.hunts.map((hunt) => (
        <li key={hunt.id}>
          <Link
            href={`/hunt/${hunt.id}`}
            className="border-hull-line bg-hull active:bg-hull-2 block rounded-2xl border p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink text-lg font-semibold">
                {hunt.name}
              </span>
              <span
                className={`shrink-0 font-mono text-[11px] tracking-[0.18em] uppercase ${
                  hunt.active ? "text-phosphor" : "text-ink-faint"
                }`}
              >
                {hunt.active ? "Live" : "Closed"}
              </span>
            </div>
            {hunt.description ? (
              <p className="text-ink-dim mt-1 text-sm leading-snug">
                {hunt.description}
              </p>
            ) : null}
            <div className="text-ink-faint mt-2 font-mono text-xs">
              ±{hunt.maxAccuracyM} m required
              {hunt.spawnEnabled ? " · spawns on" : ""}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
