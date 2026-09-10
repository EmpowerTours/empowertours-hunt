import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { hasPerpKey, storePerpKey } from "@/lib/cota/keystore";

// ---------------------------------------------------------------------------
// POST /api/cota/perp-key — a hunter hands their enrolled Perpl trading key to
// the server so the Cota agent can execute bounded trades for them. The key is
// sealed at rest (lib/cota/keystore.ts) and can only ever TRADE, never withdraw
// (Perpl enforces), with every order leash-gated + anchored.
//
// GET — whether this player already has a key stored (for the UI to show state
// without ever returning the key itself; it never leaves the server after this).
// ---------------------------------------------------------------------------

const Input = z.object({
  // The opaque X-API-Key token from /v1/api-key/enroll.
  apiKey: z.string().min(8).max(1024),
  // The Ed25519 signing secret, hex (opaque to us; the keystore seals it).
  secretHex: z.string().regex(/^(0x)?[0-9a-fA-F]{32,256}$/),
  // The Perpl account / wallet address the key trades for.
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export async function POST(req: Request) {
  try {
    const player = await requirePlayer(req);
    const parsed = Input.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    await storePerpKey(player.id, {
      apiKey: parsed.data.apiKey,
      secretHex: parsed.data.secretHex,
      account: parsed.data.account.toLowerCase(),
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    // A missing COTA_KEY_ENC_SECRET throws here by design — surface it as a
    // server error rather than storing under a weak/absent secret.
    console.error("[cota/perp-key] store failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    return NextResponse.json({ stored: await hasPerpKey(player.id) });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/perp-key] status failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
