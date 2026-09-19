import type { MetadataRoute } from "next";

// Served at /manifest.webmanifest. The file convention is only picked up at the
// app root, so this must stay here.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EmpowerTours Hunt",
    // "EmpowerTours", not "Hunt". One deployment serves the game and the
    // trading floor off the hostname, and mobile/README already fixes the
    // launcher label as EmpowerTours for exactly that reason — two icons for
    // one identity and one balance is the thing being avoided. Added to the
    // home screen from cota.empowertours.xyz, "Hunt" names the wrong door.
    short_name: "EmpowerTours",
    description:
      "Walk your city and get paid in real MON for the rewards you reach.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches the scope hull so the splash does not flash white in the dark.
    background_color: "#03080a",
    theme_color: "#03080a",
    categories: ["games", "navigation"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
