// Hunt detail — settings and caches.
//
// OPERATOR-gated, not VIEWER: this is the one screen in the product where
// cache coordinates are rendered. Everything editable here writes an
// AdminAction row with its before and after values.

import { notFound } from "next/navigation";
import { AdminRole } from "@prisma/client";
import { requireAdminPage } from "@/lib/admin/auth";
import { huntDetail, listCaches } from "@/lib/admin/queries";
import { formatMon } from "@/lib/wei";
import { weiOf, timestamp } from "@/lib/admin/format";
import { pageHref, parsePage } from "@/lib/admin/pagination";
import {
  HuntSettingsForm,
  type HuntFormValues,
} from "@/app/admin/_components/HuntSettingsForm";
import {
  CacheManager,
  type CacheRow,
} from "@/app/admin/_components/CacheManager";
import { Danger, Pager, Panel, Stat } from "@/app/admin/_components/ui";

export const dynamic = "force-dynamic";

function isoOrEmpty(d: Date | null): string {
  return d ? d.toISOString() : "";
}

export default async function HuntDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ huntId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage(AdminRole.OPERATOR);
  const { huntId } = await params;
  const sp = await searchParams;
  const page = parsePage(sp, 50);

  const hunt = await huntDetail(huntId);
  if (!hunt) notFound();

  const { rows: caches, total } = await listCaches(huntId, page);

  const initial: HuntFormValues = {
    name: hunt.name,
    description: hunt.description ?? "",
    active: hunt.active,
    startsAt: isoOrEmpty(hunt.startsAt),
    endsAt: isoOrEmpty(hunt.endsAt),
    maxAccuracyM: hunt.maxAccuracyM,
    maxSpeedKmh: hunt.maxSpeedKmh,
    cooldownSeconds: hunt.cooldownSeconds,
    maxClockSkewSeconds: hunt.maxClockSkewSeconds,
    budgetCreditMon: formatMon(weiOf(hunt.budgetCreditWei)),
    maxFindsPerPlayer: hunt.maxFindsPerPlayer,
    spawnEnabled: hunt.spawnEnabled,
    budgetMon: formatMon(weiOf(hunt.budgetMonWei)),
    spawnMinMon: formatMon(weiOf(hunt.spawnMinWei)),
    spawnMaxMon: formatMon(weiOf(hunt.spawnMaxWei)),
    spawnMinRadiusM: hunt.spawnMinRadiusM,
    spawnMaxRadiusM: hunt.spawnMaxRadiusM,
    spawnTtlSeconds: hunt.spawnTtlSeconds,
    spawnCooldownSeconds: hunt.spawnCooldownSeconds,
    spawnDailyCapMonPerPlayer: formatMon(weiOf(hunt.spawnDailyCapWeiPerPlayer)),
    autoApproveMaxMon: formatMon(weiOf(hunt.autoApproveMaxWei)),
    autoApproveDailyCapMon: formatMon(weiOf(hunt.autoApproveDailyCapWei)),
  };

  const cacheRows: CacheRow[] = caches.map((c) => ({
    id: c.id,
    lat: c.lat,
    lng: c.lng,
    radiusMeters: c.radiusMeters,
    rewardCreditMon: formatMon(c.rewardCredit),
    label: c.label,
    blurb: c.blurb,
    photoCid: c.photoCid,
    active: c.active,
    finds: c._count.finds,
    createdAt: timestamp(c.createdAt),
  }));

  const autoApproveOn = weiOf(hunt.autoApproveMaxWei) > 0n;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-base font-semibold text-slate-100">{hunt.name}</h1>
        <a
          href={`/admin/payouts?view=pending&huntId=${hunt.id}`}
          className="text-xs text-slate-400 underline hover:text-slate-200"
        >
          payouts for this hunt
        </a>
        <a
          href={`/admin/hunts/${hunt.id}/zones`}
          className="text-xs text-slate-400 underline hover:text-slate-200"
        >
          walkable ground
        </a>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="MON spent / budget"
          value={`${formatMon(weiOf(hunt.spentMonWei))} / ${formatMon(weiOf(hunt.budgetMonWei))}`}
          hint="Enforced atomically at collect time. This screen only reports it."
        />
        <Stat
          label="Credit spent / budget"
          value={`${formatMon(weiOf(hunt.spentCreditWei))} / ${formatMon(weiOf(hunt.budgetCreditWei))}`}
          hint="WMON-denominated TURBO credit."
        />
        <Stat
          label="Spawns"
          value={hunt.spawnEnabled ? "enabled" : "disabled"}
          tone={hunt.spawnEnabled ? "warn" : "neutral"}
          hint="The only path where native MON leaves the treasury."
        />
        <Stat
          label="Auto-approval"
          value={
            autoApproveOn
              ? `≤ ${formatMon(weiOf(hunt.autoApproveMaxWei))} MON`
              : "off"
          }
          tone={autoApproveOn ? "warn" : "good"}
          hint={
            autoApproveOn
              ? "Payouts at or below this move without a human."
              : "Strict human gate: every payout waits for a person."
          }
        />
      </div>

      <Panel title="Settings">
        <HuntSettingsForm huntId={hunt.id} initial={initial} />
      </Panel>

      <Panel
        title="Caches"
        subtitle="Coordinates are visible on this screen only. They are never included in any player-reachable response — not in a body, not in an error, not in a hint."
      >
        <Danger>
          Treat this table as the secret it is. A leaked coordinate is not
          recoverable by rotating anything; the cache has to be moved.
        </Danger>
        <div className="mt-3">
          <CacheManager huntId={hunt.id} caches={cacheRows} />
        </div>
        <Pager
          page={page.page}
          take={page.take}
          total={total}
          hrefFor={(p) => pageHref(`/admin/hunts/${hunt.id}`, sp, p)}
        />
      </Panel>
    </div>
  );
}
