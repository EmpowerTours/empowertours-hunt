// The Cota agent's scheduler, as a Chainlink CRE workflow.
//
// The agent is a poll: /api/cota/agent/run does one pass over every leash
// carrying an autonomy grant and returns. Something has to call it on a clock,
// and both of the things currently doing so are weak in ways that matter.
// GitHub's scheduled workflows are routinely five to twenty minutes late. The
// fallback is a cron on a 2014 Mac mini on home Wi-Fi that already reports
// `degraded`. Neither is a dependency an autonomous trading agent should have.
//
// A CRE workflow replaces both with a DON: the schedule is executed by a
// decentralised network rather than one machine or one vendor's free tier.
//
// ## THE HAZARD THIS FILE IS MOSTLY ABOUT
//
// Every node in the DON executes the HTTP request. Chainlink's own docs say so
// plainly: "By default, all nodes in the DON execute HTTP requests. For
// non-idempotent operations (POST, PUT, PATCH, DELETE), this can lead to
// duplicate resources, actions, or unintended side effects."
//
// Our POST is about as non-idempotent as a request gets — it can place an order.
// A ten-node DON calling it naively is ten agent runs, and the failure that
// produces is the one already documented in lease.ts: two runs both read the
// same unsettled position, both decide to close, both send a full close, and the
// position FLIPS to the other side at twice the size instead of closing.
//
// Two defences, and the first is the one that actually holds:
//
//   1. The LEASE, server-side. takeAgentLease() is a conditional update, so of
//      any number of simultaneous callers exactly one wins per leash and the
//      rest are told another run holds it. This already exists, is tested, and
//      does not depend on the SDK behaving as documented.
//
//   2. CacheSettings, SDK-side — one node makes the request and the others reuse
//      its response. It is the right mechanism and it is left commented out
//      below ON PURPOSE: the Go reference documents the field names and the
//      TypeScript shape is not confirmed for the SDK version pinned here, and a
//      guessed field name would silently do nothing while looking like a
//      safeguard. Confirm it against the installed SDK, then enable it — as a
//      second layer, never as the first.
//
// Defence 1 means this is safe today. Defence 2 means it would also be tidy.

import {
  ConsensusAggregationByFields,
  CronCapability,
  HTTPClient,
  Runner,
  handler,
  json,
  median,
  ok,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";

export type Config = {
  /** Standard cron. The agent is cheap to call and does nothing most ticks. */
  schedule: string;
  /** Full URL of the agent run endpoint. */
  agentUrl: string;
  /**
   * Origin to send. NOT cosmetic: the app's CSRF middleware rejects a
   * cross-origin POST with 403 before the route is reached, which reads exactly
   * like a rejected token and is not one. Both other schedulers were built
   * without it and would have failed every run.
   */
  origin: string;
  /** Decide and report, send nothing. Leave true until the logs look right. */
  dryRun: boolean;
  /** Id of the CRE secret holding COTA_AGENT_TOKEN. */
  tokenSecretId: string;
};

/** What we keep from the agent's reply. Numbers, so the DON can agree on them. */
type RunSummary = {
  ran: number;
  acted: number;
};

const callAgent =
  (token: string) =>
  (sendRequester: HTTPSendRequester, config: Config): RunSummary => {
    const resp = sendRequester
      .sendRequest({
        url: config.agentUrl,
        method: "POST" as const,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: config.origin,
        },
        body: new TextEncoder().encode(
          JSON.stringify({ dryRun: config.dryRun }),
        ),
        // cacheSettings: { store: true, maxAge: ... },  // see the note above
      })
      .result();

    if (!ok(resp)) {
      // 401 is a bad token, 403 is the missing Origin, 404 is the wrong URL.
      // Three different problems that all look alike from here, so the status
      // goes into the error rather than a generic failure.
      throw new Error(`agent run returned ${resp.statusCode}`);
    }

    const body = json(resp) as {
      ran?: number;
      results?: { act?: string }[];
    };
    const results = body.results ?? [];
    return {
      ran: body.ran ?? 0,
      acted: results.filter((r) => r.act === "open" || r.act === "close").length,
    };
  };

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const token = runtime.getSecret({ id: runtime.config.tokenSecretId }).result();
  const httpClient = new HTTPClient();

  const summary = httpClient
    .sendRequest(
      runtime,
      callAgent(token.value),
      // The DON must agree on what happened. Medians over two small integers
      // are enough: nodes that saw the same run report the same numbers, and a
      // node that saw something else cannot drag the answer on its own.
      ConsensusAggregationByFields<RunSummary>({
        ran: median<number>,
        acted: median<number>,
      }),
    )(runtime.config)
    .result();

  runtime.log(
    `cota agent: ${String(summary.ran)} leash(es) considered, ${String(summary.acted)} acted on${
      runtime.config.dryRun ? " (dry run)" : ""
    }`,
  );
  return `ran=${String(summary.ran)} acted=${String(summary.acted)}`;
};

const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
