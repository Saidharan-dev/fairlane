# FairLane
**Track 01 — AI Growth & Agentic Commerce**
*When multiple AI buyer agents want the same scarce stock at the same instant, who should win — and can the merchant prove it was fair?*

---

## The problem

Most "agentic commerce" demos assume one AI buyer agent politely chatting with one merchant. That's not the version of this problem that actually breaks things.

As protocols like NPCI's UAP, ACP, AP2, and x402 mature, merchants will be hit by **many autonomous AI buyer agents at once** — bidding for the same flash-sale item, the same low-stock SKU, the same limited coupon. Today's checkout infrastructure has no answer for this beyond "first request wins," which creates two failure modes:

1. **Overselling** — concurrent requests race past stock checks and the merchant sells more units than exist, creating refund chaos and broken trust with buyer agents.
2. **Unfair allocation** — the buyer who wins is whoever's API call was fastest, not whoever the merchant *should* have sold to (most committed, most loyal, most urgent need) — and nobody, human or agent, gets an explanation for why they lost.

This is a market-mechanism-design problem under concurrency, not a UX problem — which is exactly why almost nobody builds it for a hackathon, and exactly why it demonstrates real systems thinking.

## Our solution

**FairLane** is a merchant-side allocation engine that sits between limited stock and multiple concurrent AI buyer agents. Instead of first-come-first-served:

1. **Agents actually decide, they don't just submit fixed numbers.** Each simulated AI buyer agent is given a persona and situational context, then calls a real LLM (Groq's free tier by default) to decide its own bid amount, urgency, and a stated reason — within a hard budget ceiling the agent can never exceed. This is what makes them agents, not hardcoded bid values dressed up as agents.
2. **Batches, doesn't race.** Incoming bids for a scarce item are collected into a short window (2.5s) instead of being processed as they arrive — so an agent that's a few milliseconds "late" isn't structurally doomed. This is the core insight: fairness under concurrency requires *not* deciding on arrival order at all.
3. **Scores transparently.** Every bid is scored with a documented, non-black-box formula: `score = 0.55×bid + 0.25×urgency + 0.20×loyalty`. No ML model in the scoring itself, no hidden logic — anyone (including a losing agent) can recompute why they lost.
4. **Allocates atomically.** Stock is decremented once, synchronously, before any async work (payment calls) begins — this makes overselling structurally impossible, not just unlikely.
5. **Explains every outcome in natural language, grounded in real numbers.** An LLM writes a tailored, specific explanation for every winner and loser, referencing their actual score and which factor mattered — not a canned template.
6. **Recovers from payment failure live.** If a winning agent's payment fails, the freed unit is immediately reallocated to the next-highest-scoring agent from the *same* batch — no reopening the auction, no lost sale, no idle stock.
7. **Logs everything.** A full audit trail — every bid, every score, every allocation, every payment attempt/failure/reallocation, every explanation — timestamped, human-readable, and honestly labeled as LLM-generated or rule-based.

**Honesty by design:** if no LLM provider key is configured — or if a call fails (e.g. a rate limit) — agent decisions and explanations fall back to clearly-labeled rule-based logic. `[LLM-decided]` / `[LLM-generated]` vs `[rule-based]` tags appear on every relevant audit entry and console log line, so the system never silently pretends a fallback value came from an LLM.

This satisfies both halves of the track brief in one system: it **grows revenue** (captures the most motivated buyer, recovers failed payments instead of losing the sale) and it **makes the merchant genuinely transactable by AI buyers at scale** (defines what happens when agents collide, which single-buyer demos never even encounter). It also directly hits "the bar": every money action is explainable, bounded, and gated, with a visible audit trail and graceful failure handling.

## Architecture

```
backend/
  server.js         Express + Socket.io server, REST API, demo controls
  allocation.js      Core engine: batching, scoring, atomic allocation, reallocation, audit log
  payment.js         Razorpay test-mode adapter (falls back to mock if no keys), failure injection
  llm.js             Provider-agnostic LLM integration (Groq primary, Gemini/Anthropic as alternatives): agent bid decisions + win/loss explanations, with rate-limit retry and honest rule-based fallback
  catalog.js         Seed merchant catalog (one scarce "flash drop" SKU + two normal-stock SKUs)
  simulate-agents.js Fires 6 AI buyer agent personas (each LLM-decided), staggered across the batch window, at the scarce SKU
  public/index.html  Live dashboard: stock, ticker tape, scoreboard, audit trail, demo controls
```

**Flow:** each agent persona in `simulate-agents.js` calls `llm.js` to decide its own bid/urgency/reasoning (staggered ~350ms apart to respect free-tier rate limits, still well inside the 2.5s batch window) → `POST /api/bid` → held in an in-memory batch per item → batch window closes → `allocation.js` scores + allocates + decrements stock atomically → `llm.js` generates a tailored win/loss explanation per agent (paced ~200ms apart) → `payment.js` attempts Razorpay test-mode payment per winner, in score order → on failure, engine reallocates live to the next-highest bidder in the same batch → every step streamed to the dashboard over Socket.io and appended to the audit trail.

## LLM provider

`llm.js` checks for API keys in this order and uses the first one found:

1. **`GROQ_API_KEY`** (recommended) — free tier, no credit card, at [console.groq.com](https://console.groq.com). Its free-tier rate limits comfortably handle this demo's burst pattern (up to 12 LLM calls per batch: 6 bid decisions + up to 6 explanations).
2. **`GEMINI_API_KEY`** — free tier at [aistudio.google.com](https://aistudio.google.com/apikey), but Google's free tier for `gemini-3.6-flash` caps out at 5 requests/minute and 20/day, which this demo's burst pattern can exceed in a single run. Supported for completeness, not recommended as the primary.
3. **`ANTHROPIC_API_KEY`** — works if you have Anthropic credits (no free tier).

If none are configured, or if a call fails (e.g. a transient rate limit), the system falls back to clearly-labeled rule-based logic — one retry is attempted automatically on rate-limit errors before falling back.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # add your Razorpay TEST keys and a GROQ_API_KEY, or leave blank to run with mock payments + rule-based agent decisions
npm start               # starts the server + dashboard at http://localhost:4000
```

Open the dashboard: **http://localhost:4000/index.html**

In a second terminal, fire the agent scenario:

```bash
npm run simulate
```

## Demo script (for the pitch video)

1. **Open the dashboard.** Explain: 3 units of a flash-drop item, about to be hit by 6 AI buyer agents at once, each one a real LLM call deciding its own bid.
2. **Run `npm run simulate`.** Watch the console print each agent's LLM-decided bid and reasoning, then watch the dashboard's ticker tape and scoreboard populate, then allocation happen — 3 winners declared, 3 losses explained, all with LLM-generated explanations grounded in real scores.
3. **Reset the demo**, then **force-fail** the current top-scoring agent's payment before re-running. Show the audit trail: payment fails → unit reallocated live to the next-highest agent → payment succeeds → **zero units lost, zero units oversold.**
4. **Show the Razorpay test-mode dashboard side by side** — the order IDs in FairLane's audit trail match real orders in Razorpay's own Orders tab, proving this is a live integration, not a mockup.
5. **Close on the audit trail panel.** Every decision — the bid reasoning, the score, the reason for a loss, the reallocation — is explainable and logged. This is the trust layer agentic commerce needs before it can scale past single-buyer demos.

## Build challenges & technical obstacles (for the submission form)

- **Proving "no overselling" isn't just a claim.** Naive per-request stock checks (`if stock > 0, decrement`) have a race window when requests are truly concurrent. We solved this by never processing bids one at a time — bids are batched, then allocation happens as a single synchronous pass over the whole batch, so there's no interleaving point where two requests can both see the same "free" unit.
- **Designing a scoring formula that's explainable, not just accurate.** We deliberately avoided an ML model here — a black-box score would undermine the "explainable" requirement in the track's own bar. The weighted linear formula is simple enough that any losing agent (or a human auditor) can recompute exactly why they lost.
- **LLM provider model names change without notice.** During development, both Groq's and Google's default free-tier model names were deprecated mid-build (`llama-3.3-70b-versatile` and `gemini-2.0-flash` both returned 404s at different points). We made the model name configurable via environment variables (`GROQ_MODEL`, `GEMINI_MODEL`) with sane defaults, rather than hardcoding a value that could silently break the demo later.
- **Reasoning models need real token headroom.** Groq's `openai/gpt-oss-20b` spends part of its token budget on internal reasoning before writing its final answer — an initial `max_tokens` of 120–200 was consistently truncating responses before the actual JSON or sentence was written. We raised the budgets (500 for structured bid decisions, forcing `response_format: json_object`; 350 for free-text explanations) and added a retry-on-rate-limit step, since free-tier per-minute token caps were tripped by firing all 6 agent calls simultaneously.
- **A silent data-loss bug in the API layer.** The `/api/bid` endpoint was destructuring the request body but never forwarding the `reasoning` and `llmUsed` fields on to the allocation engine — so genuinely LLM-decided bids were being mislabeled `[rule-based]` in the audit trail purely because that metadata got dropped in transit. This was a good reminder to verify claims end-to-end (in this case, by testing the actual audit trail output) rather than trusting that a working upstream call means the whole pipeline is correct.
- **Making failure-and-reallocation demoable on cue.** Real payment failures are rare and non-deterministic, which is bad for a live pitch. We added a one-shot `force-fail` demo control so the reallocation flow can be triggered reliably on camera instead of relying on a random decline.

## Notes on scope

This is a proof of concept built to demonstrate the mechanism, not a production payments system:
- Razorpay integration creates real **test-mode** orders when API keys are provided (no real funds ever move); it falls back to a local mock so the demo runs without requiring credentials in front of you.
- State is in-memory and resets on restart — intentional, to keep the demo fast and inspectable.
- The scoring weights, batch window, stagger timings, and catalog are all in named constants near the top of `allocation.js` / `catalog.js` / `simulate-agents.js` for easy tuning during a live demo.
