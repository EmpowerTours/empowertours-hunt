// Field survey. OPERATOR and above, matching the hunt detail page: what this
// screen produces IS a cache coordinate, so it sits behind the same gate as
// the pages that display one.

import { AdminRole } from "@prisma/client";
import { requireAdminPage } from "@/lib/admin/auth";
import { SurveyField } from "@/app/admin/_components/SurveyField";

export const dynamic = "force-dynamic";

export default async function SurveyPage() {
  await requireAdminPage(AdminRole.OPERATOR);
  return <SurveyField />;
}
