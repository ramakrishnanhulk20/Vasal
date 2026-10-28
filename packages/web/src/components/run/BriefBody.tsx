"use client";

import { useRef } from "react";
import type { ReactNode, RefObject } from "react";
import type { BriefState } from "@/lib/brief";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import type { RunGuest } from "@/lib/runPage";
import { useCopy } from "@/lib/useCopy";

const LABEL = "font-mono text-xs uppercase tracking-[0.14em] text-rice-dim";
const PARAGRAPH = "mt-3 font-body text-[18px] leading-[1.6] text-rice";

function CopyPitchButton({
  text,
  shown,
}: {
  text: string;
  shown: RefObject<HTMLDivElement | null>;
}) {
  const { copied, blocked, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text, shown.current)}
      aria-live="polite"
      className={`absolute right-3 top-3 ${COPY_BUTTON}`}
    >
      {copied ? "Copied" : blocked ? "Copy blocked" : "Copy pitch"}
    </button>
  );
}

// "listeners 55 and older" reads as "55 and older" after "leans toward".
export function leanText(bringsNew: string): string {
  return bringsNew.replace(/^listeners /, "");
}

// writer, when given, stands in for a brief that has not been written yet.
export function BriefBody({
  guest,
  state,
  writer,
}: {
  guest: RunGuest;
  state: BriefState;
  writer?: ReactNode;
}) {
  const pitch = useRef<HTMLDivElement>(null);
  const fit = guest.fitKnown ? `${Math.round(guest.fit * 100)}% fit` : "Fit not scored";
  return (
    <div>
      <h2 className="font-display text-[length:clamp(2rem,3vw,2.75rem)] font-[350] leading-[1.05] text-rice">
        {guest.name}
      </h2>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[14px]">
        <span className="text-rice">{fit}</span>
        {guest.bringsNew !== null && (
          <span className="text-accent">{`fans lean toward ${leanText(guest.bringsNew)}`}</span>
        )}
      </p>
      {state.status === "done" ? (
        <>
          <section className="mt-9">
            <p className={LABEL}>WHY THEM</p>
            <p className={PARAGRAPH}>{state.brief.why}</p>
          </section>
          <section className="mt-9">
            <p className={LABEL}>THE ANGLE</p>
            <p className={PARAGRAPH}>{state.brief.angle}</p>
          </section>
          <section className="mt-9">
            <p className={LABEL}>QUESTIONS</p>
            <ol className="mt-3 list-decimal space-y-[14px] pl-7 font-body text-[17px] leading-[1.55] text-rice marker:font-mono marker:text-[14px] marker:text-rice-dim">
              {state.brief.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ol>
          </section>
          <section className="mt-9">
            <p className={LABEL}>THE PITCH</p>
            <div className="relative mt-3 rounded-lg border border-rule bg-night-2 px-6 py-[22px]">
              <CopyPitchButton
                text={`Subject: ${state.brief.pitchSubject}\n\n${state.brief.pitchBody}`}
                shown={pitch}
              />
              <p className={LABEL}>SUBJECT</p>
              <div ref={pitch}>
                <p className="mt-2 font-body text-[16px] text-rice">{state.brief.pitchSubject}</p>
                <p className="mt-[18px] whitespace-pre-wrap font-body text-[16px] leading-[1.65] text-rice">
                  {state.brief.pitchBody}
                </p>
              </div>
            </div>
            <p className="mt-4 font-mono text-[11px] text-rice-dim">
              AI DRAFT. EVERY NUMBER AND NAME IS FILLED IN BY CODE FROM QLOO; READ IT BEFORE YOU
              SEND IT.
            </p>
          </section>
        </>
      ) : writer && (state.status === "none" || state.status === "pending") ? (
        writer
      ) : (
        <p className="mt-9 font-body text-[16px] text-rice-dim">
          {state.status === "failed"
            ? "This guest's brief could not be written."
            : "This guest's brief has not been written yet."}
        </p>
      )}
    </div>
  );
}
