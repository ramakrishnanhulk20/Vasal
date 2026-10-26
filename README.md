# Vasal

In a Tamil home, the vasal is the doorway, where a kolam is drawn each morning to welcome guests. Vasal helps podcast hosts book the guests their listeners already love, and shows which audience each guest's fans lean toward.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Vasal is an agent: it asks Qloo's taste graph which people a show's listeners love, who those people's fans are, and what the two audiences share. Then it writes a booking brief and a pitch draft. Every number on screen comes from a Qloo call, computed in code. The model only picks tools and writes the prose.

## Status

Under construction, in public. What exists today:

- `packages/agent`, the server side:
  - a metered Qloo client: every request takes its own budget slot, is cached, is retried at most twice after a 408, a 429, a server error or a dropped connection, and never follows a redirect. Once Qloo's own monthly counter shows fewer than 1,500 calls left, new calls stop, apart from a short burst once a day that picks up a fresh count after Qloo's month resets. The agent's person lookup runs on Qloo's official harness (`@qloo/qloo-harness`) inside our process: its describe workflow and name resolver, with every request it makes going through that same metered client. The other Qloo calls use the client directly, because the harness lacks the popularity and release-year filters Vasal needs
  - a feed reader that turns a show name, an Apple Podcasts link or an RSS URL into the show's episode list, without ever fetching a private or internal address
  - a key-day probe that checks Qloo's coverage of 30 real shows
  - the agent server: it starts a run only for a person on our own site who passes a human check, inside per-visitor, site-wide and budget caps, and it streams each run's progress live
  - the agent: Claude Haiku researches the show inside hard limits with five tools that call Qloo, plus a sixth, the trend lookup, which stays off unless `VASAL_TRENDS` is on. Code then scores every finalist's fit in one Qloo call, so the fits compare with each other; the audience group each guest's fans lean toward more than the show's listeners do, and the tastes they share, come from that guest's own Qloo calls. Qloo's hackathon server returns no trend data yet, so whether a guest is rising shows as unknown rather than a guess. The model writes only the angles and the booking brief. Code refuses every digit the model writes and a list of common number words (cardinals from two, order words from "second", multipliers such as "double", "halved" and "tenfold", and words such as "decade" and "century"), so "her second Emmy" never ships; the prompts forbid every other way of stating a figure. It also strips any link or email the model invents
  - the backtest pipeline, exactly as pre-registered, with the 11 pinned YouTube channels in `docs/backtest-shows.json`
  - operator commands for budgets, pruning, the kill switch, health and the home-page showcase (`npm run ops -w packages/agent -- --dev selftest` tries them all on a throwaway database)
- `docs/security/threat-model.md`: the threat model, written before the code. Its section C is the definition of done.
- `docs/backtest-preregistration.md`: how we tested whether Qloo guest fit predicts real YouTube episode views. Fixed before any data was pulled.
- [`docs/backtest-results.md`](docs/backtest-results.md): the result. Across 755 episodes from 8 large podcasts, guests with a higher Qloo fit drew more views, even after allowing for fame. The link is small but positive in every show.

## Run the tests

Requires Node 22.19 or newer.

```bash
npm install
npm test
```

## Try the feed reader

Needs no API key. It calls Apple's public podcast directory and the show's own feed.

```bash
npm run feed:demo -w packages/agent -- "SmartLess"
```

## Run the agent server locally

Needs no keys in development. It uses an in-memory database and Cloudflare's published Turnstile test secret. Without `QLOO_API_KEY` and `ANTHROPIC_API_KEY` in `.env`, it says which key is missing and every run ends with an honest "agent not ready" event. With both, it runs the real agent.

```bash
npm run server:dev -w packages/agent
```

## Licence

MIT. See [LICENSE](LICENSE).
