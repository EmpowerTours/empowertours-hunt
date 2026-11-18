import type { Metadata } from "next";
import { ChipBoard } from "@/components/cota/ChipBoard";

// Cota Chip Board: the daily BTC tournament. Everything on it comes from the
// Chip Board game server (services/chipboard); see components/cota/ChipBoard.tsx.

// The approved mockup's two faces, loaded the way the mockup loads them.
// next/font/google was tried first and fails to resolve under this Next 16.3
// Turbopack build ("next/font/google queries have exactly one entry"); the
// stylesheet link is hoisted into <head> by React and falls back to the
// system stacks in ChipBoard.module.css if it never arrives.
const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=JetBrains+Mono:wght@500;700;800&display=swap";

export const metadata: Metadata = { title: "Cota Chip Board" };

export default function ChipsPage() {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="stylesheet" href={FONTS} precedence="default" />
      {/* The app runs in a WebView with no back button: this is the way home. */}
      <a
        href="/cota"
        className="text-ink-dim block px-4 pt-3 font-mono text-xs hover:underline"
      >
        ← Cota
      </a>
      <ChipBoard />
    </>
  );
}
