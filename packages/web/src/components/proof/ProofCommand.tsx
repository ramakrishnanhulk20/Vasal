"use client";

import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useCopy } from "@/lib/useCopy";

export function ProofCommand({ command }: { command: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-lg border border-rule bg-night-2 py-[22px] pl-6 pr-[84px] font-mono text-[14px] leading-[1.7] text-rice">
        <pre className="m-0 whitespace-pre-wrap font-mono">{command}</pre>
      </div>
      <button
        type="button"
        onClick={() => copy(command)}
        aria-live="polite"
        className={`absolute right-3 top-3 ${COPY_BUTTON}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
