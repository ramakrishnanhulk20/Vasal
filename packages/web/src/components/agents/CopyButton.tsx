"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useCopy } from "@/lib/useCopy";

export function CopyButton({
  text,
  shown,
  label,
  accessibleName,
  onCopied,
  className,
}: {
  text: string;
  // The element holding the visible text, selected when the clipboard refuses.
  shown: RefObject<Element | null>;
  label: string;
  accessibleName?: string;
  onCopied: (copiedText: string) => void;
  className?: string;
}) {
  const { copied, blocked, copy } = useCopy();
  // The text is noted at the click: a snippet's text changes when a key
  // arrives, and the report must say what was really copied.
  const asked = useRef("");

  // useCopy only reports success once the clipboard took the text, so a
  // refused copy never counts as one.
  useEffect(() => {
    if (copied) onCopied(asked.current);
  }, [copied, onCopied]);

  return (
    <button
      type="button"
      onClick={() => {
        asked.current = text;
        copy(text, shown.current);
      }}
      aria-label={copied || blocked ? undefined : accessibleName}
      aria-live="polite"
      className={`${COPY_BUTTON} ${className ?? ""}`}
    >
      {copied ? "Copied" : blocked ? "Copy blocked" : label}
    </button>
  );
}
