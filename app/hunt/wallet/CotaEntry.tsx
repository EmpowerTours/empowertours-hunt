"use client";

import { useLocale } from "next-intl";
import { LinkButton, Panel } from "@/components/ui/primitives";

// ---------------------------------------------------------------------------
// The doorway from Hunt into Cota.
//
// Without this card, Cota is unreachable from the game — you'd have to know the
// URL. This is the one link that turns "Hunt and Cota both exist" into the
// funnel: it sits on the wallet screen, the moment a player looks at the MON
// they just earned and asks "now what?".
//
// Spanish first (the audience is Guerrero), and honest about the gate: practice
// is free for everyone, live needs AUSD — so the card never promises a hunter
// with only MON something they can't do yet.
// ---------------------------------------------------------------------------

const T = {
  es: {
    eyebrow: "Siguiente paso",
    title: "Pon tu MON a trabajar",
    body: "Opera con una correa que tú pones: marcas el límite y un agente no lo puede cruzar. Practica gratis, sin arriesgar nada.",
    note: "Práctica: gratis para todos. En vivo: necesitas AUSD.",
    cta: "Abrir Cota",
  },
  en: {
    eyebrow: "Next step",
    title: "Put your MON to work",
    body: "Trade with a leash you set: you draw the limit and an agent can't cross it. Practice free, risk nothing.",
    note: "Practice: free for everyone. Live: needs AUSD.",
    cta: "Open Cota",
  },
} as const;

export function CotaEntry() {
  const t = T[useLocale() === "es" ? "es" : "en"];
  return (
    <Panel className="border-phosphor/40">
      <div className="text-phosphor font-mono text-[11px] tracking-[0.24em] uppercase">
        {t.eyebrow}
      </div>
      <h2 className="text-ink mt-1 text-lg font-bold">{t.title}</h2>
      <p className="text-ink-dim mt-1 text-sm leading-snug">{t.body}</p>
      <p className="text-ink-faint mt-2 text-xs">{t.note}</p>
      <div className="mt-3">
        <LinkButton href="/cota" tone="primary">
          {t.cta}
        </LinkButton>
      </div>
    </Panel>
  );
}
