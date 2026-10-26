"use client";

import Link from "next/link";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { KolamThumb } from "@/components/KolamThumb";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";
import type { ShowcaseRun } from "@/lib/showcase";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function ShowcaseRow({ run, index }: { run: ShowcaseRun; index: number }) {
  const reduce = useReducedMotion() ?? false;
  const [active, setActive] = useState(false);
  const [drawKey, setDrawKey] = useState(0);

  const light = () => {
    setActive(true);
    setDrawKey((key) => key + 1);
  };
  const dim = () => setActive(false);
  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") light();
  };

  return (
    <motion.li
      data-rise=""
      className="border-t border-rule last:border-b"
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: reduce ? 0 : 0.6, delay: reduce ? 0 : index * 0.07, ease: EASE }}
    >
      <Link
        href={`/runs/${run.runId}`}
        onPointerEnter={onPointerEnter}
        onPointerLeave={dim}
        onFocus={(event) => event.currentTarget.matches(":focus-visible") && light()}
        onBlur={dim}
        className="group -mx-4 grid grid-cols-[1fr_auto] items-center gap-y-3 px-4 py-7 transition-colors duration-250 ease-out hover:bg-night-2 focus-visible:bg-night-2 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice md:grid-cols-12 md:gap-y-0"
      >
        <span className="col-start-1 row-start-1 font-mono text-[13px] text-rice-dim md:col-end-2">
          {String(run.position).padStart(2, "0")}
        </span>
        <span className="col-span-2 row-start-2 font-display text-[length:clamp(1.75rem,2.8vw,2.75rem)] font-[350] leading-[1.05] text-rice transition-[translate] duration-250 ease-out motion-safe:group-hover:translate-x-2 motion-safe:group-focus-visible:translate-x-2 md:col-start-2 md:col-end-7 md:row-start-1">
          {run.showName}
        </span>
        <span className="col-span-2 row-start-3 md:col-start-7 md:col-end-11 md:row-start-1">
          <span className="block font-body text-[16px] text-rice-dim">
            {run.guests.map((guest) => guest.name).join(", ")}
          </span>
          <span className="mt-2 block font-mono text-xs text-rice-dim">{`Run ${run.runDate}`}</span>
        </span>
        <span className="col-start-2 row-start-1 justify-self-end md:col-start-11 md:col-end-13">
          <KolamThumb
            kolam={run.kolam}
            active={active}
            drawKey={drawKey}
            className="block h-14 w-14 md:h-[72px] md:w-[72px]"
          />
        </span>
      </Link>
    </motion.li>
  );
}

export function ShowcaseIndex({ runs }: { runs: ShowcaseRun[] }) {
  return (
    <section id="showcase" className="relative z-20 px-[6vw] pb-[20vh] pt-[16vh]">
      <p className={KICKER}>ALREADY RUN</p>
      <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
        {`${runs.length} shows, already run.`}
      </h2>
      <p className="mt-5 max-w-[46ch] font-body text-[18px] text-rice-dim">
        {`Real boards from Qloo's taste graph, made before you arrived. Open one to see every guest, their brief and the pitch.`}
      </p>
      <ol className="mt-[8vh]">
        {runs.map((run, index) => (
          <ShowcaseRow key={run.runId} run={run} index={index} />
        ))}
      </ol>
    </section>
  );
}
