import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HuntScreen } from "./HuntScreen";
import { isCotaHost } from "@/lib/host";

export const metadata: Metadata = { title: "Scope" };

// Everything on this screen is per-player and live. Nothing about it is
// prerenderable, and a cached hunt page would be a cached proximity reading.
export const dynamic = "force-dynamic";

export default async function HuntPage({
  params,
}: {
  params: Promise<{ huntId: string }>;
}) {
  // The hunt game is not served on the cota trading host.
  if (await isCotaHost()) redirect("/cota");
  const { huntId } = await params;
  return <HuntScreen huntId={huntId} />;
}
