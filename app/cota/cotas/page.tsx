import { redirect } from "next/navigation";

// Cotas, the wall game, was replaced by Haz Mercado. Old links land there.
export default function CotasMoved() {
  redirect("/cota/mercado");
}
