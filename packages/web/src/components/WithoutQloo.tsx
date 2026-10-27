"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";
import type { Proof, ProofGuess, ProofRun } from "@/lib/showcase";

const COUNT_UP_MS = 1200;
const CROSSFADE = 0.3;
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice";
const COLUMN_HEAD = "font-mono text-xs uppercase tracking-[0.14em] text-rice-dim";
const ROW = "mt-[14px] flex items-baseline justify-between gap-4 border-b border-rule pb-[14px]";
const FIT = "shrink-0 font-mono text-[13px] text-rice-dim";

function fitLabel(fit: number | null, fitKnown: boolean): string {
  return fitKnown && fit !== null ? `${Math.round(fit * 100)}% fit` : "not scored";
}

// Writes straight into the text node so the count never re-renders React.
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = ref.current;
    const text = node?.firstChild;
    if (!node || !(text instanceof Text)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    text.nodeValue = "0";
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - start) / COUNT_UP_MS);
          text.nodeValue = String(Math.round(value * (1 - (1 - progress) ** 3)));
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      text.nodeValue = String(value);
    };
  }, [value]);

  return <span ref={ref}>{value}</span>;
}

export function GuessRow({
  guess,
  index,
  lead,
  inView,
  reduce,
}: {
  guess: ProofGuess;
  index: number;
  lead: number;
  inView: boolean;
  reduce: boolean;
}) {
  const known = guess.pastGuest || guess.host;
  return (
    <li className={ROW}>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="relative inline-block">
          <span
            className={`font-display text-[24px] leading-[1.2] ${known ? "text-rice-dim" : "text-rice"}`}
          >
            {guess.name}
          </span>
          {known && (
            <motion.span
              data-rise=""
              aria-hidden="true"
              className="absolute left-0 top-[58%] h-[2px] w-full origin-left -translate-y-1/2 bg-status"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: inView ? 1 : 0 }}
              transition={{
                duration: reduce ? 0 : 0.5,
                delay: reduce ? 0 : lead + 0.08 * index,
                ease: "easeOut",
              }}
            />
          )}
        </span>
        {known && (
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-status">
            {guess.host ? "HOSTS THE SHOW" : "ALREADY ON THE SHOW"}
          </span>
        )}
      </span>
      <span className={FIT}>{fitLabel(guess.fit, guess.fitKnown)}</span>
    </li>
  );
}

function Comparison({
  run,
  lead,
  inView,
  reduce,
}: {
  run: ProofRun;
  lead: number;
  inView: boolean;
  reduce: boolean;
}) {
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduce ? 0 : CROSSFADE },
  };
  return (
    <div className="mt-10 grid grid-cols-1 md:grid-cols-2">
      <div className="md:pr-10">
        <p className={COLUMN_HEAD}>With Qloo</p>
        <div className="grid">
          <AnimatePresence initial={false}>
            <motion.ul key={run.runId} className="[grid-area:1/1]" {...fade}>
              {run.board.map((guest) => (
                <li key={`${guest.fitRank}-${guest.name}`} className={ROW}>
                  <span className="font-display text-[24px] leading-[1.2] text-rice">
                    {guest.name}
                  </span>
                  <span className={FIT}>{fitLabel(guest.fit, guest.fitKnown)}</span>
                </li>
              ))}
            </motion.ul>
          </AnimatePresence>
        </div>
      </div>
      <div className="mt-10 border-t border-rule pt-10 md:mt-0 md:border-l md:border-t-0 md:pl-10 md:pt-0">
        <p className={COLUMN_HEAD}>Without Qloo, the same model</p>
        <div className="grid">
          <AnimatePresence initial={false}>
            <motion.ul key={run.runId} className="[grid-area:1/1]" {...fade}>
              {run.guesses.map((guess, index) => (
                <GuessRow
                  key={`${index}-${guess.name}`}
                  guess={guess}
                  index={index}
                  lead={lead}
                  inView={inView}
                  reduce={reduce}
                />
              ))}
            </motion.ul>
          </AnimatePresence>
        </div>
        <p className="mt-6 font-mono text-xs text-rice-dim">
          {`Each guess was scored by Qloo and checked against the show's episode history, the same way as the board.`}
        </p>
      </div>
    </div>
  );
}

export function WithoutQloo({ proof }: { proof: Proof }) {
  const { runs, guessesTotal, alreadyOnShow } = proof;
  const [selected, setSelected] = useState(0);
  const [lead, setLead] = useState(0);
  const reduce = useReducedMotion() ?? false;
  const comparisonRef = useRef<HTMLDivElement>(null);
  const inView = useInView(comparisonRef, { once: true, amount: 0.25 });
  const run = runs[selected];
  if (!run) return null;

  const choose = (index: number) => {
    if (index === selected) return;
    setSelected(index);
    // On screen, the lines wait for the crossfade before they draw again.
    setLead(inView ? CROSSFADE : 0);
  };

  return (
    <section id="without-qloo" className="relative z-20 min-h-screen px-[6vw] py-[18vh]">
      <div className="grid grid-cols-12">
        <p className={`col-span-12 ${KICKER}`}>WITHOUT QLOO</p>
        <h2 className={`col-span-12 mt-5 md:col-span-8 ${SECTION_TITLE}`} style={SOFT_100}>
          Ask a model alone, and it suggests people the show has already had.
        </h2>
        <p
          className="col-span-12 mt-[8vh] font-display text-[length:clamp(4.5rem,15vw,13rem)] font-light leading-[0.9] tracking-[-0.03em] text-rice md:col-span-7 md:text-[length:clamp(5rem,15vw,13rem)] md:[align-self:last_baseline]"
          style={SOFT_100}
        >
          <CountUp value={alreadyOnShow} /> <span className="text-[0.4em] text-rice-dim">of</span>{" "}
          {guessesTotal}
        </p>
        <p className="col-span-12 mt-6 max-w-[30ch] font-body text-[18px] leading-[1.6] text-rice-dim md:col-span-5 md:col-start-8 md:mt-0 md:[align-self:last_baseline]">
          {`We asked the same model for guests with no Qloo data, for the ${runs.length} shows on this page. That many of its guesses had already been on the show or host it.`}
        </p>
        <div
          role="group"
          aria-label="Show"
          className="col-span-12 -mx-[6vw] mt-[12vh] flex gap-x-[28px] overflow-x-auto px-[6vw] [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&::-webkit-scrollbar]:hidden"
        >
          {runs.map((item, index) => {
            const active = index === selected;
            return (
              <button
                key={item.runId}
                type="button"
                aria-pressed={active}
                onClick={() => choose(index)}
                className={`group shrink-0 cursor-pointer whitespace-nowrap py-[10px] font-body text-[15px] transition-colors duration-250 ease-out hover:text-rice ${active ? "text-rice" : "text-rice-dim"} ${FOCUS}`}
              >
                <span className="relative">
                  {item.tabLabel}
                  <span
                    aria-hidden="true"
                    className={`absolute -bottom-[6px] left-0 h-px w-full origin-left bg-rice transition-[scale] duration-250 ease-out ${active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"}`}
                  />
                </span>
              </button>
            );
          })}
        </div>
        <div ref={comparisonRef} className="col-span-12">
          <Comparison run={run} lead={lead} inView={inView} reduce={reduce} />
        </div>
      </div>
    </section>
  );
}
