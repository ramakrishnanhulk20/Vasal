import type { Metadata } from "next";
import { Landing } from "@/components/Landing";
import { RecordPage } from "@/components/record/RecordPage";
import { isArchive } from "@/lib/archive";

// The mode is read while the site is built, so a build made with VASAL_ARCHIVE=1 holds the record.
export function generateMetadata(): Metadata {
  if (!isArchive()) return {};
  return {
    title: "Vasal: a podcast guest booker on Qloo",
    description:
      "A record of Vasal, built for the Qloo Agentic Hackathon in October 2026: the demo, what it did and the pre-registered test behind it.",
    robots: { index: true, follow: true },
  };
}

export default function Home() {
  return isArchive() ? <RecordPage /> : <Landing />;
}
