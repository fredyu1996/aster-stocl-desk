# ICT New York morning study

Standalone paper backtest for the sweep → MSS → FVG reversal. The source model uses MNQ, with 10:00–11:00 New York entries and a noon time exit. The core accepts the desk’s `{ t, o, h, l, c, v }` completed one-minute bar shape. `t` is the close time. The module derives its own completed 15-minute bars.

## Run

```sh
node bot/ict-backtest.mjs path/to/input.json > ict-report.json
npm test
```

Pass one instrument and one consistent bar source per file. Abridged input shape:

```json
{
  "source": "trade",
  "instrument": { "symbol": "MNQZ6", "tickSize": 0.25, "pointValue": 2, "minRange": 10 },
  "costs": { "roundTrip": 4, "feeRate": 0, "stopSlippageTicks": 0, "timeSlippageTicks": 0 },
  "sessions": [
    { "date": "2026-11-20", "kind": "regular", "news": false },
    { "date": "2026-11-23", "kind": "regular", "news": false }
  ],
  "bars": []
}
```

- Populate `bars` with historical data from a single contract. Use Unix milliseconds or ISO timestamps with an offset. Include the previous full 09:30–16:00 cash session and each study day’s midnight-to-noon observations. A noon exit uses the opening price of the bar that closes at 12:01 ET. Supply the complete cash-session calendar for the study period and its preceding regular session. Use `kind: short` for early closes, omit market holidays and set `news: true` on known CPI, Employment Situation or FOMC decision dates.
- Optional `closures: [{ from, to }]` describes known venue closures as half-open intervals in the same timestamp format. Previous cash highs and lows are eligible when untouched in the intervening prices. A gap without a declared venue closure makes those levels ineligible. The opening range can still supply a target. Gaps in the reference bars, setup or execution path produce an `INCOMPLETE` result.
- The sample USD 4 round-trip cost is the worked MNQ illustration. The report uses the supplied fixed round-trip cost, optional proportional `feeRate`, and optional adverse stop and time-exit slippage. Set those inputs for the instrument and data. `minRange` is a distance in quote-price points from sweep extreme to target. The model filters below 2.0 net R:R and returns per-unit P&L, planned risk and realized R.
- For an Aster stock perpetual, supply its `symbol`, the run’s `tickSize`, `pointValue` per one base unit, and a separate `minRange` study parameter in the symbol’s price units. The original MNQ distance is 10 index points. Aster mark candles are supported as a price-path study through `source: mark`. Use traded bars for the traded-price study and audit thin trading separately. The simulator uses OHLC trade-through assumptions and the supplied costs.
- Optional `asOf` makes the replay stop at a completed-bar cutoff. Optional `splitAt` separates discovery and holdout in the JSON summary. The output contains one session record per date and a separate list of closed trades.

## Integration for Claude

Import `backtestIct` from `core/ict.mjs` for a research report or Backtest panel integration. The existing `bars1m` export in `bot/backtest.mjs` can supply the Aster candle shape, and `core/aster.mjs` provides exchange specs. Keep each symbol and bar source in a separate run and pass its cost and range settings explicitly. Render the daily statuses and `trades` from the returned report. Treat `PENDING` and `OPEN` as simulated states and `INCOMPLETE` as a data-quality status.

The standalone command runs from input JSON with no account-sync dependencies. The study assumes one unit and at most one setup per session. Limit fills use the limit price after a one-tick trade-through. Stops take priority on an ambiguous bar. A target crossed on the fill bar is flagged and its fill is deferred. The model has yet to be evaluated on an out-of-sample market dataset.
