"use client";

// One place where admin mutations leave the browser.
//
// Every call is same-origin and relies on the SameSite=Strict session cookie.
// The server re-checks the role on every one of these, so a hidden button is
// never the thing standing between a VIEWER and an approval.

export interface ApiFailure {
  ok: false;
  error: string;
}
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export async function adminPost<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const message =
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `request failed (${res.status})`;
      return { ok: false, error: message };
    }
    return { ok: true, data: (parsed ?? {}) as T };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "network error",
    };
  }
}
