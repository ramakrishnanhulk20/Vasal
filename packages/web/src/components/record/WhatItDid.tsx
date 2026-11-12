import { Reveal } from "@/components/proof/Reveal";
import { KICKER, SECTION_TITLE, SOFT_100 } from "@/lib/textStyles";

const ROWS = [
  {
    lead: "A live agent.",
    body: "Claude worked through Qloo's tools on every run, and each call appeared on screen as it happened. A board took about a minute and about 25 Qloo calls.",
  },
  {
    lead: "The show's own history.",
    body: "Every name was checked against the show's episode feed, so past guests and hosts never reached the board.",
  },
  {
    lead: "Without Qloo, side by side.",
    body: "Every board carried the same model's guesses made with no Qloo data. Across the seven saved boards, 41 of its 56 guesses had already been on the show or hosted it.",
  },
  {
    lead: "An open door for agents.",
    body: "Any MCP client could run the same booker with a free key.",
  },
];

export function WhatItDid() {
  return (
    <section className="relative z-20 px-[6vw] pt-[18vh]">
      <Reveal amount={0.2}>
        <p className={KICKER}>WHAT IT DID</p>
        <h2 className={`mt-5 text-balance ${SECTION_TITLE}`} style={SOFT_100}>
          One question for Qloo, answered for every show.
        </h2>
      </Reveal>
      <div className="mt-10">
        {ROWS.map((row, index) => (
          <Reveal
            key={row.lead}
            delay={index * 0.07}
            amount={0.2}
            className="grid grid-cols-1 gap-y-3 border-t border-rule py-6 first:border-t-0 md:grid-cols-12 md:items-baseline md:gap-y-0"
          >
            <p className="font-display text-[26px] font-[350] text-rice md:col-span-4">
              {row.lead}
            </p>
            <p className="font-body text-[17px] leading-[1.6] text-rice-dim md:col-span-7 md:col-start-5">
              {row.body}
            </p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
