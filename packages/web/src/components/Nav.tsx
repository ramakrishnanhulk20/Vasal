import { Mark } from "@/components/Mark";
import { MobileMenu } from "@/components/MobileMenu";

const LINKS = [
  { label: "Showcase", href: "#showcase" },
  { label: "How it works", href: "#story" },
  { label: "Proof", href: "/proof" },
  { label: "Docs", href: "/docs" },
  { label: "For agents", href: "/agents" },
];

// On other pages, home is "/" so the section links point back at the landing page.
export function Nav({ home = "" }: { home?: string }) {
  const links = LINKS.map(({ label, href }) => ({
    label,
    href: href.startsWith("#") ? `${home}${href}` : href,
  }));
  const tryHref = `${home}#try`;

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
        {links.map(({ label, href }) => (
          <a
            key={label}
            href={href}
            className="link-draw font-body text-[15px] text-rice-dim hover:text-rice focus-visible:text-rice focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice"
          >
            {label}
          </a>
        ))}
        <a
          href={tryHref}
          className="rounded-lg border border-[rgba(242,169,59,0.55)] px-[14px] py-[7px] font-body text-[15px] text-accent transition-[background-color,color] duration-150 ease-out hover:bg-accent hover:text-night focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice"
        >
          Try your show
        </a>
      </nav>
      <MobileMenu links={[{ label: "Try your show", href: tryHref }, ...links]} />
    </header>
  );
}
