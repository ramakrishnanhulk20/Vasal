import { DawnBackground } from "@/components/DawnBackground";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { DemoSection } from "@/components/record/DemoSection";
import { RecordBackdrop } from "@/components/record/RecordBackdrop";
import { RecordHero } from "@/components/record/RecordHero";
import { RecordLinks } from "@/components/record/RecordLinks";
import { WhatItDid } from "@/components/record/WhatItDid";
import { WhatItProved } from "@/components/record/WhatItProved";

// The whole page that "/" shows in archive mode.
export function RecordPage() {
  return (
    <div className="relative">
      <RecordBackdrop />
      <DawnBackground />
      <Nav />
      <main>
        <RecordHero />
        <DemoSection />
        <WhatItDid />
        <WhatItProved />
        <RecordLinks />
      </main>
      <Footer />
    </div>
  );
}
