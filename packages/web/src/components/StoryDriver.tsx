"use client";

import { useEffect, useState } from "react";
import type { RefObject } from "react";

// One animation-frame loop turns the scroll position into progress through the
// section. The progress goes to a CSS variable on the section every frame; React
// is told only when the frame index changes.
export function useStoryFrame(sectionRef: RefObject<HTMLElement | null>, frames: number): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let frame = 0;
    let lastProgress = -1;
    let lastIndex = 0;

    const tick = () => {
      const box = section.getBoundingClientRect();
      const range = box.height - window.innerHeight;
      const progress = range > 0 ? Math.min(1, Math.max(0, -box.top / range)) : 0;
      if (progress !== lastProgress) {
        section.style.setProperty("--story", String(progress));
        lastProgress = progress;
      }
      const next = Math.min(frames - 1, Math.floor(progress * frames));
      if (next !== lastIndex) {
        lastIndex = next;
        setIndex(next);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sectionRef, frames]);

  return index;
}
