import { useSyncExternalStore } from "react";

export type KolamMode = "rings" | "line";
export type LabState = { mode: KolamMode; replay: number };

const initial: LabState = { mode: "rings", replay: 0 };
let state = initial;
const listeners = new Set<() => void>();

function emit(next: LabState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setKolamMode(mode: KolamMode) {
  if (state.mode !== mode) emit({ ...state, mode });
}

export function replayKolam() {
  emit({ ...state, replay: state.replay + 1 });
}

// The lab panel and the kolam live in different parts of the tree, so they
// share this small store instead of a provider.
export function useLabState(): LabState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  );
}
