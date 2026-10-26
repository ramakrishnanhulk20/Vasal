import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Rise, RiseWord } from "@/components/Rise";
import { PRIMARY_BUTTON, SECONDARY_LINK } from "@/lib/buttonStyle";

const HEADLINE = "Book the guests your listeners already love.";

export function Hero({ children, boardHref }: { children: ReactNode; boardHref: string }) {
  return (
    <section className="relative z-20 px-[6vw] pb-12 md:h-screen md:min-h-[720px] md:pb-0">
      <div className="md:grid md:h-full md:grid-cols-12">
        <div className="flex flex-col pt-8 md:col-span-6 md:justify-end md:pb-[7vh] md:pt-0">
          <Rise delay={0.15}>
            <p className="font-mono text-[13px] uppercase tracking-[0.14em] text-rice-dim">
              VASAL / PODCAST GUEST BOOKING ON QLOO
            </p>
          </Rise>
          <h1
            className="mt-6 max-w-[12.5ch] font-display text-[length:clamp(2.6rem,11vw,3.5rem)] font-[350] leading-[0.95] tracking-[-0.02em] text-rice md:text-[length:clamp(3rem,7.2vw,7.25rem)]"
            style={{ fontVariationSettings: '"SOFT" 100, "WONK" 1' }}
          >
            {HEADLINE.split(" ").map((word, index) => (
              <Fragment key={index}>
                {index > 0 && " "}
                <RiseWord delay={0.25 + 0.06 * index} className="inline-block">
                  {word}
                </RiseWord>
              </Fragment>
            ))}
          </h1>
          <Rise delay={0.75}>
            <p className="mt-7 max-w-[34ch] font-body text-[17px] leading-[1.55] text-rice-dim md:text-[19px]">
              Vasal reads your show&apos;s audience on Qloo&apos;s taste graph, finds the people
              those listeners already follow, and checks every name against your show&apos;s episode
              history.
            </p>
          </Rise>
          <Rise delay={0.95} className="mt-10 flex flex-col gap-6 md:flex-row md:items-center">
            <Link href={boardHref} className={PRIMARY_BUTTON}>
              See a real board
            </Link>
            <a href="#story" className={SECONDARY_LINK}>
              <span className="link-draw">How it works</span>
            </a>
          </Rise>
        </div>
      </div>
      <div className="pointer-events-none relative mt-12 -ml-[2vw] w-[92vw] md:absolute md:left-[70%] md:top-1/2 md:mt-0 md:ml-0 md:w-[min(78vh,56vw)] md:-translate-x-1/2 md:-translate-y-1/2">
        {children}
      </div>
    </section>
  );
}
