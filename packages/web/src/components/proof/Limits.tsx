import { Reveal } from "@/components/proof/Reveal";
import { KICKER, SOFT_100 } from "@/lib/textStyles";

const LIMITS = [
  {
    lead: "Cause and effect.",
    body: "Qloo learns from what audiences enjoy together, so a hit episode may itself strengthen the link between a guest and a show. Holding fame equal doesn't remove that.",
  },
  {
    lead: "Downloads.",
    body: "YouTube views are not podcast downloads, and many listeners never open YouTube.",
  },
  {
    lead: "Smaller shows.",
    body: "These are some of the biggest podcasts there are. Mid-size shows, the hosts Vasal is built for, may behave differently.",
  },
  {
    lead: "Every guest.",
    body: "Episodes whose guest isn't named in the title, or isn't in Qloo, are missing. The bars above show how many.",
  },
];

export function Limits() {
  return (
    <section className="mt-[18vh]">
      <Reveal>
        <p className={KICKER}>WHAT THIS DOES NOT SHOW</p>
      </Reveal>
      <Reveal className="mt-8" amount={0.15}>
        <dl className="divide-y divide-rule">
          {LIMITS.map((limit) => (
            <div key={limit.lead} className="grid grid-cols-12 gap-y-2 py-6">
              <dt
                className="col-span-12 font-display text-[24px] font-[350] leading-[1.2] text-rice md:col-span-4 md:pr-8"
                style={SOFT_100}
              >
                {limit.lead}
              </dt>
              <dd className="col-span-12 font-body text-[17px] leading-[1.6] text-rice-dim md:col-span-7 md:col-start-5">
                {limit.body}
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  );
}
