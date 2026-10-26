"use client";

import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { RunHeader } from "@/components/run/RunHeader";
import { RunStopped } from "@/components/run/RunStopped";
import { confirmRun, followRun, readRun } from "@/lib/api";
import type { Candidate, Failure, LiveStep, RunSnapshot } from "@/lib/api";
import { PRIMARY_BUTTON, SECONDARY_LINK } from "@/lib/buttonStyle";
import { failureReason } from "@/lib/failure";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const POLL_MS = 3_000;
const REFRESH_DELAY_MS = 600;
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice";

type Phase = "working" | "choosing" | "ready" | "failed";

type Note = { text: string; link?: { href: string; label: string } };

type State = {
  phase: Phase;
  mode: "stream" | "poll";
  candidates: Candidate[];
  chosen: Candidate | null;
  confirming: string | null;
  // The stream replays every event to a new source. Once the show has been
  // picked, or the page opened on a run that is past the pick, a replayed
  // candidates event must not send the page back to the pick.
  pastPick: boolean;
  note: Note | null;
  steps: LiveStep[];
  failureCode: string | null;
  readyAt: number | null;
  doneAt: number | null;
};

type Action =
  | { type: "step"; step: LiveStep }
  | { type: "candidates"; list: Candidate[]; fromStream: boolean }
  | { type: "confirming"; id: string }
  | { type: "confirmFailed"; note: Note }
  | { type: "confirmed"; candidate: Candidate }
  | { type: "ready"; at: number }
  | { type: "done"; at: number }
  | { type: "failed"; code: string | null }
  | { type: "poll" }
  | { type: "snapshot"; snapshot: RunSnapshot; at: number };

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "step":
      return { ...state, steps: [...state.steps, action.step] };
    case "candidates":
      if (state.phase === "failed" || state.phase === "ready") return state;
      if (action.fromStream && state.pastPick) return state;
      return {
        ...state,
        phase: "choosing",
        candidates: action.list,
        confirming: null,
        pastPick: action.fromStream ? true : state.pastPick,
      };
    case "confirming":
      return { ...state, confirming: action.id, note: null };
    case "confirmFailed":
      return { ...state, confirming: null, note: action.note };
    case "confirmed":
      return {
        ...state,
        phase: "working",
        chosen: action.candidate,
        confirming: null,
        pastPick: true,
        note: null,
      };
    case "ready":
      if (state.phase === "failed") return state;
      return { ...state, phase: "ready", readyAt: state.readyAt ?? action.at };
    case "done":
      if (state.phase === "failed") return state;
      return {
        ...state,
        phase: "ready",
        readyAt: state.readyAt ?? action.at,
        doneAt: action.at,
      };
    case "failed":
      return { ...state, phase: "failed", failureCode: action.code };
    case "poll":
      return { ...state, mode: "poll" };
    case "snapshot": {
      const { status, errorCode, candidates } = action.snapshot;
      if (status === "done") return reduce(state, { type: "done", at: action.at });
      if (status === "failed") return reduce(state, { type: "failed", code: errorCode });
      if (status === "awaiting_confirm" && candidates && candidates.length > 0) {
        return state.phase === "choosing"
          ? state
          : reduce(state, { type: "candidates", list: candidates, fromStream: false });
      }
      if (state.phase === "choosing" && state.confirming === null && status === "running") {
        return { ...state, phase: "working" };
      }
      return state;
    }
  }
}

function confirmNote(failure: Failure): Note {
  const { status, code } = failure;
  if (status === 410)
    return {
      text: failureReason("CONFIRM_EXPIRED"),
      link: { href: "/#try", label: "Back to the home page" },
    };
  if (status === 404) return { text: "This page couldn't start a run. Reload it and try again." };
  if (status === 429 && code === "BUSY") {
    return { text: "Vasal is building as many boards as it can right now. Try again in a minute." };
  }
  if (status === 503 && code === "LIVE_RUNS_OFF") {
    return {
      text: "Live runs open on 30 October, when judging starts. Until then, open one of the boards on the home page.",
      link: { href: "/#showcase", label: "Back to the home page" },
    };
  }
  return { text: "Vasal couldn't be reached. Try again in a minute." };
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Counts from the run's own start time. Once the board is ready it stays put.
function useElapsed(createdAt: string, stoppedAt: number | null, active: boolean): number {
  const start = Date.parse(createdAt);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active) return () => {};
      const timer = setInterval(onChange, 1_000);
      return () => clearInterval(timer);
    },
    [active],
  );
  const live = useSyncExternalStore(
    subscribe,
    () => Math.floor((Date.now() - start) / 1_000),
    () => 0,
  );
  const seconds = stoppedAt !== null ? Math.floor((stoppedAt - start) / 1_000) : live;
  return Math.max(0, seconds);
}

const noSubscription = () => () => {};

function startedTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function LiveRun({
  runId,
  status,
  createdAt,
  errorCode,
  candidates,
}: {
  runId: string;
  status: string;
  createdAt: string;
  errorCode: string | null;
  candidates: Candidate[];
}) {
  const router = useRouter();
  const motionOff = useReducedMotion() ?? false;
  const [state, dispatch] = useReducer(reduce, undefined, (): State => {
    const choosing = status === "awaiting_confirm" && candidates.length > 0;
    return {
      phase: status === "failed" ? "failed" : choosing ? "choosing" : "working",
      mode: "stream",
      candidates,
      chosen: null,
      confirming: null,
      pastPick: candidates.length > 0 && status !== "awaiting_confirm",
      note: null,
      steps: [],
      failureCode: errorCode,
      readyAt: null,
      doneAt: null,
    };
  });
  const lastSeen = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );

  // The server replays the whole stream to a new source, so an event is used
  // only the first time its id is seen.
  const fresh = useCallback((id: number): boolean => {
    if (id <= lastSeen.current) return false;
    lastSeen.current = id;
    return true;
  }, []);

  const following =
    state.mode === "stream" && (state.phase === "working" || state.phase === "ready");
  useEffect(() => {
    if (!following) return;
    return followRun(runId, {
      onStep: (id, step) => fresh(id) && dispatch({ type: "step", step }),
      onCandidates: (id, list) =>
        fresh(id) && dispatch({ type: "candidates", list, fromStream: true }),
      onBoard: (id) => fresh(id) && dispatch({ type: "ready", at: Date.now() }),
      onDone: (id) => fresh(id) && dispatch({ type: "done", at: Date.now() }),
      onFailed: (id, code) => fresh(id) && dispatch({ type: "failed", code }),
      onUnavailable: () => dispatch({ type: "poll" }),
    });
  }, [runId, following, fresh]);

  // Polling covers a stream that cannot be used, and a finished board whose
  // done event never arrived.
  const polling =
    (state.mode === "poll" && (state.phase === "working" || state.phase === "choosing")) ||
    (state.phase === "ready" && state.doneAt === null);
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const result = await readRun(runId);
      if (!stopped && result.ok)
        dispatch({ type: "snapshot", snapshot: result.value, at: Date.now() });
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, polling]);

  // The server renders the finished board once the run is done. The first
  // refresh may still see a run that is finishing, so each of ready and done
  // asks again.
  useEffect(() => {
    if (state.readyAt === null && state.doneAt === null) return;
    const timer = setTimeout(() => router.refresh(), REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state.readyAt, state.doneAt, router]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [state.steps.length]);

  const elapsed = useElapsed(createdAt, state.readyAt, state.phase === "working");

  const choose = async (candidate: Candidate) => {
    if (state.confirming !== null) return;
    dispatch({ type: "confirming", id: candidate.id });
    const result = await confirmRun(runId, candidate.id);
    // A run that was already confirmed elsewhere is simply followed.
    if (result.ok || (result.status === 409 && result.code === "NOT_AWAITING")) {
      dispatch({ type: "confirmed", candidate });
      return;
    }
    dispatch({ type: "confirmFailed", note: confirmNote(result) });
  };

  const name = state.chosen?.name ?? "Your run";
  const meta = [`Started ${mounted ? startedTime(createdAt) : "--:--"}`];

  return (
    <>
      <RunHeader name={name} meta={meta} kolam={null} />

      {state.phase === "failed" && <RunStopped code={state.failureCode} />}

      {state.phase === "choosing" && (
        <div className="mt-14 grid grid-cols-12">
          <div className="col-span-12 md:col-span-8">
            <p className={KICKER}>WHICH SHOW DID YOU MEAN?</p>
            <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
              {state.candidates.length === 1 ? "Is this your show?" : "Pick your show."}
            </h2>
            <ul className="mt-10">
              {state.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    disabled={state.confirming !== null}
                    onClick={() => choose(candidate)}
                    className={`flex w-full items-baseline justify-between gap-4 border-b border-rule px-[14px] py-[18px] text-left transition-colors duration-150 ease-out enabled:hover:bg-night-2/60 disabled:cursor-wait ${FOCUS}`}
                  >
                    <span>
                      <span className="block font-display text-[26px] font-[350] leading-[1.15] text-rice">
                        {candidate.name}
                      </span>
                      {candidate.publisher && (
                        <span className="mt-1 block font-body text-[15px] text-rice-dim">
                          {candidate.publisher}
                        </span>
                      )}
                    </span>
                    {state.confirming === candidate.id && (
                      <span className="shrink-0 font-mono text-xs text-rice-dim">Starting...</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {state.candidates.length === 1 && state.candidates[0] && (
              <div className="mt-8 flex">
                <button
                  type="button"
                  disabled={state.confirming !== null}
                  onClick={() => state.candidates[0] && choose(state.candidates[0])}
                  className={`${PRIMARY_BUTTON} disabled:cursor-wait disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:brightness-100`}
                >
                  Yes, that&apos;s my show
                </button>
              </div>
            )}
            {state.note && (
              <div aria-live="polite" className="mt-6 max-w-[52ch]">
                <p className="font-body text-[15px] text-rice">{state.note.text}</p>
                {state.note.link && (
                  <div className="mt-4 flex">
                    <Link href={state.note.link.href} className={SECONDARY_LINK}>
                      <span className="link-draw">{state.note.link.label}</span>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {(state.phase === "working" || state.phase === "ready") && (
        <div className="mt-14 grid grid-cols-12 gap-y-10">
          <div className="col-span-12 md:col-span-6">
            <p className={KICKER}>
              {state.phase === "ready" ? "THE BOARD IS READY" : "THE AGENT IS WORKING"}
            </p>
            <p
              role="timer"
              className="mt-5 font-display text-[length:clamp(3rem,6vw,5rem)] font-light leading-none text-rice tabular-nums"
            >
              {clock(elapsed)}
            </p>
            <p className="mt-5 max-w-[40ch] font-body text-[17px] leading-[1.6] text-rice-dim">
              Usually about a minute. Every step below is a real call to Qloo, the feed or the
              model.
            </p>
          </div>
          <div className="col-span-12 md:col-span-6">
            {state.mode === "poll" ? (
              <p className="font-body text-[15px] text-rice-dim">
                Following this run every few seconds.
              </p>
            ) : (
              <>
                <h2
                  className="font-display text-[length:clamp(1.75rem,2.6vw,2.5rem)] font-[350] leading-[1.02] tracking-[-0.015em] text-rice"
                  style={SOFT_100}
                >
                  {`${state.steps.length} steps so far`}
                </h2>
                <ol
                  ref={listRef}
                  data-lenis-prevent
                  className="mt-6 max-h-[min(60vh,34rem)] divide-y divide-rule overflow-y-auto"
                >
                  {state.steps.map((step, index) => (
                    <motion.li
                      key={index}
                      data-rise=""
                      className="flex items-baseline py-[6px]"
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: motionOff ? 0 : 0.35, ease: EASE }}
                    >
                      <span className="w-10 shrink-0 font-mono text-[13px] text-rice-dim">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 flex-1 font-body text-[16px] leading-[1.5] text-rice">
                        {step.label}
                      </span>
                      <span
                        role="img"
                        aria-label={step.ok ? "Succeeded" : "Did not succeed"}
                        className={`ml-4 h-[6px] w-[6px] shrink-0 self-center rounded-full ${step.ok ? "bg-rice" : "bg-status"}`}
                      />
                    </motion.li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
