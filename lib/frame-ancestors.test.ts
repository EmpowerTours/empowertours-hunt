import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";

// Framing is restricted by CSP frame-ancestors to the empowertours.xyz
// portfolio site. Without it any origin could frame the game (clickjacking).
describe("frame-ancestors", () => {
  it("limits framing to empowertours.xyz on every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    const csp = all?.headers.find(
      (h) => h.key.toLowerCase() === "content-security-policy",
    )?.value;
    const m = /frame-ancestors([^;]*)/.exec(csp ?? "");
    expect(m).not.toBeNull();
    expect(m![1].trim().split(/\s+/).sort()).toEqual([
      "https://empowertours.xyz",
      "https://www.empowertours.xyz",
    ]);
  });
});
