"use client";

import { Fragment, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { Reveal } from "@/components/proof/Reveal";
import { drawFrame, type Colors } from "@/components/proof/signatureDraw";
import {
  BOTTOM,
  buildLayout,
  CURVE_TO,
  GROUP_CENTRES,
  LEFT,
  MOVE_FROM,
  RING_STARTS,
  ratioShare,
  UPPER_SHARE,
  type Domain,
  type Layout,
} from "@/components/proof/signatureLayout";
import { SOFT_100 } from "@/lib/textStyles";

type Fifth = { episodes: number; episodesText: string; ratio: number; ratioText: string };
type Tick = { value: number; text: string };
type Caption = { lead: string; body: string };

const GROUP_NAMES = ["BOTTOM FIFTH", "SECOND", "MIDDLE", "FOURTH", "TOP FIFTH"];
const NOTE = "ONLY THE TOP AND BOTTOM FIFTHS WERE NAMED IN ADVANCE. THE MIDDLE THREE ARE SHOWN FOR CONTEXT.";
// Captions swap at these progress values: [from, until).
const CAPTION_SPANS: Array<[number, number | null]> = [
  [0, 0.2],
  [0.2, 0.5],
  [0.5, 0.8],
  [0.8, null],
];

// Labels are positioned with CSS from the chart's own size, the way the canvas is laid out.
const X = (share: number) => `calc(${LEFT}px + (100% - ${LEFT}px) * ${share})`;
const Y = (share: number, offset = 0) => `calc((100% - ${BOTTOM}px) * ${share} + ${offset}px)`;

// Labels sit centred on a position the chart works out from its own size (--x). On a phone the
// last column is too near the edge for a centred label, so it lines up with the chart's edge.
const CENTRED_ON_X = "left-[var(--x)] -translate-x-1/2";
const KEEP_INSIDE = "max-md:left-auto max-md:right-0 max-md:translate-x-0";

// Turned on and off by the scroll loop through data-on. With reduced motion everything shows.
const FADE =
  "opacity-0 transition-opacity duration-300 ease-out data-[on=true]:opacity-100 motion-reduce:opacity-100 motion-reduce:transition-none";
// The captions share one spot, so the old one fades out in full before the new one
// starts to fade in.
const CAPTION_FADE =
  "opacity-0 transition-opacity duration-200 ease-out data-[on=true]:opacity-100 data-[on=true]:delay-200 motion-reduce:opacity-100 motion-reduce:transition-none";

export function SignatureChart({
  fifths,
  domain,
  ticks,
  captions,
  description,
}: {
  fifths: Fifth[];
  domain: Domain;
  ticks: Tick[];
  captions: Caption[];
  description: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    const frame = frameRef.current;
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!section || !frame || !box || !canvas || !ctx) return;

    const style = getComputedStyle(canvas);
    const colors: Colors = {
      rice: style.getPropertyValue("--rice").trim(),
      rule: style.getPropertyValue("--rule").trim(),
      accent: style.getPropertyValue("--accent").trim(),
    };
    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phoneQuery = window.matchMedia("(max-width: 767px)");
    const fifthEpisodes = fifths.map((f) => f.episodes);
    const ratios = fifths.map((f) => f.ratio);
    const fades = Array.from(frame.querySelectorAll<HTMLElement>("[data-from]"), (el) => ({
      el,
      from: Number(el.dataset.from),
      until: el.dataset.until === undefined ? Infinity : Number(el.dataset.until),
    }));

    let layout: Layout | null = null;
    let dpr = 1;
    let lastProgress = Number.NaN;
    let lastPicture = Number.NaN;
    let nearby = false;
    let frameId = 0;

    // 0 when the section's top meets the top of the screen, 1 when its bottom meets the bottom.
    const readProgress = () => {
      if (reduceQuery.matches) return 1;
      const span = section.offsetHeight - frame.offsetHeight;
      if (span <= 0) return 0;
      return Math.min(1, Math.max(0, -section.getBoundingClientRect().top / span));
    };

    const paint = (force: boolean) => {
      if (!layout) return;
      const p = Math.round(readProgress() * 10000) / 10000;
      if (!force && p === lastProgress) return;
      lastProgress = p;
      // Before the dots start to move and after the curve is finished the picture is the
      // same at every progress value, so the canvas is left as it is.
      const picture = Math.min(Math.max(p, MOVE_FROM), CURVE_TO);
      if (force || picture !== lastPicture) {
        lastPicture = picture;
        drawFrame(ctx, layout, colors, p, dpr);
      }
      const everything = reduceQuery.matches;
      for (const fade of fades) {
        const value = everything || (p >= fade.from && p < fade.until) ? "true" : "false";
        if (fade.el.dataset.on !== value) fade.el.dataset.on = value;
      }
    };

    const resize = () => {
      const width = box.clientWidth;
      const height = box.clientHeight;
      if (width === 0 || height === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      layout = buildLayout({
        width,
        height,
        phone: phoneQuery.matches,
        fifthEpisodes,
        ratios,
        domain,
      });
      paint(true);
    };

    const tick = () => {
      frameId = 0;
      paint(false);
      if (nearby && !reduceQuery.matches) frameId = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!frameId && !reduceQuery.matches) frameId = requestAnimationFrame(tick);
    };

    const watcher = new IntersectionObserver(
      ([entry]) => {
        nearby = entry.isIntersecting;
        if (nearby) start();
        else paint(false);
      },
      { rootMargin: "100px 0px" },
    );
    const sizer = new ResizeObserver(resize);
    const onModeChange = () => {
      resize();
      if (nearby) start();
    };

    resize();
    watcher.observe(section);
    sizer.observe(box);
    reduceQuery.addEventListener("change", onModeChange);
    phoneQuery.addEventListener("change", onModeChange);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      watcher.disconnect();
      sizer.disconnect();
      reduceQuery.removeEventListener("change", onModeChange);
      phoneQuery.removeEventListener("change", onModeChange);
    };
  }, [fifths, domain]);

  const baseline = ratioShare(1, domain);

  return (
    <section
      ref={sectionRef}
      className="mt-[14vh] h-[300vh] md:h-[320vh] motion-reduce:h-auto md:motion-reduce:h-auto"
    >
      <div
        ref={frameRef}
        className="sticky top-0 flex h-screen flex-col justify-center md:grid md:grid-cols-12 md:items-center motion-reduce:static motion-reduce:h-auto motion-reduce:gap-10"
      >
        <Reveal className="relative md:col-span-8 md:col-start-5 md:row-start-1">
          <div ref={boxRef} className="relative h-[56vh] md:h-[min(78vh,680px)]">
            <canvas
              ref={canvasRef}
              aria-hidden="true"
              className="absolute inset-0 h-full w-full"
            />
            <div className="pointer-events-none absolute inset-0">
              <div data-from="0.5" className={`${FADE} absolute inset-0`}>
                <span
                  className="absolute w-px bg-rule"
                  style={{ left: LEFT, top: 0, height: Y(UPPER_SHARE) }}
                />
                {ticks.map((tick) => {
                  const top = Y(ratioShare(tick.value, domain));
                  return (
                    <Fragment key={tick.text}>
                      <span
                        className="absolute h-px w-[6px] bg-rule"
                        style={{ left: LEFT - 6, top }}
                      />
                      <span
                        className="absolute left-0 w-[44px] -translate-y-1/2 text-right font-mono text-[11px] leading-none text-rice-dim"
                        style={{ top }}
                      >
                        {tick.text}
                      </span>
                    </Fragment>
                  );
                })}
                <span
                  className="absolute right-0 border-t border-dashed border-rule"
                  style={{ left: LEFT, top: Y(baseline) }}
                />
                <span
                  className="absolute right-0 -translate-y-full whitespace-nowrap pb-1 font-mono text-[11px] leading-none text-rice-dim"
                  style={{ top: Y(baseline) }}
                >
                  {"THE BOTTOM FIFTH'S MEDIAN"}
                </span>
              </div>

              {fifths.map((fifth, g) => {
                const top = Y(ratioShare(fifth.ratio, domain), -20);
                return (
                  <div
                    key={`ring-${g}`}
                    data-from={RING_STARTS[g]}
                    className={`${FADE} ${CENTRED_ON_X} absolute -translate-y-full whitespace-nowrap text-center ${g === 4 ? KEEP_INSIDE : ""}`}
                    style={{ "--x": X(GROUP_CENTRES[g]), top } as CSSProperties}
                  >
                    {g === 4 ? (
                      <>
                        <span
                          className="block font-display text-[28px] font-[350] leading-none text-accent md:text-[40px]"
                          style={SOFT_100}
                        >
                          {fifth.ratioText}
                        </span>
                        <span className="mt-1 block font-mono text-[11px] leading-none text-rice-dim">
                          MEDIAN VIEWS
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-[13px] leading-none text-rice">
                        {fifth.ratioText}
                      </span>
                    )}
                  </div>
                );
              })}

              {fifths.map((fifth, g) => (
                <div
                  key={`group-${g}`}
                  data-from="0.45"
                  className={`${FADE} ${CENTRED_ON_X} absolute whitespace-nowrap text-center font-mono text-[12px] leading-[1.4] text-rice-dim ${g === 4 ? KEEP_INSIDE : ""}`}
                  style={{ "--x": X(GROUP_CENTRES[g]), top: Y(1, 10) } as CSSProperties}
                >
                  <span className="hidden md:block">
                    <span className="block">{GROUP_NAMES[g]}</span>
                    <span className="block opacity-70">{`${fifth.episodesText} episodes`}</span>
                  </span>
                  <span className="md:hidden">
                    <span className="block">{g + 1}</span>
                    {g === 0 && <span className="block">BOTTOM FIFTH</span>}
                    {g === 4 && <span className="block">TOP FIFTH</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p
            data-from="0.75"
            className={`${FADE} mx-auto mt-3 max-w-[60ch] text-center font-mono text-[11px] leading-[1.5] text-rice-dim md:absolute md:inset-x-0 md:top-full md:max-w-none md:pl-14`}
          >
            {NOTE}
          </p>
          <p className="sr-only">{description}</p>
        </Reveal>

        <Reveal className="mt-6 min-h-[30vh] md:col-span-4 md:col-start-1 md:row-start-1 md:mt-0 md:min-h-0 md:pr-8">
          <div className="grid motion-reduce:gap-10">
            {captions.map((caption, index) => (
              <div
                key={caption.lead}
                data-from={CAPTION_SPANS[index][0]}
                data-until={CAPTION_SPANS[index][1] ?? undefined}
                className={`${CAPTION_FADE} col-start-1 row-start-1 motion-reduce:row-start-auto`}
              >
                <p
                  className="font-display text-[length:clamp(1.75rem,2.6vw,2.5rem)] font-[350] leading-[1.1] text-rice"
                  style={SOFT_100}
                >
                  {caption.lead}
                </p>
                <p className="mt-4 max-w-[34ch] font-body text-[17px] leading-[1.6] text-rice-dim">
                  {caption.body}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
