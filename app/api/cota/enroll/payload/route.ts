import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/cota/enroll/payload — step 1 of Perpl enrolment, proxied.
//
// Why a proxy at all: Perpl embeds the requesting *origin* inside the payload
// the user signs, and only origins whitelisted for our builder are accepted.
// The browser cannot set the Origin header to our registered value, so this
// route makes the server-to-server call with PERPL_ORIGIN and hands the payload
// back. It stores NOTHING — Hunt stays the verifier, never the key-holder. The
// browser re-checks the payload against its own terms before signing.
//
// The request body is the exact snake_case shape Perpl's /v1/api-key/payload
// expects (see toPayloadRequest in lib/cota/enroll.ts); we forward it verbatim.
// ---------------------------------------------------------------------------

function perplApiUrl(): string {
  return process.env.PERPL_API_URL ?? "https://app.perpl.xyz/api";
}

export async function POST(req: Request) {
  const origin = process.env.PERPL_ORIGIN;
  if (!origin) {
    return NextResponse.json(
      { error: "enrolment is not configured on this deployment" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  let resp: Response;
  try {
    resp = await fetch(`${perplApiUrl()}/v1/api-key/payload`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  } catch {
    return NextResponse.json(
      { error: "could not reach the venue" },
      { status: 502 },
    );
  }

  const text = await resp.text();
  if (!resp.ok) {
    // Pass the venue's own words through — "origin not whitelisted",
    // "builder code not registered" are all actionable and not secret.
    return NextResponse.json(
      {
        error: `venue refused payload (${resp.status})`,
        detail: text.slice(0, 500),
      },
      { status: resp.status },
    );
  }

  let parsed: { typed_data?: unknown; mac?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "venue returned non-json payload" },
      { status: 502 },
    );
  }
  if (!parsed.typed_data || !parsed.mac) {
    return NextResponse.json(
      { error: "payload response missing typed_data/mac" },
      { status: 502 },
    );
  }

  // Return the origin we used so the browser can verify message.origin against
  // it before prompting the wallet.
  return NextResponse.json({
    typed_data: parsed.typed_data,
    mac: parsed.mac,
    origin,
  });
}
