"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1500;
const BLOCKED_MS = 2000;

type Outcome = "copied" | "blocked" | null;

// A browser can refuse the clipboard (a denied permission, an embedded view).
// Selecting the text keeps Ctrl+C or a long press working.
function selectText(shown: Element | null | undefined) {
  const selection = window.getSelection();
  if (!shown || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(shown);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Copies text. `copied` holds for 1.5 seconds after the clipboard took it.
// `blocked` holds for 2 seconds after it refused, and `shown`, the element
// holding the visible text, is selected instead.
export function useCopy() {
  const [outcome, setOutcome] = useState<Outcome>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = (next: Exclude<Outcome, null>, ms: number) => {
    setOutcome(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), ms);
  };

  const copy = async (text: string, shown?: Element | null) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("The text could not be copied", error);
      selectText(shown);
      show("blocked", BLOCKED_MS);
      return;
    }
    show("copied", COPIED_MS);
  };

  return { copied: outcome === "copied", blocked: outcome === "blocked", copy };
}
