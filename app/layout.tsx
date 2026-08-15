import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "EmpowerTours Hunt",
    template: "%s · EmpowerTours Hunt",
  },
  description:
    "A GPS treasure hunt. Walk to hidden caches, earn TURBO credit, sweep spawns for MON. No wallet, no seed phrase.",
  applicationName: "Hunt",
  appleWebApp: {
    capable: true,
    title: "Hunt",
    // Lets the scope run under the status bar instead of a grey letterbox.
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false, address: false, email: false },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // A hunt page is per-player state behind auth; nothing here should be
  // crawled or cached by an intermediary.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#03080a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // The scope is edge-to-edge; without this the notch letterboxes it.
  viewportFit: "cover",
  // Outdoor one-handed use: a pinch-zoom in a pocket must not strand the
  // player on a zoomed viewport, but pinch is left available for the reveal
  // photo. Cap rather than lock.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-void text-ink font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
