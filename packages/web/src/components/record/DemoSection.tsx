import { Reveal } from "@/components/proof/Reveal";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

const VIDEO = "https://www.youtube-nocookie.com/embed/rb1iZH1dGLY";

export function DemoSection() {
  return (
    <section id="demo" className="relative z-20 px-[6vw] pt-[18vh]">
      <Reveal amount={0.2}>
        <p className={KICKER}>THE DEMO</p>
        <h2 className={`mt-5 text-balance ${SECTION_TITLE}`} style={SOFT_100}>
          Ninety seconds of the live app.
        </h2>
      </Reveal>
      <Reveal delay={0.1} amount={0.15} className="mt-10 md:grid md:grid-cols-12">
        <div className="md:col-span-10">
          <div className="aspect-video w-full overflow-hidden rounded-lg border border-rule bg-night-2">
            <iframe
              src={VIDEO}
              title="Vasal demo"
              loading="lazy"
              allow="encrypted-media; picture-in-picture; fullscreen"
              referrerPolicy="strict-origin-when-cross-origin"
              className="block h-full w-full border-0"
            />
          </div>
          <p className="mt-[14px] font-body text-[15px] text-rice-dim">
            Recorded on 28 October 2026 against the live site.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
