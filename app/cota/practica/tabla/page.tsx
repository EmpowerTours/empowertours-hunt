"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button, Note, Panel, Stat } from "@/components/ui/primitives";
import { LanguageSwitch } from "@/components/hunt/LanguageSwitch";

// ---------------------------------------------------------------------------
// The Cota Práctica weekly board. Points per match, not total; aliases, never
// wallets; and only players who chose to be listed. See lib/mercado/board.ts.
// ---------------------------------------------------------------------------

type Lang = "es" | "en";

interface Row {
  rank: number;
  alias: string;
  avg: number;
  matches: number;
  wins: number;
  mine: boolean;
}
interface Payload {
  weekStart: number;
  board: Row[];
  me: {
    avg: number;
    matches: number;
    wins: number;
    qualifies: boolean;
  } | null;
  profile: { alias: string; listed: boolean } | null;
}

const T = {
  es: {
    back: "Práctica",
    title: "Tabla semanal",
    lede: "Por puntos promedio por partida, no por cuántas juegas. Mínimo 3 partidas terminadas. Se reinicia cada lunes 00:00 (CDMX).",
    since: "Desde",
    empty: "Nadie ha calificado esta semana todavía.",
    you: "Tu semana",
    ret: "Promedio",
    crossings: "Partidas",
    escapes: "Ganadas",
    notYet: (n: number) => `Te faltan ${n} partidas para calificar.`,
    alias: "Tu alias público",
    aliasHelp: "3 a 16 letras, números o _. Nunca mostramos tu cartera.",
    listed: "Aparecer en la tabla",
    save: "Guardar",
    saved: "Guardado.",
    taken: "Ese alias ya está tomado.",
    bad: "Alias inválido.",
    hit: "ganadas",
  },
  en: {
    back: "Practice",
    title: "Weekly board",
    lede: "By average points per match, not by how many you play. 3 finished matches to qualify. Resets Monday 00:00 (Mexico City).",
    since: "Since",
    empty: "Nobody has qualified this week yet.",
    you: "Your week",
    ret: "Average",
    crossings: "Matches",
    escapes: "Won",
    notYet: (n: number) => `${n} more matches to qualify.`,
    alias: "Your public alias",
    aliasHelp: "3–16 letters, digits or _. We never show your wallet.",
    listed: "Show me on the board",
    save: "Save",
    saved: "Saved.",
    taken: "That alias is taken.",
    bad: "Invalid alias.",
    hit: "won",
  },
} as const;

/** Points are tenths of a basis point; shown as points with one decimal. */
const pts = (x: number) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x / 10).toFixed(1)}`;

export default function MercadoBoardPage() {
  const locale = useLocale();
  const lang: Lang = locale === "en" ? "en" : "es";
  const t = T[lang];
  const [data, setData] = useState<Payload | null>(null);
  const [alias, setAlias] = useState("");
  const [listed, setListed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/mercado/tabla", {
      cache: "no-store",
    }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as Payload;
    setData(j);
    if (j.profile) {
      setAlias((a) => a || j.profile!.alias);
      setListed(j.profile.listed);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const save = async () => {
    setMsg(null);
    const r = await fetch("/api/mercado/tabla", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias, listed }),
    });
    setMsg(r.ok ? t.saved : r.status === 409 ? t.taken : t.bad);
    if (r.ok) void load();
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="flex gap-4">
          <a href="/cota/practica" className="text-ink-dim font-mono text-xs">
            ← {t.back}
          </a>
          <a href="/cota" className="text-ink-faint font-mono text-xs">
            Cota
          </a>
        </span>
        <LanguageSwitch />
      </div>
      <h1 className="text-spawn text-3xl font-black">{t.title}</h1>
      <p className="text-ink-dim mt-2 text-sm">{t.lede}</p>
      {data ? (
        <p className="text-ink-faint mt-1 font-mono text-xs">
          {t.since}{" "}
          {new Date(data.weekStart).toLocaleString(
            lang === "es" ? "es-MX" : "en-GB",
            {
              timeZone: "America/Mexico_City",
              dateStyle: "medium",
              timeStyle: "short",
            },
          )}
        </p>
      ) : null}

      {data?.me ? (
        <div className="mt-4">
          <h2 className="text-ink mb-2 text-lg font-semibold">{t.you}</h2>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label={t.ret}
              value={pts(data.me.avg)}
              tone={data.me.avg >= 0 ? "credit" : "warn"}
            />
            <Stat label={t.crossings} value={String(data.me.matches)} />
            <Stat label={t.escapes} value={String(data.me.wins)} />
          </div>
          {!data.me.qualifies ? (
            <p className="text-ink-faint mt-2 text-xs">
              {t.notYet(3 - data.me.matches)}
            </p>
          ) : null}
        </div>
      ) : null}

      <Panel className="mt-4">
        {!data || data.board.length === 0 ? (
          <p className="text-ink-faint text-sm">{t.empty}</p>
        ) : (
          <ol className="grid gap-1">
            {data.board.map((r) => (
              <li
                key={r.rank}
                className={`grid grid-cols-[2.5rem_1fr_auto] items-center gap-2 rounded-lg px-2 py-2 font-mono text-sm ${r.mine ? "bg-hull-2 text-phosphor" : "text-ink"}`}
              >
                <span className="text-ink-dim">#{r.rank}</span>
                <span className="truncate">{r.alias}</span>
                <span className="text-right">
                  <span className={r.avg >= 0 ? "text-phosphor" : "text-alert"}>
                    {pts(r.avg)}
                  </span>
                  <span className="text-ink-faint block text-[11px]">
                    {r.wins}/{r.matches} {t.hit}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      {data && data.me !== undefined ? (
        <Panel className="mt-4">
          <label
            className="text-ink block text-sm font-semibold"
            htmlFor="alias"
          >
            {t.alias}
          </label>
          <input
            id="alias"
            value={alias}
            maxLength={16}
            onChange={(e) => setAlias(e.target.value)}
            className="border-hull-line bg-hull-2 text-ink mt-2 w-full rounded-xl border px-3 py-2 font-mono"
          />
          <p className="text-ink-faint mt-1 text-xs">{t.aliasHelp}</p>
          <label
            className="text-ink mt-3 flex items-center gap-2 text-sm"
            htmlFor="listed"
          >
            <input
              id="listed"
              type="checkbox"
              checked={listed}
              onChange={(e) => setListed(e.target.checked)}
            />
            {t.listed}
          </label>
          <div className="mt-3">
            <Button onClick={() => void save()}>{t.save}</Button>
          </div>
          {msg ? (
            <div className="mt-2">
              <Note tone={msg === t.saved ? "success" : "warn"}>{msg}</Note>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </main>
  );
}
