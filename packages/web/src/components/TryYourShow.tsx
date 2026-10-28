"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { startRun } from "@/lib/api";
import type { Failure } from "@/lib/api";
import { PRIMARY_BUTTON } from "@/lib/buttonStyle";
import { KICKER, SECTION_TITLE_PHONE, SOFT_100 } from "@/lib/textStyles";
import { SITE_KEY, USING_TEST_KEY, loadTurnstile } from "@/lib/turnstile";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function countWord(count: number): string {
  return count >= 1 && count <= 12 ? (NUMBER_WORDS[count] ?? String(count)) : String(count);
}

const CLOSED = "closed";

// What to tell the visitor when the server turns a start down. Each line says
// what to do next; a closed site shows the closed notice instead.
function refusalLine(failure: Failure): string {
  const { status, code } = failure;
  if (status === 400) {
    return "That doesn't look like a show. Try the show's name as it appears in your podcast app.";
  }
  if (status === 403 && code === "HUMAN_CHECK_FAILED") {
    return "The human check didn't go through. Try it once more.";
  }
  if (status === 403 || status === 413) {
    return "This page couldn't start a run. Reload it and try again.";
  }
  if (status === 429 && code === "VISITOR_LIMIT") {
    return "That's today's runs from your network. Open one of the boards above, or come back tomorrow.";
  }
  if (status === 429 && code === "BUSY") {
    return "Vasal is building as many boards as it can right now. Try again in a minute.";
  }
  if (status === 503 && code === "LIVE_RUNS_OFF") return CLOSED;
  return "Vasal couldn't be reached. Try again in a minute.";
}

function Reveal({
  delay,
  className,
  children,
}: {
  delay: number;
  className?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      data-rise=""
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: reduce ? 0 : 0.7, delay: reduce ? 0 : delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

export function TryYourShow({
  liveRuns,
  boardCount,
}: {
  liveRuns: boolean;
  boardCount: number | null;
}) {
  const router = useRouter();
  const [show, setShow] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const closed = !liveRuns || refusal === CLOSED;

  // No check is loaded while runs are closed, so nobody solves one for a run
  // that cannot start.
  useEffect(() => {
    const container = widgetRef.current;
    if (closed || !container) return;
    let cancelled = false;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetId.current = turnstile.render(container, {
          sitekey: SITE_KEY,
          action: "run_start",
          theme: "dark",
          size: "normal",
          callback: (value) => setToken(value),
          "expired-callback": () => setToken(null),
          "error-callback": () => setToken(null),
        });
      })
      .catch((error: unknown) => console.error("Human check could not start", error));

    return () => {
      cancelled = true;
      if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [closed]);

  useEffect(() => {
    if (refusal === CLOSED) noticeRef.current?.focus();
  }, [refusal]);

  const ready = show.replace(/\s/g, "").length >= 2 && token !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || token === null || starting) return;
    if (!liveRuns) {
      noticeRef.current?.focus();
      return;
    }
    setStarting(true);
    setRefusal(null);
    const result = await startRun(show.trim(), token);
    if (result.ok) {
      router.push(`/runs/${result.value.runId}`);
      return;
    }
    // A token works once, so a new one is asked for after every refusal.
    setStarting(false);
    setToken(null);
    if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    setRefusal(refusalLine(result));
  };

  return (
    <section id="try" className="relative z-20 min-h-[90vh] px-[6vw] py-[18vh]">
      <div className="grid grid-cols-12">
        <Reveal delay={0} className="col-span-12">
          <p className={KICKER}>TRY YOUR SHOW</p>
        </Reveal>
        <Reveal delay={0.1} className="col-span-12 mt-5 md:col-span-8">
          <h2 className={SECTION_TITLE_PHONE} style={SOFT_100}>
            Who should be on your show next?
          </h2>
        </Reveal>
        <Reveal delay={0.2} className="col-span-12 mt-[7vh] md:col-span-8">
          <form onSubmit={submit}>
            <input
              type="text"
              value={show}
              onChange={(event) => setShow(event.target.value)}
              aria-label="Your show"
              maxLength={300}
              autoComplete="off"
              disabled={closed}
              placeholder="Show name, Apple Podcasts link or RSS feed"
              className="w-full border-0 border-b border-rule bg-transparent py-[18px] font-display text-[length:clamp(1.5rem,2.6vw,2.25rem)] font-[350] text-rice outline-none transition-[border-color] duration-200 placeholder:text-rice-dim focus:border-rice disabled:cursor-not-allowed disabled:opacity-45"
            />
            {!closed && (
              <div className="mt-7 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
                <div className="md:min-w-[300px] md:flex-1">
                  <div ref={widgetRef} data-action="run_start" />
                  {USING_TEST_KEY && (
                    <p className="mt-2 font-mono text-[11px] text-rice-dim">
                      Test human check: local only.
                    </p>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={!ready || starting}
                  className={`${PRIMARY_BUTTON} shrink-0 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:brightness-100`}
                >
                  {starting ? "Starting..." : "Find my guests"}
                </button>
              </div>
            )}
            {refusal !== null && refusal !== CLOSED && (
              <p aria-live="polite" className="mt-4 max-w-[52ch] font-body text-[15px] text-rice">
                {refusal}
              </p>
            )}
            {!closed ? (
              <p className="mt-[18px] max-w-[52ch] font-body text-[15px] text-rice-dim">
                {`About a minute. Live from Qloo's taste graph, and every name is checked against your show's episode history.`}
              </p>
            ) : (
              <div
                ref={noticeRef}
                tabIndex={-1}
                aria-live="polite"
                className="mt-7 max-w-[52ch] rounded-lg border border-rule bg-night-2 px-[18px] py-4 font-body text-[17px] text-rice outline-none"
              >
                {boardCount === null ? (
                  "Live runs open on 30 October, when judging starts."
                ) : (
                  <>
                    {
                      "Live runs open on 30 October, when judging starts. Until then, open one of the "
                    }
                    <a href="#showcase" className="link-draw">
                      {`${countWord(boardCount)} boards above`}
                    </a>
                    .
                  </>
                )}
              </div>
            )}
          </form>
        </Reveal>
      </div>
    </section>
  );
}
