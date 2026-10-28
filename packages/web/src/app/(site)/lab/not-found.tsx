import type { Metadata } from "next";
import { SiteNotFound } from "@/components/SiteNotFound";

export const metadata: Metadata = {
  title: "Not found | Vasal",
};

export default function LabNotFound() {
  return <SiteNotFound />;
}
