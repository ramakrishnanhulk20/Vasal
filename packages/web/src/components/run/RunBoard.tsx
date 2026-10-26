"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { GuessRow } from "@/components/WithoutQloo";
import { BriefBody, leanText } from "@/components/run/BriefBody";
import { BriefWriter } from "@/components/run/BriefWriter";
import { Crossfade } from "@/components/run/Crossfade";
import type { BriefState } from "@/lib/brief";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { SOFT_100 } from "@/lib/textStyles";
import { useIsMobile } from "@/lib/useIsMobile";
import type { RunGuest } from "@/lib/runPage";
import type { ProofGuess } from "@/lib/showcase";

type Mode = "with" | "without";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice";
const CHIP = "rounded-md border px-2 py-[3px] font-mono text-[11px] uppercase tracking-[0.1em]";
const CHIP_PLAIN = `${CHIP} border-rule text-rice-dim`;
const CHIP_LEAN = `${CHIP} border-accent/45 text-accent`;
const TAB =
  "flex-1 rounded-md px-[14px] py-2 font-mono text-[13px] transition-colors duration-150 ease-out md:flex-none";
const NO_BRIEF: BriefState = { status: "none" };

function Chips({ guest }: { guest: RunGuest }) {
  const tags = guest.sharedTags.slice(0, 3);
  if (guest.reach === null && guest.bringsNew === null && tags.length === 0) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-[6px] pl-9">
      {guest.reach !== null && <span className={CHIP_PLAIN}>HOUSEHOLD NAME</span>}
      {guest.bringsNew !== null && (
        <span className={CHIP_LEAN}>{`LEANS TOWARD ${leanText(guest.bringsNew)}`}</span>
      )}
      {tags.map((tag) => (
        <span key={tag} className={CHIP_PLAIN}>
          {tag}
        </span>
      ))}
    </span>
  );
}

export function RunBoard({
  runId,
  promoted,
  guests,
  briefs,
  guesses,
  initialGuestId,
}: {
  runId: string;
  promoted: boolean;
  guests: RunGuest[];
  briefs: Record<string, BriefState>;
  guesses: ProofGuess[] | null;
  initialGuestId: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const mobile = useIsMobile();
  const [mode, setMode] = useState<Mode>("with");
  const [selectedId, setSelectedId] = useState(initialGuestId);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [lead, setLead] = useState(0);
  // Briefs written or being written on this page, kept across guest changes.
  const [written, setWritten] = useState<Record<string, BriefState>>({});
  const [writingSince, setWritingSince] = useState<Record<string, number>>({});
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const sheetRef = useRef<HTMLDivElement>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const inView = useInView(listRef, { once: true, amount: 0.2 });

  const showSheet = sheetOpen && mobile;

  const onStarted = useCallback((guestId: string, at: number) => {
    setWritingSince((current) => ({ ...current, [guestId]: at }));
  }, []);
  const onSettled = useCallback((guestId: string, state: BriefState | null) => {
    setWritingSince((current) => {
      const rest = { ...current };
      delete rest[guestId];
      return rest;
    });
    if (state) setWritten((current) => ({ ...current, [guestId]: state }));
  }, []);

  // The sheet owns a history entry, so the back gesture closes it.
  const closeSheet = useCallback(() => {
    if (window.history.state?.vasalSheet) window.history.back();
    else setSheetOpen(false);
  }, []);

  useEffect(() => {
    if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
  }, [selectedId]);

  useEffect(() => {
    if (!showSheet) return;
    sheetRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeSheet();
    };
    const onPop = () => setSheetOpen(false);
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, [showSheet, closeSheet]);

  useEffect(() => {
    if (wasOpen.current && !showSheet) rowRefs.current[selectedId]?.focus();
    wasOpen.current = showSheet;
  }, [showSheet, selectedId]);

  const selected = guests.find((guest) => guest.id === selectedId) ?? guests[0];
  if (!selected) return null;

  // replaceState, not push: picking a guest should not fill the back button.
  const select = (id: string) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("guest", id);
    window.history.replaceState(window.history.state, "", url);
    if (mobile) {
      window.history.pushState({ vasalSheet: true }, "", url);
      setSheetOpen(true);
    }
  };

  const choose = (next: Mode) => {
    if (next === mode || (next === "without" && !guesses)) return;
    setMode(next);
    setLead(inView ? 0.3 : 0);
    if (sheetOpen) closeSheet();
  };

  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    choose(mode === "with" ? "without" : "with");
  };

  // A run on the showcase has every brief stored, so only other runs offer to write one.
  const briefOf = (guest: RunGuest) => {
    const state = written[guest.id] ?? briefs[guest.id] ?? NO_BRIEF;
    const writer = promoted ? undefined : (
      <BriefWriter
        key={guest.id}
        runId={runId}
        guestId={guest.id}
        alreadyPending={state.status === "pending"}
        since={writingSince[guest.id]}
        onStarted={onStarted}
        onSettled={onSettled}
      />
    );
    return <BriefBody guest={guest} state={state} writer={writer} />;
  };

  const already = guesses ? guesses.filter((guess) => guess.pastGuest || guess.host).length : 0;

  return (
    <>
      <div inert={showSheet}>
        <div
          role="tablist"
          aria-label="Board view"
          onKeyDown={onTabKey}
          className="mt-9 flex w-full rounded-lg border border-rule p-1 md:inline-flex md:w-auto"
        >
          <button
            type="button"
            role="tab"
            id="run-tab-with"
            aria-selected={mode === "with"}
            aria-controls="run-workspace"
            tabIndex={mode === "with" ? 0 : -1}
            onClick={() => choose("with")}
            className={`${TAB} ${FOCUS} ${mode === "with" ? "bg-night-2 text-rice" : "text-rice-dim hover:text-rice"}`}
          >
            With Qloo
          </button>
          <button
            type="button"
            role="tab"
            id="run-tab-without"
            aria-selected={mode === "without"}
            aria-controls="run-workspace"
            tabIndex={mode === "without" ? 0 : -1}
            disabled={!guesses}
            onClick={() => choose("without")}
            className={`${TAB} ${FOCUS} disabled:cursor-not-allowed disabled:opacity-45 ${mode === "without" ? "bg-night-2 text-rice" : "text-rice-dim enabled:hover:text-rice"}`}
          >
            Without Qloo
          </button>
        </div>

        <div
          id="run-workspace"
          role="tabpanel"
          aria-labelledby={mode === "with" ? "run-tab-with" : "run-tab-without"}
          className="mt-14 md:grid md:grid-cols-12"
        >
          <div ref={listRef} className="md:col-span-5">
            <Crossfade id={mode} duration={0.3}>
              {mode === "with" || !guesses ? (
                <ul>
                  {guests.map((guest, index) => {
                    const isSelected = guest.id === selected.id;
                    return (
                      <li key={guest.id}>
                        <button
                          type="button"
                          ref={(element) => {
                            rowRefs.current[guest.id] = element;
                          }}
                          aria-current={isSelected ? "true" : undefined}
                          onClick={() => select(guest.id)}
                          className={`relative block w-full border-b border-rule px-[14px] py-[18px] text-left transition-colors duration-150 ease-out ${isSelected ? "bg-night-2" : "hover:bg-night-2/60"} ${FOCUS}`}
                        >
                          {isSelected && (
                            <span
                              aria-hidden="true"
                              className="absolute inset-y-0 left-0 w-[2px] bg-rice"
                            />
                          )}
                          <span className="flex items-baseline">
                            <span className="w-9 shrink-0 font-mono text-[13px] text-rice-dim">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <span className="min-w-0 font-display text-[26px] font-[350] leading-[1.15] text-rice">
                              {guest.name}
                            </span>
                            <span className="ml-auto shrink-0 pl-4 font-mono text-[15px] text-rice">
                              {guest.fitKnown ? `${Math.round(guest.fit * 100)}%` : "not scored"}
                            </span>
                          </span>
                          <Chips guest={guest} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul>
                  {guesses.map((guess, index) => (
                    <GuessRow
                      key={`${index}-${guess.name}`}
                      guess={guess}
                      index={index}
                      lead={lead}
                      inView={inView}
                      reduce={reduce}
                    />
                  ))}
                </ul>
              )}
            </Crossfade>
          </div>

          <div
            className={`md:col-span-6 md:col-start-7 ${mode === "without" ? "mt-10 md:mt-0" : ""}`}
          >
            <div
              ref={panelScrollRef}
              data-lenis-prevent
              className="md:sticky md:top-24 md:max-h-[calc(100vh-120px)] md:overflow-y-auto md:border-l md:border-rule md:pl-9"
            >
              <Crossfade id={mode} duration={0.3}>
                {mode === "with" || !guesses ? (
                  <div className="hidden md:block">
                    {!mobile && (
                      <Crossfade id={selected.id} duration={0.25}>
                        {briefOf(selected)}
                      </Crossfade>
                    )}
                  </div>
                ) : (
                  <div>
                    <h2
                      className="font-display text-[length:clamp(1.75rem,2.6vw,2.5rem)] font-[350] leading-[1.02] tracking-[-0.015em] text-rice"
                      style={SOFT_100}
                    >
                      {`${already} of ${guesses.length} of these had already been on the show.`}
                    </h2>
                    <p className="mt-[18px] font-body text-[18px] leading-[1.6] text-rice-dim">
                      {`We asked the same model for guests with no Qloo data. Each guess was scored by Qloo and checked against the show's episode history, the same way as the board.`}
                    </p>
                  </div>
                )}
              </Crossfade>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showSheet && (
          <motion.div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={selected.name}
            tabIndex={-1}
            data-lenis-prevent
            className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain bg-night px-[6vw] pb-16 outline-none"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: reduce ? 0 : 0.35, ease: EASE }}
          >
            <div className="sticky top-0 z-10 -mx-[6vw] flex justify-end bg-night px-[6vw] py-4">
              <button type="button" onClick={closeSheet} className={COPY_BUTTON}>
                Close
              </button>
            </div>
            {briefOf(selected)}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
