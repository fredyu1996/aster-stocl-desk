# Aster Stock Desk

Walkable 3D paper-trading desk for Aster DEX stock perpetuals with two paper traders: GMS PMR v1.4, and the SMC Trader from Fred's crypto desk (`fredyu1996/aster-desk`, run from its own code). Started 2026-11-23 from Market Floor's strategy engine and Aster Desk's layout (cloud trader + private data repo + review wall).

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

```bash
BT_DAYS=7 BT_TOP=3 BT_OUT=/tmp/bt.json node bot/backtest.mjs   # both traders, real Aster 1m candles (180 d × 10 ≈ 10–40 min)
```

Behind an HTTPS proxy add `NODE_USE_ENV_PROXY=1` for Node fetch. After a UI change, open the desk in Playwright, walk to each wall (P, V, R), open each panel (1–7, ☁ Sync, ⚙), move the mouse (and press Esc with nothing open: the view should hold still) (the view should turn without a click), open the Picks wall (B), draw a mark, switch a timeframe, and check for page errors. jsDelivr may be blocked in the sandbox: install `three@0.149.0` from npm and route the import-map URL to it. After a strategy or account change, run the tests and a real cycle.

`test/regime.test.mjs` compares the regime port with the original Python skills. `test/fixtures/regime_expected.json` was produced by running their calculators (`.claude/skills/*/scripts`, plus their `scorer.py`) on `test/fixtures/uptrend_*.csv` and synthetic breadth CSVs; regenerate it the same way if you re-vendor the skills. `.claude/skills/` holds six vendored claude-trading-skills (MIT, see its README) for use from Claude.

## Code map

| File | Responsibility |
| --- | --- |
| `core/pmr.mjs` | GMS PMR v1.4 `Scanner` (ported from Market Floor `public/market.mjs`, perpetual path only), taker-flow / volume `intel`. Timing / thresholds / `targetR` in `PMR_DEFAULT` (= v1.4), overridden by `cfg.pmr` (default `{}`). |
| `core/aster.mjs` | Aster REST (`fapi.asterdex.com`), stock-perp universe (`underlyingSubType` contains `STOCK`, not `pre-launch`), 1m bars (6,000 = 100 h), book, funding. |
| `core/reviewer.mjs` | Net R:R economics, `preTrade` gate and sizing, `grade` A–F, `learn` rule proposals from trades and Fred's reviews. |
| `core/desk.mjs` | State schema, paper fills / stops / targets / time exits on 1m bars, one `cycle` shared by browser and cloud. `choosePicks` (the north-wall shortlist). |
| `core/regime.mjs` | US market posture ported from claude-trading-skills: market-breadth-analyzer, uptrend-analyzer, exposure-coach (breadth + uptrend + sector inputs). `pyRound` = Python round. |
| `core/postmortem.mjs` | signal-postmortem adaptation: replays declined proposals with the desk's fill rules (`simulatePlan`), outcome classes, per-filter report. |
| `core/digest.mjs` | weekly-performance-digest + trade-performance-coach adaptations (Digest panel, key 5). |
| `core/smc.mjs`, `core/smc-config.mjs`, `vendor/smc-core.js` | SMC Trader. `vendor/smc-core.js` = aster-desk's generated `bot/core.js`, **unchanged** (commit in `smc-config.mjs`), run in a function sandbox with inert DOM / storage / network stand-ins (`makeCore`). `core/smc.mjs` feeds it like aster-desk's `bot/backtest.mjs`: 1m → 5m / 15m / 1h rows, `viewAt` (closed bars + forming bar from closed 5m), `runStep` (walk held positions through the 5m candle, then `smTick`), `smcCycle` (live, state key `smc`). `smc-config.mjs` = snapshot of the crypto `sm.cfg` + `rv.smAdj` (small-cap SMC Trader). |
| `bot/backtest.mjs`, `.github/workflows/backtest.yml` | Nightly report of both traders on today's top 10 stock perps × 180 d (plus `PMR_VARIANTS`: report-only PMR loosenings with funnel counts) → branch `backtest-report` of this repo (`stock-backtest.json`, read by the 7 Backtest panel from raw.githubusercontent.com). |
| `core/github.mjs` | State on the private data repo: parentless commit per save, force-updated, re-read ref before write, `update` retries. |
| `bot/run.mjs` | Cloud cycle (GitHub Actions `cloud-trader.yml`). `STATE_IN`/`STATE_OUT` for local files. |
| `ui/scene.mjs` | three.js room: five desks (6 = SMC Trader), figures, four wall screens (north = picks, east = both traders' positions), walking, mouse-look (follow / fast / drag, `asd_look`; Esc with nothing open holds the view still) and picking. |
| `ui/wall.mjs` | Picks wall overlay: interactive charts from Aster klines (zoom, pan, 1m–1d, older history on demand), Fred's mark tools, auto FVG / swings, PMR + Trader level layer, pin / skip. |
| `ui/app.mjs`, `ui/charts.mjs`, `ui/styles.css` | Data loop, panels, review form, settings, canvas charts. ☁ Sync panel + HUD sync chip (modelled on aster-desk `src/sync.js`): role, take over / hand back, cloud-trader card from the public Actions runs API (no token), connect form (`asd_sync`: repo, branch, token, name, dev, on). |

## Invariants

1. Strategy timing follows Market Floor: completed 1H breakout with known pivots and prior ATR; causal 15m OB (needs BOS) or FVG known at C3 close, search ≤ 2 bars after the breakout; first retest ≤ 120 min; 5m MSS + displacement ≤ 45 min; first associated FVG midpoint, eligible after C3; 60 min entry window. Continuous UTC bars. A partial interval never forms a candle. `test/desk.test.mjs` checks that a prefix of bars gives exactly the prefix of events.
2. A proposal is acted on once (`state.seen[plan.id]`). Its limit only fills on bars that opened after the cycle that saw it (`activeAfter`). Stop beats target in the same bar. Target cannot fill on the entry bar. Time exit at 90 min. The scanner cancelling the setup (1H close back inside, POI broken) cancels the pending limit.
3. R = net P&L / planned risk, and planned risk already includes fees, slippage and expected funding, so a clean stop is −1R.
4. The cloud and a browser never both trade (Sync, like the crypto desk, 2026-11-25): a trading browser (`lastCycle.by = 'browser'`, `dev` / `name` = its device) keeps the desk while it cycles; the cloud and other browsers take over after it has been silent 5 min. A browser takes over from the cloud only when the cloud has been quiet 30 min or Fred clicks "Take over trading here"; "Hand trading back to the cloud" writes `by: 'handback'`. The decision is made inside `update()` on the fresh copy, and every save re-reads the ref first.
5. Learned rules only gate trades after Fred approves them (`rules.active`). Rejected / removed keys stay in `rules.decided` so they are not proposed again.
6. Picks: `state.picks` = held symbols (both traders), then Fred's `pins`, then symbols with a current SMC scan candidate, then furthest PMR stage, then 24h volume, minus his `skips` (a held symbol stays). Size `cfg.picks` (6). With `cfg.picksOnly` (default on) a proposal outside the picks is declined `NOT_IN_PICKS`. Pins are always scanned (passed with held symbols to `loadMarket`).
7. Fred's chart marks (`state.marks[symbol]`, FVG / OB / MSS / liquidity / HH HL LH LL, times are chart-bar open times). Fred chose (2026-11-23) "veto + record": `markCheck` declines a proposal when his latest hand-drawn MSS (by bar time, at or before the signal) points the other way, or the entry sits inside one of his opposite-direction FVG / OB; a same-direction FVG / OB overlapping the 15m POI or 5m entry FVG is recorded as `plan.marks.confluence` (feature `marks`, rule `marksConfluenceOnly` only after his approval). Auto marks and marks placed after the signal bar never count. Marks never size a trade. Order of checks: trading off → not in picks → marks veto → `preTrade`. Chart-wall candles (`chartBars`) are display only; trading stays on completed 1m bars.
8. Market posture (`state.market`, refreshed at most hourly by whoever runs the cycle), the postmortem (`decision.post`) and the digest / coach are record and display only. They never gate, size or cancel a trade. Each proposal stores `plan.market` (exposure recommendation, ceiling, zones) and each trade `marketAtExit`, `mae`, `mfe` (R of planned risk per unit).
9. SMC Trader (Fred, 2026-11-24: runs in this desk, small-cap SMC Trader settings, backtest top 10 × 180 d): `vendor/smc-core.js` is never edited here; to update it, copy aster-desk's built `bot/core.js` and re-read `sm.cfg` / `rv.smAdj` into `core/smc-config.mjs`. It trades `cfg.smcScope` (Fred, 2026-11-25: default `watch` = the universe watch list minus skips; `picks` = picks only) plus held symbols, steps at each 5m close (catch-up ticks at most the last 12 steps, walks up to 24 h of candles), fills at the 5m close + slippage, and rides on the same cycle and lock as the PMR Trader. `cfg.on` off or `state.smc.on === false` blocks its entries; Fred's hand-drawn marks veto its entries via `markCheck` (zone = its entry zone). Its R is aster-desk's (realized P&L / risk at entry). A failure is stored in `state.smc.error` and never blocks the PMR cycle. The Reviewer does not learn from it, and it has no postmortem.

## Open items

- PMR v1.4 as written rarely completes an entry. 2026-11-25 study (top 10 × 180 d): 668 1H breakouts → 284 POI → 171 retests → 15 MSS → 3 proposals, all declined NET_RR (the measured-move target is mostly spent by entry). Loosening windows / displacement / R:R alone: 0 trades. Loosened + fixed 2.5R target: n 14, −0.7R, halves −2.8R (n 8) / +2.1R (n 6) — too small and inconsistent. `cfg.pmr` stays `{}` until Fred approves a variant.
- Needs a public GitHub repo for Pages + Actions, the `DATA_TOKEN` secret, and a cron-job.org timer. Data goes to `fredyu1996/aster-desk-data` branch `stocks-state` unless `DATA_REPO` / `DATA_BRANCH` say otherwise.
- No live executor yet (Fred chose "paper first, keep live"). Market Floor's `binance-execution.mjs` is the reference if he asks for one; Aster's v1 futures API is Binance-style HMAC.
- No backtester panel and no news feed yet.
- Marks veto has no expiry: an old opposite FVG / OB keeps vetoing until Fred erases it. Ask before adding mitigation / age rules.
- Manual paper orders from the Picks wall are not built.
- SMC config is a snapshot (2026-11-24). When Fred changes the crypto SMC Trader or its Reviewer rules, ask whether the stock SMC Trader should follow.
- Backtests do not model picks, marks, spread or funding, and use today's top-10 list (survivorship).
- Exposure coach runs with 3 of its 8 inputs (no regime, top-risk, FTD, theme, institutional: those skills need FMP or charts), so it always applies a 20-point haircut and never says NEW_ENTRY_ALLOWED. Fred did not choose the drawdown circuit breaker / discipline gate.
