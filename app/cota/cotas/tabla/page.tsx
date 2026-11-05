import { redirect } from "next/navigation";

// The Cotas board moved with the game to Cota Práctica.
export default function CotasBoardMoved() {
  redirect("/cota/practica/tabla");
}
