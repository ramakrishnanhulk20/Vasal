import Link from "next/link";
import { Reveal } from "@/components/proof/Reveal";
import { LINK_FOCUS } from "@/components/proof/links";
import { SOURCE_URL } from "@/lib/archive";
import { KICKER } from "@/lib/textStyles";

const ROWS = [
  { label: "Source code", href: SOURCE_URL, external: true },
  { label: "Hackathon submission", href: "https://devpost.com/software/vasal", external: true },
  { label: "The proof", href: "/proof", external: false },
  { label: "Architecture", href: `${SOURCE_URL}/blob/main/ARCHITECTURE.md`, external: true },
  {
    label: "Threat model",
    href: `${SOURCE_URL}/blob/main/docs/security/threat-model.md`,
    external: true,
  },
];

const ROW_CLASS = `flex items-center justify-between py-[18px] ${LINK_FOCUS}`;

function Row({ label, href, external }: (typeof ROWS)[number]) {
  const content = (
    <>
      <span className="link-draw font-body text-[17px] text-rice">{label}</span>
      <span aria-hidden="true" className="font-mono text-rice-dim">
        →
      </span>
    </>
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={ROW_CLASS}>
      {content}
    </a>
  ) : (
    <Link href={href} prefetch={false} className={ROW_CLASS}>
      {content}
    </Link>
  );
}

export function RecordLinks() {
  return (
    <section className="relative z-20 px-[6vw] pb-[18vh] pt-[18vh]">
      <Reveal amount={0.2}>
        <p className={KICKER}>THE RECORD</p>
      </Reveal>
      <Reveal delay={0.1} amount={0.1} className="mt-6 md:grid md:grid-cols-12">
        <ul className="md:col-span-11">
          {ROWS.map((row) => (
            <li key={row.label} className="border-t border-rule first:border-t-0">
              <Row {...row} />
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}
