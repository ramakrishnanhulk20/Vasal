"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { issueAgentKey } from "@/lib/agentKeys";
import type { IssuedKey } from "@/lib/agentKeys";
import type { Failure } from "@/lib/api";
import { PRIMARY_BUTTON, SECONDARY_LINK } from "@/lib/buttonStyle";
import { SITE_KEY, loadTurnstile } from "@/lib/turnstile";

const MCP_OFF = "MCP_OFF";

// What to tell the visitor when the server turns a request down. Each line says
// what to do next. A paused server shows the paused notice instead.
function refusalLine(failure: Failure): string {
  const { status, code } = failure;
  if (status === 403 && code === "HUMAN_CHECK_FAILED") {
    return "The human check didn't go through. Try it once more.";
  }
  if (status === 429 && code === "VISITOR_LIMIT") {
    return "That's today's keys from your network. Come back tomorrow, or use a key you already have.";
  }
  if (status === 429 && code === "KEY_BUDGET") {
    return "Vasal has given out all of today's agent keys. Come back tomorrow.";
  }
  if (status === 400 || (status === 403 && code === "FORBIDDEN_ORIGIN") || status === 413) {
    return "This page couldn't ask for a key. Reload it and try again.";
  }
  return "Vasal couldn't be reached. Try again in a minute.";
}

export function PausedNotice({ takeFocus }: { takeFocus: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (takeFocus) ref.current?.focus();
  }, [takeFocus]);

  return (
    <div ref={ref} tabIndex={-1} aria-live="polite" className="outline-none">
      <p className="max-w-[40ch] font-body text-[16px] text-rice">
        Agent keys are paused right now. The boards on the home page still work.
      </p>
      <div className="mt-3 flex">
        <Link href="/#showcase" className={SECONDARY_LINK}>
          <span className="link-draw">See the boards</span>
        </Link>
      </div>
    </div>
  );
}

export function KeyForm({
  onIssued,
  onPaused,
}: {
  onIssued: (key: IssuedKey) => void;
  onPaused: () => void;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    const container = widgetRef.current;
    if (!container) return;
    let cancelled = false;

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled) return;
        widgetId.current = turnstile.render(container, {
          sitekey: SITE_KEY,
          action: "agent_key",
          theme: "dark",
          size: "normal",
          callback: (value) => setToken(value),
          "expired-callback": () => setToken(null),
          "error-callback": () => setToken(null),
        });
      })
      .catch((error: unknown) => console.error("Human check could not start", error));

    return () => {
      cancelled = true;
      if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (token === null || pending) return;
    setPending(true);
    setRefusal(null);
    const result = await issueAgentKey(token);
    if (result.ok) {
      onIssued(result.value);
      return;
    }
    // A token works once, so a new one is asked for after every refusal.
    setPending(false);
    setToken(null);
    if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    if (result.status === 503 && result.code === MCP_OFF) {
      onPaused();
      return;
    }
    setRefusal(refusalLine(result));
  };

  return (
    <form onSubmit={submit}>
      <div ref={widgetRef} data-action="agent_key" />
      <button
        type="submit"
        disabled={token === null || pending}
        className={`${PRIMARY_BUTTON} mt-4 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:brightness-100`}
      >
        {pending ? "Getting your key..." : "Get an agent key"}
      </button>
      <div aria-live="polite" className="mt-[14px]">
        {refusal !== null && <p className="font-body text-[15px] text-rice">{refusal}</p>}
      </div>
    </form>
  );
}
