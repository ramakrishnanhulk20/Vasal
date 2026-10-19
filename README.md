# Vasal

In a Tamil home, the vasal is the doorway, where a kolam is drawn each morning to welcome guests. Vasal helps podcast hosts book the guests their listeners already love, and the guests who bring new listeners.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). Vasal is an agent: it asks Qloo's taste graph which people a show's listeners love, who those people's fans are, whether they are rising, and what the two audiences share. Then it writes a booking brief and a pitch draft. Every number on screen comes from a Qloo call, computed in code. The model only picks tools and writes the prose.

## Status

Under construction, in public. What exists today:

- `packages/agent`, the server side:
  - a Qloo client built on Qloo's official harness (`qloo mcp`)
  - a feed reader that turns a show name, an Apple Podcasts link or an RSS URL into the show's episode list, without ever fetching a private or internal address
  - a key-day probe that checks Qloo's coverage of 30 real shows
  - the agent server: it starts a run only for a person on our own site who passes a human check, inside per-visitor, site-wide and budget caps, and it streams each run's progress live; the agent itself plugs in next
  - a YouTube client for the backtest, which reads a channel's uploads and view counts with the key kept out of every URL
- `docs/security/threat-model.md`: the threat model, written before the code. Its section C is the definition of done.
- `docs/backtest-preregistration.md`: how we will test whether Qloo guest fit predicts real YouTube episode views. Fixed before any data was pulled.

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

Needs no keys in development. It uses an in-memory database and Cloudflare's published Turnstile test secret. Until the agent is wired in, every run ends with an honest "agent not ready" event.

```bash
npm run server:dev -w packages/agent
```

## Licence

MIT. See [LICENSE](LICENSE).
