# Aster Stock Desk

Walkable 3D paper-trading desk for Aster DEX stock perpetuals, running GMS PMR v1.4. Started 2026-11-23 from Market Floor's strategy engine and Aster Desk's layout (cloud trader + private data repo + review wall).

## Working with Fred

- He writes in Cantonese, sometimes English. Reply in colloquial Cantonese (Traditional Chinese). Keep code and trading terms in English (OB, FVG, MSS, R, long/short).
- Lead with the answer: what changed, what he will see, what is still open. Give numbers with their sample size.
- **Paper only.** Never place real orders, never hold his keys. He must not paste tokens into chat. Tokens live only in the `DATA_TOKEN` repo secret, each browser's Sync panel (localStorage `asd_sync`) and his cron-job.org job.
- Evidence over enthusiasm. Say when a sample is too small. Reviewer rules are proposals until he approves them. Ask before changing a strategy when the evidence is thin.

## Run and verify

Node 22+. No build step and no npm dependencies; the browser loads three.js 0.149.0 from jsDelivr through the import map in `index.html`.

```bash
npm test                                   # node --test, offline
STATE_OUT=/tmp/st.json node bot/run.mjs    # one real cycle against Aster, no token
node tools/serve.mjs                       # desk on http://127.0.0.1:4180
```

Behind an HTTPS proxy add `NODE_USE_ENV_PROXY=1` for Node fetch. After a UI change, open the desk in Playwright, walk to each wall (P, V, R), open each panel (1–4, ⚙), open the Picks wall (B), draw a mark, switch a timeframe, and check for page errors. jsDelivr may be blocked in the sandbox: install `three@0.149.0` from npm and route the import-map URL to it. After a strategy or account change, run the tests and a real cycle.

## Code map

| File | Responsibility |
| --- | --- |
| `core/pmr.mjs` | GMS PMR v1.4 `Scanner` (ported from Market Floor `public/market.mjs`, perpetual path only), taker-flow / volume `intel`. |
| `core/aster.mjs` | Aster REST (`fapi.asterdex.com`), stock-perp universe (`underlyingSubType` contains `STOCK`, not `pre-launch`), 1m bars (6,000 = 100 h), book, funding. |
| `core/reviewer.mjs` | Net R:R economics, `preTrade` gate and sizing, `grade` A–F, `learn` rule proposals from trades and Fred's reviews. |
| `core/desk.mjs` | State schema, paper fills / stops / targets / time exits on 1m bars, one `cycle` shared by browser and cloud. `choosePicks` (the north-wall shortlist). |
| `core/github.mjs` | State on the private data repo: parentless commit per save, force-updated, re-read ref before write, `update` retries. |
| `bot/run.mjs` | Cloud cycle (GitHub Actions `cloud-trader.yml`). `STATE_IN`/`STATE_OUT` for local files. |
| `ui/scene.mjs` | three.js room: desks, figures, four wall screens (north = picks), walking and picking. |
| `ui/wall.mjs` | Picks wall overlay: interactive charts from Aster klines (zoom, pan, 1m–1d, older history on demand), Fred's mark tools, auto FVG / swings, PMR + Trader level layer, pin / skip. |
| `ui/app.mjs`, `ui/charts.mjs`, `ui/styles.css` | Data loop, panels, review form, settings/sync, canvas charts. |

## Invariants

1. Strategy timing follows Market Floor: completed 1H breakout with known pivots and prior ATR; causal 15m OB (needs BOS) or FVG known at C3 close, search ≤ 2 bars after the breakout; first retest ≤ 120 min; 5m MSS + displacement ≤ 45 min; first associated FVG midpoint, eligible after C3; 60 min entry window. Continuous UTC bars. A partial interval never forms a candle. `test/desk.test.mjs` checks that a prefix of bars gives exactly the prefix of events.
2. A proposal is acted on once (`state.seen[plan.id]`). Its limit only fills on bars that opened after the cycle that saw it (`activeAfter`). Stop beats target in the same bar. Target cannot fill on the entry bar. Time exit at 90 min. The scanner cancelling the setup (1H close back inside, POI broken) cancels the pending limit.
3. R = net P&L / planned risk, and planned risk already includes fees, slippage and expected funding, so a clean stop is −1R.
4. The cloud and a browser never both trade: whoever ran last (`lastCycle.by`) keeps the desk for 30 min. Every save re-reads the ref first.
5. Learned rules only gate trades after Fred approves them (`rules.active`). Rejected / removed keys stay in `rules.decided` so they are not proposed again.
6. Picks: `state.picks` = held symbols, then Fred's `pins`, then furthest PMR stage, then 24h volume, minus his `skips` (a held symbol stays). Size `cfg.picks` (6). With `cfg.picksOnly` (default on) a proposal outside the picks is declined `NOT_IN_PICKS`. Pins are always scanned (passed with held symbols to `loadMarket`).
7. Fred's chart marks (`state.marks[symbol]`, FVG / OB / MSS / liquidity / HH HL LH LL, times are chart-bar open times) are notes only. They never gate or size a trade. Chart-wall candles (`chartBars`) are display only; trading stays on completed 1m bars.

## Open items

- PMR v1.4 as written rarely completes an entry (Nov 23 scan: 30 symbols × 100 h → 25 patterns, 0 entries). Ask Fred whether to add the Aster Desk SMC strategy as a second paper account, or loosen PMR with a backtest first.
- Needs a public GitHub repo for Pages + Actions, the `DATA_TOKEN` secret, and a cron-job.org timer. Data goes to `fredyu1996/aster-desk-data` branch `stocks-state` unless `DATA_REPO` / `DATA_BRANCH` say otherwise.
- No live executor yet (Fred chose "paper first, keep live"). Market Floor's `binance-execution.mjs` is the reference if he asks for one; Aster's v1 futures API is Binance-style HMAC.
- No backtester panel and no news feed yet.
- Picks wall (added 2026-11-23): ask Fred whether his marks should ever feed the Trader (for example only take a proposal whose POI overlaps his FVG / OB). Today they are notes only. Manual paper orders from the wall are also not built.
