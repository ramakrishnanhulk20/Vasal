import type { Metadata } from "next";
import { Landing } from "@/components/Landing";
import { LabPanel } from "@/components/LabPanel";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <>
      <Landing />
      <LabPanel />
    </>
  );
}
