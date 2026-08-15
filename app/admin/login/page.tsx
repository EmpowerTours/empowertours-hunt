import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/auth";
import { LoginForm } from "@/app/admin/_components/LoginForm";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage() {
  const session = await getAdminSession();
  if (session) redirect("/admin");
  return <LoginForm />;
}
