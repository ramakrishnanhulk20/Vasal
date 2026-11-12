import { Fragment } from "react";
import { DrawnMark } from "@/components/record/DrawnMark";
import { Rise, RiseWord } from "@/components/Rise";
import { SOURCE_URL } from "@/lib/archive";
import { PRIMARY_BUTTON, SECONDARY_LINK } from "@/lib/buttonStyle";

const HEADLINE = "Book the guests your listeners already love.";

export function RecordHero() {
  return (
    <section className="relative z-20 px-[6vw] pb-12 md:grid md:min-h-[max(100vh,720px)] md:grid-cols-12 md:pb-0">
      <div className="flex flex-col pt-8 md:col-span-7 md:justify-end md:pb-[7vh] md:pt-[120px]">
        <Rise delay={0.15}>
          <p className="font-mono text-[13px] uppercase tracking-[0.14em] text-rice-dim">
            VASAL / OCTOBER 2026
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
          <p className="mt-7 max-w-[46ch] font-body text-[19px] leading-[1.55] text-rice-dim">
            Vasal was a podcast guest booker, built in October 2026 for the Qloo Agentic Hackathon.
            An AI agent read a show&apos;s audience on Qloo&apos;s taste graph, ranked guests by how
            closely their fans matched the show&apos;s listeners, checked every name against the
            show&apos;s own episode feed, and wrote each guest&apos;s brief and pitch.
          </p>
        </Rise>
        <Rise delay={0.85}>
          <p className="mt-4 max-w-[46ch] font-body text-[15px] text-rice-dim">
            The hackathon&apos;s API access ended with judging, so the live app is retired. This
            page keeps the record.
          </p>
        </Rise>
        <Rise delay={0.95} className="mt-10 flex flex-col gap-6 md:flex-row md:items-center">
          <a href="#demo" className={PRIMARY_BUTTON}>
            Watch the demo
          </a>
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" className={SECONDARY_LINK}>
            <span className="link-draw">Read the code</span>
          </a>
        </Rise>
      </div>
      <div className="pointer-events-none mt-12 w-[70vw] md:col-span-5 md:mt-0 md:w-[min(56vh,36vw)] md:self-center md:justify-self-center">
        <DrawnMark className="block aspect-square h-auto w-full" />
      </div>
    </section>
  );
}
