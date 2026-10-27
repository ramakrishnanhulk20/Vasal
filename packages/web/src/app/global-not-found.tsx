import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Grain } from "@/components/Grain";
import { RunShell } from "@/components/run/RunShell";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";
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
        <RunShell>
          <p className={KICKER}>NOT FOUND</p>
          <h1 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
            There is no page here.
          </h1>
          <div className="mt-8 flex">
            <Link href="/" className={SECONDARY_LINK}>
              <span className="link-draw">Back to the home page</span>
            </Link>
          </div>
        </RunShell>
        <Grain />
      </body>
    </html>
  );
}
