import { DawnBackground } from "@/components/DawnBackground";
import { Footer } from "@/components/Footer";
import { ForAgents } from "@/components/ForAgents";
import { GuestStory } from "@/components/GuestStory";
import { Hero } from "@/components/Hero";
import { Kolam } from "@/components/Kolam";
import { Nav } from "@/components/Nav";
import { ShowcaseIndex } from "@/components/ShowcaseIndex";
import { TryYourShow } from "@/components/TryYourShow";
import { WithoutQloo } from "@/components/WithoutQloo";
import { loadLiveRuns } from "@/lib/health";
import { loadRun } from "@/lib/run";
import { loadShowcase } from "@/lib/showcase";

function ShowcaseMessage() {
  return (
    <section className="relative z-20 px-[6vw] py-[18vh]">
      <p className="font-mono text-xs text-rice-dim">The showcase could not be loaded.</p>
    </section>
  );
}

// The whole landing page. "/" renders it as is and "/lab" adds the lab panel,
// so the two cannot drift.
export async function Landing() {
  const [result, showcase, liveRuns] = await Promise.all([
    loadRun(),
    loadShowcase(),
    loadLiveRuns(),
  ]);
  const first = showcase.ok ? showcase.showcase.runs[0] : undefined;
  const boardHref = first ? `/runs/${first.runId}` : "#showcase";

  return (
    <>
      <DawnBackground />
      <Nav />
      <Hero boardHref={boardHref}>
        {result.ok ? (
          <Kolam run={result.run} />
        ) : (
          <p className="pointer-events-auto grid aspect-square place-items-center text-center font-mono text-xs text-rice-dim">
            The run could not be loaded.
          </p>
        )}
      </Hero>
      {result.ok && <GuestStory run={result.run} boardHref={boardHref} />}
      {showcase.ok ? (
        <>
          {showcase.showcase.proof.runs.length > 0 ? (
            <WithoutQloo proof={showcase.showcase.proof} />
          ) : (
            <ShowcaseMessage />
          )}
          <ShowcaseIndex runs={showcase.showcase.runs} />
        </>
      ) : (
        <ShowcaseMessage />
      )}
      <TryYourShow
        liveRuns={liveRuns}
        boardCount={showcase.ok ? showcase.showcase.runs.length : null}
      />
      <ForAgents />
      <Footer />
    </>
  );
}
