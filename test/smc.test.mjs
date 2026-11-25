import assert from 'node:assert/strict';
import test from 'node:test';
import { stats } from '../bot/backtest.mjs';
import { freshState } from '../core/desk.mjs';
import { framesFrom1m, H, M15, M5, makeCore, nClosed, smcCycle, smcSource, viewAt, withSmc, SMC_ADJ, SMC_CFG } from '../core/smc.mjs';

const MIN = 60_000, T0 = Date.UTC(2026, 10, 20, 0, 0);
// 1m desk bars, t = close time, a slow up-drift with a wiggle
const ones = (n, start = T0) => Array.from({ length: n }, (_, i) => { const c = 100 + i * 0.01 + Math.sin(i / 7); return { t: start + (i + 1) * MIN, o: c - 0.05, h: c + 0.2, l: c - 0.2, c, q: 1000, tb: 600 }; });

test('1m bars aggregate to 5m / 15m / 1h rows by open time, and the view only sees what closed by T', () => {
  const F = framesFrom1m(ones(3 * 60));
  assert.equal(F.h1.length, 3); assert.equal(F.m15.length, 12); assert.equal(F.m5.length, 36);
  assert.deepEqual(F.m5[0].slice(0, 1), [T0]);
  assert.equal(F.m5[0][5], 5000); // quote volume summed
  const T = T0 + 70 * MIN, v = viewAt(F, T);
  assert.equal(nClosed(F.h1, H, T), 1);
  assert.equal(v.h.length, 2); // one closed 1h bar + the forming one built from 5m bars closed by T
  assert.equal(v.h[1][0], T0 + H);
  assert.equal(v.k.at(-1)[0], T0 + 60 * MIN); // forming 15m bar = 5m bars 60–70 min
  assert.equal(v.k.length, 5);
  assert.ok(v.k.every(b => b[0] + (b === v.k.at(-1) ? 0 : M15) <= T));
  assert.equal(v.last, F.m5[nClosed(F.m5, M5, T) - 1][4]);
});

test("the crypto desk's SMC code loads offline in the sandbox with Fred's rules in force", async () => {
  const { h } = await makeCore(await smcSource(), { symbols: [{ symbol: 'NVDAUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', baseAsset: 'NVDA', underlyingSubType: ['STOCK'] }] });
  h.prep(SMC_CFG, SMC_ADJ, null);
  const r = h.rules();
  assert.equal(r.needHTF, true); assert.equal(r.needDepth, true); assert.equal(r.minQ, 65); assert.equal(r.tp1R, 1.2);
  const D = { NVDAUSDT: framesFrom1m(ones(4 * 24 * 60)) }, T = T0 + 4 * 24 * H;
  const v = viewAt(D.NVDAUSDT, T);
  const out = h.step(T, { NVDAUSDT: { k: v.k, h: v.h, tk: { last: v.last, pct: 1, qv: 5e6 } } }, { NVDAUSDT: { side: 'G', t0: T, px0: v.last, pct0: 1, lastTop: T, rank: 1 } }, {});
  assert.deepEqual(out.closed, []);
  assert.equal(h.account().cash, 1000);
});

function fakeCore(seen) {
  const h = {
    prep(cfg, adj, acct) { seen.prep = acct; }, positions: () => [], walk() {}, equity: () => 1000, account: () => ({ start: 1000, cash: 1000, pos: {} }),
    step(T, F, trk) {
      seen.steps.push({ T, coins: Object.keys(trk) });
      const c = { s: 'NVDAUSDT', side: 'L', tk: { last: 100 }, r: { zone: { lo: 99, hi: 99.5 } } };
      const v = h.veto(c);
      return { closed: [], scan: { cands: [{ b: 'NVDA', side: 'L', tf: '15m', zone: 'FVG', q: 'B', type: 'rev', took: !v, skip: v || '' }] } };
    },
  };
  return { h };
}
const market = now => ({ t: now, universe: { watch: ['NVDAUSDT', 'AMDUSDT'] }, bars: { NVDAUSDT: ones(3 * 24 * 60), AMDUSDT: ones(3 * 24 * 60) }, funding: {} });

test('SMC cycle: scans every watched stock minus skips (or the picks), ticks at most the last 12 steps, and Fred\'s marks veto an entry against them', () => {
  const now = T0 + 3 * 24 * H, seen = { steps: [] };
  const s = { ...freshState(), picks: [{ symbol: 'NVDAUSDT', why: 'setup', status: 'WAIT' }],
    marks: { NVDAUSDT: [{ id: 'm', type: 'mss', dir: 'bear', t1: now - 60 * MIN, p1: 101, tf: '15m' }] }, smc: { acct: null, lastStep: now - 30 * M5, trades: [], decisions: [] } };
  smcCycle(s, market(now), fakeCore(seen), { now });
  assert.equal(seen.steps.length, 12);
  assert.ok(seen.steps.every(x => x.coins.join() === 'NVDAUSDT,AMDUSDT'));
  const skipped = { ...freshState(), skips: ['AMDUSDT'], picks: [], smc: { lastStep: now - M5, trades: [], decisions: [] } }, seen2 = { steps: [] };
  smcCycle(skipped, market(now), fakeCore(seen2), { now });
  assert.equal(seen2.steps.at(-1).coins.join(), 'NVDAUSDT');
  const onlyPicks = { ...freshState(), cfg: { ...freshState().cfg, smcScope: 'picks' }, picks: [{ symbol: 'AMDUSDT' }], smc: { lastStep: now - M5, trades: [], decisions: [] } }, seen3 = { steps: [] };
  smcCycle(onlyPicks, market(now), fakeCore(seen3), { now });
  assert.equal(seen3.steps.at(-1).coins.join(), 'AMDUSDT');
  assert.equal(s.smc.lastStep, now);
  assert.equal(s.smc.decisions[0].status, 'Declined');
  assert.match(s.smc.decisions[0].reason, /^MARK · your bear MSS/);
  // nothing new to do inside the same 5m step
  smcCycle(s, market(now + 2 * MIN), fakeCore(seen), { now: now + 2 * MIN });
  assert.equal(seen.steps.length, 12);
  // trading off: vetoed as TRADING_OFF, no mark needed
  const off = { ...freshState(), cfg: { ...freshState().cfg, on: false }, picks: [{ symbol: 'NVDAUSDT' }], smc: { lastStep: now - M5, trades: [], decisions: [] } };
  smcCycle(off, market(now), fakeCore({ steps: [] }), { now });
  assert.equal(off.smc.decisions[0].reason, 'TRADING_OFF');
});

test('an SMC failure is recorded and never blocks the desk', () => {
  const s = freshState(), boom = { h: { prep() { throw new Error('boom'); } } };
  assert.equal(withSmc(s, market(T0 + 3 * 24 * H), boom).smc.error, 'boom');
  assert.equal(withSmc(s, market(T0), null), s);
});

test('backtest stats: win rate, average and total R, drawdown on cumulative R, profit factor', () => {
  const s = stats([1, -1, -1, 2, -0.5].map(R => ({ R, pnl: R * 10 })));
  assert.deepEqual([s.n, s.win, s.avgR, s.totR, s.maxDD, s.pf, s.pnl], [5, 40, 0.1, 0.5, -2, 1.2, 5]);
  assert.equal(stats([]).avgR, null);
});
