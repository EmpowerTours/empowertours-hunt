import { redirect } from "next/navigation";

// Cotas, the wall game, was replaced by Cota Práctica. Old links land there.
export default function CotasMoved() {
  redirect("/cota/practica");
}
