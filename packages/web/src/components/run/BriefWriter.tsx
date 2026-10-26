"use client";

import { useEffect, useState } from "react";
import { readBrief, requestBrief } from "@/lib/api";
import type { Failure } from "@/lib/api";
import type { BriefState } from "@/lib/brief";
import { PRIMARY_BUTTON } from "@/lib/buttonStyle";

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 90_000;
const FAILED_LINE = "This brief could not be written.";

type Phase =
  | { kind: "idle"; line: string | null }
  | { kind: "starting" }
  | { kind: "writing"; since: number | null };

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function refusalLine({ status, code }: Failure): string {
  if (status === 429 && code === "BRIEF_LIMIT")
    return "This run has written as many briefs as it can.";
  if (status === 503 && code === "LIVE_RUNS_OFF") {
    return "Live runs are closed, so no new briefs can be written right now.";
  }
  if (code === "BRIEF_FAILED" || code === "NOT_READY" || code === "BRIEF_NOT_READY")
    return FAILED_LINE;
  return "Vasal couldn't be reached. Try again in a minute.";
}

// Stands in for "has not been written yet" on a run that is not on the
// showcase: the visitor can ask for the brief, then wait for it.
export function BriefWriter({
  runId,
  guestId,
  alreadyPending,
  since,
  onStarted,
  onSettled,
}: {
  runId: string;
  guestId: string;
  alreadyPending: boolean;
  since: number | undefined;
  onStarted: (guestId: string, at: number) => void;
  onSettled: (guestId: string, state: BriefState | null) => void;
}) {
  const [phase, setPhase] = useState<Phase>(
    since !== undefined || alreadyPending
      ? { kind: "writing", since: since ?? null }
      : { kind: "idle", line: null },
  );
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (phase.kind !== "writing") return;
    const began = phase.since ?? Date.now();
    let stopped = false;
    const showElapsed = () => setSeconds(Math.floor((Date.now() - began) / 1_000));
    const firstTick = setTimeout(showElapsed, 0);
    const clockTimer = setInterval(showElapsed, 1_000);
    const pollTimer = setInterval(async () => {
      if (Date.now() - began > POLL_LIMIT_MS) {
        stopped = true;
        setPhase({ kind: "idle", line: FAILED_LINE });
        onSettled(guestId, null);
        return;
      }
      const result = await readBrief(runId, guestId);
      if (stopped || !result.ok) return;
      if (result.value.status === "done" || result.value.status === "failed") {
        stopped = true;
        onSettled(guestId, result.value);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(firstTick);
      clearInterval(clockTimer);
      clearInterval(pollTimer);
    };
  }, [phase, runId, guestId, onSettled]);

  const ask = async () => {
    setPhase({ kind: "starting" });
    const result = await requestBrief(runId, guestId);
    if (!result.ok) {
      setPhase({ kind: "idle", line: refusalLine(result) });
      return;
    }
    if (result.value.kind === "done") {
      onSettled(guestId, { status: "done", brief: result.value.brief });
      return;
    }
    const at = Date.now();
    onStarted(guestId, at);
    setSeconds(0);
    setPhase({ kind: "writing", since: at });
  };

  if (phase.kind === "writing") {
    return (
      <div className="mt-9" aria-live="polite">
        <p className="font-body text-[16px] text-rice-dim">Writing the brief...</p>
        <p className="mt-2 font-mono text-[13px] text-rice-dim tabular-nums">{clock(seconds)}</p>
      </div>
    );
  }

  return (
    <div className="mt-9">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
        <button
          type="button"
          onClick={ask}
          disabled={phase.kind === "starting"}
          className={`${PRIMARY_BUTTON} md:shrink-0 disabled:cursor-wait disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:brightness-100`}
        >
          {phase.kind === "starting" ? "Starting..." : "Write this guest's brief"}
        </button>
        <p className="font-body text-[14px] text-rice-dim">About fifteen seconds.</p>
      </div>
      {phase.kind === "idle" && phase.line && (
        <p aria-live="polite" className="mt-4 max-w-[52ch] font-body text-[15px] text-rice">
          {phase.line}
        </p>
      )}
    </div>
  );
}
