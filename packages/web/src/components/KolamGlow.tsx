import type { KolamData } from "@/lib/run";

export function KolamGlow({ id, viewBox }: { id: string; viewBox: KolamData["viewBox"] }) {
  const [minX, minY, width, height] = viewBox;
  return (
    <defs>
      <filter id={id} filterUnits="userSpaceOnUse" x={minX} y={minY} width={width} height={height}>
        <feDropShadow
          dx="0"
          dy="0"
          stdDeviation="0.06"
          style={{ floodColor: "var(--rice)", floodOpacity: 0.35 }}
        />
      </filter>
    </defs>
  );
}
