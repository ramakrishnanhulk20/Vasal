import { ProofCommand } from "@/components/proof/ProofCommand";
import { Reveal } from "@/components/proof/Reveal";
import { Timeline, type Milestone } from "@/components/proof/Timeline";
import { REPO } from "@/components/proof/links";
import { backtest } from "@/lib/backtest";
import { SECONDARY_LINK } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

const RERUN = "npm run backtest -w packages/agent -- --dev-db";

export function CheckOurWork() {
  const milestones: Milestone[] = [
    {
      date: "19 Oct 2026, 05:41 UTC",
      text: "The method and the list of shows were committed, before we had a Qloo key.",
      hash: "52e208f",
    },
    { date: "19 Oct, 10:25 UTC", text: "Each show's YouTube channel was pinned.", hash: "4a2a8ca" },
    {
      date: "21 Oct, 10:16 UTC",
      text: "Three fixes to the title reader went into the change log, found by reading 12 titles and nothing else.",
      hash: "40547e0",
    },
    {
      date: "21 Oct, 10:52 UTC",
      text: "The pull behind every number on this page started.",
      note: `dataset ${backtest.dataset}`,
    },
    {
      date: "21 Oct, 15:14 UTC",
      text: "The results were published as they came out.",
      hash: "f513835",
    },
  ];

  return (
    <section className="mt-[18vh]">
      <Reveal>
        <p className={KICKER}>CHECK OUR WORK</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          The test was public before the data existed.
        </h2>
      </Reveal>

      <div className="mt-12 grid grid-cols-12">
        <Reveal className="col-span-12 md:col-span-8" amount={0.2}>
          <Timeline milestones={milestones} />
        </Reveal>
      </div>

      <Reveal className="mt-10" amount={0.2}>
        <div className="flex flex-col gap-y-1 md:flex-row md:gap-x-7">
          <a
            href={`${REPO}/blob/main/docs/backtest-preregistration.md`}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY_LINK}
          >
            <span className="link-draw">Read the pre-registration</span>
          </a>
          <a
            href={`${REPO}/blob/main/docs/backtest-results.md`}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY_LINK}
          >
            <span className="link-draw">Read the full results</span>
          </a>
        </div>
        <p className="mt-5 max-w-[62ch] font-body text-[15px] leading-[1.6] text-rice-dim">
          The dataset holds Qloo and YouTube data, so it stays private. The code is public, and with
          your own keys one command reruns the whole pull:
        </p>
        <div className="mt-3 max-w-[62ch]">
          <ProofCommand command={RERUN} />
        </div>
        <p className="mt-3 font-body text-[14px] text-rice-dim">
          The pull behind this page used 915 Qloo calls. View counts keep moving, so a fresh pull
          comes out slightly different.
        </p>
      </Reveal>
    </section>
  );
}
