import { KolamThumb } from "@/components/KolamThumb";
import { KICKER, SOFT_100 } from "@/lib/textStyles";
import type { KolamData } from "@/lib/run";

export function RunHeader({
  name,
  meta,
  kolam,
}: {
  name: string;
  meta: string[];
  kolam: KolamData | null;
}) {
  return (
    <header className="grid grid-cols-12">
      <div className="col-span-12 row-start-2 md:col-span-9 md:row-start-1">
        <p className={KICKER}>THE BOARD</p>
        <h1
          className="mt-[14px] font-display text-[length:clamp(2.5rem,5vw,4.5rem)] font-[350] leading-none text-rice"
          style={SOFT_100}
        >
          {name}
        </h1>
        {meta.length > 0 && (
          <p className="mt-[18px] whitespace-pre-wrap font-mono text-[13px] text-rice-dim">
            {meta.join("  /  ")}
          </p>
        )}
      </div>
      {kolam && (
        <div className="col-span-12 row-start-1 mb-6 md:col-span-2 md:col-start-11 md:mb-0 md:justify-self-end">
          <KolamThumb
            kolam={kolam}
            active={false}
            drawKey={0}
            className="block h-24 w-24 md:h-[140px] md:w-[140px]"
          />
        </div>
      )}
    </header>
  );
}
