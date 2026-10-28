"use client";

import { useRef } from "react";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useCopy } from "@/lib/useCopy";

export function ProofCommand({ command }: { command: string }) {
  const { copied, blocked, copy } = useCopy();
  const shown = useRef<HTMLPreElement>(null);

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-lg border border-rule bg-night-2 font-mono text-[14px] leading-[1.7] text-rice">
        <pre
          ref={shown}
          className="m-0 mr-[128px] overflow-x-auto whitespace-pre py-[22px] pl-6 font-mono"
        >
          {command}
        </pre>
      </div>
      <button
        type="button"
        onClick={() => copy(command, shown.current)}
        aria-live="polite"
        className={`absolute right-3 top-3 ${COPY_BUTTON}`}
      >
        {copied ? "Copied" : blocked ? "Copy blocked" : "Copy"}
      </button>
    </div>
  );
}
