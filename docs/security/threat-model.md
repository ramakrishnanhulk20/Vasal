# Threat model

Written at the architecture gate, before any code. Section C is the acceptance criteria. Each invariant states an outcome and how to show it holds, and the build is not done until each one can be pointed to in the code.

Note on sources: the reviewed design looked a show up through the Podcast Index API. The build uses Apple's iTunes Search API instead (DECISIONS.md, 16 Oct 2026). It has the same property: podcasters register their own feed URLs. So every rule below that names Podcast Index applies to the iTunes lookup unchanged.

## Data flows referred to below

- F1 Run start: a visitor submits a show name or URL and optional names to exclude. Later they send a "this is the right show" choice and a guest pick.
- F2 Show resolution: the server searches Qloo and the podcast directory, or reads a pasted Apple Podcasts link, and returns candidates.
- F3 Feed fetch: the server downloads an RSS feed from a pasted URL or a directory result and parses it.
- F4 Agent loop: the model reads tool results and picks the next Qloo, feed or YouTube call. Code computes the ranking and every number. The model writes the brief and the pitch.
- F5 Live stream: step events (tool name, inputs, summarised outputs) go to the browser over server-sent events (SSE).
- F6 Storage and read-back: runs, step logs, the Qloo cache, counters, showcase runs and backtest results live in Postgres and are rendered later.
- F7 Offline scripts: the backtest, the seed script and the daily health check, run by the operator with the same keys.
- F8 Repo and deploy: public source on GitHub, secrets in the host's environment variables.

## A) App-class risk profile

In security terms this system is six things at once:
1. A service that fetches URLs chosen by someone else (the visitor, a podcast directory, a redirect, or the model) from the server's position on the network.
2. An AI agent with tools that reads text written by strangers (feeds, YouTube titles, directory metadata, Qloo entity data) and decides what to call next.
3. An anonymous front door to metered third-party APIs that one operator pays for and every visitor shares.
4. A site that shows other people content an attacker can influence (third-party feed text and model-written prose), both live over a stream and later from storage.
5. A shared cache and run store that every visitor reads from and writes to.
6. A public open-source repo for a server that holds several secrets and handles licensed data whose terms forbid publishing it.

It is not a store of private per-user data (there are no accounts). It holds no money directly, and it sends no email.

Risks that typically hit this kind of system:

A1. Server-side request forgery (SSRF), in F3. The server fetches a feed URL the visitor pasted or the directory returned. Podcasters list their own feed URLs in directories, so a directory result is as attacker-controlled as a paste. Several things can change the real destination: redirects, DNS answers that change between the check and the connection, and alternate IP spellings (decimal, octal, IPv4-mapped IPv6). Fetched content is summarised into F5 events and saved in F6, so the attacker can read what the server fetched; it is not a blind attack. On Railway or Fly the container sits on a private network with any other services there, and every host has loopback-only services. The model can also be talked into calling the fetch tool with a URL of its own (A3). Applies strongly.

A2. Attacks on the XML parser, in F3. A feed is untrusted XML. External entities (XXE) can read files or trigger more requests. Nested entity expansion ("billion laughs") and gzip bombs exhaust memory, and a huge or endless "feed" ties up time. Applies.

A3. Indirect prompt injection and too much agency, in F4. Episode titles and show notes, YouTube titles and descriptions, directory metadata and Qloo entity names all go back into the model, which then picks the next tool, its arguments, and the prose. Text in any of them can steer it: loop on tools, fetch an internal URL, spend hundreds of Qloo calls, plant a phishing link or false claims in the pitch. The visitor's show-name field is a direct injection channel too. Applies strongly. The design's strength is that ranking and numbers are computed in code, which limits what injection can fake, but only if the code enforces it.

A4. Burning the operator's money and quota, in F1, F4 and F7. Anyone can start a run. Each run spends Qloo calls from a shared pool of 50,000 a month at 10 a second (Qloo's own rate-limit headers, read on key day, 21 Oct 2026), plus Anthropic credit and YouTube quota. At 10 calls a second the month's Qloo pool is gone in about 83 minutes, and a day's public share in under three minutes. Things that multiply this:
- model loops (A3)
- crawlers or link prefetching hitting anything that starts work on a GET
- other websites making their visitors' browsers POST to the start endpoint, which spreads one attacker across thousands of IP addresses
- IPv6 address rotation
- simultaneous requests racing a counter that is read and then written
- direct calls to a separate agent server that skip the web app's checks

Applies strongly. This is the most likely real attack.

A5. Injecting content into the browser, in F5 and F6. Feed text, Qloo names, YouTube titles, the model's tool inputs and the brief and pitch are all rendered, live and from saved runs. The risks:
- cross-site scripting (XSS), if anything is rendered as HTML or as markdown with raw HTML allowed
- `javascript:` links built from a feed's link field
- forged stream events: a feed title containing a blank line followed by `event:` or `data:` lines fakes an SSE event if written into the stream raw
- feed artwork pushed through Next.js's image optimizer, which turns the optimizer into a fetch proxy
- Unicode direction-control characters that make text display differently from what it is

Applies.

A6. Leaking secrets, in F4, F5, F6 and F8. The reviewed design sent the YouTube key as a `key` query parameter, so any logged or stored request URL would contain it. The build sends it in the `X-goog-api-key` header instead, which Google accepts (checked on 19 Oct 2026), so no URL carries it. HTTP client errors often carry the full request, headers included, which means the Qloo `X-Api-Key`. Step events stream tool inputs. The MCP child process is third-party code and gets an environment. Next.js puts any `NEXT_PUBLIC_` variable into the browser bundle. The repo is public. Applies strongly.

A7. Cache poisoning and mismatched cache keys, in F6. The cache can go wrong in several ways: a key built differently from the request actually sent (parameter order, a different encoder, a parameter left out of the key), the MCP path and the HTTPS path colliding, or an error response cached as data. Then one visitor's request fills an entry another visitor's run reads. Applies.

A8. Smuggling parameters into upstream APIs, in F2 and F4. The show name and the model's arguments become query strings for Qloo, the directory and YouTube. If URLs are built by joining strings, an `&` or `#` in the input adds or cuts parameters, for example widening a Qloo filter or raising a result count. Applies wherever a URL is built by hand.

A9. SQL injection, in F6. Inputs, tool responses and names are all stored. Applies only if any SQL text is built from values.

A10. Tampering with multi-step state, in F1. The confirm choice and the guest pick arrive from the client after the server offered options. If the client can send back a feed URL, an entity or a name instead of picking from what the server issued, it skips the checks made at issue time. A confirm step that accepts a URL bypasses the SSRF defence, and a free-text guest pick lets anyone get a brief about any real person. Guessable run IDs would expose other visitors' runs and streams. Applies.

A11. False data on screen, in F2, F4 and F7. YouTube search by name can return a lookalike channel. Qloo search can return the wrong entity. The model can invent figures or claims about real guests, and backtest name extraction can invent guests. Each puts false data in front of a judge or a host. AI prose about a real person at a shareable URL on the product's domain is also a reputational and legal exposure. Applies.

A12. Supply chain, in F4. The Qloo MCP server is an npm package run as a child process holding the Qloo key. If it is launched by fetching the latest version at run time, a changed or compromised release runs with whatever it is given. Applies.

A13. Breaking Qloo's data terms, in F6, F7 and F8. Qloo data must not be stored in a public repo. The likely ways it gets there are test fixtures recorded from real responses, seed output, debug dumps, backtest exports and sample run JSON in docs. This is not an attack, but it is the most likely way to lose eligibility.

A14. Privacy, in F6. Per-visitor counters are keyed on something that identifies a visitor, usually an IP address. Keeping raw IPs serves no purpose beyond the counter window. Applies lightly.

Does not apply, and why:
- Login, sessions and account takeover: there are no accounts and no session grants anything. This stays true only while the kill switch remains a database flag and never becomes a web page.
- Classic cross-site request forgery against user data: visitors own nothing and no cookie carries authority. Cross-site requests still matter for budget (A4).
- Tenant isolation: there is no private tenant data. The closest thing is run IDs (A10).
- File upload and path traversal: no uploads and no user-chosen paths.
- Command injection: only at the MCP spawn, and only if an argument is dynamic or a shell is used.
- Unsafe deserialisation: JSON only.
- Open redirect: no redirect endpoint exists, and none should be added.
- Sending mail on the user's behalf: the pitch is a draft on screen and never sent. Its content still matters because the host may send it (A3, A11).
- Clickjacking: the only action a click can trigger is starting a run (A4).

## B) Threat model

### Trust boundaries
- TB1 Browser to the web app and the agent server: bodies, query strings, run IDs in paths, headers (Origin, X-Forwarded-For, Content-Type, Last-Event-ID, User-Agent), and the number and timing of requests and open streams.
- TB2 Web app to agent server, if they are deployed separately: this call crosses the public internet unless the two share a private network. The agent server cannot assume a request came through the web app. As built, the browser calls the agent server directly (DECISIONS, 19 Oct), and since section D the agent server also serves the public /mcp route. It is a front door in its own right, so every check lives in it (C5.6, D2.7).
- TB3 Agent server to arbitrary feed hosts: status, headers, redirects, body, and the DNS answers for the host.
- TB4 Upstream APIs to the agent server (Qloo over HTTPS and MCP, the podcast directory, YouTube, Anthropic): the transport is trusted, but the content is written by strangers. Podcasters write directory metadata, channel owners write video titles, and Qloo entity data comes from public sources.
- TB5 Model to agent server: tool calls and prose. The model has read untrusted text, so everything it returns is untrusted.
- TB6 Agent server and the MCP child process: third-party code that holds a secret and talks over stdio.
- TB7 Database back to code: cache rows, run logs, showcase runs and backtest rows were built from untrusted data when written.
- TB8 Server to browser: HTML, the server-component payload and SSE frames, where server data becomes something a browser parses and acts on.
- TB9 Repo to the public: every committed file, tests and docs included.
- TB10 Offline scripts: third-party feeds, YouTube data and model output written into tables that public pages read.

### Inputs an attacker can influence
Direct:
- the show name or URL text
- the exclusion list (number, length, content)
- the confirm choice and the guest pick (whatever the client sends, not only what the UI offers)
- run IDs in page URLs and stream URLs
- headers: Origin, X-Forwarded-For and similar, Content-Type, Content-Length, Last-Event-ID on stream reconnect, User-Agent
- the HTTP method used on any route (GET, HEAD, prefetch)
- request rate, number of simultaneous requests, number of open streams, and the source IP (rotatable, especially on IPv6)

Indirect:
- every part of a feed URL: scheme, host spelling, port, user info, path
- the DNS answers for that host, which can change between check and connect
- redirect Location headers, at every hop
- feed response headers: Content-Encoding, Content-Length, Content-Type
- the feed body: DOCTYPE and entities, nesting, size, and every text field (titles, descriptions, authors, links, image and enclosure URLs, itunes tags, new-feed-url)
- directory results: feed URLs and metadata that podcasters register themselves
- YouTube results: channel names, video titles and descriptions, lookalike channels
- Qloo results: entity names, descriptions, image URLs
- what the MCP server returns: its tool list and its results
- upstream status codes and error bodies (429, 5xx, malformed JSON)
- every tool call the model makes and every word it writes
- rows read back from the database: cache, runs, showcase, backtest
- for the backtest: episode titles of the shows on the operator's list

### Privileged position and assets
- The secrets: the Qloo key, the Anthropic key, the YouTube key and the database URL. The database URL means write access to everything.
- Spending power no visitor has directly: the shared Qloo quota (50,000 calls a month at 10 a second, also used by the operator's scripts), the operator's Anthropic credit, and the YouTube quota (the default daily units are to be checked against Google's current table).
- Network position: the outbound connection of a Vercel function or a container. On Railway or Fly that includes a private network with the operator's other services, and on every host it includes loopback-only services.
- Write access to the shared database: cache, runs, counters. Read access to the kill switch.
- The product's domain and reputation: content at product URLs, the showcase on the home page, and pitch drafts a host may send under their own name.
- Availability while judges are looking.
- Standing with Qloo: the data terms and hackathon eligibility.

### Attacker goals
- G1. Kill live runs or burn the operator's money. Start runs in bulk (scripts, rotating IPs, other sites' visitors via cross-origin POSTs, crawlers on any GET that starts work, direct calls to a separate agent server), or make each run expensive through injected loops. Flows F1, F4, F7.
- G2. Read internal resources through the feed fetcher. Paste a URL, or list a podcast whose feed URL resolves, redirects or later re-resolves to loopback, a private range or a cloud metadata address. The server fetches it, and the summary streams back and is saved. Or steer the model into fetching such a URL. Flows F3, F4, F5, F6.
- G3. Steal API keys from request URLs in logs or step logs (the YouTube key is in the query string), HTTP client errors that carry headers, streamed tool inputs, a variable with a public prefix, the child process environment, or the public repo. Flows F4, F5, F6, F8.
- G4. Turn the product against its visitors and hosts: XSS or forged stream events from feed text or model prose, a phishing link or false claim in a pitch that a host sends to a real guest, defamatory text about a real person at a shareable product URL, or a poisoned cache entry so other visitors see attacker-shaped results. Flows F4, F5, F6.
- G5. Make the product look dishonest or break Qloo's terms: steer channel or entity matching to a lookalike so a judge sees false numbers, get model-invented figures shown as metrics, or get Qloo data into the public repo. Flows F2, F4, F7, F8.

## C) Defensive-programming standards (definition of done)

A "run" means one visitor's whole flow, including its confirm and brief steps. Each invariant ends with how to show it holds.

### C1 Outbound fetching (A1, A2, G2)
- C1.1 No request the server makes for a run connects to an address outside public unicast internet space, on any hop. The check runs on the resolved address the socket actually uses (a DNS lookup hook in the HTTP agent that rejects before connecting), not on the hostname text.
  - Predicate: `ipaddr.process(addr).range() === 'unicast'` (ipaddr.js).
  - Covers: loopback, private ranges, link-local including 169.254.169.254, carrier-grade NAT, IPv6 unique-local (the Fly and Railway private networks), multicast, unspecified, reserved, and IPv4-mapped and NAT64 forms.
  - Does not cover: public addresses that belong to the operator or to anyone who trusts the server's IP. C1.2 covers that.
  - Show it: feed URLs `http://127.0.0.1/`, `http://0x7f.1/`, `http://2130706433/`, `http://[::ffff:127.0.0.1]/`, `http://169.254.169.254/`, `http://10.0.0.1/`, `http://[fd00::1]/`, a hostname resolving to a private address, a public URL that redirects to 127.0.0.1, and a stubbed lookup that answers public first and private second. All fail with no connection opened.
- C1.2 The feed fetcher carries no authority. It sends no API key, cookie or auth header, and no operator service grants access based on where a request comes from: the database needs its password over TLS, and a separate agent server checks a secret from the web app, not an IP.
- C1.3 The fetcher speaks only http and https on their default ports, rejects URLs that contain user info, follows at most 3 redirects, and applies C1.1 and C1.3 again at every hop. The scheme and port rule is a deliberate allowlist: a feed on an odd port is refused.
- C1.4 Every fetch is bounded: a connect timeout, a total timeout, and a cap on bytes counted after decompression, so a gzip bomb hits the cap. Going over any bound fails the fetch.
  - Show it: a test server that drips slowly, one that never stops, and a 10 KB gzip that expands past the cap all fail within their bounds. These tests swap in a test address check, because C1.1 blocks a local server; C1.1 has its own test.
- C1.5 The model cannot choose what to fetch. The fetch tool accepts only an opaque handle to a URL the server got for this run: the visitor's checked URL, or the directory result for the confirmed show. URLs found inside a feed (enclosures, images, links, new-feed-url) are never fetched.
  - Show it: a tool call carrying a raw URL or an unknown handle is refused with no network call.
- C1.6 If fetched bytes do not parse as an RSS or Atom feed, nothing from them is returned, streamed, stored, logged or given to the model. Only a fixed error code goes out. This turns any C1.1 bypass into a blind one.
  - Show it: fetch a page of HTML containing a marker string. The marker appears in no stream frame, database row, log line or model message.
- C1.7 Parsing a feed never resolves an external entity, never reads a file or URL, and never expands an entity. Any document with a DOCTYPE is rejected. Element depth and count are capped.
  - Show it: an XXE file read, an external-entity URL and a billion-laughs payload are each rejected with no file read and no network call.

### C2 The model and its tools (A3, A4, A8)
- C2.1 The model is never the security check. Every limit in C2 and C5 is enforced by code that never asks the model for permission.
  - Show it: tests replace the model with a stub that returns hostile tool calls and prose.
- C2.2 The model can call only tools on a fixed server-side list. Tools the MCP server offers that are not on the list are refused, even if a package update adds them. Every tool argument passes a strict schema before any call: unknown keys are rejected, strings and numbers are capped, and Qloo operations come from a fixed set.
- C2.3 No upstream request's host, path, header or raw query string comes from the model or the visitor. The server builds each request from checked fields. Visitor and model text enter only as the value of a single encoded parameter (URLSearchParams or the client library), never by joining strings.
  - Show it: the show name `x&take=500#y` produces a request whose parsed query has one parameter holding the whole string.
- C2.4 Each run has hard caps in code on model turns, tool calls per tool, tokens per response, tokens per run, and wall-clock time. Hitting a cap ends the run as failed with AGENT_LIMIT (C6.4), and what was spent stays counted.
  - The wall clock runs 120 s from confirm. The feed read (at most 15 s), the research, the fit call and the fills all spend from it.
  - Every Qloo call after confirm carries a signal that fires at the deadline. A call still running is cut off, no call, retry or wait for a meter slot starts after the deadline, and a cut-off call keeps the one meter slot it already took.
  - A model turn starts only if the tokens used so far, plus the turn's estimated input (the model client's own reservation estimate, or the last turn's counted tokens if higher) and its output cap, fit under the run's token cap.
  - Show it: a stub model that asks for tools forever stops at the turn cap, and the run is marked failed.
- C2.5 The visitor controls no model setting. Model name, system prompt, token limits and tool list are fixed on the server.
- C2.6 No secret, environment variable, database URL or internal hostname appears in any message to the model, including tool results and tool errors.
- C2.7 Exclusions are applied in code to the ranked board, and the model never sees them. Visitor free text never reaches the brief or pitch prompts. Those get only the confirmed show, the guest picked from the stored board, computed numbers and tool data. Only a feed a directory search found (provenance "directory") is vouched for. A feed the visitor pasted ("pasted") or an Apple entry the visitor linked directly ("linked") is vouched for by no search, so none of its episode titles reaches any model and the flip never sees its publisher: it serves only the past-guest check (C2.9). A directory feed's titles reach the research model as quoted tool data, and any angle written from them still passes every C3 check before it can reach a brief.
  - The Without Qloo prompt gets only Qloo's show name, a directory feed's recent episode titles (none for a linked or pasted feed), and the publisher only for provenance "directory". A pasted feed's publisher is the visitor's own hostname, so it never reaches a prompt. The visitor's exclusions apply to the flip too, in code.
- C2.8 Tool results reach the model only as tool-result content, capped in size, and are never merged into the system prompt. Every third-party string in a tool result is cleaned first by the same cleaner as D5.2: NFC, `\p{Cc}` removed, `\p{Default_Ignorable_Code_Point}` and `\p{Bidi_Control}` removed. That takes out the invisible Unicode tag characters (U+E0000 to U+E007F), which a model reads and a person cannot see.
- C2.9 A person the show has already had as a guest, or who hosts it, never reaches the board. Code (isPastGuest, at recordPerson, the one gate every person passes) removes them before the model sees them. An episode title or a host entry matches when every word of the person's name, after a trailing Jr, Sr, II, III or IV is dropped, appears in it as a whole word in any order, so "Peyton and Eli Manning" matches Peyton Manning. An episode description matches only on the whole name, the first and last name side by side, or a three-letter short first name before the same surname, because descriptions name people in passing. Host entries are the show's directory name, publisher, Qloo name and feed title, the feed's itunes:author and itunes:owner names, and any host the operator names for a showcase seed. For a show whose feed no longer reaches its first episodes, the operator seed takes an archive of older titles and descriptions, which joins the index for that run only and is never stored or shown. A person dropped once (a past guest, a host, or dead) stays dropped for the whole run, whatever a later answer says. The scoring step applies the death check too. Their id is then unknown, so it is refused like any id no tool returned (C2.2). When the feed cannot be read, or gives no titles, the run records that past guests were not checked, rather than implying there were none. Every public read of a run (the run page, the showcase, MCP get_board) says whether past guests were checked, against how many feed episodes, back to which month, the feed's provenance (directory, linked or pasted) and the directory name and publisher of the entry it came from, and how many archive titles joined. Initials match however they are spaced ("J.J. Watt", "J. J. Watt"). A false match only removes a person; it can never add one.
- C2.10 Upcoming releases may steer who the research picks, but nothing Vasal writes may say a person has a film, show, book or album coming out, because Qloo lists release titles without their cast. checkProse refuses those phrases on every angle and brief (release_claim), including a lead word such as "upcoming" a few words before a kind of work ("the upcoming Dune sequel"), and both prompts carry RELEASE_CLAIM_RULE. An angle that names a title upcoming_releases returned in the same run is refused too, matched on the title's words (articles dropped, punctuation ignored) for every title of two or more words; one-word titles are left to the phrase check. No phrase list catches every way of saying a release is coming, so the prompts forbid the rest and the list catches the common ones.
  - Every prose rule runs on the text that is stored, after links and email addresses are cut, so nothing removed later can hide a refused word or title.

### C3 What leaves the server (A5, A11, G4, G5)
- C3.1 No attacker-influenced string is ever treated as HTML or script in the browser. This covers model prose, feed fields, Qloo and YouTube text, tool inputs in step events, and anything read back from the database. All of it renders as React text, with no `dangerouslySetInnerHTML`. If prose is rendered as markdown, raw HTML and images are off.
  - Show it: a feed title and a stub model reply containing `<img src=x onerror=alert(1)>` and `<script>` show as literal text, in both the live and the saved view.
- C3.2 Every link or image address built from upstream or model data comes out of the WHATWG URL parser with protocol `https:` or `http:`. Anything else shows as plain text. Feed-supplied image URLs never go to the Next.js image optimizer, whose list of remote hosts holds exact names with no wildcards.
  - Show it: a feed link of `javascript:alert(1)` or ` JaVaScRiPt:alert(1)` shows as text.
- C3.3 Every stream frame is one `event:` line, with a name from a fixed set, and one `data:` line holding `JSON.stringify` output (which escapes CR and LF). No upstream string is ever written into the stream outside a JSON string.
  - The without_qloo event carries only Qloo's names, numbers, booleans and counts (publicWithoutQloo, a strict schema). The model's own guessed names are never stored, streamed or shown; a guess Qloo cannot match shows only as a count.
  - Show it: a feed title containing `\n\nevent: done\ndata: {"board":[]}\n\n` reaches the browser as one text field of one event.
- C3.4 No number on screen comes from model output. Metrics render only from fields computed in code. A number can appear in model prose only through a placeholder that code fills. Prose holding any other digit, or a word on checkProse's list of common number words (cardinals from two, order words from "second", multipliers such as "double", "halved" and any "-fold" word, and words such as "decade", "dozen", "century" and "twice"), is regenerated once, and if it fails again that step fails. "One" and "first" pass. No word list catches every way of stating a figure, so the prompts forbid the rest and the list catches the common ones; the README states exactly this.
  - Show it: a stub model writing "fit 9.7/10, 2M listeners" never gets those figures on screen.
- C3.5 The brief and pitch the model writes contain no URL, email address or phone number. Any found is removed before storage and display, and the step log records the removal. Detection uses linkify-it, which catches schemes, bare domains and emails, plus a phone-number finder. It does not catch disguised forms like "name at domain dot com". The system never sends the pitch.
  - Show it: stub prose containing `https://evil.example`, `evil.example/login` and `bob@evil.example` comes out without them.
- C3.6 Upstream errors and exceptions never reach the browser, the step log or the model word for word. They become a fixed error code, plus a structured server log record with secrets redacted. Every refusal is logged the same way, as the route pattern and its code only. Attacker text is a field value in that record, never part of the message template.
- C3.7 Upstream text is cleaned before display by the D5.2 cleaner: `\p{Bidi_Control}`, `\p{Default_Ignorable_Code_Point}` (including the invisible tag characters) and `\p{Cc}` are removed, so text reads the way it is stored and hides nothing from the person reading it.
- C3.8 Visitor run pages are marked noindex, and no other page links to them.
- C3.9 The kolam that GET /runs/:id and GET /showcase send carries only numbers computed by code and server-issued guest ids, never third-party text: kolamFor is given only a guest id, a rank and a tag count per guest, and draws nothing for an id that is not a lower-case UUID.
- C3.10 Nothing Vasal writes about a real person claims their sexuality, gender identity, health, religion, ethnicity, politics or family life. Both prompts forbid them (SENSITIVE_TRAITS_RULE, FAMILY_RULE). checkProse refuses, on every angle and brief, the words that almost always make such a claim: sexuality and gender identity terms, named diagnoses and pregnancy, accusations, and marriage, spouse and children words (family_claim; "partner" and "family" pass, because business partners and family comedy are common angles). Religion, ethnicity and politics words are also everyday topics in prose, so there they stay prompt rules. A refused angle goes back to the model with that rule as its hint.
  - Taste chips sit next to a real person's name and read as a fact about them, so they pass two gates: Qloo's tag family must be on an allowlist (genre, subgenre, style, content, emotional tone, aesthetic, host, audience), and the name must clear a broad topic word net (crime, sex, politics, religion and faith, health and mind, addiction, race and origin, gender, environment and activism) and the identity words. The name check runs again on every public read, so a run stored before today's rules never shows a chip they refuse. A dropped chip costs nothing.
  - Labels code writes claim only what their number measures: "household name" only at Qloo popularity 0.97 or above and no other reach label, and "brings" as an audience group the guest's fans lean toward more than the show's listeners do, never one the show lacks.

### C4 Secrets (A6, A12, G3)
- C4.1 No secret value appears in any byte sent to a browser, stored in the database, written to logs, sent to the model, or committed to git.
  - Show it: after a full test run, search the HTML, the server-component payload, a capture of the stream, every row the run wrote, and the captured logs for each secret's literal value and for `key=`. Zero hits. The git history is searched in the finishing sweep.
- C4.2 Secrets stay on the server. None uses the `NEXT_PUBLIC_` prefix, and every module that reads one imports `server-only`, so importing it into a client component breaks the build.
- C4.3 Request logs and step logs record the operation and its checked parameters, never the URL or headers as sent. Both the YouTube key (`X-goog-api-key`) and the Qloo key (`X-Api-Key`) ride in headers. Every client that sends one refuses redirects, because fetch would forward the header to the redirect target.
- C4.4 The Qloo MCP child process gets an environment holding only the Qloo key and what it needs to start, never a copy of the server's environment. It is spawned with a fixed argument list and no shell, from the version pinned in the lockfile, and never downloaded at run time.
  - Show it: a unit test checks that the spawn call's environment has exactly the expected keys and that `shell` is false.
- C4.5 A leaked key's damage is capped at the provider. The YouTube key is restricted to the YouTube Data API, and the Anthropic key sits in a workspace with a spend limit.
- C4.6 Every database connection uses TLS with full certificate checks, with two exceptions: a loopback address, and a host ending in `.railway.internal` when the operator sets `DATABASE_NETWORK=railway-private`. Railway's private network is WireGuard-encrypted between services, and its Postgres certificate is signed by a CA made inside the container, so full verification cannot pass there. The exception comes only from that setting, never from the connection string, and every other host keeps verified TLS.

### C5 Budget and abuse (A4, G1)
- C5.1 Qloo calls per day and per month, Anthropic tokens per day and YouTube units per day never go over operator-set caps. This holds across every process (web, agent, offline scripts) and every instance. A metered call is made only after the database reserves its share in one atomic statement (it adds to the counter only if the total stays under the cap). If the reservation fails, no call is made. The offline scripts draw from their own reserved share.
  - Show it: 50 simultaneous run starts against a cap of 10 produce exactly 10 reservations.
  - Model tokens are reserved before each call (the output allowance plus an input estimate) and settled to the usage the reply reports, in the same bucket window the reservation was charged in: unused tokens are given back and an over-run is charged, never refused, so the meter never undercounts. A failed call keeps its whole reservation.
  - Offline work (seeds, briefs, the backtest) also reserves qloo:month:offline on every Qloo slot, a share of each month (4,000 in October, 3,000 in November), so it can never spend what the judging days need.
  - Qloo's own monthly counter (X-Month-RateLimit-Remaining, recorded from every reply) is the last word: with fewer than 1,500 calls remaining, no process sends a Qloo call, so spend this meter never sees cannot run the key dry. The reading is timed by the database clock, and one older than 24 hours counts as none, so after Qloo's monthly reset the next reply brings a fresh count. A process on a throwaway in-memory database sends at most 2 Qloo calls a second, and at most one such process uses the production key at a time (an operator rule), so with the server's 8 the total stays inside Qloo's 10.
- C5.2 The service never goes over Qloo's per-second limit across all instances. A Qloo call that fails with a 408, a 429, a 5xx or a dropped connection is tried at most three times in all, pausing 250 ms and then 750 ms, each attempt on its own meter slot and inside the run's deadline. Any other 4xx, and any other failure, is never retried. Qloo's per-second window is one second, so a fixed pause stands in for Retry-After.
  - Qloo's harness runs in our process for find_person only, on a client we supply (createMeteredHarnessClient). Each request it makes takes one meter slot, is retried only as above, on a fresh slot each time, never follows a redirect and carries the run's deadline. The harness's own HTTP client, its stdio `qloo mcp` route and its log files are never used. A harness match counts as found only when its name matches the name asked for (sameName), and an id-shaped name is refused with no Qloo call.
- C5.3 Per-visitor caps use the client address from the header the hosting edge sets, the one clients cannot set. IPv6 addresses are counted per /64 block. One normaliser (`ipaddr.process`) produces the key both when counting and when checking, so `::ffff:1.2.3.4` and `1.2.3.4` count as the same visitor.
  - One IPv4 address is one visitor, so judges behind one venue or office network share these caps. For the judging days (30 Oct to 6 Nov) RUNS_PER_VISITOR_PER_DAY is 15; it goes back to 5 after.
- C5.4 No GET, HEAD, link prefetch or crawler visit starts a run or spends a metered call. Showing a saved run, a showcase run or the backtest page makes zero upstream calls.
  - Show it: crawl every page with GET requests only while counting upstream calls. The count is zero.
- C5.5 Starting a run, confirming a show and requesting a brief all require a POST with Content-Type `application/json` and an Origin header that, once parsed by the URL parser, equals the app's configured origin parsed the same way. A missing Origin is refused.
  - Show it: POSTs with Origin `https://evil.example`, with no Origin, and with `text/plain` are all refused.
- C5.6 Every check that protects spending runs in the process that spends. If the agent server is deployed separately, it enforces C5.1 to C5.5 itself. It accepts relayed requests only with the web app's secret, and takes the visitor identity from a field the web app sets after its own C5.3 check. As built there is no relay: the agent server takes the visitor address only from the edge header (C5.3), and the public /mcp route follows D2.7.
- C5.7 The kill switch and every cap fail closed. If the flag, a counter or the database cannot be read, no run starts and no metered call goes out. When live runs are off, the site says so and saved runs still work, their stored briefs included. The switch is checked at the doors, when a run, a confirm or a brief starts, so a run already under way finishes within its own caps (C2.4; at most 3 runs of 120 s).
- C5.8 Expensive steps cannot be repeated for free. Each guest gets one brief per run, served from storage after the first. The claim is made atomically, under a unique (run, guest) key, before any model call, so parallel requests make one call. Runs in progress are capped globally. Open streams are capped per run and across the whole process, and each stream has a maximum lifetime. A server with no model key refuses a brief before claiming it, so no attempt is spent on a call that cannot run. No request takes a site or MCP run place unless it will start work: a run start from a visitor already at the daily cap, a confirm on a run that is not awaiting confirmation, and an MCP call from a key already at its daily cap, are refused before any place is taken. A brief a budget refuses is deferred: it spends no attempt and can be claimed again. A failed release is retried twice, and places are reconciled hourly, only ever lowered to the runs that hold them.
- C5.9 A run starts only after a fresh human check solved on this site for this purpose. The server calls Cloudflare's siteverify itself and accepts only when all three hold: `success` is true; `hostname` equals the hostname of the configured app origin, taken by the URL parser with both sides lower-cased; and `action` equals the run-start action. A failure, a timeout or an answer that does not parse is a refusal. Each surface uses its own action name (run start and agent-key issue), so an answer solved for one can never be spent on the other.
  - Show it: a stubbed reply naming another hostname, one with the agent-key action, one with no action, and a siteverify timeout are each refused, and no run is created.

### C6 Runs, state and storage (A9, A10, A14)
- C6.1 Run IDs carry at least 122 random bits (`crypto.randomUUID`) and are never sequential. A visitor's run can be reached only by its ID, and no endpoint lists visitor runs. The Last-Event-ID header is read as a bounded non-negative integer or ignored.
- C6.2 The confirm step accepts only a candidate the server issued for that run, and the brief step only a guest on that run's stored board. Both are matched by server-issued ID as an exact string, with the candidate list stored with the run or carried in a token the server signed. The client never sends back a URL, entity data or a name for the server to act on. The website's confirm window is 30 minutes (410 CONFIRM_EXPIRED after it), an MCP candidate lives 1 hour, and prune closes any run still awaiting confirmation after 1 hour.
  - Show it: a candidate ID from another run, an ID never issued, an added URL field, and a guest name not on the board are each refused with no upstream call.
- C6.3 Only operator-promoted runs appear on any page besides the run's own URL. Promotion happens only through an operator script, after the operator has looked at the rendered run. No web endpoint can promote a run, change the kill switch, edit counters, or write showcase or backtest rows.
- C6.4 A run that stops early (cap hit, timeout, function killed, upstream failure, parse failure) is saved and shown as failed, with no board. Partial results are never shown as complete. A run awaiting confirmation holds nothing in flight, so a restart leaves it alone. A deploy gives website runs and brief writes in flight up to 12 seconds before the process stops; MCP runs are not waited for, and the next start fails them (no agent keys exist yet).
- C6.5 Every row read back from the database passes the same schema it was written with before it is used. A row that fails counts as missing. Every public read is an allowlist of named fields on top of that schema: GET /runs/:id (publicBoardGuest, publicWithoutQloo), the showcase and the MCP results.
- C6.6 SQL text is never built from a value; every value is a bound parameter. The one exception is the operator's ALTER ROLE ... PASSWORD, which Postgres cannot take as a parameter: it holds only a SCRAM verifier computed locally and checked against a strict pattern, for one of two named roles (store/scram.ts). A connection URL with no user is refused, so the driver can never fill one in from the environment. The database role the web server uses can read and write only its own tables. It cannot change the schema, the kill switch, or the showcase and backtest tables. Once a run is promoted, that role cannot insert, update or delete any of its rows in runs, run_events, run_candidates, run_board, run_briefs or run_brief_claims: a database trigger refuses it whatever the code does, and the boot sweeps skip promoted runs.
- C6.7 Outsiders cannot fill the database. Stored tool-response bytes per run are capped, and runs per day are bounded by C5.1.
- C6.8 Visitor addresses are stored only as a keyed hash (HMAC with a server secret) and are deleted after the counter window.

### C7 Cache and Qloo data (A7, A13)
- C7.1 The cache key is the canonical form of the exact upstream request (method, host, path, and parameters sorted and encoded once), built by the same function that builds the request actually sent. Calls through the MCP server are keyed by tool name and canonical arguments in a separate namespace.
  - Show it: two requests that differ only in parameter order share a key, and two that differ in any value do not.
- C7.2 Only a 200 response that parsed and passed its schema is cached. Errors, 429s and schema failures are never cached, and entries expire after a set time.
- C7.3 Qloo response data lives only in the private database. No file in the git tree contains any: test fixtures are synthetic, the seed script writes only to the database, and dumps go to git-ignored folders.
  - Show it: a sweep of the tracked files for Qloo response shapes and entity IDs finds nothing.

### C8 Inputs and matching (A8, A10, A11)
- C8.1 Every request body passes a strict schema before any work starts. Body size is capped, the show text is capped in characters after NFC normalisation, the exclusion list is capped in count and length, and unknown fields are rejected.
- C8.2 Only the WHATWG URL parser decides whether a pasted value is a URL.
  - It is an Apple Podcasts link only if the parsed hostname equals `podcasts.apple.com` and the path gives a numeric id. The server never fetches the Apple URL; it looks up the id.
  - Any other value whose parsed protocol is `http:` or `https:` is a feed URL and goes through C1.
  - Everything else is a show name, searched as text, and C2.3 keeps it harmless.
- C8.3 Exclusions match by Qloo entity ID where the name resolves. Otherwise one normaliser is applied to both sides: NFKC, removal of `\p{Default_Ignorable_Code_Point}`, lower case, and collapsed whitespace. This handles case, spacing, compatibility forms and invisible characters. It does not handle lookalike letters, nicknames or misspellings.
- C8.4 If more than one show matches, the run asks the visitor to confirm instead of picking one. Directory entries that map to the same Qloo podcast collapse to the first in Apple's order, so a lookalike can never lend its feed to the real show's run, and the run records which candidate it continued with. An Apple entry the visitor linked directly is a candidate of its own, with provenance "linked" (C2.7).
- C8.5 A YouTube channel found by search is labelled on screen as matched by name, not verified. The backtest uses channel IDs pinned in the operator's show list and never searches.

### C9 Offline pipeline (A11, G5)
- C9.1 Every guest name the model pulls from an episode title must appear in that title under the C8.3 normaliser. Names that do not are dropped and counted, and the count is published with the backtest.
- C9.2 The offline scripts use the same metered Qloo client as the server (C5.1) and the same feed fetcher (C1). A script on a throwaway meter (backtest --dev-db) takes at most 2 Qloo calls a second, and at most one throwaway-meter process uses the production key at a time (C5.1), so with the server's 8 the total stays within Qloo's 10. The key-day probe (scripts/probe.ts) is unmetered and paced at 2 a second, and it is run only while live runs are off.
- C9.3 Committed scripts recompute every scripted number on the backtest page from the stored dataset: --analyse for the pre-registered results, backtest:robustness for the post-hoc checks. A hand check is labelled as one. Every pull attempt is listed, including any that stopped, and the page states the method and the sample size.

### General standards

1. Primitives over lists at every security boundary. No denylist decides whether an address, a URL or a request is safe. The word lists in checkProse and the chip net (C3.4, C3.10) are content rules on model and third-party text, where no primitive states the intent; they err toward refusing, and a refusal costs one rewrite or one chip.
   - Where a library or standard predicate states the intent, we use it:
     - outbound address check: ipaddr.js `range()` (C1.1)
     - URL classification and link checks: the WHATWG URL parser (C3.2, C8.2)
     - XML: DOCTYPE rejected outright (C1.7)
     - HTML safety: React text escaping (C3.1)
     - character handling: Unicode property escapes, not lists of code points (C3.7, C8.3)
     - finding links in prose: linkify-it (C3.5)
   - The lists that remain are deliberate allowlists that fail closed: the model's tool list, the Qloo operation set, image hosts, stream event names, the app origin, and the http/https default ports. A missing entry breaks a feature; it never opens a hole.
   - What each check covers and misses is stated next to its invariant above.
2. Normalise before you compare. Every comparison takes both sides from the same parser:
   - the address that was checked and the address connected to (both inside the lookup hook)
   - the URL that was checked and the URL fetched (the fetcher receives the parsed URL, never the raw string)
   - the Apple hostname (parsed hostname against a literal)
   - the Origin check (`new URL(...).origin` on both sides)
   - the cache key and the request (one builder)
   - the visitor key when counting and when checking (one normaliser)
   - exclusions against the board (entity ID, or the C8.3 normaliser)
   - confirm and guest IDs (exact server-issued strings)
   - backtest names against titles (the C8.3 normaliser)
3. Validate outputs like inputs. Each next consumer gets its own rule:
   - the browser DOM (C3.1)
   - browser navigation (C3.2)
   - the browser's stream parser (C3.3)
   - the person reading numbers (C3.4)
   - the guest who receives a host's email (C3.5)
   - the model, which takes tool results as input (C1.6, C2.6, C2.8)
   - upstream APIs (C2.3)
   - the database (C6.5, C6.6)
   - logs and whoever reads them (C3.6, C4.3)
   - the image optimizer (C3.2)
   - the operator reading the backtest (C9.1)
4. Fail closed. These are starting values, to be set and tested during the build:
   - request body: 8 KB
   - show text: 300 characters
   - exclusions: 25 names of 100 characters each
   - feed fetch: 5 s to connect, 15 s total, 32 MB decoded, 3 redirects, IPv4 addresses dialled first, newest 2,000 items parsed (episode dates outside 2000 to now read as unknown)
   - model: 12 turns, 25 tool calls, 8,000 output tokens per reply (raised from a first guess of 4,000, so a turn that plans several tool calls is not cut off; the per-run cap is unchanged), 250,000 tokens per run (raised from 150,000 on 24 Oct: once the check counted each turn's input, research on a large show hit 150,000 in about one run in seven)
   - run wall clock: 120 s
   - streams: 3 per run, 10 minutes each
   - runs in progress across the site: 3
   - upstream retries: 2

   An unreadable kill switch, counter or database means no run. A parse error means a refusal. A database row that fails its schema counts as missing. A malformed MCP reply becomes a tool error. An ambiguous show means asking the visitor.
5. Non-goals. This system does not defend against:
   - Mistakes in AI prose about real people. Briefs and pitches are labelled AI drafts. The code guarantees their numbers come from data and that they carry no links or contact details (C3.4, C3.5), not that every sentence is true.
   - Prompt injection happening. Feed and channel text can still sway the model's wording and tool choices. C1.5, C2 and C3 limit what that can cost or reach.
   - A determined attacker draining the day's budget. Caps protect money and quota, and run start now needs a human check (C5.9). But a funded attacker buying Turnstile answers from a solving service, while rotating addresses, can still use up the public daily share and turn live runs off until the reset. Saved runs keep working. The judging reserve is built from protected time, not protected people (DECISIONS, 19 Oct).
   - Privacy of runs. Anyone with a run link can read it, so visitors should not type anything private.
   - Secrecy of prompts and ranking logic. The repo is public by design.
   - Accuracy of third-party data. Qloo, YouTube and directory data is shown as received, apart from the confirm step and the channel label.
   - A compromised provider or host (Qloo, Anthropic, Google, Apple, Vercel, Railway or Fly, the Postgres host, npm). C4.4 and C4.5 limit the damage; nothing here detects a compromise.
   - Network-level floods, which are left to the host's edge.
   - Life after the hackathon. Once Qloo turns off the key, live runs stop with a clear message (C5.7), and saved runs and the backtest stay up from the database.

## Section D: the public MCP server

Written on 19 Oct 2026, before any code for this component existed, in a second threat model pass. Section D extends section C. Every C invariant still holds for runs started through MCP, and D adds what the new door needs.

How callers authenticate is decided as follows (Ram, 19 Oct 2026). A person gets a free agent key on the website after the human check, and pastes it into an MCP client that can send an Authorization header: Claude Code, agent frameworks, scripts. Official docs checked on 19 Oct show the Claude.ai and ChatGPT apps cannot send a static key, so they cannot use it. An OAuth sign-in for those apps comes later, after the frontend stage, and gets its own threat model pass before any code.

### Data flows added
- F9 Key issue: a website visitor passes Turnstile and receives a bearer token once. The server stores its hash, issue time, expiry and counters.
- F10 MCP request: any internet client sends JSON-RPC over Streamable HTTP to /mcp on the agent server, with the token in the Authorization header.
- F11 find_show: the query goes through the website's resolve step and returns up to 5 candidates with server-issued ids.
- F12 book_guests: a candidate id starts a run on the shared runner. The request waits up to a fixed time, then returns the board and a run link, or the run id to poll.
- F13 get_board and write_brief: a run id, plus a guest id for briefs, reads a board or asks for one model-written brief.
- F14 Tool results to the calling agent: board fields, briefs and candidate names carry text from podcasters, Qloo and Vasal's model. That text becomes input to a model Vasal does not control.

### A) App-class risk profile
The MCP server adds four things:
1. A public, scriptable API, authenticated by a bearer token, in front of the same metered runs the website starts.
2. A credential issuer. Tokens go to anonymous people and then live for 30 days in files Vasal never sees.
3. A tool provider whose output is input to someone else's AI agent. That agent may hold its user's email, files, shell or other MCP servers.
4. A second public route on the agent server.

It still holds no private user data, sends no email and moves no money directly. What it holds is spending power, shared capacity, and the trust a calling agent places in its results.

- A15 Leaked and stolen tokens (F9, F10). Tokens get pasted into config files, committed, synced, screenshotted and logged. Each is a 30-day spending credential. A stored or logged token is as good as the original.
- A16 Broken authentication on the transport (F10). Malformed or duplicate Authorization headers, tokens offered in the query string, cookie or body, a session id treated as authentication, and one transport instance shared across clients, which routes responses by a client-chosen JSON-RPC id.
- A17 Acting on objects that are not yours (F11 to F13). A candidate from another token, a website run's id, a guest id from another board, a guest name in place of an id, or a candidate id that encodes a URL.
- A18 Budget and capacity exhaustion (F9, F11 to F13). Everything in A4, plus:
  - token farming
  - one human check covering 30 days of calls
  - client retries buying new runs
  - races on per-token counters
  - JSON-RPC batches
  - long-held connections
  - MCP runs filling the site's in-flight slots
  - MCP daily slices adding up to the shared monthly ceiling
  - find_show spam getting the server throttled by the Apple directory
- A19 Prompt injection relayed to the caller's agent (F14). Podcasters write show names and episode titles, and Qloo tags come from public sources. Vasal's angles and briefs were written by a model that read them. Payloads include plain instructions, fake "Vasal note" framing, invisible Unicode tag characters, markdown images that leak data when rendered, and sheer size.
- A20 Leaking internals through errors (F10 to F13). The SDK can turn a thrown error's message into a tool result. Different answers for "does not exist" and "not yours" would also reveal which ids are live.
- A21 A public door on a process built for its own website (F10). Path tricks around the public route, relayed identity headers, and the website's and MCP's opposite Origin rules leaking into each other.
- A22 The resolver as a scriptable service (F11). The new part is rate and amplification, not reach: C1 still guards the network.
- A23 Bulk extraction of Qloo-derived data (F12 to F14). Whether Qloo's terms allow returning derived data through an API is to be verified (A13).
- A24 A weaker human check (F9). A check that skips the hostname or the action, or treats a siteverify timeout as a pass.
- A25 Claims about real people leaving Vasal's domain (F14). Applies lightly; mostly a non-goal.

Does not apply, and why:
- **Cross-site request forgery on /mcp.** Authority is a bearer header, which a browser never attaches on its own. This stays true only while no code reads the token from a cookie or the query string.
- **DNS rebinding.** The server is public and checks a token on every request. Origins are still refused, by D2.6.
- **Server-to-client features.** None are declared (D2.4).
- **Token passthrough to upstreams.** Vasal calls Qloo and Anthropic with its own keys and never needs the caller's token.
- **Tool poisoning through Vasal's own tool descriptions.** They are fixed strings in a public repo.

### B) Threat model
Trust boundaries:
- TB11 Internet client to /mcp
- TB12 Browser to the key-issue endpoint
- TB13 Cloudflare siteverify's answer, which must be checked, not assumed
- TB14 The MCP SDK to Vasal's code: the parsing edge
- TB15 The public MCP route and the other routes in one process
- TB16 Vasal to the calling agent: TB5 in reverse
- TB17 The new tables read back
- TB18 The caller's environment: config files, logs and the model provider

Inputs an attacker can influence:
- On /mcp:
  - every header: Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Accept, Content-Type, Origin, Host, forwarding headers
  - the method
  - the JSON-RPC body: size, batches, undeclared methods, client-chosen ids, `_meta`, clientInfo
  - tool arguments
  - the path's spelling
  - timing and concurrency
- At key issue: the Turnstile answer, the address, and the rate.
- Indirectly:
  - every upstream input in section B, which now also flows out through F14
  - Vasal's model output
  - the siteverify answer
  - rows read back
  - the calling agent's own retry policy

Privileged position and assets:
- the power to start runs, and through it the shared monthly Qloo ceiling and the site's 3 in-flight slots
- the token store
- the server's standing with the Apple directory and Qloo
- the trust the calling agent places in Vasal's results
- Qloo-derived data in bulk
- the run links Vasal hands out

Attacker goals:
- G6 Drain the MCP budget and starve the website.
- G7 Use Vasal to attack its own users' agents through injected podcast text. This is the most damaging goal, and it costs one podcast registration.
- G8 Spend or read on someone else's authority.
- G9 Reach the agent server's internals through the new door.
- G10 Extract Qloo data in bulk.

### C) Defensive-programming standards for the MCP server (the definition of done)
"Token" means an agent key issued in F9. Each invariant ends with how to show it holds.

D1 Tokens and the human check (A15, A24, G8)
- D1.1 A database read yields no usable token. A token is 32 bytes from `crypto.randomBytes`, base64url-encoded behind the prefix `vsl_`, and only its SHA-256 hash is stored. Covers guessing and a leaked database, but not a token its holder leaks.
  - Show it: only the hash appears in the rows and logs an issue wrote.
- D1.2 The token is read only from the Authorization header, by one parser: scheme `Bearer` (any case), one space, then the exact token format. Any other shape gets 401 before the body is parsed or the database is read. A token in the query string, a cookie or the body is never read.
  - Show it: two spaces, `Basic`, `?token=` with no header, a short token and a token with extra text each get 401 with zero database reads.
- D1.3 A token authorizes a request only if its hash row exists, it is not revoked, and the database clock is before its expiry. All three are checked in the one query that loads the row, on every request. Expiry is set from the database clock. No decision is cached past one request.
  - Show it: expire or revoke a token between two requests, and the second is refused.
- D1.4 Outside the caller, the token appears in exactly one place: the one response that shows it, sent with `Cache-Control: no-store` and never in a URL. It never appears in a log, run row, step log, stream frame, tool result, error, run page or analytics event, and it is never sent upstream.
  - Show it: a full MCP test run finds zero `vsl_` hits in logs, rows, streams and results.
- D1.5 A token is issued only after a fresh human check solved on this site for key issue: `success` true, `hostname` equal to the app origin's hostname, and `action` equal to the key-issue action (C5.9's rule with its own action). A failure, timeout or unparseable answer issues nothing. The endpoint keeps C5.5. Per-visitor issue caps use C5.3's normaliser and an atomic reservation, and a global cap bounds tokens issued per day.
  - Show it: a replay, the run-start action, another hostname and a timeout each issue nothing. 50 parallel requests against a cap of 3 issue exactly 3 tokens.
- D1.6 A leaked token can be made useless at once. The operator can revoke one token, revoke all of them, or switch MCP off, through database flags only, with no web endpoint. The main kill switch stops MCP too. All of these fail closed.
  - Show it: flip each flag, and the next request gets a fixed refusal.
- D1.7 Token rows carry no visitor address, raw or hashed.

D2 Transport (A16, A20, A21, G8, G9)
- D2.1 A session id grants nothing. Every request authenticates with its own token.
- D2.2 The server runs stateless: no session ids, no event store, a fresh server and transport per request. If sessions are ever added, each id is minted by the server, bound to the token hash, capped and idle-expired, and an unknown or foreign id gets 404.
- D2.3 A response reaches only the connection whose request produced it. JSON-RPC ids are never used as keys outside one transport instance.
  - Show it: two tokens send `tools/call` with `id: 1` at once, 200 times, and each gets only its own result.
- D2.4 The server offers tools only, with no sampling, elicitation, roots or log messages. Undeclared methods get method-not-found. Tool names, descriptions, schemas, annotations and instructions are fixed strings. Annotations tell the truth: book_guests and write_brief are not read-only, and all four tools are open-world.
- D2.5 Vasal's code caps the body at 16 KB before the SDK parses it. Content-Type must be `application/json`, and JSON-RPC batch arrays are refused. Limits count tool calls, not HTTP requests. GET streams are refused, since the server is stateless and JSON-only. The HTTP server's timeouts are set explicitly.
  - Show it: a 17 KB body, a batch and `text/plain` are each refused, and no tool runs.
- D2.6 A request carrying an Origin header is refused unless that origin is on a fixed list, which is empty at launch, and /mcp sends no CORS headers. A request with no Origin is allowed. This is deliberately the opposite of C5.5, and the two rules live in separate code.
  - Show it: `Origin: https://evil.example` gets 403, no Origin works, and the website's run start with no Origin is still refused.
- D2.7 Only the exact mounted /mcp route answers to an agent key, and that comes from the router's own match, never a string test on the raw path. Identity comes only from the token there.
  - Show it: `/MCP`, `/mcp/`, `/mcpx` and `/mcp/../runs` reach no MCP handler. `/%6Dcp` is decoded by the router to `/mcp` before any match, so it meets the same key check: the decoded path is the only path any layer sees.
- D2.8 No exception text reaches the caller. Every handler returns one code from a fixed set (`invalid_input`, `not_found`, `busy`, `budget_exhausted`, `expired`, `upstream_failed`, `mcp_off`), never `error.message`. "Does not exist" and "not yours" both return `not_found`.
  - Show it: a planted marker and an internal hostname appear in no result or error.

D3 Spending and capacity (A18, A22, G6)
- D3.1 Nothing an MCP tool reaches goes unmetered. Qloo is charged to `qloo:day:mcp` and Anthropic to `anthropic:day:mcp`. Every call also counts against the token's daily count, the shared monthly ceiling and the per-second limit, all reserved atomically. If any one fails, no call goes out.
  - Show it: 50 tokens calling book_guests against a slice sized for 2 runs start exactly 2.
- D3.2 Which share a call is charged to is recorded on the run (its surface, which the app role cannot change) when it is created, and the runner, briefs included, reads it back. It is never inferred from the request or a header. The website's confirm and brief routes act only on web runs (D4.1).
  - Show it: an MCP run touches only MCP counters, and a website run touches none.
- D3.3 MCP can never take the website's capacity:
  - it holds at most 1 of the 3 in-flight slots, reserved atomically
  - it has its own monthly cap below the shared ceiling
  - when no MCP slot is free, book_guests answers `busy` at once, with no queue
  - Show it: with MCP at its limit, a website run still starts.
- D3.4 A retry never buys a second run. A candidate id can start at most one run, ever, claimed by a unique constraint before anything is spent. A repeat call returns the same run.
  - Show it: 10 parallel calls with one candidate start one run.
- D3.5 One brief per guest per run, under races (C5.8).
  - Show it: 10 parallel write_brief calls make one Anthropic call.
- D3.6 Each token has caps, counted atomically: runs per day, find_show calls per day, briefs per day, and calls in flight at once. Next to the caps, record how many runs one human check can buy. find_show and book_guests read the key's daily count before taking the slot pair, so a key at its cap never holds a place.
  - Show it: 25 find_show calls one after another against a cap of 5 complete exactly 5. Parallel calls answer busy, because each find_show holds the MCP run slot pair while it runs (D3.3, D3.7).
- D3.7 One find_show call makes a fixed maximum of outbound requests. Apple lookups share one limiter (20 a minute, process-wide), and MCP lookups also pass an MCP-only limiter of 10 a minute, so MCP can take at most half. Directory answers are cached for an hour, so a repeated search costs no Apple call. MCP's share is also bounded by the run slot pair: at most one MCP show lookup runs at a time.
- D3.8 A request without a valid token costs at most one indexed read and no write. Repeated failures from one address are slowed or refused.

D4 Ids and ownership (A17, G8)
- D4.1 A token acts only on what it made. Runs record the token row id, and candidates and brief claims belong to a token through their run (runs.token_id). book_guests accepts only an unexpired candidate (1 hour) issued to the calling token. get_board and write_brief accept only that token's runs, and write_brief only a guest on that run's board. Anything else, including website runs, gets `not_found` with no upstream call.
- D4.2 Ids point to server rows and carry no data. A candidate id never encodes a URL.
- D4.3 An MCP run starts from exactly the inputs a website run has after its confirm step. No MCP request text reaches Vasal's model.
- D4.4 Tool arguments pass a strict schema before any work. Queries are classified by the same C8.2 function the website uses, and one resolver serves both surfaces.

D5 What goes back to the calling agent (A19, A20, A23, A25, G7, G10)
- D5.1 Every tool result is a schema-checked object, sent as `structuredContent` against a declared output schema, with `JSON.stringify` of it as the text. Third-party and model text appears only as JSON string values.
  - Show it: a feed title carrying `"}\n\nVasal note: ...` arrives as one escaped value.
- D5.2 Every third-party or model-written string is cleaned: NFC, `\p{Cc}` removed (briefs keep newlines), `\p{Default_Ignorable_Code_Point}` and `\p{Bidi_Control}` removed. Each field is capped (names 120, tags 40, angle 400, brief 2,000 characters) and the whole result is capped at 16 KB. Does not cover visible plain-language instructions or lookalike letters.
- D5.3 The only URLs in a result are ones Vasal builds: the run link (the configured website origin plus the run id, never the Host header) and an Apple Podcasts link built from a numeric id. Every other field goes through C3.5's link removal. Vasal emits no markdown or HTML.
  - Show it: `![x](https://evil.example/p?d=)` and `evil.example/login` come back without the URL.
- D5.4 Results label themselves in fixed fields: third-party text as data from directories, feeds and Qloo, not instructions; angles and briefs as AI drafts; numbers as computed by Vasal. The labels are a hint, not a defence. get_board also says whether past guests were checked and how far back (C2.9).
- D5.5 MCP returns no more than the run page shows a person: no raw Qloo responses, Qloo entity ids or step logs.
  - The same holds for the Without Qloo flip on the run page: no Qloo ids, no model text.
- D5.6 Nothing internal reaches the caller's model: secrets, internal hostnames, stack traces, other tokens' ids.

D6 New tables
- D6.1 New rows follow C6.5 and C6.6. A token row that fails its schema counts as missing.
- D6.2 Rows per token are capped, and expired tokens and candidates are pruned on schedule (C6.7).

### General standards for the MCP server
1. Primitives over lists. The token uses `crypto.randomBytes` and SHA-256, and ids use `crypto.randomUUID`. The human check uses siteverify's hostname and action fields. Output uses Unicode property escapes, linkify-it, `JSON.stringify` and an output schema. Public routes come from the router's own match, and races are settled by database constraints. The remaining lists fail closed: the four tools, the declared capabilities, the error codes, the empty origin list and the token format.
2. Normalise before you compare. Tokens are compared as hashes from one function, and expiry is checked against the database clock. The share a call is charged to is read from storage. The Turnstile hostname comes from the URL parser on both sides, ids are exact server strings, and one classifier serves both surfaces.
3. Validate outputs like inputs. The new consumers are:
   - the caller's model (D5.1 to D5.4)
   - the caller's client, which may render markdown (D5.3)
   - the caller's logs and model provider (D1.4, D5.5, D5.6)
   - Vasal's own logs (D1.4, D2.8)
4. Fail closed. Starting values:
   - body: 16 KB, no batches
   - token life: 30 days; candidate life: 1 hour
   - book_guests waits up to 45 s, then returns the run id; there is no queue
   - per token, per day: 3 runs, 20 find_show calls, 15 briefs
   - per token, at once: 1 book_guests and 3 calls in flight
   - MCP in-flight slots: 1 of 3
   - key issue: 3 per visitor per day, plus a global daily cap
   - tool result: 16 KB

   An unreadable token row, flag or counter, a siteverify failure, a schema failure or an unknown method is a refusal. One human check buys at most 3 runs a day for 30 days, so 90 runs.
5. Non-goals. The MCP server does not defend against:
   - the caller's model obeying visible plain-language text in a result
   - tokens leaked by their holders, beyond the caps until expiry or revocation
   - a funded attacker minting tokens through solver services, beyond D3.3 keeping the website's capacity safe
   - fairness among honest MCP users once the daily slice is spent
   - privacy of MCP runs (run links work like the website's)
   - knowing who a token belongs to
   - compromise of the caller's agent, client or model provider, or of the MCP SDK (pinned in the lockfile)

### Facts to verify for section D
- How SDK 1.32.1 handles each of these:
  - a thrown tool error
  - batch arrays
  - unknown keys in a raw-shape input schema
  - `structuredContent` against `outputSchema`
  - reuse of a stateless transport across requests
- Cloudflare siteverify's `hostname` and `action` fields, and whether an answer is single use.
- The Apple directory's per-address rate limit.
- Whether Qloo's terms allow returning Qloo-derived board data to third parties through an API (A13, A23).
- Settled on 19 Oct: the agent loop does not call YouTube; only the offline backtest does.

## Facts to verify before a work order cites them

These come from the reviewer's own knowledge, not from a document read in this project:
- YouTube's default daily quota and the unit cost of each call
- which client-IP header Vercel and Fly or Railway set, and whether a client can spoof it
- whether Fly and Railway private networks use IPv6 unique-local addresses
- whether `qloo mcp` offers tools beyond the Qloo API (C2.2 refuses unlisted tools either way)
- whether Qloo's terms count derived numbers (fit scores, backtest correlations) as "response data", which changes how wide C7.3 must be
