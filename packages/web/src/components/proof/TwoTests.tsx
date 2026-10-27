import { Reveal } from "@/components/proof/Reveal";
import { TestRows, type TestRow } from "@/components/proof/TestRows";
import {
  backtest,
  correlationAxis,
  formatCorrelation,
  formatCount,
  formatRange,
} from "@/lib/backtest";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

type Checked = { rho: number; low: number; high: number };

function withInterval(test: Checked): string {
  return `${formatCorrelation(test.rho)} (${formatRange(test.low, test.high)})`;
}

// Each test's interval is its own run, so two different counts are both said.
function resampleText(h1: number, h2: number): string {
  return h1 === h2
    ? `${formatCount(h1)} resamples`
    : `${formatCount(h1)} and ${formatCount(h2)} resamples`;
}

export function TwoTests() {
  const { h1, h2, bootstrap, sensitivity, guestLevel } = backtest;
  const axis = correlationAxis();
  const bothPassed = h1.supported && h2.supported;

  const rows: TestRow[] = [
    {
      title: "Fit and views",
      sub: "Views adjusted for how long the episode had been up.",
      test: h1,
    },
    {
      title: "Fit and views, fame held equal",
      sub: "The same test after taking out how famous each guest is in general.",
      test: h2,
    },
  ].map(({ title, sub, test }) => ({
    title,
    sub,
    rho: test.rho,
    low: test.low,
    high: test.high,
    rhoText: formatCorrelation(test.rho),
    rangeText: formatRange(test.low, test.high),
    supported: test.supported,
  }));

  const checks = [
    {
      label: `Without the misread episodes (${formatCount(sensitivity.episodes)})`,
      first: withInterval(sensitivity.h1),
      second: withInterval(sensitivity.h2),
    },
    {
      label: `Resampling guests, not episodes (${formatCount(guestLevel.guests)} guests, ${resampleText(guestLevel.resamples.h1, guestLevel.resamples.h2)})`,
      first: formatRange(guestLevel.h1.low, guestLevel.h1.high),
      second: formatRange(guestLevel.h2.low, guestLevel.h2.high),
    },
    {
      label: "One row per guest",
      first: formatCorrelation(guestLevel.oneRowPerGuest.h1),
      second: formatCorrelation(guestLevel.oneRowPerGuest.h2),
    },
  ];

  return (
    <section className="mt-[18vh]">
      <Reveal>
        <p className={KICKER}>THE TWO TESTS</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          {bothPassed ? "Both passed the rule we set in advance." : "The rule we set in advance."}
        </h2>
        <p className="mt-[18px] max-w-[56ch] font-body text-[18px] text-rice-dim">
          {`The rule, written before the pull: a test passes when its correlation is above zero and the low end of its 95% interval is above zero too. The intervals come from ${formatCount(bootstrap.iterations)} resamples.`}
        </p>
      </Reveal>

      <Reveal className="mt-12" amount={0.2}>
        <TestRows rows={rows} axis={axis} />
      </Reveal>

      <Reveal className="mt-14" amount={0.2}>
        <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-rice-dim">
          CHECKED AFTER THE FACT
        </p>

        <table className="mt-4 hidden w-full table-fixed border-collapse md:table">
          <thead>
            <tr className="text-left font-mono text-[13px] font-normal text-rice-dim">
              <th scope="col" className="w-[44%] py-[14px] pr-4 font-normal">
                Check
              </th>
              <th scope="col" className="w-[28%] py-[14px] pr-4 font-normal">
                Fit and views
              </th>
              <th scope="col" className="w-[28%] py-[14px] font-normal">
                Fame held equal
              </th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.label} className="border-t border-rule align-baseline">
                <th
                  scope="row"
                  className="py-[14px] pr-6 text-left font-body text-[15px] font-normal text-rice"
                >
                  {check.label}
                </th>
                <td className="py-[14px] pr-4 font-mono text-[13px] text-rice">{check.first}</td>
                <td className="py-[14px] font-mono text-[13px] text-rice">{check.second}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="mt-4 divide-y divide-rule border-t border-rule md:hidden">
          {checks.map((check) => (
            <li key={check.label} className="py-[14px]">
              <p className="font-body text-[15px] text-rice">{check.label}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono text-[13px]">
                <dt className="text-rice-dim">Fit and views</dt>
                <dd className="text-rice">{check.first}</dd>
                <dt className="text-rice-dim">Fame held equal</dt>
                <dd className="text-rice">{check.second}</dd>
              </dl>
            </li>
          ))}
        </ul>

        <p className="mt-4 max-w-[60ch] font-body text-[15px] leading-[1.6] text-rice-dim">
          We added these after the result, at a reviewer&apos;s request. They are not part of the
          pre-registered test, and neither changed a verdict.
        </p>
      </Reveal>
    </section>
  );
}
