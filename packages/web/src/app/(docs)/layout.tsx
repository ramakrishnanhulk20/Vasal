import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./docs.css";

const display = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-docs-display",
  display: "swap",
});

const body = Geist({
  subsets: ["latin"],
  variable: "--font-docs-body",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-docs-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Vasal docs", template: "%s | Vasal docs" },
};

export default function DocsRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
