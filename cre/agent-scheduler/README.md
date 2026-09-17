# cota-agent-scheduler

A Chainlink CRE workflow that calls the Cota agent on a schedule.

## Why it exists

`/api/cota/agent/run` is a poll. One call is one pass over every leash carrying
an autonomy grant, and then it returns — nothing inside the app wakes it again.
Whatever calls it on a clock *is* the agent's heartbeat, and until now that was
either GitHub Actions (routinely 5–20 minutes late) or a cron on a 2014 Mac mini
on home Wi-Fi that already reports `degraded`. For software that trades money
unattended, both are the weakest link in the system.

CRE replaces a single machine, or a single vendor's free scheduler, with a DON.

## The thing to understand before changing anything here

**Every node in the DON executes the HTTP request.** Chainlink documents this
directly for non-idempotent methods. Our POST can place an order, so a ten-node
DON calling it naively is ten agent runs — and two concurrent runs is the exact
failure `lib/cota/agent/lease.ts` exists to prevent: both read the same unsettled
position, both decide to close, both send a full close, and the position flips to
the other side at twice the size instead of closing.

The server-side lease is the defence that holds. It is a conditional update, so
exactly one caller wins per leash and the rest are told so. `CacheSettings` is
the SDK's own mechanism for the same problem and is left commented out in
`main.ts` until its TypeScript field names are confirmed against the installed
SDK — a guessed field name would look like a safeguard and do nothing.

## Run it

    cre workflow simulate agent-scheduler --target staging-settings

Staging is `dryRun: true`: the agent decides, records, and sends no orders. That
is the correct state until the decision log reads sensibly for a while.

Going live is choosing `--target production-settings`, which is deliberately a
different target rather than a flag edited in place.

## Secrets

`COTA_AGENT_TOKEN` is a CRE secret, referenced by id from the config and read
with `runtime.getSecret()`. It is not in this repository, not in either config
file, and not in the workflow code.
