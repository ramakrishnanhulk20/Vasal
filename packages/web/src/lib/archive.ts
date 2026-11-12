// Archive mode shows the one-page record in place of the live app, because the
// agent API the app depends on is retired. It reads the server's environment
// only: the variable has no NEXT_PUBLIC prefix, so it never reaches the browser.
export function isArchive(): boolean {
  return process.env.VASAL_ARCHIVE === "1";
}

export const SOURCE_URL = "https://github.com/ramakrishnanhulk20/Vasal";

export type ArchiveLink = { label: string; href: string; external?: boolean };

// The three links the nav, the phone menu and the footer share in archive mode.
export const ARCHIVE_LINKS: ArchiveLink[] = [
  { label: "Demo", href: "#demo" },
  { label: "Proof", href: "/proof" },
  { label: "Source", href: SOURCE_URL, external: true },
];
