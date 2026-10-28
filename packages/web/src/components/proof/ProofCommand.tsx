"use client";

import { useRef } from "react";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useCopy } from "@/lib/useCopy";

export function ProofCommand({ command }: { command: string }) {
  const { copied, blocked, copy } = useCopy();
  const shown = useRef<HTMLPreElement>(null);

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-lg border border-rule bg-night-2 py-[22px] pl-6 pr-[128px] font-mono text-[14px] leading-[1.7] text-rice">
        <pre ref={shown} className="m-0 whitespace-pre-wrap font-mono">{command}</pre>
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
