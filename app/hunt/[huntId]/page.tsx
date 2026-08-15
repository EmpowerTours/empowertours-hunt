import type { Metadata } from "next";
import { HuntScreen } from "./HuntScreen";

export const metadata: Metadata = { title: "Scope" };

// Everything on this screen is per-player and live. Nothing about it is
// prerenderable, and a cached hunt page would be a cached proximity reading.
export const dynamic = "force-dynamic";

export default async function HuntPage({
  params,
}: {
  params: Promise<{ huntId: string }>;
}) {
  const { huntId } = await params;
  return <HuntScreen huntId={huntId} />;
}
