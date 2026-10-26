"use client";

import { motion, useReducedMotion } from "motion/react";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";
import type { Step } from "@/lib/runPage";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
// Rows that enter together cascade; rows far down the list start a new cascade.
const BATCH = 12;

export function StepsList({ steps }: { steps: Step[] }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <section className="mt-[18vh] grid grid-cols-12">
      <div className="col-span-12 md:col-span-8">
        <p className={KICKER}>HOW THIS BOARD WAS MADE</p>
        <h2 className={`mt-5 ${SECTION_TITLE}`} style={SOFT_100}>
          {`${steps.length} steps, each a real call.`}
        </h2>
        <ol className="mt-10 divide-y divide-rule">
          {steps.map((step, index) => (
            <motion.li
              key={index}
              data-rise=""
              className="flex items-baseline py-[6px]"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{
                duration: reduce ? 0 : 0.5,
                delay: reduce ? 0 : 0.03 * (index % BATCH),
                ease: EASE,
              }}
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
      </div>
    </section>
  );
}
