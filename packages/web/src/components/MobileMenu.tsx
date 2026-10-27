"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useIsMobile } from "@/lib/useIsMobile";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const FOCUSABLE = "a[href], button:not([disabled])";

export function MobileMenu({ links }: { links: Array<{ label: string; href: string }> }) {
  const reduce = useReducedMotion() ?? false;
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const firstLinkRef = useRef<HTMLAnchorElement>(null);
  // The sheet only exists on phones. A window widened past that closes it.
  const showSheet = open && mobile;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!showSheet) return;
    firstLinkRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(true);
        return;
      }
      if (event.key !== "Tab") return;
      const items = sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = items?.[0];
      const last = items?.[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [showSheet, close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Menu"
        aria-expanded={showSheet}
        aria-controls="mobile-menu"
        onClick={() => setOpen(true)}
        className="group flex h-6 w-6 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice md:hidden"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 8H21M3 16H21"
            className="stroke-rice-dim transition-[stroke] duration-150 ease-out group-hover:stroke-rice"
            strokeWidth="1.5"
          />
        </svg>
      </button>
      <AnimatePresence>
        {showSheet && (
          <motion.div
            ref={sheetRef}
            id="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            data-lenis-prevent
            className="fixed inset-0 z-50 bg-night"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: reduce ? 0 : 0.25 } }}
            exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.2 } }}
          >
            <nav aria-label="Menu links" className="px-[6vw] pt-[112px]">
              <ul className="flex flex-col gap-5">
                {links.map((link, index) => (
                  <motion.li
                    key={link.label}
                    initial={{ opacity: 0, y: reduce ? 0 : 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: reduce ? 0 : 0.4,
                      delay: reduce ? 0 : index * 0.05,
                      ease: EASE,
                    }}
                  >
                    <a
                      ref={index === 0 ? firstLinkRef : undefined}
                      href={link.href}
                      onClick={() => close(false)}
                      className="block font-display text-[36px] font-[350] leading-[1.1] text-rice transition-colors duration-150 ease-out hover:text-accent focus-visible:text-accent focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice"
                    >
                      {link.label}
                    </a>
                  </motion.li>
                ))}
              </ul>
            </nav>
            <button
              type="button"
              onClick={() => close(true)}
              className={`absolute right-[6vw] top-9 -translate-y-1/2 ${COPY_BUTTON}`}
            >
              Close
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
