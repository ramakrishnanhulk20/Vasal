"use client";

import { useRef } from "react";
import { COPY_BUTTON } from "@/lib/buttonStyle";
import { useCopy } from "@/lib/useCopy";

const COMMENT = "# Claude Code";
const COMMAND =
  'claude mcp add --transport http vasal https://api.vasal.site/mcp --header "Authorization: Bearer YOUR_KEY"';

export function CopyCommand() {
  const { copied, blocked, copy } = useCopy();
  const command = useRef<HTMLSpanElement>(null);

  return (
    <div className="relative">
      <div className="overflow-x-auto rounded-lg border border-rule bg-night-2 px-6 py-[22px] font-mono text-[14px] leading-[1.7] text-rice">
        <pre className="m-0 w-max font-mono">
          <span className="block text-rice-dim">{COMMENT}</span>
          <span ref={command} className="block">
            {COMMAND}
          </span>
        </pre>
      </div>
      <button
        type="button"
        onClick={() => copy(COMMAND, command.current)}
        aria-live="polite"
        className={`absolute right-3 top-3 ${COPY_BUTTON}`}
      >
        {copied ? "Copied" : blocked ? "Copy blocked" : "Copy"}
      </button>
    </div>
  );
}
