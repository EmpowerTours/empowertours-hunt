import { redirect } from "next/navigation";

// The Cotas board moved with the game to Haz Mercado.
export default function CotasBoardMoved() {
  redirect("/cota/mercado/tabla");
}
