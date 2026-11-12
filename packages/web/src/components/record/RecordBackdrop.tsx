// The dawn behind the page is a fixed layer, so a full-page capture paints it
// over the first screen only and the rest shows the plain page colour, with a
// hard edge between them. This continues that layer's bottom edge (its colour
// and the lower half of its glow) down the rest of the page. The fixed layer
// covers it on screen, so a visitor never sees it.
export function RecordBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 top-[100vh] z-0"
      style={{
        background:
          "radial-gradient(ellipse 85% 39vh at 50% 0%, rgba(201, 135, 74, calc(0.1 + 0.28 * var(--dawn))) 0%, rgba(110, 74, 90, calc(0.08 + 0.17 * var(--dawn))) 38%, transparent 72%), #121428",
      }}
    />
  );
}
