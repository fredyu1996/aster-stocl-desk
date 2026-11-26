// SMC Trader: Fred's crypto-desk SMC strategy (small-cap settings) trading the stock picks as a second paper account.
// vendor/smc-core.js is fredyu1996/aster-desk's generated bot/core.js, unchanged. This file only feeds it candles and reads
// its account, the way aster-desk's bot/backtest.mjs simulate() does: 5m steps; at step T the strategy sees 15m and 1h bars
// closed by T plus a forming bar built from the 5m bars closed by T; open positions are walked through each closed 5m candle
// (open, adverse extreme, favourable extreme, close), filling at the exact level crossed. Entries fill at the 5m close + slippage.
import { MIN } from './pmr.mjs';
import { markCheck } from './reviewer.mjs';
import { SMC_ADJ, SMC_CFG, SMC_SOURCE } from './smc-config.mjs';

export const M5 = 300e3, M15 = 900e3, H = 3600e3;
export { SMC_ADJ, SMC_CFG, SMC_SOURCE };

const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
export async function smcSource() {
  if (isNode) { const fs = await import('node:fs'); return fs.readFileSync(new URL('../vendor/smc-core.js', import.meta.url), 'utf8'); }
  const r = await fetch(new URL('../vendor/smc-core.js', import.meta.url));
  if (!r.ok) throw new Error(`vendor/smc-core.js: HTTP ${r.status}`);
  return r.text();
}

// The desk's code in its own function scope. Browser globals it touches are replaced by inert stand-ins, and it has no network.
export async function makeCore(src, exInfo) {
  const el = { addEventListener() {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, textContent: '', innerHTML: '', appendChild() {} };
  const shims = {
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => el, createElement: () => el, body: el },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, sayFor() {}, renderPanel() {}, syViewer: () => false, setInterval: () => 0,
    navigator: { userAgent: 'aster-stock-desk' }, WebSocket: class { close() {} },
    fetch: async () => { throw new Error('no network inside the SMC sandbox'); }, __EXINFO: exInfo,
  };
  const names = Object.keys(shims);
  // eslint-disable-next-line no-new-func
  const X = new Function(...names, `${src}\n;return __c => eval(__c);`)(...names.map(n => shims[n]));
  await X(`api = async p => /exchangeInfo/.test(p) ? __EXINFO : []; loadExInfo();`);
  const h = X(`(() => {
    const H = { veto: null };
    const enter = smTryEnter;
    smTryEnter = c => { const v = H.veto ? H.veto(c) : null; if (v) { c.skip = v; c.vetoed = true; return false; } return enter(c); };
    H.prep = (cfg, adj, acct) => {
      const C = Object.assign({}, SM_DEF.cfg, cfg);
      RV.smAdj = JSON.parse(JSON.stringify(adj || {})); delete RV.smAdj.zone; C.zoneLearn = 0;
      Object.assign(SM, {on: true, pos: {}, log: [], cool: {}, cash: SM_DEF.start, start: SM_DEF.start, day: null, paused: null, eqs: [], lastScan: null},
        acct ? JSON.parse(JSON.stringify(acct)) : {}, {cfg: C});
      warm = true; S.started = 0;
    };
    // one open position through one closed candle, adverse extreme first, filling at the exact level crossed (aster-desk bot/backtest.mjs __walk)
    H.walk = (s, o, h, l, c, tEnd) => { const p = SM.pos[s]; if (!p) return; CLOCK_OVR = tEnd; const L = p.side === 'L'; let prev = o;
      for (const v of L ? [o, l, h, c] : [o, h, l, c]) { const q = SM.pos[s]; if (!q) break; const d = Math.abs(q.entry - q.stop0), dir = L ? 1 : -1;
        const lv = [q.stop, q.tp1 ? null : q.entry + dir * (q.tp1R || SM.cfg.tp1R) * d, q.target].filter(z => z != null && isFinite(z));
        const pts = lv.filter(z => (z - prev) * (z - v) <= 0 && z !== prev).sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev));
        for (const z of [...pts, v]) { if (!SM.pos[s]) break; PX_OVR = {[s]: z}; smManage(CLOCK_OVR, s); } prev = v; }
      PX_OVR = null; CLOCK_OVR = 0; };
    H.step = (T, F, trk, fund) => {
      CLOCK_OVR = T; S.trk = trk; S.kl.clear(); S.h1.clear(); S.tk.clear(); S.M.clear(); S.smC.clear(); if (S.smCB) S.smCB.clear(); S.alerts.length = 0; S.fund.clear();
      for (const [s, f] of Object.entries(F)) { S.kl.set(s, {t: T, bars: f.k}); S.h1.set(s, {t: T, bars: f.h}); S.tk.set(s, f.tk); }
      for (const [s, f] of Object.entries(fund || {})) S.fund.set(s, f);
      smTick();
      const out = {closed: SM.log.splice(0), scan: SM.lastScan};
      CLOCK_OVR = 0; return out; };
    H.positions = () => Object.keys(SM.pos);
    H.account = () => JSON.parse(JSON.stringify({on: SM.on, start: SM.start, cash: SM.cash, pos: SM.pos, cool: SM.cool, day: SM.day, paused: SM.paused, eqs: SM.eqs.slice(-600), created: SM.created}));
    H.equity = () => smEquity();
    H.rules = () => JSON.parse(JSON.stringify(smRules()));
    return H; })()`);
  return { X, h };
}

let corePromise = null;
export function smcCore(exInfo) { return (corePromise ??= smcSource().then(src => makeCore(src, exInfo))).catch(e => { corePromise = null; throw e; }); }

// ---------- candles ----------
// 1m desk bars ({t: close time, o, h, l, c, q: quote volume, tb: taker-buy quote volume}) → aster-desk kline rows
// [openTime, open, high, low, close, quoteVol, takerBuyQuoteVol] for one interval. A bucket is kept even if partial;
// readers only count a bar once its whole period has closed.
export function rowsFrom1m(one, len) {
  const out = [];
  let cur = null;
  for (const b of one) {
    const open = b.t - MIN, k = Math.floor(open / len) * len;
    if (!cur || cur[0] !== k) { cur = [k, b.o, b.h, b.l, b.c, b.q || 0, b.tb || 0]; out.push(cur); }
    else { if (b.h > cur[2]) cur[2] = b.h; if (b.l < cur[3]) cur[3] = b.l; cur[4] = b.c; cur[5] += b.q || 0; cur[6] += b.tb || 0; }
  }
  return out;
}
export const framesFrom1m = one => ({ m5: rowsFrom1m(one, M5), m15: rowsFrom1m(one, M15), h1: rowsFrom1m(one, H) });
// count of bars (sorted by open time) closed by T
export function nClosed(B, len, T) { let lo = 0, hi = B.length; while (lo < hi) { const m = (lo + hi) >> 1; if (B[m][0] + len <= T) lo = m + 1; else hi = m; } return lo; }
const agg = (B, t) => [t, B[0][1], Math.max(...B.map(b => b[2])), Math.min(...B.map(b => b[3])), B.at(-1)[4], B.reduce((a, b) => a + b[5], 0), B.reduce((a, b) => a + b[6], 0)];
export const H1_BARS = 72; // the 1h bars aster-desk's engine keeps (limit=72)
// what the crypto desk would hold for a symbol at T (aster-desk bot/backtest.mjs viewAt)
export function viewAt(C, T) {
  const n5 = nClosed(C.m5, M5, T);
  if (!n5) return null;
  const form = len => { const p0 = Math.floor(T / len) * len, F = []; for (let i = n5 - 1; i >= 0 && C.m5[i][0] >= p0; i--) F.unshift(C.m5[i]); return F.length ? [agg(F, p0)] : []; };
  const n15 = nClosed(C.m15, M15, T), n1 = nClosed(C.h1, H, T);
  return { last: C.m5[n5 - 1][4], k: C.m15.slice(Math.max(0, n15 - 95), n15).concat(form(M15)), h: C.h1.slice(Math.max(0, n1 - (H1_BARS - 1)), n1).concat(form(H)) };
}
// 24h ticker at T from closed 1h bars plus the 5m close (aster-desk tkAt, kept current to the step)
export function tickerAt(C, T, last) {
  const n = nClosed(C.h1, H, T), W = C.h1.slice(Math.max(0, n - 24), n);
  if (W.length < 20) return null;
  return { last, pct: (last / W[0][1] - 1) * 100, qv: W.reduce((a, b) => a + b[5], 0) };
}
// The symbols the SMC Trader may enter, as aster-desk tracker entries (side G / L by the 24h move).
export function trackerFor(symbols, F, T) {
  const trk = {};
  symbols.forEach((s, i) => { const f = F[s]; if (f) trk[s] = { side: f.tk.pct >= 0 ? 'G' : 'L', t0: T, px0: f.tk.last, pct0: f.tk.pct, lastTop: T, rank: i + 1 }; });
  return trk;
}

// One step: walk held positions through the 5m candle that just closed, then tick the strategy at T.
export function runStep(h, D, T, { coins, fund, tick = true }) {
  for (const s of h.positions()) {
    const C = D[s], i = C ? nClosed(C.m5, M5, T) - 1 : -1;
    if (i >= 0 && C.m5[i][0] === T - M5) { const b = C.m5[i]; h.walk(s, b[1], b[2], b[3], b[4], T - 1); }
  }
  if (!tick) return { closed: [], scan: null };
  const F = {};
  for (const s of new Set([...coins, ...h.positions()])) {
    const C = D[s], v = C && viewAt(C, T), tk = v && tickerAt(C, T, v.last);
    if (v && tk) F[s] = { k: v.k, h: v.h, tk };
  }
  return h.step(T, F, trackerFor(coins.filter(s => F[s]), F, T), fund);
}

// A closed SMC trade in the desk's trade shape (digest, review wall). R is aster-desk's: realized P&L / risk at entry.
export function smcTrade(x) {
  return { id: `smc|${x.s}|${x.t0}`, account: 'smc', symbol: x.s, direction: x.side === 'L' ? 1 : -1, entry: x.entry, exit: x.exit, entryAt: x.t0, exitAt: x.t1,
    qty: x.qty, pnl: x.pnl, fees: x.fees, funding: x.funding ?? 0, r: x.R, reason: x.exitWhy, why: x.why, stop: x.stop0, target: x.target, maxR: x.maxR,
    plan: { signalAt: x.t0, grade: x.grd?.g ?? x.q?.grade ?? null, pattern: { type: `${x.tf ?? '15m'} ${x.type === 'cont' ? 'continuation' : 'reversal'}` },
      poi: { type: x.zoneKind ?? '?', lo: x.zone?.lo, hi: x.zone?.hi }, marks: x.marks ?? null, market: x.market ?? null, tf: x.tf, quality: x.q?.score ?? null } };
}

// The SMC account rides on every desk cycle (browser or cloud, same lock). A failure is recorded and never blocks the PMR Trader.
export function withSmc(state, market, core, opts) {
  if (!core) return state;
  try { smcCycle(state, market, core, opts); if (state.smc) state.smc.error = null; }
  catch (e) { state.smc = { ...(state.smc ?? {}), error: String(e.message ?? e).slice(0, 300) }; }
  return state;
}

// Live: one desk cycle for the SMC account. Runs every 5m step since the last one (ticks at most the last 12, walks all),
// on every watched stock minus Fred's skips (cfg.smcScope 'picks': the picks only) plus held symbols. Fred's hand-drawn marks veto entries the same way as for PMR.
export function smcCycle(state, market, core, { now = market.t } = {}) {
  const smc = state.smc ?? (state.smc = { acct: null, lastStep: 0, trades: [], decisions: [], scan: null, on: true });
  const end = Math.floor(Math.floor(now / MIN) * MIN / M5) * M5;
  if (smc.lastStep >= end) return state;
  const held = Object.keys(smc.acct?.pos ?? {});
  // Fred (2026-11-25): the SMC Trader scans every watched stock (top by volume + pins + held), minus his skips.
  // cfg.smcScope 'picks' puts it back on the picks wall only.
  const coins = state.cfg.smcScope === 'picks' ? state.picks.map(p => p.symbol) : market.universe.watch.filter(s => !state.skips.includes(s));
  const D = {};
  const src = market.smcBars ?? market.bars;
  for (const s of new Set([...coins, ...held])) if (src[s]?.length) D[s] = framesFrom1m(src[s]);
  const { h } = core;
  h.prep(SMC_CFG, SMC_ADJ, smc.acct);
  const from = smc.lastStep ? smc.lastStep + M5 : end, tickFrom = Math.max(from, end - 11 * M5);
  const fund = Object.fromEntries(Object.entries(market.funding ?? {}).map(([s, f]) => [s, { r: f.rate, next: f.next }]));
  h.veto = c => {
    if (smc.on === false || !state.cfg.on) return 'TRADING_OFF';
    const T = smc.stepT, plan = { direction: c.side === 'L' ? 1 : -1, entry: c.tk.last, signalAt: T, poi: c.r.zone, fvg: null };
    const mk = markCheck(plan, state.marks[c.s]);
    c.marks = mk.summary;
    return mk.veto;
  };
  for (let T = Math.max(from, end - 288 * M5); T <= end; T += M5) {
    smc.stepT = T;
    const r = runStep(h, D, T, { coins, fund, tick: T >= tickFrom });
    for (const x of r.closed) smc.trades.unshift({ ...smcTrade(x), market: null });
    if (r.scan) {
      smc.scan = { t: T, cands: r.scan.cands };
      for (const c of r.scan.cands.filter(c => c.took || c.skip === 'TRADING_OFF' || /^MARK/.test(c.skip ?? '')))
        smc.decisions.unshift({ t: T, symbol: `${c.b}USDT`, side: c.side, status: c.took ? 'Entered' : 'Declined', reason: c.took ? `${c.tf} ${c.zone} q ${c.q ?? '?'}` : c.skip });
    }
  }
  delete smc.stepT;
  h.veto = null;
  smc.acct = h.account();
  smc.equity = h.equity();
  smc.lastStep = end;
  smc.trades = smc.trades.slice(0, 300);
  smc.decisions = smc.decisions.slice(0, 100);
  return state;
}
