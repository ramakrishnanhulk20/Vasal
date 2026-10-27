// One closed loop that weaves around four dots, the same shape the kolam
// generator draws for a guest with four shared tastes. Eight pixels per unit,
// so the dots sit at the corners of a 16px square and the stroke is 1.5px.
export const LOOP =
  "M 0.5 0.5 Q 1 0 1.5 0.5 Q 2 1 1.5 1.5 Q 1 2 0.5 2.5 Q 0 3 0.5 3.5 Q 1 4 1.5 3.5 Q 2 3 2.5 2.5 Q 3 2 3.5 1.5 Q 4 1 3.5 0.5 Q 3 0 2.5 0.5 Q 2 1 2.5 1.5 Q 3 2 3.5 2.5 Q 4 3 3.5 3.5 Q 3 4 2.5 3.5 Q 2 3 1.5 2.5 Q 1 2 0.5 1.5 Q 0 1 0.5 0.5 Z";

export const DOTS: Array<[number, number]> = [
  [1, 1],
  [3, 1],
  [3, 3],
  [1, 3],
];

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="32"
      height="32"
      viewBox="0 0 4 4"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={LOOP}
        className="stroke-rice"
        strokeWidth="0.1875"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {DOTS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="0.25" className="fill-rice" />
      ))}
    </svg>
  );
}
