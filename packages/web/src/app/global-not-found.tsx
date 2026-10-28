import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { Grain } from "@/components/Grain";
import { SiteNotFound } from "@/components/SiteNotFound";
import "./(site)/globals.css";

// This page skips every layout, so it loads the site's fonts and styles itself.
const display = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-display",
  display: "swap",
});

const body = Geist({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Not found | Vasal",
};

export default function GlobalNotFound() {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <SiteNotFound />
        <Grain />
      </body>
    </html>
  );
}
