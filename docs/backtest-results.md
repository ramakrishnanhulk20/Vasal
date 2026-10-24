# Backtest results: does Qloo guest fit predict episode views?

The data was pulled on 21 Oct 2026. The method was fixed and committed before any data existed. It is in [the pre-registration](backtest-preregistration.md).

## The answer

Yes, by a small margin, and consistently. Across 755 episodes from 8 large podcasts, guests with a higher Qloo fit to the show drew more YouTube views. This is after adjusting for how long each episode had been online. The link held when the guest's general fame was controlled for, and it was positive in all 8 shows.

Episodes whose guest sat in the top fifth by fit had 1.55 times the median adjusted views of episodes in the bottom fifth.

The effect is small. A correlation of 0.14 means fit tilts the odds. It does not decide how big an episode's audience will be.

## Results

| Test | Pooled Spearman correlation | 95% interval | Decision |
| --- | --- | --- | --- |
| H1: fit and age-adjusted views | 0.140 | 0.069 to 0.211 | Supported |
| H2: the same, controlling for fame | 0.096 | 0.021 to 0.173 | Supported |

- **Pooling:** each show's correlation is pooled across shows with the Fisher z transform, weighted by n minus 3.
- **Intervals:** from 10,000 bootstrap resamples of episodes within each show, with seed 20261019.
- **The decision rule:** "Supported" means the pooled correlation is above 0 and the lower end of its interval is above 0. This rule was written before the pull.

### By show

| Show | Episodes | Fit and views | Controlling for fame |
| --- | --- | --- | --- |
| Armchair Expert with Dax Shepard | 196 | 0.157 | 0.140 |
| Call Her Daddy | 127 | 0.026 | 0.033 |
| The Diary Of A CEO | 43 | 0.104 | 0.102 |
| Club Shay Shay | 53 | 0.126 | 0.119 |
| Conan O'Brien Needs A Friend | 62 | 0.222 | 0.056 |
| This Past Weekend w/ Theo Von | 73 | 0.125 | 0.105 |
| Impaulsive | 37 | 0.410 | 0.296 |
| The Joe Rogan Experience | 164 | 0.132 | 0.049 |

## Timeline, from the git history

- **19 Oct 2026, 05:41 UTC:** the method and the show list were committed ([52e208f](https://github.com/ramakrishnanhulk20/Vasal/commit/52e208f)). Our Qloo key did not exist yet.
- **19 Oct, 10:25 UTC:** each show's YouTube channel was pinned ([4a2a8ca](https://github.com/ramakrishnanhulk20/Vasal/commit/4a2a8ca)).
- **21 Oct, 10:16 UTC:** three fixes to the title reader went into the change log ([40547e0](https://github.com/ramakrishnanhulk20/Vasal/commit/40547e0)). They were found by a pre-flight that looked only at 12 episode titles.
- **21 Oct, 10:16 UTC:** pull 1 started. About 30 minutes later it stopped with an error, because a scheduled YouTube premiere had no duration yet. It wrote no dataset, and no number on this page comes from it.
- **21 Oct, 10:52 UTC:** pull 2 started, with a fix that reads a missing duration as unknown. The fix was not yet committed. Pull 2 is the dataset 20261021T105230Z, and it was analysed as it finished.
- **21 Oct, 15:07 UTC:** the fix was committed ([d16c6d9](https://github.com/ramakrishnanhulk20/Vasal/commit/d16c6d9)). The pre-registration's [change log](backtest-preregistration.md#change-log) gained an entry for both pulls on 24 Oct.

## The sample

Of the 12 pre-registered shows, 8 passed the inclusion rules. Four were excluded by those rules:
- **Hot Ones and Good Hang with Amy Poehler:** Qloo's podcast search returned no podcast whose name matched.
- **Flagrant:** two Qloo podcasts matched, and the rule excludes the show rather than picking one.
- **SmartLess:** it has no official full-episode YouTube channel.

Club Shay Shay was cut short. Its 2,000 most recent uploads only reach back to February 2025.

Episodes dropped, by rule:

| Rule | Episodes dropped |
| --- | --- |
| Belongs to another show on a shared channel | 922 |
| Published outside 1 Oct 2024 to 31 Jul 2026 | 5,181 |
| Shorter than 20 minutes, such as clips and shorts | 4,215 |
| Title does not name exactly one guest | 403 |
| Guest not found in Qloo under the same name | 257 |
| Qloo gave no fit score | 194 |
| Title could not be read, name not in the title, views hidden, or no fame score | 0 |

## Precision check

The pre-registration asks for 50 kept guests, drawn with seed 20261019, to be checked against their episodes. We checked each one against its title and the show's format. We did not watch the episodes. 44 of the 50 were right, which is 88%.

- **Five errors** were Armchair Expert "Fact Check" episodes. Their titles name an earlier guest, but that guest does not appear in them.
- **One error** was a Conan O'Brien Needs A Friend travel special, where the reader named the co-host as the guest.

### A check added after the fact

This check is post-hoc. It is not part of the pre-registered result, and it is labelled that way here.

We reran the same analysis without all 70 Fact Check episodes and the 2 travel specials, which left 683 episodes:
- H1 came out at 0.149 (interval 0.070 to 0.226).
- H2 came out at 0.100 (interval 0.017 to 0.184).

Both are still supported.

## Repeat guests: a check added after publication

This check is post-hoc. It was added on 24 Oct, after this page was published, at a reviewer's request. It is not part of the pre-registered result.

Some guests appear on the same show more than once. The 755 episodes have 603 distinct guests, counting each show's guests separately. The intervals above resample episodes, so a guest's episodes count as independent, which can make an interval too narrow. Two checks on the same dataset:
- **Resampling guests instead of episodes,** with all of a guest's episodes drawn together (2,000 resamples, seed 20261024): H1's interval is 0.065 to 0.211, and H2's is 0.020 to 0.167.
- **One row per guest,** using the mean adjusted views of that guest's episodes: H1 is 0.153 and H2 is 0.111, over 603 guests.

Both guest-level intervals stay above 0, so both verdicts stand. H2's lower end, 0.020, is close to 0.

## What this does not show

- **Causation.** Qloo learns from what audiences consume together, so a hit episode may itself strengthen the link between a guest and a show. Controlling for fame does not remove that.
- **Audio downloads.** YouTube views are not podcast downloads, and many listeners never use YouTube.
- **Smaller shows.** These 8 are among the largest podcasts. Mid-size shows, which are the hosts Vasal is built for, may behave differently.
- **Every guest.** Episodes whose guest is not named in the title, or is not in Qloo, are missing. The drop counts above show how many.

## Reproducing it

The dataset holds Qloo responses, and Qloo's terms keep those out of public repositories, so it is not published here. The code is in [packages/agent/src/backtest](../packages/agent/src/backtest).

- `npm run backtest -w packages/agent -- --dry-run` prints the plan and every rule, with no keys needed.
- With QLOO_API_KEY, ANTHROPIC_API_KEY and YOUTUBE_API_KEY in `.env`, `npm run backtest -w packages/agent -- --dev-db` pulls and analyses. It costs about 900 Qloo calls and well under a dollar of model use.
- `npm run backtest -w packages/agent -- --analyse <dataset.json>` recomputes the pre-registered results from a stored dataset: both hypotheses with their intervals, the by-show correlations, the 1.55 ratio, and the sample and drop counts.
- `npm run backtest:robustness -w packages/agent -- <dataset.json>` recomputes the two post-hoc checks from the same dataset: the rerun without misread rows, and the repeat-guest check.
- The precision figure, 44 of 50, is a hand check, so no script recomputes it. The labelled rows are not published, because they are YouTube titles read through YouTube's API, and we keep data from Qloo's and YouTube's APIs out of the public repo.

A fresh pull will come out slightly different, because view counts keep moving.
