import { redirect } from "next/navigation";

// The game was briefly called "Haz Mercado" at this address. It is Cota Práctica now.
export default function MercadoMoved() {
  redirect("/cota/practica");
}
