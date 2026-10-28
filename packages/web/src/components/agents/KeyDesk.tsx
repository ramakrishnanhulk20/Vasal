"use client";

import { useCallback, useEffect, useState } from "react";
import { DeskPanel } from "@/components/agents/DeskPanel";
import { KeyForm, PausedNotice } from "@/components/agents/KeyForm";
import { LimitsList } from "@/components/agents/LimitsList";
import type { IssuedKey, KeyDeskState } from "@/lib/agentKeys";
import { KICKER, SOFT_100 } from "@/lib/textStyles";

// `desk` is what the server read of the key settings gave, or null when that
// read failed. Null keeps the form and drops the limits.
export function KeyDesk({ desk }: { desk: KeyDeskState | null }) {
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [pausedByServer, setPausedByServer] = useState(false);
  const [copied, setCopied] = useState(false);
  const paused = desk?.open === false || pausedByServer;

  // Only a copy that holds the key counts. A snippet copied before the key
  // existed, or the server address, leaves the key unsaved.
  const markCopied = useCallback(
    (copiedText: string) => {
      if (issued !== null && copiedText.includes(issued.token)) setCopied(true);
    },
    [issued],
  );

  // A copy made before the key arrived must not switch the warning off.
  const keyIssued = useCallback((key: IssuedKey) => {
    setCopied(false);
    setIssued(key);
  }, []);

  // The key is on this page and nowhere else, so leaving before copying it
  // loses it. The warning goes once the key itself has been copied.
  useEffect(() => {
    if (issued === null || copied) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [issued, copied]);

  return (
    <section className="grid grid-cols-1 items-start gap-y-14 md:grid-cols-12 md:gap-y-0">
      <div className="min-w-0 md:col-span-5">
        <p className={KICKER}>FOR AGENTS</p>
        <h1
          className="mt-[14px] font-display text-[length:clamp(2.5rem,5vw,4.5rem)] font-[350] leading-none text-rice"
          style={SOFT_100}
        >
          Give your agent a key.
        </h1>
        <p className="mt-5 max-w-[40ch] font-body text-[18px] leading-[1.6] text-rice-dim">
          {`Vasal is a remote MCP server. With a key, any agent that speaks MCP can find a show, build a guest board from Qloo's taste data and write a brief, with the same checks the site uses.`}
        </p>
        <div className="mt-9">
          {issued !== null ? (
            <p className="font-body text-[15px] text-rice-dim">
              Your key is <span className="md:hidden">below</span><span className="hidden md:inline">on the right</span>. Need another? Reload the page.
            </p>
          ) : paused ? (
            <PausedNotice takeFocus={pausedByServer} />
          ) : (
            <KeyForm onIssued={keyIssued} onPaused={() => setPausedByServer(true)} />
          )}
        </div>
        {desk !== null && <LimitsList limits={desk.limits} />}
      </div>
      <div className="min-w-0 md:col-span-6 md:col-start-7">
        <DeskPanel issued={issued} onCopied={markCopied} />
      </div>
    </section>
  );
}
