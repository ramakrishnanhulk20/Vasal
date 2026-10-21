# Vasal

In a Tamil home, the vasal is the doorway, where a kolam is drawn each morning to welcome guests. Vasal helps podcast hosts book the guests their listeners already love, and the guests who bring new listeners.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Vasal is an agent: it asks Qloo's taste graph which people a show's listeners love, who those people's fans are, and what the two audiences share. Then it writes a booking brief and a pitch draft. Every number on screen comes from a Qloo call, computed in code. The model only picks tools and writes the prose.

## Status

Under construction, in public. What exists today:

- `packages/agent`, the server side:
  - a Qloo client built on Qloo's official harness (`qloo mcp`)
  - a feed reader that turns a show name, an Apple Podcasts link or an RSS URL into the show's episode list, without ever fetching a private or internal address
  - a key-day probe that checks Qloo's coverage of 30 real shows
  - the agent server: it starts a run only for a person on our own site who passes a human check, inside per-visitor, site-wide and budget caps, and it streams each run's progress live
  - the agent: Claude Haiku researches the show with eight Qloo tools inside hard limits. Code then scores every finalist in one comparable Qloo call (fit, reach, the listeners they bring, the tastes they share). Qloo's hackathon server returns no trend data yet, so whether a guest is rising shows as unknown rather than a guess. The model writes only the angles and the booking brief, and code strips any number, link or email it invents
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
