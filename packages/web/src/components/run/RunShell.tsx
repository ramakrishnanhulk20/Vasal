import type { CSSProperties, ReactNode } from "react";
import { DawnBackground } from "@/components/DawnBackground";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";

// The dawn is held at early morning on these pages. The variable is set on this
// wrapper, so the scroll loop that writes to the page root never reaches it.
const EARLY_MORNING = { "--dawn": 0.35 } as CSSProperties;

export function RunShell({ children }: { children: ReactNode }) {
  return (
    <div style={EARLY_MORNING}>
      <DawnBackground />
      <Nav home="/" />
      <main className="relative z-20 min-h-screen px-[6vw] pb-[14vh] pt-32">{children}</main>
      <Footer home="/" />
    </div>
  );
}
