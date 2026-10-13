// Pure helpers for showing whether a hunter already has a Perpl key stored
// server-side, so the enroll page doesn't offer "Create key" as if they had none.

export type PerpKeyStatus = { stored: boolean; createdAt: string | null };

export function parsePerpKeyStatus(json: unknown): PerpKeyStatus {
  if (!json || typeof json !== "object") return { stored: false, createdAt: null };
  const o = json as Record<string, unknown>;
  const stored = o.stored === true;
  const raw = typeof o.createdAt === "string" ? o.createdAt : null;
  const valid = raw !== null && !Number.isNaN(Date.parse(raw));
  return { stored, createdAt: stored && valid ? raw : null };
}

export function perpKeyCreatedLabel(
  createdAt: string | Date | null | undefined,
  locale: "en" | "es",
): string {
  const base = locale === "es" ? "Clave de Perpl ya creada" : "Perpl key already created";
  if (createdAt == null) return base;
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(d.getTime())) return base;
  let date: string;
  try {
    date = d.toLocaleDateString(locale === "es" ? "es-MX" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    date = d.toISOString().slice(0, 10);
  }
  return `${base} ${locale === "es" ? "el" : "on"} ${date}`;
}
