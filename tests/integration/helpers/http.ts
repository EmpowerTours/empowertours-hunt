import "./env";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { issueSession, SESSION_COOKIE } from "@/lib/auth/mera";
import { HUNT_DOMAIN, CLAIM_ATTEMPT_TYPES } from "@/lib/auth/eip712";
import type { TestPlayer } from "./factories";

/**
 * Build the request a real client would send: session cookie, EIP-712
 * signature over the exact intent, and a fresh single-use nonce.
 *
 * Nothing here reimplements a check. It produces a genuinely valid request so
 * the route's own auth, its own signature verification and its own nonce store
 * all run — a test that stubbed those out would be proving the ceilings hold
 * for requests that could never arrive.
 */
export async function signedRequest(args: {
  url: string;
  actor: TestPlayer;
  huntId: string;
  lat: number;
  lng: number;
  accuracyM: number;
  /** Extra body fields — spawnId for a collect, cacheId for a claim. */
  body?: Record<string, unknown>;
  /**
   * Rate-limit bucket. Distinct values keep concurrent actors out of each
   * other's per-IP quota, which would otherwise refuse requests for a reason
   * that has nothing to do with what is being tested.
   */
  ip?: string;
  clientTsSeconds?: number;
}): Promise<Request> {
  const lat = args.lat.toString();
  const lng = args.lng.toString();
  const accuracyM = args.accuracyM.toString();
  const clientTs = BigInt(
    args.clientTsSeconds ?? Math.floor(Date.now() / 1000),
  );
  const nonce = randomBytes(16).toString("base64url");

  const account = privateKeyToAccount(args.actor.privateKey);
  const signature = await account.signTypedData({
    domain: HUNT_DOMAIN,
    types: CLAIM_ATTEMPT_TYPES,
    primaryType: "ClaimAttempt",
    message: { huntId: args.huntId, lat, lng, accuracyM, clientTs, nonce },
  });

  return new Request(args.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${issueSession(args.actor.address)}`,
      "x-forwarded-for": args.ip ?? "127.0.0.1",
    },
    body: JSON.stringify({
      ...args.body,
      lat,
      lng,
      accuracyM,
      clientTs: Number(clientTs),
      nonce,
      signature,
    }),
  });
}

/** Next's `params` are a promise in the App Router. */
export function routeCtx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}
