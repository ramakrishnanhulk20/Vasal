import { Fragment } from "react";
import { Rise } from "@/components/Rise";
import { REPO, TEXT_LINK } from "@/components/proof/links";
import { backtest, dayMonthYear, formatCount, inWords } from "@/lib/backtest";
import { KICKER, SOFT_100 } from "@/lib/textStyles";

// A show whose correlation is under this is above zero, but only just.
const BARELY_POSITIVE = 0.05;

export function ProofHeader() {
  const { sample, shows, datasetBuiltAt } = backtest;
  const episodes = formatCount(sample.episodes);
  const everyShowPositive = shows.every((show) => show.rho > 0);
  const barelyPositive = shows.filter((show) => show.rho < BARELY_POSITIVE).length === 1;
  const positive = everyShowPositive
    ? `, and it was positive in all ${inWords(shows.length)} shows${barelyPositive ? ", though barely in one" : ""}.`
    : ".";
  const lede = `Before we pulled any data, we wrote the test down and committed it in public. Then we checked ${episodes} episodes from ${inWords(sample.shows)} of the biggest podcasts on YouTube. The link is small, it passed the test we set in advance${positive}`;

  const meta = [
    <a
      key="method"
      href={`${REPO}/commit/52e208f`}
      target="_blank"
      rel="noopener noreferrer"
      className={`whitespace-nowrap ${TEXT_LINK}`}
    >
      Method committed 19 Oct 2026
    </a>,
    <span key="data" className="whitespace-nowrap">{`Data pulled ${dayMonthYear(datasetBuiltAt)}`}</span>,
    <span key="episodes" className="whitespace-nowrap">{`${episodes} episodes`}</span>,
    <span key="shows" className="whitespace-nowrap">{`${sample.shows} shows`}</span>,
  ];

  return (
    <header className="grid grid-cols-12">
      <div className="col-span-12 md:col-span-9">
        <Rise delay={0.1}>
          <p className={KICKER}>THE PROOF</p>
        </Rise>
        <Rise delay={0.2}>
          <h1
            className="mt-[14px] font-display text-[length:clamp(2.75rem,6vw,5.5rem)] font-[350] leading-none text-rice"
            style={SOFT_100}
          >
            Guests who fit the show drew more views.
          </h1>
        </Rise>
        <Rise delay={0.3}>
          <p className="mt-6 max-w-[54ch] font-body text-[19px] leading-[1.6] text-rice-dim">
            {lede}
          </p>
        </Rise>
        <Rise delay={0.4}>
          <p className="mt-7 whitespace-pre-wrap font-mono text-[13px] text-rice-dim">
            {meta.map((item, index) => (
              <Fragment key={item.key}>
                {index > 0 && "  /  "}
                {item}
              </Fragment>
            ))}
          </p>
        </Rise>
        <Rise delay={0.5}>
          <p className="mt-5 max-w-[54ch] font-body text-[15px] leading-[1.6] text-rice-dim">
            It does not show cause and effect, audio downloads, or how smaller shows behave. Those
            limits are spelled out{" "}
            <a href="#limits" className={TEXT_LINK}>
              at the end
            </a>
            .
          </p>
        </Rise>
      </div>
    </header>
  );
}
