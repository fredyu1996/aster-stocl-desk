// Snapshot of Fred's live SMC Trader (small caps) settings from his crypto desk, the account the stock SMC Trader copies.
// Source: fredyu1996/aster-desk-data, branch `state`, keys `sm.cfg` and `rv.smAdj` (the Reviewer's SMC rules in force), read 2026-11-24.
// The locked zone weights (`smAdj.zone`, `zoneLearn 0`) are left out, as in aster-desk's own backtest (PREP).
// To follow a later change on the crypto desk, re-read those two keys and update this file (and vendor/smc-core.js for code changes).
export const SMC_SOURCE = {
  code: 'fredyu1996/aster-desk bot/core.js @ 1a4dedca5376bd43f6f032ea17d50d139a0f7805 (vendor/smc-core.js, unchanged)',
  config: 'aster-desk-data state · sm.cfg + rv.smAdj, read 2026-11-24',
  account: 'SMC Trader (small caps)',
};
export const SMC_CFG = {
  riskPct: 1, maxPos: 3, maxLev: 10, minScore: 4, dailyLossPct: 0, feePct: 0.04, slipPct: 0.1, holdH: 12, minVol: 300000, maxStopPct: 15,
  minRR: 2, maxRR: 5, tp1R: 1.5, stopBuf: 0.3, unlGuard: 0, useScreens: 0, tf15: 1, tf1h: 1, holdH1h: 36, minQ: 55, learn: 1, poiRule: 1,
  ltfConfirm: 1, roomCheck: 1, cont: 1, pathCheck: 1, pdLiq: 1, invExit: 1, minStopPct: 1.5, minDepth: 15, zoneLearn: 0, regimeGate: 1,
  obPick: 0, gmsA: 0, gmsB: 1, gmsC: 0, gmsD: 1, fib: 1, closedOnly: 0, retestExp: 0, ltf5m: 0, pat1h: 0,
  ownJudge: 1, lev10: 1, pause1113: 1, resume1113: 1, gmsBD1115: 1, pause1115: 1, resume1115: 1, nolimit1116: 1, fib1119: 1, nounl1120: 1,
};
// Reviewer rules in force: HTF must agree, midpoint / deeper entries, OB quality bar, quality ≥ 65, stop 0.6% beyond the sweep, half at +1.2R.
export const SMC_ADJ = { needHTF: true, minQ: 65, needDepth: true, obQ: true, stopBuf: 0.6, tp1R: 1.2 };
