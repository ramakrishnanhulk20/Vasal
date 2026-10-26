"use client";

import { useState } from "react";
import { replayKolam, setKolamMode, useLabState } from "@/lib/labStore";
import type { KolamMode } from "@/lib/labStore";

const MODES: Array<{ mode: KolamMode; label: string }> = [
  { mode: "rings", label: "Rings" },
  { mode: "line", label: "One line" },
];

const MARIGOLDS = [
  { name: "A", color: "#F2A93B" },
  { name: "B", color: "#F5B041" },
  { name: "C", color: "#E39B2D" },
];

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-rice";

const TEXT_BUTTON = `cursor-pointer rounded-lg border px-2 py-1 transition-[color,border-color] duration-150 ease-out ${FOCUS}`;
const IDLE_TEXT_BUTTON =
  "border-rule text-rice-dim hover:border-[rgba(242,238,230,0.45)] hover:text-rice";
const ACTIVE_TEXT_BUTTON = "border-rice text-rice";

export function LabPanel() {
  const { mode } = useLabState();
  const [open, setOpen] = useState(false);
  const [marigold, setMarigold] = useState(MARIGOLDS[0]?.name);

  const chooseMarigold = (name: string, color: string) => {
    setMarigold(name);
    document.documentElement.style.setProperty("--accent", color);
  };

  return (
    <>
      <div
        className={`fixed inset-x-0 bottom-0 z-50 flex-col gap-[10px] rounded-t-lg border border-rule bg-night-2 p-3 pb-16 font-mono text-xs text-rice ${open ? "flex" : "hidden"} md:bottom-auto md:left-auto md:right-4 md:top-[88px] md:flex md:w-max md:rounded-lg md:pb-3`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-rice-dim">Kolam</span>
          <div className="flex gap-2">
            {MODES.map((item) => (
              <button
                key={item.mode}
                type="button"
                onClick={() => setKolamMode(item.mode)}
                aria-pressed={mode === item.mode}
                className={`${TEXT_BUTTON} ${mode === item.mode ? ACTIVE_TEXT_BUTTON : IDLE_TEXT_BUTTON}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-rice-dim">Marigold</span>
          <div className="flex gap-2">
            {MARIGOLDS.map((item) => (
              <button
                key={item.name}
                type="button"
                aria-label={`Marigold ${item.name}`}
                aria-pressed={marigold === item.name}
                onClick={() => chooseMarigold(item.name, item.color)}
                className={`h-5 w-5 cursor-pointer rounded-[4px] transition-[scale,box-shadow] duration-150 ease-out hover:scale-[1.12] hover:ring-1 hover:ring-rice ${marigold === item.name ? "ring-1 ring-rice" : ""} ${FOCUS}`}
                style={{ backgroundColor: item.color }}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={replayKolam}
          className={`${TEXT_BUTTON} ${IDLE_TEXT_BUTTON} text-left`}
        >
          Replay drawing
        </button>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`fixed bottom-4 right-4 z-[60] cursor-pointer rounded-lg border border-rule bg-night-2 px-3 py-2 font-mono text-xs text-rice-dim transition-[color] duration-150 ease-out hover:text-rice md:hidden ${FOCUS}`}
      >
        Lab
      </button>
    </>
  );
}
