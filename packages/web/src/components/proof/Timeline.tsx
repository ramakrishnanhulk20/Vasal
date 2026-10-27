"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { EASE, useSeenOnce } from "@/components/proof/Reveal";
import { REPO, TEXT_LINK } from "@/components/proof/links";

export type Milestone = {
  date: string;
  text: string;
  hash?: string;
  note?: string;
};

export function Timeline({ milestones }: { milestones: Milestone[] }) {
  const reduce = useReducedMotion() ?? false;
  const { ref, seen } = useSeenOnce<HTMLOListElement>(0.4);
  const lastRef = useRef<HTMLLIElement>(null);
  const [lineHeight, setLineHeight] = useState<number | null>(null);

  // The line runs from the first dot to the last one, so it ends where the last entry starts.
  useEffect(() => {
    const list = ref.current;
    const last = lastRef.current;
    if (!list || !last) return;
    const measure = () => setLineHeight(last.offsetTop);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(list);
    return () => watcher.disconnect();
  }, [ref]);

  return (
    <ol ref={ref} className="relative pl-8">
      <motion.span
        data-rise=""
        aria-hidden="true"
        className={`absolute left-[3px] top-[10px] w-px origin-top bg-rule ${
          lineHeight === null ? "bottom-0" : ""
        }`}
        style={lineHeight === null ? undefined : { height: lineHeight }}
        initial={{ scaleY: 0 }}
        animate={{ scaleY: seen ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 0.9, ease: EASE }}
      />
      {milestones.map((milestone, index) => (
        <motion.li
          key={milestone.date}
          ref={index === milestones.length - 1 ? lastRef : undefined}
          data-rise=""
          className="relative pb-10 last:pb-0"
          initial={{ opacity: 0, y: 16 }}
          animate={seen ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: reduce ? 0 : 0.5, delay: reduce ? 0 : index * 0.12, ease: EASE }}
        >
          <span
            aria-hidden="true"
            className="absolute -left-8 top-[7px] h-[7px] w-[7px] rounded-full bg-rice"
          />
          <p className="font-mono text-[13px] text-rice-dim">{milestone.date}</p>
          <p className="mt-1 font-body text-[16px] leading-[1.5] text-rice">{milestone.text}</p>
          {milestone.hash && (
            <a
              href={`${REPO}/commit/${milestone.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-2 inline-block font-mono text-[13px] text-rice-dim ${TEXT_LINK}`}
            >
              {milestone.hash}
            </a>
          )}
          {milestone.note && (
            <p className="mt-2 font-mono text-[13px] text-rice-dim">{milestone.note}</p>
          )}
        </motion.li>
      ))}
    </ol>
  );
}
