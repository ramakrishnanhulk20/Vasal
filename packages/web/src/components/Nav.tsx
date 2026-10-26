import { Mark } from "@/components/Mark";

const LINKS = [
  { label: "Showcase", href: "#showcase" },
  { label: "How it works", href: "#story" },
  { label: "Docs", href: "/docs" },
  { label: "For agents", href: "#agents" },
];

// On other pages, home is "/" so the section links point back at the landing page.
export function Nav({ home = "" }: { home?: string }) {
  return (
    <header className="relative z-30 flex h-[72px] items-center justify-between px-[6vw] md:absolute md:inset-x-0 md:top-0">
      <div className="flex items-center gap-3">
        <Mark />
        <span
          className="font-display text-[24px] font-normal text-rice"
          style={{ fontVariationSettings: '"SOFT" 50' }}
        >
          Vasal
        </span>
      </div>
      <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
        {LINKS.map(({ label, href }) => (
          <a
            key={label}
            href={href.startsWith("#") ? `${home}${href}` : href}
            className="link-draw font-body text-[15px] text-rice-dim hover:text-rice focus-visible:text-rice focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice"
          >
            {label}
          </a>
        ))}
      </nav>
      <button
        type="button"
        aria-label="Menu"
        className="group flex h-6 w-6 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice md:hidden"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 8H21M3 16H21"
            className="stroke-rice-dim transition-[stroke] duration-150 ease-out group-hover:stroke-rice"
            strokeWidth="1.5"
          />
        </svg>
      </button>
    </header>
  );
}
