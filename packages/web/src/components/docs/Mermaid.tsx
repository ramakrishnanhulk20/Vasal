"use client";

import {
  Component,
  Suspense,
  use,
  useCallback,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

// Mapped to the site's night palette. Dark only: the docs have no light theme.
const THEME_VARIABLES = {
  background: "#0a0c11",
  primaryColor: "#11141c",
  primaryTextColor: "#f2eee6",
  primaryBorderColor: "rgba(242, 238, 230, 0.35)",
  lineColor: "rgba(242, 238, 230, 0.55)",
  secondaryColor: "#11141c",
  tertiaryColor: "#0a0c11",
  textColor: "#f2eee6",
  fontFamily: "var(--font-docs-body), system-ui, sans-serif",
  actorBkg: "#11141c",
  actorBorder: "rgba(242, 238, 230, 0.35)",
  actorTextColor: "#f2eee6",
  signalColor: "rgba(242, 238, 230, 0.7)",
  signalTextColor: "#f2eee6",
  noteBkgColor: "#11141c",
  noteTextColor: "#f2eee6",
  noteBorderColor: "rgba(242, 238, 230, 0.2)",
  labelBoxBkgColor: "#11141c",
  labelTextColor: "#f2eee6",
};

// Drawn charts are cached by their text, so a diagram that appears twice is
// only drawn once. The library has its own map: a chart whose text is exactly
// "mermaid" must not be mistaken for it.
const library = new Map<string, Promise<unknown>>();
const charts = new Map<string, Promise<unknown>>();

function cached<T>(
  store: Map<string, Promise<unknown>>,
  key: string,
  make: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit as Promise<T>;
  const promise = make();
  store.set(key, promise);
  return promise;
}

function loadMermaid() {
  return cached(library, "mermaid", async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: THEME_VARIABLES.fontFamily,
      themeVariables: THEME_VARIABLES,
      // Fit-to-width shrank the labels to about 7px on desktop and 3px on a
      // phone, so diagrams draw at their own size and scroll inside the box.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
    });
    // Mermaid measures label text to size the boxes, so the real font must be ready first.
    await document.fonts.ready;
    return mermaid;
  });
}

function Loading() {
  return (
    <div className="docs-diagram" role="status">
      <span className="docs-diagram-note">Drawing the diagram...</span>
    </div>
  );
}

function Failed({ chart }: { chart: string }) {
  return (
    <div className="docs-diagram">
      <pre className="docs-diagram-source">
        <code>{chart}</code>
      </pre>
      <p className="docs-diagram-note">This diagram could not be drawn.</p>
    </div>
  );
}

class DiagramBoundary extends Component<{ chart: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  render() {
    if (this.state.failed) return <Failed chart={this.props.chart} />;
    return this.props.children;
  }
}

// React reads this hook off the class itself. It is attached here because the
// site's stylesheet scans every file in the app for class names, and the
// keyword that would otherwise sit in the class body is also a class name.
Object.assign(DiagramBoundary, { getDerivedStateFromError: () => ({ failed: true }) });

// Shrinks a wide diagram to the box, but never below the scale at which its
// labels stay readable; past that it scrolls sideways inside the box.
// `onOverflow` is told whether the diagram still runs wider than the box.
const MIN_SCALE = 0.72;

function fitToBox(box: HTMLDivElement, onOverflow: (wider: boolean) => void): () => void {
  const svg = box.querySelector("svg");
  if (!svg) return () => {};
  const natural = svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width;
  const fit = () => {
    const room = box.clientWidth - 32;
    const scale = Math.min(1, Math.max(MIN_SCALE, room / natural));
    svg.style.width = `${Math.round(natural * scale)}px`;
    svg.style.height = "auto";
    // One pixel of slack, because the width is rounded.
    onOverflow(box.scrollWidth > box.clientWidth + 1);
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(box);
  return () => observer.disconnect();
}

function Drawing({ chart }: { chart: string }) {
  const id = useId();
  const mermaid = use(loadMermaid());
  const { svg, bindFunctions } = use(cached(charts, chart, () => mermaid.render(id, chart)));
  const [wider, setWider] = useState(false);
  const attach = useCallback(
    (box: HTMLDivElement | null) => {
      if (!box) return;
      bindFunctions?.(box);
      return fitToBox(box, setWider);
    },
    [bindFunctions],
  );

  return (
    <>
      <div className="docs-diagram" ref={attach} dangerouslySetInnerHTML={{ __html: svg }} />
      {wider && <p className="docs-diagram-hint">Scroll sideways for the rest of the diagram.</p>}
    </>
  );
}

export function Mermaid({ chart }: { chart: string }) {
  const onClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  if (!onClient) return <Loading />;

  return (
    <DiagramBoundary chart={chart}>
      <Suspense fallback={<Loading />}>
        <Drawing chart={chart} />
      </Suspense>
    </DiagramBoundary>
  );
}
