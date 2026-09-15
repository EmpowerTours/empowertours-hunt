// The answer a POST-only Cota route gives a browser address bar.
//
// Typing one of these URLs into a browser sends a GET. Next.js answers an
// unhandled method with a 405 that has an EMPTY body and no Content-Type, and
// with `x-content-type-options: nosniff` set the browser has nothing it is
// allowed to render — so it offers to save the response as a file. A hunter
// trying to reconcile a position gets a download and no explanation.
//
// So each POST-only route answers GET itself, and says where the decision
// actually gets made. It must NEVER do the work: these routes place orders and
// adopt positions, and a GET is a link, a prefetch, a preview crawler or a
// pasted URL — never a person deciding. Gate on the method, not on who seems to
// be asking.

import { NextResponse } from "next/server";

/**
 * A 405 that explains itself, with the `Allow` header a 405 is supposed to
 * carry. `hint` names where the action is really taken.
 */
export function postOnlyResponse(path: string, hint: string): NextResponse {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      detail: `${path} accepts POST only. ${hint}`,
      allow: ["POST"],
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
