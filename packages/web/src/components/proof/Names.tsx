import { NameDots } from "@/components/proof/NameDots";
import { Reveal } from "@/components/proof/Reveal";
import { backtest, formatCount } from "@/lib/backtest";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

export function Names() {
  const { precision } = backtest;
  const checked = formatCount(precision.checked);

  return (
    <section className="mt-[18vh] grid grid-cols-12 gap-y-10">
      <Reveal className="col-span-12 md:col-span-7">
        <p className={KICKER}>THE NAMES</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          {`${formatCount(precision.correct)} of ${checked} names were right.`}
        </h2>
        <p className="mt-[18px] max-w-[58ch] font-body text-[18px] text-rice-dim">
          {`A program reads each guest's name from the episode title. We checked ${checked} of them by hand, drawn at random with a fixed seed, against the title and the show's format. Most misses were Armchair Expert's "Fact Check" episodes, which name an earlier guest who isn't on them.`}
        </p>
      </Reveal>
      <Reveal className="col-span-12 md:col-span-5 md:col-start-8 md:self-end" amount={0.2}>
        <NameDots checked={precision.checked} correct={precision.correct} />
      </Reveal>
    </section>
  );
}
