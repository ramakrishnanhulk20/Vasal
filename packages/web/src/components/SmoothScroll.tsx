"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

// The nav is 72px tall, so an anchor lands with its section just below it.
const NAV_OFFSET = -72;

export function SmoothScroll() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lenis: Lenis | null = null;

    const sync = () => {
      if (query.matches) {
        lenis?.destroy();
        lenis = null;
      } else if (!lenis) {
        lenis = new Lenis({ duration: 1.1, smoothWheel: true, autoRaf: true });
      }
    };

    // Without Lenis this does nothing, so the browser makes its normal jump.
    const onClick = (event: MouseEvent) => {
      if (!lenis || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || !link.hash || link.origin !== window.location.origin) return;
      if (link.pathname !== window.location.pathname) return;
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: NAV_OFFSET });
      window.history.pushState(null, "", link.hash);
    };

    sync();
    query.addEventListener("change", sync);
    document.addEventListener("click", onClick);
    return () => {
      query.removeEventListener("change", sync);
      document.removeEventListener("click", onClick);
      lenis?.destroy();
    };
  }, []);

  return null;
}
