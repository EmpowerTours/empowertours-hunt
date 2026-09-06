import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/cota/enroll/submit — step 2 of Perpl enrolment, proxied.
//
// The browser has both signatures (wallet + Ed25519 proof-of-possession); this
// route forwards them to /v1/api-key/enroll with our whitelisted origin and
// returns the venue's response. The response carries the api-key token, which
// flows straight back to the browser and is saved on the device — this route
// does NOT persist it, and never sees the Ed25519 private key at all (that stays
// in the browser). Hunt remains the verifier, not the key-holder.
//
// The request body is the exact shape Perpl expects:
//   { chain_id, address, typed_data, mac, signature, pop_signature }
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
    resp = await fetch(`${perplApiUrl()}/v1/api-key/enroll`, {
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
    return NextResponse.json(
      {
        error: `venue refused enrolment (${resp.status})`,
        detail: text.slice(0, 500),
      },
      { status: resp.status },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "venue returned non-json enrolment response" },
      { status: 502 },
    );
  }

  // Pass through verbatim. The browser reads the api-key token and terms echo,
  // and saves the credential on the device. Nothing is stored here.
  return NextResponse.json(parsed);
}
