import { SignatureChart } from "@/components/proof/SignatureChart";
import {
  backtest,
  formatCount,
  formatRatio,
  inWords,
  monthYear,
  ratioAxis,
} from "@/lib/backtest";

export function Signature() {
  const { sample, window: span, minimumMinutes, fifths } = backtest;
  const axis = ratioAxis(fifths.map((f) => f.medianRatio));
  const episodes = formatCount(sample.episodes);
  const ratios = fifths.map((f) => formatRatio(f.medianRatio));

  const captions = [
    {
      lead: "Each dot is one episode.",
      body: `${episodes} episodes from ${inWords(sample.shows)} of the biggest podcasts on YouTube, published from ${monthYear(span.from)} to ${monthYear(span.to)}, each at least ${minimumMinutes} minutes long with one guest named in the title.`,
    },
    {
      lead: "Sorted by how well the guest fit.",
      body: "Qloo scores how closely a guest's fans match a show's listeners. We split each show's episodes into fifths by that score, from the weakest fit to the strongest, then put the shows' fifths together.",
    },
    {
      lead: "Then we looked at views.",
      body: "Each ring is a fifth's median views, adjusted for how long its episodes had been up, against the bottom fifth's.",
    },
    {
      lead: `The best-fitting fifth drew ${ratios[4]} the bottom fifth's views.`,
      body: "The middle fifths don't climb in a straight line, so read it as a tilt, not a promise. A better fit raises the odds of a bigger episode; it doesn't decide one.",
    },
  ];

  return (
    <SignatureChart
      fifths={fifths.map((f, i) => ({
        episodes: f.episodes,
        episodesText: formatCount(f.episodes),
        ratio: f.medianRatio,
        ratioText: ratios[i],
      }))}
      domain={{ min: axis.min, max: axis.max }}
      ticks={axis.ticks}
      captions={captions}
      description={`${episodes} episodes in five groups by Qloo fit. Median views for their age, against the bottom group: ${ratios.join(", ")}.`}
    />
  );
}
