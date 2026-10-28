"use client";

import { Fragment, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CopyButton } from "@/components/agents/CopyButton";
import { PLACEHOLDER_KEY, snippetsFor } from "@/components/agents/snippets";
import type { Block, Snippet } from "@/components/agents/snippets";
import { API_BASE } from "@/lib/api";
import { KICKER } from "@/lib/textStyles";

const MCP_ADDRESS = `${API_BASE}/mcp`;

// The offset is 1px so the focus ring stays inside the row's 4px padding and
// the scrolling row does not clip it.
const TAB =
  "shrink-0 whitespace-nowrap rounded-md px-[10px] py-2 font-mono text-[13px] transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-[1px] focus-visible:outline-rice";

const BOX = "rounded-lg border border-rule bg-night";

// Splits the text around the key so the key alone can be drawn in the accent.
function WithKey({ text, apiKey }: { text: string; apiKey: string | null }) {
  if (apiKey === null) return <>{text}</>;
  const parts = text.split(apiKey);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="text-accent">{apiKey}</span>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function CodeBlock({
  block,
  apiKey,
  preRef,
}: {
  block: Block;
  apiKey: string | null;
  preRef: RefObject<HTMLPreElement | null>;
}) {
  return (
    <div className={`${BOX} overflow-x-auto px-5 py-[18px]`}>
      <pre ref={preRef} className="m-0 w-max font-mono text-[13px] leading-[1.7] text-rice">
        <WithKey text={block.text} apiKey={apiKey} />
      </pre>
    </div>
  );
}

// The button shares the row with the label, so it never sits over the value.
// On a phone the value drops to a line of its own and scrolls sideways there.
function ValueRow({
  block,
  apiKey,
  onCopied,
}: {
  block: Block;
  apiKey: string | null;
  onCopied: (copiedText: string) => void;
}) {
  const value = useRef<HTMLSpanElement>(null);
  return (
    <div
      className={`${BOX} grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 py-[14px] pl-5 pr-3 md:grid-cols-[112px_minmax(0,1fr)_auto]`}
    >
      <span className="col-start-1 row-start-1 font-mono text-[12px] text-rice-dim">
        {block.label}
      </span>
      <span
        ref={value}
        className="col-span-2 row-start-2 min-w-0 overflow-x-auto whitespace-pre font-mono text-[13px] leading-[1.7] text-rice md:col-span-1 md:col-start-2 md:row-start-1"
      >
        <WithKey text={block.text} apiKey={apiKey} />
      </span>
      <CopyButton
        text={block.text}
        shown={value}
        label="Copy"
        accessibleName={block.accessibleName}
        onCopied={onCopied}
        className="col-start-2 row-start-1 md:col-start-3"
      />
    </div>
  );
}

// A snippet's one code block has its Copy button in the instruction line's
// row. The Claude app tab has no code block, only labelled rows.
function SnippetPanel({
  snippet,
  apiKey,
  onCopied,
}: {
  snippet: Snippet;
  apiKey: string | null;
  onCopied: (copiedText: string) => void;
}) {
  const codeRef = useRef<HTMLPreElement>(null);
  const code = snippet.blocks.find((block) => block.label === undefined);
  const rows = snippet.blocks.filter((block) => block.label !== undefined);
  return (
    <>
      <div className="flex items-start gap-4">
        <p className="min-w-0 flex-1 font-body text-[14px] text-rice-dim">{snippet.line}</p>
        {code && (
          <CopyButton
            text={code.text}
            shown={codeRef}
            label="Copy"
            accessibleName={code.accessibleName}
            onCopied={onCopied}
            className="shrink-0"
          />
        )}
      </div>
      <div className="mt-3 flex flex-col gap-[10px]">
        {code && <CodeBlock block={code} apiKey={apiKey} preRef={codeRef} />}
        {rows.map((row) => (
          <ValueRow key={row.label} block={row} apiKey={apiKey} onCopied={onCopied} />
        ))}
      </div>
    </>
  );
}

// `apiKey` is the issued key, or null before one exists, when every snippet
// shows the placeholder instead.
export function SetupTabs({
  apiKey,
  onCopied,
}: {
  apiKey: string | null;
  onCopied: (copiedText: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const [current, setCurrent] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const snippets = useMemo(
    () => snippetsFor(MCP_ADDRESS, apiKey ?? PLACEHOLDER_KEY),
    [apiKey],
  );
  const snippet = snippets[current] ?? snippets[0];
  if (!snippet) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    const last = snippets.length - 1;
    let next: number;
    if (event.key === "ArrowRight") next = current === last ? 0 : current + 1;
    else if (event.key === "ArrowLeft") next = current === 0 ? last : current - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    setCurrent(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className="mt-8">
      <p className={KICKER}>CONNECT YOUR AGENT</p>
      <div
        role="tablist"
        aria-label="Agent app"
        onKeyDown={onKeyDown}
        className="mt-[14px] flex w-fit max-w-full overflow-x-auto rounded-lg border border-rule p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {snippets.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`setup-tab-${item.id}`}
            aria-selected={index === current}
            aria-controls="setup-panel"
            tabIndex={index === current ? 0 : -1}
            onClick={() => setCurrent(index)}
            className={`${TAB} ${index === current ? "bg-night text-rice" : "text-rice-dim hover:text-rice"}`}
          >
            {item.tab}
          </button>
        ))}
      </div>

      <div
        id="setup-panel"
        role="tabpanel"
        aria-labelledby={`setup-tab-${snippet.id}`}
        className="mt-4 grid grid-cols-[minmax(0,1fr)]"
      >
        <AnimatePresence initial={false}>
          <motion.div
            key={snippet.id}
            className="min-w-0 [grid-area:1/1]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2 }}
          >
            <SnippetPanel snippet={snippet} apiKey={apiKey} onCopied={onCopied} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
