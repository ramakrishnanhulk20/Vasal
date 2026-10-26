export function Grain() {
  return (
    <svg className="grain" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <filter id="grain-noise">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.85"
          numOctaves="2"
          stitchTiles="stitch"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain-noise)" />
    </svg>
  );
}
