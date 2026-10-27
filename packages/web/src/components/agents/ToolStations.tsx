"use client";

import { useId, useRef } from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useIsMobile } from "@/lib/useIsMobile";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const LINE_SECONDS = 1.4;
const STATION_STEP = 0.3;

const TOOLS = [
  {
    name: "find_show",
    job: "Finds the show a name or link points to, and lists up to five candidates.",
    takes: "Takes: a show's name, Apple Podcasts link or RSS feed",
    uses: "Uses: one of the day's show searches",
  },
  {
    name: "book_guests",
    job: "Ranks guests for the candidate you confirm, and waits up to 45 seconds for the board.",
    takes: "Takes: a candidateId from find_show",
    uses: "Uses: one of the day's guest boards",
  },
  {
    name: "get_board",
    job: "Reads a board this key started: its status, then the ranked guests and the link to it on Vasal.",
    takes: "Takes: a runId from book_guests",
    uses: "Uses: nothing",
  },
  {
    name: "write_brief",
    job: "Writes the brief and pitch email for one guest on a finished board.",
    takes: "Takes: a runId and a guestId",
    uses: "Uses: one of the day's briefs",
  },
];

// The stack's gap is 3rem, so a segment runs one station's height plus 3rem to
// reach the next dot.
// Paths are written ten times larger than they are drawn (the svg is
// stretched down to fit) so the browser's length measure is exact, the same
// reason the kolam paths are scaled.
const ROW_PATH = "M 0 200 Q 1500 -160 3000 200 Q 4500 560 6000 200 Q 7500 -160 9000 200";
const COLUMN_PATHS = [
  "M 50 0 Q 250 5000 50 10000",
  "M 50 0 Q -150 5000 50 10000",
  "M 50 0 Q 250 5000 50 10000",
];

// The rice colour at the strength the line has at each end of a stretch.
function Fade({ id, from, to, vertical }: { id: string; from: number; to: number; vertical: boolean }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2={vertical ? "0" : "1"} y2={vertical ? "1" : "0"}>
      <stop offset="0" style={{ stopColor: "var(--rice)", stopOpacity: from }} />
      <stop offset="1" style={{ stopColor: "var(--rice)", stopOpacity: to }} />
    </linearGradient>
  );
}

const FAINT = 0.12;
const BRIGHT = 0.4;
const along = (step: number) => FAINT + (BRIGHT - FAINT) * (step / 3);

function Station({
  index,
  tool,
  rowInView,
  phone,
  reduce,
}: {
  index: number;
  tool: (typeof TOOLS)[number];
  rowInView: boolean;
  phone: boolean;
  reduce: boolean;
}) {
  const ownRef = useRef<HTMLLIElement>(null);
  const ownInView = useInView(ownRef, { once: true, amount: 0.4 });
  const gradient = useId();
  const show = phone ? ownInView : rowInView;
  const delay = reduce || phone ? 0 : index * STATION_STEP;
  const column = COLUMN_PATHS[index];

  return (
    <li
      ref={ownRef}
      className="relative min-w-0 pl-8 md:col-span-3 md:pl-0 md:pr-8"
    >
      {column !== undefined && (
        <svg
          viewBox="0 0 100 10000"
          preserveAspectRatio="none"
          aria-hidden="true"
          className="absolute left-0 top-[11px] h-[calc(100%+3rem)] w-[10px] overflow-visible md:hidden"
        >
          <defs>
            <Fade id={gradient} from={along(index)} to={along(index + 1)} vertical />
          </defs>
          <motion.path
            d={column}
            data-kolam-draw=""
            fill="none"
            stroke={`url(#${gradient})`}
            strokeWidth="15"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: show ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.8, ease: EASE }}
          />
        </svg>
      )}
      <motion.span
        data-rise=""
        aria-hidden="true"
        className="absolute left-0 top-[6px] block h-[10px] w-[10px] rounded-full bg-rice md:static md:mt-[15px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: show ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 0.5, delay, ease: EASE }}
      />
      <motion.div
        data-rise=""
        className="md:mt-7"
        initial={{ opacity: 0, y: 16 }}
        animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
        transition={{ duration: reduce ? 0 : 0.5, delay, ease: EASE }}
      >
        <p className="font-mono text-[15px] text-rice">{tool.name}</p>
        <p className="mt-2 max-w-[26ch] font-body text-[15px] leading-[1.55] text-rice-dim">
          {tool.job}
        </p>
        <div className="mt-3 font-mono text-[12px] text-rice-dim">
          <p>{tool.takes}</p>
          <p>{tool.uses}</p>
        </div>
      </motion.div>
    </li>
  );
}

export function ToolStations() {
  const reduce = useReducedMotion() ?? false;
  const phone = useIsMobile();
  const rowRef = useRef<HTMLOListElement>(null);
  const rowInView = useInView(rowRef, { once: true, amount: 0.4 });
  const gradient = useId();

  return (
    <ol
      ref={rowRef}
      className="relative mt-14 flex flex-col gap-12 md:grid md:grid-cols-12 md:gap-0"
    >
      <svg
        viewBox="0 0 9000 400"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute left-[5px] top-0 hidden h-[40px] w-3/4 overflow-visible md:block"
      >
        <defs>
          <Fade id={gradient} from={FAINT} to={BRIGHT} vertical={false} />
        </defs>
        <motion.path
          d={ROW_PATH}
          data-kolam-draw=""
          fill="none"
          stroke={`url(#${gradient})`}
          strokeWidth="15"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: rowInView && !phone ? 1 : 0 }}
          transition={{ duration: reduce ? 0 : LINE_SECONDS, ease: EASE }}
        />
      </svg>
      {TOOLS.map((tool, index) => (
        <Station
          key={tool.name}
          index={index}
          tool={tool}
          rowInView={rowInView}
          phone={phone}
          reduce={reduce}
        />
      ))}
    </ol>
  );
}
