import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Landing } from "@/components/Landing";
import { LabPanel } from "@/components/LabPanel";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// The lab is for the dev server. The live site answers it with the site 404.
export default function LabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <Landing />
      <LabPanel />
    </>
  );
}
