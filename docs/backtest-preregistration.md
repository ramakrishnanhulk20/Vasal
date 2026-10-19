# Backtest pre-registration: does Qloo guest fit predict episode views?

Written on 19 Oct 2026, before any Qloo data existed for this project; our hackathon API key had not been issued. This file is committed to the public repo before the data pull, so its git timestamp shows the method was fixed first. Any change after the data pull goes in the change log at the bottom, with the reason, in a new commit.

## The question

Vasal ranks possible podcast guests by how strongly Qloo links each person's audience to a show's audience. If that ranking means anything for a host, past guests with a higher fit should have drawn bigger audiences for their episodes.

## Hypotheses

- **H1 (primary).** Within a show, episodes whose guest has a higher Qloo fit to that show get more YouTube views, after adjusting for how long each episode has been online.
- **H2 (secondary).** H1 still holds after controlling for the guest's general fame, measured as their Qloo popularity percentile. This separates "a good fit for this audience" from "simply famous".

## Shows

These 12 shows were chosen on 19 Oct 2026, by name only. Each posts full episodes on YouTube and usually names one guest in the episode title.

1. Armchair Expert with Dax Shepard
2. Call Her Daddy
3. The Diary Of A CEO
4. Club Shay Shay
5. Hot Ones
6. Good Hang with Amy Poehler
7. Conan O'Brien Needs A Friend
8. This Past Weekend w/ Theo Von
9. Flagrant
10. Impaulsive
11. The Joe Rogan Experience
12. SmartLess

Before the data pull, a separate commit pins each show's official YouTube channel ID. The channels are found by hand and checked against each show's own website, and no Qloo data is consulted to pick them.

A show stays in the sample only if all of these hold. The rules are fixed here and applied the same way to every show:
- It resolves to a Qloo podcast entity whose normalised name matches the show's name.
- Its pinned channel has at least 30 eligible episodes in the window.
- At least 30 of those episodes have a guest resolved in Qloo.

If fewer than 6 shows pass, we report "insufficient data" and make no claim about correlation.

## Episodes

- **Window:** published from 1 Oct 2024 to 31 Jul 2026, so every episode has been online for at least 80 days at the pull and its view count has mostly settled.
- **Eligible:** a full episode at least 20 minutes long, with exactly one guest named in the title.
- **Excluded:** compilations, best-ofs, trailers, live Q&As, and episodes naming two or more guests. Each exclusion is counted.

## Guests

- **Extraction.** A language model reads each video title and returns the guest's name. A name is kept only if it appears in that title under the same normaliser used everywhere else in Vasal: NFKC, invisible characters removed, lower case, whitespace collapsed. Dropped names are counted.
- **Resolution.** Each name is searched in Qloo with the person type. The top result is kept only if its normalised name equals the extracted name. Otherwise the episode is dropped and counted.
- **Precision check.** A random sample of 50 kept guests, drawn with seed 20261019, is checked by hand against the episode. The precision is published.

## Measures

- **Fit.** Qloo's affinity score for the guest's person entity, given the show's podcast entity as the signal. The call is `/v2/insights` with `filter.type=urn:entity:person`, `signal.interests.entities=<podcast id>` and `filter.results.entities=<guest ids>`, in batches of at most 25. A guest with no score is dropped and counted.
- **Fame.** The guest's Qloo popularity percentile, from the same response.
- **Views.** The YouTube view count at the time of the pull.
- **Age.** The number of days from publication to the pull.
- **Adjusted views.** Within each show, the residual from an ordinary least squares fit of log(views + 1) on log(age).

## Analysis

- **H1.**
  - Compute the Spearman rank correlation between fit and adjusted views within each show.
  - Pool across shows with the Fisher z transform, weighting each show by (n - 3).
  - Build a 95% interval by bootstrap: 10,000 resamples of episodes within each show, seed 20261019.
- **H2.** The same, using a partial Spearman correlation between fit and adjusted views that controls for fame.
- **Descriptive.** The median adjusted-view ratio between the top and bottom fit quintiles, using quintiles computed within each show and pooled.
- **Decision rule.** A hypothesis is "supported" if the pooled correlation is above 0 and the lower end of its 95% interval is above 0. Otherwise it is "not supported". Both outcomes are published on the proof page in the same form.

## What this does not establish

- **Causation.** Qloo learns from what audiences consume together. A hit episode may itself raise the link between a guest and a show, which would inflate the correlation. H2 controls for general fame but not for this.
- **Audio downloads.** YouTube views are not podcast downloads. Many listeners never see YouTube.
- **Shows outside this sample.** The sample is 12 large, well-known shows. Mid-size shows, which are Vasal's real buyers, may behave differently.
- **Every guest.** Guests not named in titles, or not in Qloo, are missing. The drop counts are published so the size of the gap is visible.

## Change log

- 19 Oct 2026: first version.
