// Route-handler plumbing shared by every /api/admin endpoint.
//
// Two things it enforces:
//   * a single error shape, so a route never leaks a stack trace or a Prisma
//     message (which can echo column values) to the browser;
//   * a single place where an unexpected throw becomes a 500 with nothing in
//     the body but a generic string.
//
// Cache `lat`/`lng` are allowed in admin responses ONLY from the cache
// management endpoints, which are OPERATOR-gated. Nothing here serialises a
// model automatically, precisely so that inclusion is always a deliberate act.

import { NextResponse } from "next/server";
import { AdminAuthError } from "@/lib/admin/auth";

export function jsonOk<T extends object>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** A field-level validation failure the operator can act on. */
export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminInputError";
  }
}

/** A refused state transition. 409, because the row moved under the operator. */
export class AdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConflictError";
  }
}

export function adminErrorResponse(e: unknown): NextResponse {
  if (e instanceof AdminAuthError) return jsonError(e.message, e.status);
  if (e instanceof AdminInputError) return jsonError(e.message, 400);
  if (e instanceof AdminConflictError) return jsonError(e.message, 409);
  console.error("[admin-api] unhandled error", e);
  return jsonError("internal error", 500);
}

/** Parse a JSON body, refusing anything that is not a plain object. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new AdminInputError("body must be JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminInputError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const raw = body[field];
  if (typeof raw !== "string")
    throw new AdminInputError(`${field} is required`);
  const value = raw.trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? 500;
  if (value.length < min) {
    throw new AdminInputError(`${field} must be at least ${min} characters`);
  }
  if (value.length > max) {
    throw new AdminInputError(`${field} must be at most ${max} characters`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  max = 500,
): string | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string")
    throw new AdminInputError(`${field} must be a string`);
  const value = raw.trim();
  if (value.length > max) {
    throw new AdminInputError(`${field} must be at most ${max} characters`);
  }
  return value;
}

export function optionalBool(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean")
    throw new AdminInputError(`${field} must be a boolean`);
  return raw;
}

/**
 * Bounded integer. Written as `!(in range)` rather than `(out of range)` so a
 * NaN — which fails every comparison — is rejected instead of slipping past.
 */
export function optionalInt(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!(Number.isInteger(value) && value >= min && value <= max)) {
    throw new AdminInputError(
      `${field} must be a whole number between ${min} and ${max}`,
    );
  }
  return value;
}

/** Latitude / longitude. Same negative-form guard: NaN must not pass. */
export function requireLatLng(
  body: Record<string, unknown>,
  field: "lat" | "lng",
): number {
  const raw = body[field];
  const value = typeof raw === "number" ? raw : Number(raw);
  const bound = field === "lat" ? 90 : 180;
  if (!(Number.isFinite(value) && value >= -bound && value <= bound)) {
    throw new AdminInputError(
      `${field} must be a number between -${bound} and ${bound}`,
    );
  }
  return value;
}
