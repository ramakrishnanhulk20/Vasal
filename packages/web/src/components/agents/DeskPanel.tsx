"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CopyButton } from "@/components/agents/CopyButton";
import { SetupTabs } from "@/components/agents/SetupTabs";
import { DOTS, LOOP } from "@/components/Mark";
import type { IssuedKey } from "@/lib/agentKeys";
import { SHRINK } from "@/lib/kolamDrawing";
import { scalePath, DRAW_SCALE } from "@/lib/pathLength";
import { formatRunDate } from "@/lib/showcase";
import { KICKER } from "@/lib/textStyles";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const DRAW_SECONDS = 1.2;
const KEY_DELAY = 0.9;
const STROKE = 0.1875;
const DIM = 0.35;

const LOOP_SCALED = scalePath(LOOP);

// The Mark's four dots at 96px. When a key arrives the Mark's loop draws
// itself through them, then the dots come up to full strength.
function DeskMark({ issued, reduce }: { issued: boolean; reduce: boolean }) {
  return (
    <svg
      width="96"
      height="96"
      viewBox="0 0 4 4"
      fill="none"
      aria-hidden="true"
      className="shrink-0 overflow-visible"
    >
      {issued && (
        <g transform={SHRINK}>
          <motion.path
            d={LOOP_SCALED}
            className="stroke-accent"
            strokeWidth={STROKE * DRAW_SCALE}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: reduce ? 1 : 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: reduce ? 0 : DRAW_SECONDS, ease: EASE }}
          />
        </g>
      )}
      {DOTS.map(([x, y]) => (
        <motion.circle
          key={`${x}-${y}`}
          cx={x}
          cy={y}
          r="0.25"
          className="fill-rice"
          initial={{ opacity: DIM }}
          animate={{ opacity: issued ? 1 : DIM }}
          transition={{ duration: reduce ? 0 : 0.3, delay: issued && !reduce ? DRAW_SECONDS : 0 }}
        />
      ))}
    </svg>
  );
}

function KeyBlock({
  issued,
  onCopied,
}: {
  issued: IssuedKey;
  onCopied: (copiedText: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const keyText = useRef<HTMLDivElement>(null);

  // The button that asked for the key is gone by now, so focus lands here.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <motion.div
      ref={ref}
      data-rise=""
      role="group"
      aria-label="Your agent key"
      tabIndex={-1}
      className="mt-8 outline-none"
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.5, delay: reduce ? 0 : KEY_DELAY, ease: EASE }}
    >
      <p className={KICKER}>YOUR AGENT KEY</p>
      <p className="mt-2 font-body text-[14px] text-rice-dim">
        {`Shown once. Vasal keeps only a scrambled fingerprint of it, so it can't show it to you again.`}
      </p>
      <div className="relative mt-4">
        <div
          ref={keyText}
          className="break-all rounded-lg border border-rule bg-night py-4 pl-[18px] pr-32 font-mono text-[15px] text-rice"
        >
          {issued.token}
        </div>
        <CopyButton
          text={issued.token}
          shown={keyText}
          label="Copy key"
          onCopied={onCopied}
          className="absolute right-3 top-3"
        />
      </div>
      <p className="mt-[10px] font-mono text-[12px] text-rice-dim">
        {`Expires ${formatRunDate(issued.expiresAt)}, UTC`}
      </p>
    </motion.div>
  );
}

export function DeskPanel({
  issued,
  onCopied,
}: {
  issued: IssuedKey | null;
  onCopied: (copiedText: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="relative rounded-lg border border-rule bg-night-2 p-5 md:p-8">
      <div className="flex flex-col gap-5 md:flex-row md:items-center md:gap-8">
        <DeskMark issued={issued !== null} reduce={reduce} />
        <AnimatePresence>
          {issued === null && (
            <motion.div
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.25 }}
              className="min-w-0"
            >
              <p className="font-display text-[26px] font-[350] leading-[1.15] text-rice">
                Your key appears here, once.
              </p>
              <p className="mt-2 max-w-[36ch] font-body text-[15px] text-rice-dim">
                Pass the human check on the left. The key is shown on this page and nowhere else.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {issued !== null && <KeyBlock issued={issued} onCopied={onCopied} />}
      <SetupTabs apiKey={issued?.token ?? null} onCopied={onCopied} />
    </div>
  );
}
