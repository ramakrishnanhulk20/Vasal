"use client";

import { useEffect } from "react";

// Writes the scroll progress straight to a CSS variable so React never
// re-renders while the page scrolls.
export function DawnDriver() {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let last = -1;

    const tick = () => {
      const dawn = Math.min(1, Math.max(0, window.scrollY / window.innerHeight));
      if (dawn !== last) {
        root.style.setProperty("--dawn", String(dawn));
        last = dawn;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return null;
}
