import Link from "next/link";
import { Reveal } from "@/components/proof/Reveal";
import { backtest, formatCount, formatRatio, inWords } from "@/lib/backtest";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER } from "@/lib/textStyles";

export function WhatItProved() {
  const { sample, fifths } = backtest;
  const ratio = formatRatio(fifths[4].medianRatio);
  const times = ratio.replace("×", "");

  return (
    <section className="relative z-20 px-[6vw] pt-[18vh]">
      <Reveal amount={0.2}>
        <p className={KICKER}>WHAT IT PROVED</p>
      </Reveal>
      <div className="mt-8 grid grid-cols-1 gap-y-8 md:grid-cols-12 md:items-end md:gap-y-0">
        <Reveal amount={0.3} className="md:col-span-5">
          <p className="font-display text-[length:clamp(4rem,10vw,9rem)] font-[350] leading-none text-accent">
            {ratio}
          </p>
        </Reveal>
        <Reveal delay={0.1} amount={0.2} className="md:col-span-6 md:col-start-6">
          <p className="max-w-[52ch] font-body text-[18px] leading-[1.6] text-rice-dim">
            {`Across ${formatCount(sample.episodes)} episodes of ${inWords(sample.shows)} large podcasts, episodes in the top fifth by guest fit drew ${times} times the median views of those in the bottom fifth. The test was written down before any data was pulled. The correlation is small, and it is not a cause.`}
          </p>
          <div className="mt-4 flex">
            <Link href="/proof" prefetch={false} className={SECONDARY_LINK}>
              <span className="link-draw">See the full proof</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
