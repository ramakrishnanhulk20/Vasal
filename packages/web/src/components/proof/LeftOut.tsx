import { FunnelRows } from "@/components/proof/FunnelRows";
import { Reveal } from "@/components/proof/Reveal";
import { backtest, EXCLUDED_TEXT, formatCount, funnelRows } from "@/lib/backtest";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

export function LeftOut() {
  const { uploadsRead, sample, excluded } = backtest;

  return (
    <section className="mt-[18vh]">
      <Reveal>
        <p className={KICKER}>WHAT WE LEFT OUT</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          {`From ${formatCount(uploadsRead)} uploads to ${formatCount(sample.episodes)} episodes.`}
        </h2>
        <p className="mt-[18px] max-w-[56ch] font-body text-[18px] text-rice-dim">
          Every rule was written before the pull. Each bar shows what one rule took out.
        </p>
      </Reveal>

      <div className="mt-12 grid grid-cols-12">
        <Reveal className="col-span-12 md:col-span-10" amount={0.2}>
          <FunnelRows rows={funnelRows()} />
        </Reveal>
      </div>

      {excluded.length > 0 && (
        <Reveal className="mt-12" amount={0.2}>
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-rice-dim">
            SHOWS LEFT OUT BY THE RULES
          </p>
          <ul className="mt-4 divide-y divide-rule">
            {excluded.map((show) => (
              <li key={show.name} className="grid grid-cols-12 gap-y-1 py-4">
                <span className="col-span-12 font-body text-[17px] text-rice md:col-span-4">
                  {show.name}
                </span>
                <span className="col-span-12 font-body text-[15px] text-rice-dim md:col-span-7">
                  {EXCLUDED_TEXT[show.reason]}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      )}
    </section>
  );
}
