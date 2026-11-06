import { redirect } from "next/navigation";

// Cotas, the wall game, was replaced by Cota Práctica, at the root of the cota subdomain.
export default function CotasMoved() {
  redirect("/");
}
