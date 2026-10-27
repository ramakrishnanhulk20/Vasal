import { Reveal } from "@/components/proof/Reveal";
import { ShowRows } from "@/components/proof/ShowRows";
import { CUT_SHORT_HINT, backtest, correlationAxis, formatCorrelation, formatCount, inWords } from "@/lib/backtest";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

export function ShowByShow() {
  const { shows } = backtest;
  const axis = correlationAxis();
  const allPositive = shows.every((show) => show.rho > 0);
  const rows = [...shows]
    .sort((a, b) => b.episodes - a.episodes)
    .map((show) => ({
      name: show.name,
      episodesText: formatCount(show.episodes),
      cutShort: show.cutShort,
      rho: show.rho,
      rhoGivenFame: show.rhoGivenFame,
      rhoText: formatCorrelation(show.rho),
      fameText: formatCorrelation(show.rhoGivenFame),
    }));

  return (
    <section className="mt-[18vh]">
      <Reveal>
        <p className={KICKER}>SHOW BY SHOW</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          {allPositive ? `Positive in all ${inWords(shows.length)}.` : "Show by show."}
        </h2>
        <p className="mt-[18px] max-w-[56ch] font-body text-[18px] text-rice-dim">
          Each show&apos;s own correlation. The filled dot is fit and views; the hollow one holds
          fame equal. Shows with more episodes give steadier numbers.
        </p>
      </Reveal>
      <Reveal className="mt-12" amount={0.15}>
        <ShowRows rows={rows} axis={axis} />
        {shows.some((show) => show.cutShort) && (
          <p className="mt-5 max-w-[60ch] font-body text-[15px] text-rice-dim">
            Cut short: {CUT_SHORT_HINT.charAt(0).toLowerCase() + CUT_SHORT_HINT.slice(1)}
          </p>
        )}
      </Reveal>
    </section>
  );
}
