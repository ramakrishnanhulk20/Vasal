import { Mark } from "@/components/Mark";

const LINK =
  "link-draw font-body text-[15px] text-rice-dim hover:text-rice focus-visible:text-rice focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice";

const LINKS = [
  { label: "Showcase", href: "#showcase" },
  { label: "How it works", href: "#story" },
  { label: "Docs", href: "/docs" },
  { label: "For agents", href: "#agents" },
];

const SOURCE = "https://github.com/ramakrishnanhulk20/Vasal";

export function Footer({ home = "" }: { home?: string }) {
  return (
    <footer className="relative z-20 border-t border-rule px-[6vw] pb-[6vh] pt-[10vh]">
      <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Mark />
          <span
            className="font-display text-[24px] font-normal text-rice"
            style={{ fontVariationSettings: '"SOFT" 50' }}
          >
            Vasal
          </span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-[28px] gap-y-3">
          {LINKS.map(({ label, href }) => (
            <a key={label} href={href.startsWith("#") ? `${home}${href}` : href} className={LINK}>
              {label}
            </a>
          ))}
          <a href={SOURCE} target="_blank" rel="noopener noreferrer" className={LINK}>
            Source
          </a>
        </nav>
      </div>
      <p className="mt-12 max-w-[64ch] font-body text-[14px] leading-[1.6] text-rice-dim">
        Built for the Qloo Agentic Hackathon. Taste data from Qloo. Show names belong to their
        owners, and Vasal is not affiliated with any show on this page.
      </p>
    </footer>
  );
}
