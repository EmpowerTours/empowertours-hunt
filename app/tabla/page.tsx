import { redirect } from "next/navigation";
import { PracticaBoard } from "@/components/cota/PracticaBoard";
import { isCotaHost } from "@/lib/host";

// The Cota Práctica weekly board, at /tabla on the cota subdomain only.
export default async function TablaPage() {
  if (!(await isCotaHost())) redirect("/");
  return <PracticaBoard />;
}
