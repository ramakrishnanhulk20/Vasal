import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { LiveRun } from "@/components/run/LiveRun";
import { RunBoard } from "@/components/run/RunBoard";
import { RunHeader } from "@/components/run/RunHeader";
import { RunStopped } from "@/components/run/RunStopped";
import { RunShell } from "@/components/run/RunShell";
import { StepsList } from "@/components/run/StepsList";
import { loadRunPage, metaItems } from "@/lib/runPage";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ guest?: string | string[] }>;
};

const NOT_INDEXED = { index: false, follow: false };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const page = await loadRunPage(id);
  if (page.kind !== "ready") return { robots: NOT_INDEXED };
  const { run, name, promoted } = page;
  const metadata: Metadata = {
    title: `${name}: guest board | Vasal`,
    robots: promoted ? { index: true, follow: true } : NOT_INDEXED,
  };
  if (run.board) {
    metadata.description = `${run.board.length} guests for ${name}, ranked by how closely their fans match the show's listeners on Qloo's taste graph.`;
  }
  return metadata;
}

function Message({ children }: { children: ReactNode }) {
  return (
    <p className="mt-12 max-w-[52ch] font-body text-[18px] leading-[1.6] text-rice-dim">
      {children}
    </p>
  );
}

export default async function RunPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { guest } = await searchParams;
  const page = await loadRunPage(id);
  if (page.kind === "not-found") notFound();

  if (page.kind === "unavailable") {
    return (
      <RunShell>
        <RunHeader name="This board" meta={[]} kolam={null} />
        <Message>This board could not be loaded. Try again in a minute.</Message>
      </RunShell>
    );
  }

  const { run, name, promoted, briefs, steps } = page;
  const kolam = run.kolam ?? null;

  if (run.status === "failed") {
    return (
      <RunShell>
        <RunHeader name={name} meta={[]} kolam={kolam} />
        <RunStopped code={run.errorCode} />
      </RunShell>
    );
  }

  if (run.status === "queued" || run.status === "running" || run.status === "awaiting_confirm") {
    return (
      <RunShell>
        <LiveRun
          runId={run.id}
          status={run.status}
          createdAt={run.createdAt}
          errorCode={run.errorCode}
          candidates={run.candidates ?? []}
        />
      </RunShell>
    );
  }

  if (run.status !== "done" || !run.board) {
    return (
      <RunShell>
        <RunHeader name={name} meta={[]} kolam={kolam} />
        <Message>
          This run is still going. This page shows finished boards; open it again in a minute.
        </Message>
      </RunShell>
    );
  }

  const guests = [...run.board].sort((a, b) => a.fitRank - b.fitRank);
  const first = guests[0];
  const requested = Array.isArray(guest) ? guest[0] : guest;
  const initialGuestId =
    guests.some((item) => item.id === requested) && requested ? requested : (first?.id ?? "");
  const flip = run.withoutQloo;
  const guesses = flip && flip.status === "done" && flip.guesses ? flip.guesses : null;

  return (
    <RunShell>
      <RunHeader name={name} meta={metaItems(run)} kolam={kolam} />
      <RunBoard
        runId={run.id}
        promoted={promoted}
        guests={guests}
        briefs={briefs}
        guesses={guesses}
        initialGuestId={initialGuestId}
      />
      {steps && <StepsList steps={steps} />}
    </RunShell>
  );
}
