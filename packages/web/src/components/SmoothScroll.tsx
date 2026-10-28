"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

// The nav is 72px tall, so an anchor lands with its section just below it.
const NAV_OFFSET = -72;

export function SmoothScroll() {
  const pathname = usePathname();
  const lenisRef = useRef<Lenis | null>(null);
  const lastPath = useRef(pathname);

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
      lenisRef.current = lenis;
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
      lenisRef.current = null;
    };
  }, []);

  // A page on a new path opens at its top. Lenis keeps its own scroll target,
  // so a glide still running from the old page would carry on and land at the
  // bottom of the new one. A hash is left to the router, and a change that
  // keeps the path (the board's guest in the address) never gets here.
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (window.location.hash) return;
    if (lenisRef.current) lenisRef.current.scrollTo(0, { immediate: true, force: true });
    else window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
