import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requirePlayer } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";

// ---------------------------------------------------------------------------
// GET/PUT /api/cota/note — a hunter's private note about one leash.
//
// This route handles ciphertext it cannot read, and that is the entire feature.
// It validates SHAPE — base64, sane length, a digest that looks like a digest —
// and nothing else, because there is nothing else it could check. It cannot tell
// an encrypted note from encrypted noise, and it should not be able to.
//
// That constrains what it may do, in ways worth naming:
//   - No search, no filtering, no sorting by content. There is no content here.
//   - No server-side validation of what a hunter wrote. No length limit on the
//     plaintext, only on the blob, because the two differ by padding we cannot
//     see through.
//   - No migration that "fixes" a note. A schema change that needed to rewrite
//     one would be a schema change that cannot be performed, and that is a
//     property to design around rather than discover.
//
// Scoped to the caller by playerId at the query. The digest comes from the
// client, but it is only ever used ALONGSIDE playerId, so naming somebody else's
// leash returns nothing rather than theirs.
// ---------------------------------------------------------------------------

/** Generous: GCM ciphertext is base64 of plaintext + 16-byte tag. ~48KB of text. */
const MAX_CIPHERTEXT = 65_536;

const Put = z.object({
  digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  // 12-byte IV, base64 — exactly 16 characters.
  iv: z.string().regex(/^[A-Za-z0-9+/]{16}={0,2}$/),
  ciphertext: z
    .string()
    .min(1)
    .max(MAX_CIPHERTEXT)
    .regex(/^[A-Za-z0-9+/=]+$/),
});

export async function GET(req: Request) {
  try {
    const player = await requirePlayer(req);
    const digest = new URL(req.url).searchParams.get("digest");
    if (!digest) {
      return NextResponse.json({ error: "digest required" }, { status: 400 });
    }
    const note = await prisma.cotaNote.findUnique({
      where: {
        playerId_cotaDigest: { playerId: player.id, cotaDigest: digest },
      },
      select: { iv: true, ciphertext: true, updatedAt: true },
    });
    return NextResponse.json({ note });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/note] read failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const player = await requirePlayer(req);
    const parsed = Put.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const { digest, iv, ciphertext } = parsed.data;

    // The leash must be the caller's. Not because the note reveals anything —
    // it cannot — but because letting anyone attach storage to any digest turns
    // this into a free write-anywhere blob store.
    const owns = await prisma.cota.findFirst({
      where: { digest, playerId: player.id },
      select: { id: true },
    });
    if (!owns) {
      return NextResponse.json({ error: "no such leash" }, { status: 404 });
    }

    const saved = await prisma.cotaNote.upsert({
      where: {
        playerId_cotaDigest: { playerId: player.id, cotaDigest: digest },
      },
      create: { playerId: player.id, cotaDigest: digest, iv, ciphertext },
      update: { iv, ciphertext },
      select: { updatedAt: true },
    });
    return NextResponse.json({ updatedAt: saved.updatedAt });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/note] write failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const player = await requirePlayer(req);
    const digest = new URL(req.url).searchParams.get("digest");
    if (!digest) {
      return NextResponse.json({ error: "digest required" }, { status: 400 });
    }
    // deleteMany, not delete: a missing row is the state the caller asked for,
    // and erroring on it would make "clear my note" fail for someone who has
    // already cleared it.
    await prisma.cotaNote.deleteMany({
      where: { playerId: player.id, cotaDigest: digest },
    });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: "sign in first" }, { status: 401 });
    }
    console.error("[cota/note] delete failed", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
