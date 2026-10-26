"use client";

import Link from "next/link";
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Variants } from "motion/react";
import { KolamFocus } from "@/components/KolamFocus";
import { useStoryFrame } from "@/components/StoryDriver";
import { PRIMARY_BUTTON } from "@/lib/buttonStyle";
import { buildDrawing } from "@/lib/kolamDrawing";
import type { DrawnRing } from "@/lib/kolamDrawing";
import type { Run } from "@/lib/run";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const PANEL: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, staggerChildren: 0.05 } },
  exit: { opacity: 0, transition: { duration: 0.2 } },
};
const ITEM: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } },
};
const PANEL_INSTANT: Variants = {
  hidden: { opacity: 1, y: 0 },
  show: { opacity: 1, y: 0, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } },
};
const ITEM_INSTANT: Variants = {
  hidden: { opacity: 1, y: 0 },
  show: { opacity: 1, y: 0, transition: { duration: 0 } },
};

const KICKER = "font-mono text-[13px] uppercase tracking-[0.14em] text-rice-dim";
const TITLE =
  "font-display text-[length:clamp(2rem,4vw,3.75rem)] font-[350] leading-[1.02] tracking-[-0.015em] text-rice md:text-[length:clamp(2.25rem,4vw,3.75rem)]";
const NAME =
  "font-display text-[length:clamp(2.25rem,4.6vw,4.25rem)] font-[350] leading-none text-rice md:text-[length:clamp(2.5rem,4.6vw,4.25rem)]";
const BODY = "font-body text-[18px] leading-[1.6] text-rice-dim";
const SOFT_100 = { fontVariationSettings: '"SOFT" 100' };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function monthYear(since: string): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(since);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : null;
}

function closingBody(run: Run): string {
  const { episodes, archiveTitles, since } = run.pastGuests;
  const count = (value: number) => value.toLocaleString("en-US");
  const archived = archiveTitles > 0 ? ` and ${count(archiveTitles)} archived ones` : "";
  const month = since ? monthYear(since) : null;
  const back = month ? `, back to ${month}` : "";
  return `${count(episodes)} episodes from the show's feed${archived}${back}. Anyone who has been on the show before, or hosts it, is left off the board.`;
}

function Frame({ reduce, children }: { reduce: boolean; children: ReactNode }) {
  return (
    <motion.div
      variants={reduce ? PANEL_INSTANT : PANEL}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}

function Item({
  reduce,
  className,
  children,
}: {
  reduce: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div variants={reduce ? ITEM_INSTANT : ITEM} className={className}>
      {children}
    </motion.div>
  );
}

function IntroFrame({ run, reduce }: { run: Run; reduce: boolean }) {
  const show = run.pastGuests.feedName ?? "this show";
  return (
    <Frame reduce={reduce}>
      <Item reduce={reduce}>
        <p className={KICKER}>THE BOARD, ONE GUEST AT A TIME</p>
      </Item>
      <Item reduce={reduce} className="mt-5">
        <h2 className={TITLE} style={SOFT_100}>
          Each loop is a guest. Each dot is a taste their fans share with your listeners.
        </h2>
      </Item>
      <Item reduce={reduce} className="mt-6">
        <p className={BODY}>
          {`This board was built for ${show} from Qloo's taste graph, ranked by how closely each guest's fans match the show's listeners.`}
        </p>
      </Item>
    </Frame>
  );
}

function GuestFrame({
  ring,
  number,
  total,
  reduce,
}: {
  ring: DrawnRing;
  number: number;
  total: number;
  reduce: boolean;
}) {
  const { guest } = ring;
  const fit = guest.fitKnown ? `${Math.round(guest.fit * 100)}% fit` : "Fit not scored";
  return (
    <Frame reduce={reduce}>
      <Item reduce={reduce}>
        <p className={KICKER}>{`${number} OF ${total}`}</p>
      </Item>
      <Item reduce={reduce} className="mt-4">
        <h2 className={NAME} style={SOFT_100}>
          {guest.name}
        </h2>
      </Item>
      <Item reduce={reduce} className="mt-[18px] flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-[15px] text-rice">{fit}</span>
        {guest.bringsNew !== null && (
          <span className="font-mono text-[15px] text-accent">
            {`fans lean toward ${guest.bringsNew.replace(/^listeners /, "")}`}
          </span>
        )}
      </Item>
      {guest.sharedTags.length > 0 && (
        <Item reduce={reduce} className="mt-[22px] flex flex-wrap gap-2">
          {guest.sharedTags.map((tag) => (
            <span
              key={tag}
              className="rounded-lg border border-rule px-[10px] py-[6px] font-mono text-xs uppercase tracking-[0.08em] text-rice-dim"
            >
              {tag}
            </span>
          ))}
        </Item>
      )}
      <Item reduce={reduce} className="mt-[26px]">
        <p className="line-clamp-4 max-w-[40ch] font-body text-[19px] leading-[1.6] text-rice-dim md:line-clamp-none">
          {guest.angle}
        </p>
      </Item>
    </Frame>
  );
}

function ClosingFrame({
  run,
  drawn,
  reduce,
  boardHref,
}: {
  run: Run;
  drawn: number;
  reduce: boolean;
  boardHref: string;
}) {
  const total = run.board.length;
  return (
    <Frame reduce={reduce}>
      <Item reduce={reduce}>
        <p className={KICKER}>CHECKED</p>
      </Item>
      <Item reduce={reduce} className="mt-5">
        <h2 className={TITLE} style={SOFT_100}>
          Every name, checked against the show&apos;s history.
        </h2>
      </Item>
      <Item reduce={reduce} className="mt-6">
        <p className={BODY}>{closingBody(run)}</p>
      </Item>
      <Item reduce={reduce} className="mt-8 flex">
        <Link href={boardHref} className={PRIMARY_BUTTON}>
          See the full board
        </Link>
      </Item>
      {total > drawn && (
        <Item reduce={reduce} className="mt-4">
          <p className="font-mono text-xs text-rice-dim">
            {`${total} guests on the full board, ${drawn} drawn here.`}
          </p>
        </Item>
      )}
    </Frame>
  );
}

function Rail({ frames, index }: { frames: number; index: number }) {
  return (
    <div
      aria-hidden="true"
      className="absolute right-[2.5vw] top-1/2 hidden -translate-y-1/2 flex-col gap-[10px] md:flex"
    >
      {Array.from({ length: frames }, (_, tick) => (
        <span
          key={tick}
          className={`w-[2px] transition-[height] duration-300 ease-out motion-reduce:transition-none ${tick === index ? "h-7 bg-rice" : "h-[18px] bg-rule"}`}
        />
      ))}
    </div>
  );
}

export function GuestStory({ run, boardHref }: { run: Run; boardHref: string }) {
  const { rings } = useMemo(() => buildDrawing(run), [run]);
  const frames = rings.length + 2;
  const sectionRef = useRef<HTMLElement>(null);
  const index = useStoryFrame(sectionRef, frames);
  const reduce = useReducedMotion() ?? false;
  const active = index >= 1 && index <= rings.length ? index - 1 : null;
  const ring = active === null ? undefined : rings[active];

  let frame: ReactNode;
  if (ring) {
    frame = (
      <GuestFrame key={index} ring={ring} number={index} total={rings.length} reduce={reduce} />
    );
  } else if (index === 0) {
    frame = <IntroFrame key={index} run={run} reduce={reduce} />;
  } else {
    frame = (
      <ClosingFrame
        key={index}
        run={run}
        drawn={rings.length}
        reduce={reduce}
        boardHref={boardHref}
      />
    );
  }

  return (
    <section
      id="story"
      ref={sectionRef}
      className="relative z-20"
      style={{ height: `${frames * 100}vh` }}
    >
      <div className="sticky top-0 flex h-screen flex-col items-center px-[6vw] md:grid md:grid-cols-12 md:items-center">
        <div className="mt-[88px] w-[min(56vw,38vh)] md:col-span-6 md:mt-0 md:w-[min(70vh,44vw)] md:justify-self-start">
          <KolamFocus run={run} rings={rings} active={active} />
        </div>
        <div
          aria-live="polite"
          className="mt-6 w-full max-w-[30rem] md:col-span-5 md:col-start-8 md:mt-0"
        >
          <AnimatePresence mode="wait" initial={false}>
            {frame}
          </AnimatePresence>
        </div>
        <Rail frames={frames} index={index} />
      </div>
    </section>
  );
}
