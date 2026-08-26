import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Points next-intl at i18n/request.ts, which decides the locale per request.
// There is no `[locale]` route segment: every URL stays exactly as it was.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Headers applied to every response. Geolocation is the one powerful feature
// this app genuinely needs; everything else is denied outright so a future
// dependency cannot quietly start asking for a camera on an outdoor game.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "geolocation=(self), accelerometer=(), camera=(), microphone=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The version banner is free reconnaissance. Nothing depends on it.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
