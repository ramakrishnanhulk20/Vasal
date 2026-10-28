import { DRAW_SCALE, pathLength, scalePath } from "@/lib/pathLength";
import type { BoardGuest, Run } from "@/lib/run";

export const SHRINK = `scale(${1 / DRAW_SCALE})`;
export const DOT_RADIUS = 0.09;
const EQUAL_WIDTH = 0.09;

export type DrawnRing = {
  guestId: string;
  d: string;
  name: string;
  fit: number;
  fresh: boolean;
  width: number;
  guest: BoardGuest;
};

export type DrawnStretch = { key: string; d: string; width: number; from: number; to: number };

// Rings come back in fit order, strongest guest first. Both the hero and the
// board story read from here so their paths and stroke widths cannot differ.
export function buildDrawing(run: Run) {
  const guests = new Map(run.board.map((guest) => [guest.id, guest]));
  const ranked = run.kolam.rings
    .flatMap((ring) => {
      const guest = guests.get(ring.guestId);
      return guest ? [{ ring, guest }] : [];
    })
    .sort((a, b) => a.guest.fitRank - b.guest.fitRank);

  const fits = ranked.map(({ guest }) => guest.fit);
  const minFit = Math.min(...fits);
  const maxFit = Math.max(...fits);
  const widthFor = (fit: number) =>
    maxFit === minFit ? EQUAL_WIDTH : 0.05 + (0.08 * (fit - minFit)) / (maxFit - minFit);

  const rings: DrawnRing[] = ranked.map(({ ring, guest }) => ({
    guestId: ring.guestId,
    d: scalePath(ring.d),
    name: guest.name,
    fit: guest.fit,
    fresh: guest.bringsNew !== null,
    width: widthFor(guest.fit) * DRAW_SCALE,
    guest,
  }));

  const lengths = run.kolam.joined.map((stretch) => {
    const length = pathLength(stretch.d);
    return Number.isFinite(length) && length > 0 ? length : 1;
  });
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  let covered = 0;
  const stretches: DrawnStretch[] = run.kolam.joined.flatMap((stretch, index) => {
    const guest = guests.get(stretch.guestId);
    const length = lengths[index] ?? 1;
    const from = covered / totalLength;
    covered += length;
    return guest
      ? [
          {
            key: `${index}-${stretch.guestId}`,
            d: scalePath(stretch.d),
            width: widthFor(guest.fit) * DRAW_SCALE,
            from,
            to: covered / totalLength,
          },
        ]
      : [];
  });

  return { rings, stretches };
}

export function ringStrokeClass(ring: DrawnRing): string {
  return ring.fresh ? "stroke-accent" : "stroke-rice";
}

export function showSuffix(run: Run): string {
  return run.pastGuests.feedName ? ` for ${run.pastGuests.feedName}` : "";
}

export function kolamLabel(run: Run): string {
  const { kolam } = run;
  const loops =
    kolam.rings.length === run.board.length
      ? `${kolam.rings.length} loops, one for each guest`
      : `${kolam.rings.length} loops, one for each guest with shared tastes (the board has ${run.board.length})`;
  return `A kolam drawn from a real Vasal run${showSuffix(run)}: ${loops}, and ${kolam.dots.length} dots, one for each taste a guest's fans share with the show's listeners.`;
}
