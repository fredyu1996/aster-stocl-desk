import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CFG, applyPmrPreset, choosePicks, cycle, freshState, normalize, persistable } from '../core/desk.mjs';
import { PMR_PRESETS } from '../core/pmr.mjs';
import { MIN, Scanner } from '../core/pmr.mjs';
import { economics, features, latestMss, learn, markCheck, preTrade } from '../core/reviewer.mjs';
import { chartBars, pickUniverse } from '../core/aster.mjs';
import { coach, digest, weekOf } from '../core/digest.mjs';
import { classifyTrade, filterReport, simulatePlan } from '../core/postmortem.mjs';
import { Conflict, store, update } from '../core/github.mjs';

const T0 = Date.parse('2026-11-23T15:00:00Z'); // 10:00 New York, a Monday
const spec = { symbol: 'NVDAUSDT', tickSize: 0.01, stepSize: 0.01, minQty: 0.01, minNotional: 5 };

function plan(over = {}) {
  return { id: `NVDAUSDT-${T0}`, symbol: 'NVDAUSDT', direction: 1, entry: 100, stop: 99, target: 104, grade: 'A', grossRR: 4,
    signalAt: T0, expiresAt: T0 + 60 * MIN, atr5: 0.5, fvg: { lo: 99.8, hi: 100.2 },
    pattern: { type: 'FLAG', t: T0 - 60 * MIN, boundary: 99.5, target: 104, atr: 1 },
    poi: { type: 'FVG', lo: 99.4, hi: 99.9, knownAt: T0 - 45 * MIN, confluence: false }, firstRetestAt: T0 - 30 * MIN, mssAt: T0 - 5 * MIN,
    sweep: false, ...over };
}

// Bars from T0-10m to the given path of [low, high, close] per minute after T0.
function bars(path, start = 100.5) {
  const out = [];
  for (let i = -10; i <= 0; i++) out.push({ t: T0 + i * MIN, o: start, h: start + 0.1, l: start - 0.1, c: start, v: 10, q: 1000, tb: 500 });
  let prev = start;
  path.forEach(([l, h, c], i) => { out.push({ t: T0 + (i + 1) * MIN, o: prev, h: Math.max(h, prev, c), l: Math.min(l, prev, c), c, v: 10, q: 1000, tb: 500 }); prev = c; });
  return out;
}

function fakeScanner(p) {
  return (symbol, series) => ({ symbol, proposals: p ? [p] : [], events: [], history: { 1: series, 5: [], 15: [], 60: [] },
    last: series.at(-1), summary: () => ({ symbol, status: p ? 'QUALIFIED' : 'WAIT' }) });
}

function market(series, now, extra = {}) {
  return { t: now, universe: { watch: ['NVDAUSDT'], specs: { NVDAUSDT: spec }, board: [] }, bars: { NVDAUSDT: series },
    book: { NVDAUSDT: { bid: 100.49, ask: 100.51 } }, funding: { NVDAUSDT: { rate: 0.0001, next: T0 + 8 * 60 * MIN } }, ...extra };
}

const run = (state, series, now, p = plan()) => cycle(state, market(series, now), { now, makeScanner: fakeScanner(p) });

test('approves a 2R+ proposal, sizes by 1% risk and only fills on bars that open after the order is live', () => {
  // Price trades through 100 in minute 1, before the desk saw the proposal at T0 + 2m: no fill on that bar.
  const path = [[99.9, 100.4, 100.3], [100.2, 100.6, 100.5], [100.3, 100.6, 100.4], [99.95, 100.4, 100.1]];
  const s1 = run(freshState(), bars(path).slice(0, 13), T0 + 2 * MIN + 5000);
  assert.equal(s1.decisions[0].status, 'Approved');
  assert.equal(s1.orders.length, 1);
  const o = s1.orders[0];
  assert.ok(Math.abs(o.riskUSDT - 10) < 0.2, `risk ${o.riskUSDT}`);
  assert.equal(o.activeAfter, T0 + 2 * MIN);
  const s2 = run(s1, bars(path), T0 + 4 * MIN + 5000);
  assert.equal(s2.positions.length, 1);
  assert.equal(s2.positions[0].entryAt, T0 + 4 * MIN);
  assert.equal(s2.positions[0].entry, 100);
});

test('stop wins when stop and target share a bar, and R includes fees and slippage', () => {
  const path = [[99.9, 100.4, 100.2], [98.5, 105, 100]];
  const s = run(freshState(), bars(path), T0 + 2 * MIN + 1, plan());
  // order went live at T0 + 2m; feed more bars in a later cycle
  const later = bars([[99.9, 100.4, 100.2], [100.3, 100.4, 100.35], [99.9, 100.2, 100.1], [98.5, 105, 100]]);
  const s2 = run(s, later, T0 + 4 * MIN + 1);
  assert.equal(s2.trades.length, 1);
  assert.equal(s2.trades[0].reason, 'Stop');
  assert.ok(Math.abs(s2.trades[0].r + 1) < 0.01, `planned risk includes costs, so a clean stop is −1R: ${s2.trades[0].r}`);
  assert.equal(s.trades.length, 0);
});

test('target and 90-minute time exits close at bar prices', () => {
  const up = bars([[100.4, 100.6, 100.5], [100.3, 100.6, 100.5], [99.9, 100.5, 100.2], [100.2, 104.2, 104]]);
  const s = run(run(freshState(), up.slice(0, 13), T0 + 2 * MIN + 1), up, T0 + 4 * MIN + 1);
  assert.equal(s.trades[0].reason, 'Target');
  assert.ok(s.trades[0].r > 3, `r ${s.trades[0].r}`);
  const flat = [[100.4, 100.6, 100.5], [100.3, 100.6, 100.5], [99.9, 100.5, 100.2], ...Array.from({ length: 95 }, () => [100.1, 100.3, 100.2])];
  const t = run(run(freshState(), bars(flat).slice(0, 13), T0 + 2 * MIN + 1), bars(flat), T0 + 98 * MIN + 1);
  assert.equal(t.trades[0].reason, 'Time exit');
  assert.equal(t.trades[0].exitAt, t.trades[0].entryAt + 90 * MIN);
});

test('cancels the limit when the window passes or the scanner invalidates the proposal', () => {
  const above = Array.from({ length: 70 }, () => [100.3, 100.6, 100.5]);
  const s = run(run(freshState(), bars(above).slice(0, 13), T0 + 2 * MIN + 1), bars(above), T0 + 70 * MIN + 1);
  assert.equal(s.orders.length, 0);
  assert.equal(s.decisions[0].status, 'No fill');
  const p = plan({ endedAt: T0 + 5 * MIN, endReason: '1H_CLOSE_BACK_INSIDE' });
  const first = run(freshState(), bars(above).slice(0, 13), T0 + 2 * MIN + 1, plan());
  const c = run(first, bars(above).slice(0, 20), T0 + 9 * MIN + 1, p);
  assert.equal(c.decisions[0].reason, '1H_CLOSE_BACK_INSIDE');
});

test('reviewer declines low net R:R, wide spreads and approved-rule matches', () => {
  const cfg = freshState().cfg;
  const ctx = { cfg, equity: 1000, openNotional: 0, openCount: 0, holding: false, spec, book: null, funding: null, active: [] };
  assert.match(preTrade(plan({ target: 101.5 }), ctx).reason, /NET_RR/);
  assert.match(preTrade(plan(), { ...ctx, book: { bid: 99, ask: 101 } }).reason, /SPREAD/);
  assert.match(preTrade(plan(), { ...ctx, active: [{ rule: 'avoidPattern', value: 'FLAG' }] }).reason, /RULE/);
  assert.equal(preTrade(plan(), ctx).ok, true);
  const e = economics(plan(), cfg);
  assert.ok(e.netRR < 4 && e.netRR > 3);
});

test('learns rule proposals only from losing buckets in both halves, or from three matching reviews', () => {
  const trades = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, r: -0.8, exitAt: i, plan: plan({ pattern: { type: 'HNS' } }) }));
  const props = learn(trades, {});
  assert.ok(props.some(p => p.rule === 'avoidPattern' && p.value === 'HNS'));
  assert.equal(learn(trades.slice(0, 5), {}).length, 0);
  const reviews = Object.fromEntries(trades.slice(0, 3).map(t => [t.id, { a: ['skip'], b: ['poi'] }]));
  assert.ok(learn(trades.slice(0, 3), reviews).some(p => p.rule === 'avoidPoi' && p.value === 'FVG'));
  assert.equal(learn(trades, {}, { 'avoidPattern:HNS': 'rejected' }).some(p => p.value === 'HNS'), false);
});

test('scanner is causal: a prefix of the bars yields exactly the prefix of the events', () => {
  let x = 100, seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const series = [];
  for (let i = 0; i < 4000; i++) {
    const drift = Math.sin(i / 300) * 0.04 + (i % 900 > 820 ? 0.25 : 0);
    const o = x; x = Math.max(5, x + drift + (rnd() - 0.5) * 0.3);
    series.push({ t: T0 + i * MIN, o, c: x, h: Math.max(o, x) + rnd() * 0.1, l: Math.min(o, x) - rnd() * 0.1, v: 10, q: 1000, tb: 500 });
  }
  const full = new Scanner('TEST', series);
  for (const cut of [1500, 2600, 3999]) {
    const part = new Scanner('TEST', series.slice(0, cut));
    const end = series[cut - 1].t;
    assert.deepEqual(part.events, full.events.filter(e => e.t <= end));
  }
});

const T1 = Date.UTC(2026, 0, 5);
test('PMR params: defaults are v1.4, loosened variants are causal too, and targetR sets a fixed-multiple target', () => {
  // A plain random walk; seed 32 happens to give one loosened PMR proposal.
  let x = 100, seed = 32;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const series = [];
  for (let i = 0; i < 12000; i++) {
    const o = x; x = Math.max(5, x + (rnd() - 0.5) * 0.6 + Math.sin(i / 500) * 0.03);
    series.push({ t: T1 + i * MIN, o, c: x, h: Math.max(o, x) + rnd() * 0.15, l: Math.min(o, x) - rnd() * 0.15, v: 10, q: 1000, tb: 500 });
  }
  assert.deepEqual(new Scanner('T', series, { params: {} }).events, new Scanner('T', series).events);
  const P = { poiWaitMin: 60, retestMin: 240, mssMin: 90, fvgMin: 30, entryWindowMin: 120, dispAtr: 0.8, poiDistAtr: 1.0, targetR: 2.5 };
  const full = new Scanner('T', series, { params: P });
  const part = new Scanner('T', series.slice(0, 7000), { params: P });
  assert.deepEqual(part.events, full.events.filter(e => e.t <= series[6999].t));
  for (const p of full.proposals) assert.ok(Math.abs(Math.abs(p.target - p.entry) - 2.5 * Math.abs(p.entry - p.stop)) <= 0.011, `${p.target} ${p.entry} ${p.stop}`);
  assert.ok(full.proposals.length > 0, 'the synthetic series should produce at least one loosened proposal');
});

test('universe keeps stock perps above the volume floor plus held symbols', () => {
  const sym = (symbol, tags) => ({ symbol, status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', underlyingSubType: tags, baseAsset: symbol,
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] });
  const info = { symbols: [sym('NVDAUSDT', ['STOCK']), sym('XAUUSDT', ['Commodities']), sym('OPENAIUSDT', ['pre-launch', 'STOCK']), sym('AAPLUSDT', ['STOCK'])] };
  const tick = (symbol, q) => ({ symbol, quoteVolume: String(q), lastPrice: '1', priceChangePercent: '0' });
  const u = pickUniverse(info, [tick('NVDAUSDT', 9e6), tick('XAUUSDT', 9e7), tick('OPENAIUSDT', 9e6), tick('AAPLUSDT', 1000)],
    { universe: 10, minVolume: 300_000, always: [], exclude: [] }, ['AAPLUSDT']);
  assert.deepEqual(u.watch, ['NVDAUSDT', 'AAPLUSDT']);
});

test('github store writes a parentless commit and refuses when the ref moved', async () => {
  const refs = { 'stocks-state': 'c0' };
  const blobs = {}, trees = {}, commits = { c0: { tree: { sha: 'tr0' } } };
  trees.tr0 = { tree: [{ path: 'stock-desk-state.json', sha: 'b0' }] };
  blobs.b0 = { content: Buffer.from('{"v":1,"n":1}').toString('base64') };
  let n = 0;
  const fetchImpl = async (url, { method, body }) => {
    const u = new URL(url).pathname.replace('/repos/o/r', '');
    const data = body && JSON.parse(body);
    const ok = x => ({ ok: true, status: 200, json: async () => x });
    if (method === 'GET' && u.startsWith('/git/ref/heads/')) return refs[u.split('/').pop()] ? ok({ object: { sha: refs[u.split('/').pop()] } }) : { ok: false, status: 404 };
    if (method === 'GET' && u.startsWith('/git/commits/')) return ok(commits[u.split('/').pop()]);
    if (method === 'GET' && u.startsWith('/git/trees/')) return ok(trees[u.split('/').pop()]);
    if (method === 'GET' && u.startsWith('/git/blobs/')) return ok(blobs[u.split('/').pop()]);
    if (method === 'POST' && u === '/git/blobs') { blobs[`b${++n}`] = { content: Buffer.from(data.content).toString('base64') }; return ok({ sha: `b${n}` }); }
    if (method === 'POST' && u === '/git/trees') { trees[`tr${++n}`] = { tree: data.tree }; return ok({ sha: `tr${n}` }); }
    if (method === 'POST' && u === '/git/commits') { assert.deepEqual(data.parents, []); commits[`c${++n}`] = { tree: { sha: data.tree } }; return ok({ sha: `c${n}` }); }
    if (method === 'PATCH') { refs[u.split('/').pop()] = data.sha; return ok({}); }
    throw new Error(`unexpected ${method} ${u}`);
  };
  const st = store({ token: 'x', repo: 'o/r', fetchImpl });
  const { state } = await update(st, s => ({ ...s, n: s.n + 1 }));
  assert.equal(state.n, 2);
  assert.equal((await st.read()).state.n, 2);
  const { ref } = await st.read();
  refs['stocks-state'] = 'moved';
  await assert.rejects(st.write({}, ref), Conflict);
});

test('persistable state drops chart payloads', () => {
  const s = run(freshState(), bars([[100.4, 100.6, 100.5]]), T0 + MIN + 1);
  s.scan = [{ symbol: 'X', h1: [1], m15: [1], m5: [1] }];
  assert.deepEqual(persistable(s).scan, [{ symbol: 'X' }]);
});

test('an open position ignores bars from before its entry', () => {
  const s = freshState();
  const p = plan();
  s.positions = [{ ...p, plan: p, qty: 10, riskUSDT: 10, netRR: 3, entryAt: T0, mark: 100 }];
  const old = [{ t: T0 - 5 * MIN, o: 90, h: 91, l: 80, c: 85, v: 1 }, ...bars([[100.1, 100.4, 100.2]])];
  const out = run(s, old, T0 + MIN + 1, null);
  assert.equal(out.trades.length, 0);
  assert.equal(out.positions[0].checkedTo, T0 + MIN);
});

test('picks: held, then pins, then furthest PMR stage, then 24h volume; skips are left out', () => {
  const scan = [['AAA', 'WAIT'], ['BBB', 'WAIT_RETEST'], ['CCC', 'QUALIFIED'], ['DDD', 'WAIT'], ['EEE', 'WAIT'], ['FFF', 'POI_TOUCHED']]
    .map(([symbol, status]) => ({ symbol, status }));
  const board = ['DDD', 'AAA', 'EEE', 'BBB', 'CCC', 'FFF'].map(symbol => ({ symbol }));
  const picks = choosePicks(scan, { board, n: 3 });
  assert.deepEqual(picks.map(p => p.symbol), ['CCC', 'FFF', 'BBB']);
  assert.deepEqual(choosePicks(scan, { board, n: 3, pins: ['EEE'], skips: ['CCC'] }).map(p => [p.symbol, p.why]),
    [['EEE', 'pinned'], ['FFF', 'setup'], ['BBB', 'setup']]);
  // Held and pinned symbols stay even past n; a held symbol stays even when skipped.
  assert.deepEqual(choosePicks(scan, { board, n: 1, pins: ['DDD'], held: ['AAA'], skips: ['AAA'] }).map(p => p.symbol), ['AAA', 'DDD']);
  // SMC zones rank after pins and before PMR setups
  assert.deepEqual(choosePicks(scan, { board, n: 3, pins: ['EEE'], smc: ['AAA'] }).map(p => [p.symbol, p.why]), [['EEE', 'pinned'], ['AAA', 'smc'], ['CCC', 'setup']]);
});

test('the Trader only takes proposals on picks unless picksOnly is off', () => {
  const series = bars([[100.4, 100.6, 100.5], [100.3, 100.6, 100.5]]);
  const skipped = { ...freshState(), skips: ['NVDAUSDT'] };
  const s = run(skipped, series, T0 + 2 * MIN + 1);
  assert.equal(s.decisions[0].status, 'Declined');
  assert.equal(s.decisions[0].reason, 'NOT_IN_PICKS');
  assert.equal(s.orders.length, 0);
  assert.deepEqual(s.picks, []);
  const open = run({ ...skipped, cfg: { ...freshState().cfg, picksOnly: false } }, series, T0 + 2 * MIN + 1);
  assert.equal(open.decisions[0].status, 'Approved');
  const picked = run(freshState(), series, T0 + 2 * MIN + 1);
  assert.deepEqual(picked.picks.map(p => [p.symbol, p.why]), [['NVDAUSDT', 'setup']]);
  assert.equal(picked.decisions[0].status, 'Approved');
});

test("Fred's marks, pins and skips survive a cycle and the save, and bad values normalize", () => {
  const marks = { NVDAUSDT: [{ id: 'm1', type: 'fvg', dir: 'bull', t1: T0, t2: T0 + 3 * MIN, p1: 100, p2: 101, tf: '15m' }] };
  const s = persistable(run({ ...freshState(), marks, pins: ['NVDAUSDT'] }, bars([[100.4, 100.6, 100.5]]), T0 + MIN + 1, null));
  assert.deepEqual(s.marks, marks);
  assert.deepEqual(s.pins, ['NVDAUSDT']);
  const n = normalize({ marks: [], pins: 'x', skips: null });
  assert.deepEqual([n.marks, n.pins, n.skips], [{}, [], []]);
});

test('chart klines use open time and flag the forming candle', async () => {
  const now = T0 + 30 * MIN;
  const rows = [[T0, '1', '2', '0.5', '1.5', '10', T0 + 15 * MIN - 1], [T0 + 15 * MIN, '1.5', '2', '1', '1.8', '4', T0 + 30 * MIN + 15 * MIN - 1]];
  let asked;
  const out = await chartBars('NVDAUSDT', '15m', { now, get: async (path, params) => { asked = params; return rows; } });
  assert.deepEqual(out.map(b => [b.t, b.c, b.closed]), [[T0, 1.5, true], [T0 + 15 * MIN, 1.8, false]]);
  assert.equal(asked.interval, '15m');
  await assert.rejects(chartBars('NVDAUSDT', '2h', { get: async () => rows }));
});

const mk = (o) => ({ id: o.id ?? Math.random().toString(36).slice(2), tf: '15m', ...o });

test("Fred's latest hand-drawn MSS against the proposal vetoes it; auto and later marks don't count", () => {
  const p = plan(); // long, entry 100, signal at T0
  const bear = mk({ type: 'mss', dir: 'bear', t1: T0 - 60 * MIN, p1: 101 });
  assert.match(markCheck(p, [bear]).veto, /bear MSS .* against this long/);
  // a newer bull MSS overrides the older bear one
  assert.equal(markCheck(p, [bear, mk({ type: 'mss', dir: 'bull', t1: T0 - 20 * MIN, p1: 99.5 })]).veto, null);
  // auto marks and marks placed after the signal bar are ignored
  assert.equal(markCheck(p, [{ ...bear, auto: true }]).veto, null);
  assert.equal(markCheck(p, [{ ...bear, t1: T0 + 5 * MIN }]).veto, null);
  assert.equal(latestMss([bear, { ...bear, id: 'x', dir: 'bull', t1: T0 - 30 * MIN }]).dir, 'bull');
});

test("an entry inside Fred's opposite-direction FVG / OB is vetoed; a same-direction zone on the POI is recorded as confluence", () => {
  const p = plan(); // POI 99.4–99.9, entry FVG 99.8–100.2, entry 100
  const against = mk({ type: 'ob', dir: 'bear', t1: T0 - 90 * MIN, t2: T0 - 75 * MIN, p1: 99.95, p2: 100.4 });
  assert.match(markCheck(p, [against]).veto, /inside your bear OB/);
  const same = mk({ id: 'z1', type: 'fvg', dir: 'bull', t1: T0 - 90 * MIN, t2: T0 - 60 * MIN, p1: 99.2, p2: 99.5 });
  const r = markCheck(p, [same]);
  assert.equal(r.veto, null);
  assert.deepEqual(r.summary.with, ['z1']);
  assert.equal(features({ ...p, marks: r.summary }).marks, 'confluence');
  assert.equal(features(p).marks, 'none');
  // a same-direction zone away from the POI and entry FVG is not confluence
  assert.equal(markCheck(p, [{ ...same, p1: 101, p2: 102 }]).summary.confluence, false);
});

test('cycle declines a proposal against Fred\'s marks and records his marks on the plan', () => {
  const series = bars([[100.4, 100.6, 100.5], [100.3, 100.6, 100.5]]);
  const marks = { NVDAUSDT: [mk({ type: 'mss', dir: 'bear', t1: T0 - 30 * MIN, p1: 100.8 })] };
  const s = run({ ...freshState(), marks }, series, T0 + 2 * MIN + 1);
  assert.equal(s.decisions[0].status, 'Declined');
  assert.match(s.decisions[0].reason, /^MARK · your bear MSS/);
  assert.equal(s.orders.length, 0);
  const ok = run({ ...freshState(), marks: { NVDAUSDT: [mk({ type: 'fvg', dir: 'bull', t1: T0 - 60 * MIN, p1: 99.3, p2: 99.6 })] } }, series, T0 + 2 * MIN + 1);
  assert.equal(ok.decisions[0].status, 'Approved');
  assert.equal(ok.orders[0].plan.marks.confluence, true);
});

test('Reviewer proposes "confluence only" when trades without Fred\'s zone lose in both halves', () => {
  const trades = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, r: -0.8, exitAt: T0 + i * 60 * MIN,
    plan: plan({ pattern: { type: ['FLAG', 'TRIANGLE', 'HNS', 'DOUBLE_TOP', 'INVERSE_HNS'][i % 5] }, direction: i % 2 ? 1 : -1,
      poi: { type: i % 2 ? 'OB' : 'FVG' }, grade: 'A+', signalAt: Date.parse('2026-11-23T16:00:00Z') }) }));
  assert.ok(learn(trades, {}).some(p => p.rule === 'marksConfluenceOnly'));
});

test('postmortem replay gives the same fill, exit and R as the desk for an approved plan', () => {
  const up = bars([[100.4, 100.6, 100.5], [100.3, 100.6, 100.5], [99.9, 100.5, 100.2], [100.2, 104.2, 104]]);
  const s = run(run(freshState(), up.slice(0, 13), T0 + 2 * MIN + 1), up, T0 + 4 * MIN + 1);
  const t = s.trades[0];
  const sim = simulatePlan(t.plan, up, s.cfg, { activeAfter: T0 + 2 * MIN });
  assert.equal(sim.reason, t.reason);
  assert.equal(sim.entryAt, t.entryAt);
  assert.ok(Math.abs(sim.r - t.r) < 0.01, `sim ${sim.r} vs desk ${t.r}`);
  assert.ok(t.mfe > 3 && t.mae <= 0, `mae ${t.mae} mfe ${t.mfe}`);
  assert.equal(classifyTrade(t), 'TRUE_POSITIVE');
});

test('a declined proposal gets a counterfactual once its window is over, grouped by the filter that declined it', () => {
  const marks = { NVDAUSDT: [{ id: 'm', type: 'mss', dir: 'bear', t1: T0 - 30 * MIN, p1: 100.8, tf: '15m' }] };
  const path = [[100.4, 100.6, 100.5], [100.3, 100.6, 100.5], [99.9, 100.5, 100.2], [100.2, 104.2, 104]];
  const s1 = run({ ...freshState(), marks }, bars(path).slice(0, 13), T0 + 2 * MIN + 1);
  assert.equal(s1.decisions[0].status, 'Declined');
  assert.equal(s1.decisions[0].post, undefined); // window still open
  const s2 = run(s1, bars(path), T0 + 4 * MIN + 1);
  const post = s2.decisions[0].post;
  assert.equal(post.outcome, 'MISSED_OPPORTUNITY');
  assert.equal(post.filter, 'Your MSS mark');
  assert.ok(post.r > 3);
  const rep = filterReport(s2.decisions);
  assert.equal(rep[0].filter, 'Your MSS mark');
  assert.equal(rep[0].missed, 1);
  assert.match(rep[0].verdict, /樣本太細/);
});

const tr = (i, pnl, r, o = {}) => ({ id: `t${i}`, symbol: 'NVDAUSDT', direction: 1, pnl, r, reason: r > 0 ? 'Target' : 'Stop',
  entryAt: Date.parse('2026-11-17T15:00:00Z') + i * 864e5, exitAt: Date.parse('2026-11-17T15:40:00Z') + i * 864e5,
  plan: plan({ signalAt: Date.parse('2026-11-17T14:58:00Z') + i * 864e5 }), ...o });

test('weekly digest: win rate, expectancy, profit factor, R stats and buckets as in the skill', () => {
  const ts = [tr(0, 30, 3), tr(1, -10, -1), tr(2, -10, -1, { reason: 'Time exit', mae: 0.2, mfe: 0.6 }), tr(7, 20, 2)];
  assert.equal(weekOf(ts[0].exitAt), '2026-11-16');
  assert.equal(weekOf(ts[3].exitAt), '2026-11-23');
  const d = digest(ts, { week: '2026-11-16' });
  assert.equal(d.trades, 3);
  assert.ok(Math.abs(d.winRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(d.expectancy - 10 / 3) < 1e-9);
  assert.equal(d.profitFactor, 1.5);
  assert.equal(d.avgMaeR, 0); // MAE clamped to <= 0 on read
  assert.equal(d.by.exit['Time exit'].losses, 1);
  assert.equal(digest(ts).trades, 4);
  assert.equal(digest([tr(0, 5, 0.5)]).profitFactor, null);
});

test('coach: findings cite evidence, verdict ladder, no breach claimed where no limit exists', () => {
  const ts = [tr(0, -16, -1.6), tr(1, -10, -1, { plan: plan({ signalAt: Date.parse('2026-11-18T14:30:00Z') }), entryAt: Date.parse('2026-11-18T15:00:00Z') }),
    tr(2, -10, -1, { plan: { ...plan(), market: { rec: 'REDUCE_ONLY' } } })];
  const c = coach(ts, { reviews: {}, start: 1000 });
  assert.equal(c.verdict, 'REVIEW_REQUIRED');
  assert.ok(c.findings.some(f => f.severity === 'critical' && /1.60R/.test(f.text)));
  assert.ok(c.findings.some(f => f.axis === 'execution' && /30 min/.test(f.text)));
  assert.ok(c.findings.some(f => f.axis === 'regime' && /唔算犯規/.test(f.text)));
  assert.ok(c.findings.some(f => /連蝕 3 單.*未清楚/.test(f.text)));
  assert.deepEqual(c.rootCauses, { risk_sizing: 1, execution: 1, market_environment: 1 });
  assert.equal(coach([tr(0, 20, 2)], { reviews: { t0: { agree: true } } }).verdict, 'OK');
});

test('PMR presets: fresh accounts and accounts saved before presets run loose-2.5R; v1.4 stays selectable', () => {
  assert.equal(freshState().cfg.pmrPreset, 'loose-2.5R');
  assert.deepEqual(freshState().cfg.pmr, PMR_PRESETS['loose-2.5R'].pmr);
  assert.equal(freshState().cfg.minNetRR, 1.5);
  const old = normalize({ cfg: { ...DEFAULT_CFG, pmrPreset: undefined, pmr: {}, minNetRR: 2, riskPct: 0.5 } });
  assert.equal(old.cfg.pmrPreset, 'loose-2.5R');
  assert.equal(old.cfg.pmr.targetR, 2.5);
  assert.equal(old.cfg.minNetRR, 1.5);
  assert.equal(old.cfg.riskPct, 0.5);
  const back = normalize({ cfg: applyPmrPreset({ ...old.cfg }, 'v1.4') });
  assert.equal(back.cfg.pmrPreset, 'v1.4');
  assert.deepEqual(back.cfg.pmr, {});
  assert.equal(back.cfg.minNetRR, 2);
  assert.equal(applyPmrPreset({ pmrPreset: 'v1.4' }, 'nope').pmrPreset, 'v1.4');
});
