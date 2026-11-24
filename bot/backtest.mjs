// Backtest of both paper traders on the top stock perps by 24h volume. REPORT ONLY: never touches the live accounts or rules.
//  · PMR Trader: GMS PMR v1.4 Scanner over completed 1m bars (the same code the desk runs); each proposal is gated and sized
//    by the Reviewer's preTrade and filled with simulatePlan (the desk's fill rules: limit live after the signal bar, stop beats
//    target, no target on the entry bar, 90 min time exit). One $1,000 account, max open / leverage as in the live cfg.
//  · SMC Trader: Fred's crypto-desk SMC code (vendor/smc-core.js) with the live small-cap settings, stepping at every 5m close
//    on 15m / 1h views built from the same 1m bars (core/smc.mjs, as aster-desk's own backtester). One $1,000 account.
// Not modelled: picks (every symbol counts as a pick), Fred's chart marks (none drawn in the past), spread (no book history),
// funding, and symbols delisted since (the list is today's top by volume).
// Env: BT_DAYS (default 180), BT_TOP (default 10), BT_OUT (default report/stock-backtest.json), BT_SYMBOLS (comma list, optional).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStock, klineBar, specOf } from '../core/aster.mjs';
import { DEFAULT_CFG } from '../core/desk.mjs';
import { MIN, Scanner } from '../core/pmr.mjs';
import { simulatePlan } from '../core/postmortem.mjs';
import { preTrade } from '../core/reviewer.mjs';
import { framesFrom1m, M5, makeCore, runStep, smcSource, smcTrade, SMC_ADJ, SMC_CFG, SMC_SOURCE } from '../core/smc.mjs';

const API = 'https://fapi.asterdex.com', DAY = 864e5, WARM = 5 * DAY;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let slot = 0;
async function aster(p) {
  for (let a = 0; ; a++) {
    const w = slot - Date.now(); slot = Math.max(Date.now(), slot) + 120; if (w > 0) await sleep(w);
    let r; try { r = await fetch(API + p, { signal: AbortSignal.timeout(30_000) }); } catch { r = { ok: false, status: 0 }; }
    if (r.ok) return r.json();
    if (a >= 5 || !(r.status === 0 || r.status === 429 || r.status >= 500)) throw new Error(`Aster ${r.status} ${p.split('?')[0]}`);
    await sleep(2000 * 2 ** a);
  }
}
// completed 1m bars (desk shape, t = close time) with close time in (from, to]
export async function bars1m(symbol, from, to, get = aster) {
  const out = [];
  for (let t = from - MIN; t < to;) {
    const rows = await get(`/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${t}&limit=1500`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const k of rows) { const b = klineBar(k); if (b && b.t > from && b.t <= to) out.push(b); }
    const next = +rows.at(-1)[0] + MIN;
    if (rows.length < 1500 || next <= t) break;
    t = next;
  }
  return out;
}

// ---------- statistics ----------
const r3 = v => Math.round(v * 1000) / 1000;
export function stats(rows) {
  const R = rows.map(x => x.R), n = R.length, pos = R.filter(v => v > 0), neg = R.filter(v => v < 0);
  let cum = 0, peak = 0, dd = 0;
  for (const v of R) { cum += v; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const sum = R.reduce((a, b) => a + b, 0);
  return { n, win: n ? Math.round(pos.length / n * 100) : null, avgR: n ? r3(sum / n) : null, totR: r3(sum), maxDD: r3(dd),
    pf: neg.length ? r3(pos.reduce((a, b) => a + b, 0) / -neg.reduce((a, b) => a + b, 0)) : null, pnl: r3(rows.reduce((a, x) => a + (x.pnl ?? 0), 0)) };
}
const group = (rows, key) => { const g = {}; for (const x of rows) (g[key(x)] ??= []).push(x); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, stats(v)])); };
export function report(rows, split) {
  rows = [...rows].sort((a, b) => a.t0 - b.t0);
  return { all: stats(rows), halves: [stats(rows.filter(x => x.t0 < split)), stats(rows.filter(x => x.t0 >= split))],
    bySymbol: group(rows, x => x.s), bySide: group(rows, x => x.side), months: group(rows, x => new Date(x.t0).toISOString().slice(0, 7)),
    exits: group(rows, x => String(x.why).replace(/\(.*?\)|[\d.]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)),
    trades: rows.slice(-300) };
}

// ---------- PMR ----------
export function pmrRun(data, { cfg = DEFAULT_CFG, from, specs }) {
  const plans = [];
  for (const [s, bars] of Object.entries(data)) {
    const sc = new Scanner(s, bars, { tickSize: specs[s]?.tickSize });
    for (const p of sc.proposals) if (p.signalAt > from) plans.push(p);
  }
  plans.sort((a, b) => a.signalAt - b.signalAt);
  let equity = 1000, open = [];
  const rows = [], declined = {}, settle = t => { for (const o of open.filter(o => o.until <= t)) equity += o.pnl; open = open.filter(o => o.until > t); };
  for (const p of plans) {
    settle(p.signalAt);
    const d = preTrade(p, { cfg, equity, openNotional: open.reduce((a, o) => a + o.notional, 0), openCount: open.length,
      holding: open.some(o => o.symbol === p.symbol), spec: specs[p.symbol], book: null, funding: null, active: [] });
    if (!d.ok) { const k = String(d.reason).split(' ')[0]; declined[k] = (declined[k] ?? 0) + 1; continue; }
    const sim = simulatePlan(p, data[p.symbol], cfg, { activeAfter: Math.floor(p.signalAt / MIN) * MIN, endedAt: p.endedAt ?? Infinity });
    if (!sim.done) { open.push({ symbol: p.symbol, until: Infinity, pnl: 0, notional: d.size.notional }); continue; }
    if (!sim.filled) { open.push({ symbol: p.symbol, until: Math.min(p.expiresAt, p.endedAt ?? Infinity), pnl: 0, notional: d.size.notional }); declined[sim.reason] = (declined[sim.reason] ?? 0) + 1; continue; }
    const pnl = sim.r * d.size.riskUSDT;
    open.push({ symbol: p.symbol, until: sim.exitAt, pnl, notional: d.size.notional });
    rows.push({ s: p.symbol, side: p.direction === 1 ? 'L' : 'S', t0: sim.entryAt, t1: sim.exitAt, R: r3(sim.r), pnl: r3(pnl), why: sim.reason,
      entry: sim.entry, exit: sim.exit, stop: p.stop, target: p.target, pattern: p.pattern?.type, poi: p.poi?.type, grade: p.grade, maxR: r3(sim.mfe) });
  }
  settle(Infinity);
  return { rows, proposals: plans.length, declined, open: open.filter(o => o.until === Infinity).length, equity: r3(equity) };
}

// ---------- SMC ----------
export async function smcRun(data, { from, to, exInfo, src }) {
  const { h } = await makeCore(src ?? await smcSource(), exInfo);
  h.prep(SMC_CFG, SMC_ADJ, null);
  const D = Object.fromEntries(Object.entries(data).map(([s, b]) => [s, framesFrom1m(b)])), coins = Object.keys(D), rows = [], skips = {};
  for (let T = Math.floor(from / M5) * M5 + M5; T <= to; T += M5) {
    const r = runStep(h, D, T, { coins });
    for (const x of r.closed) { const t = smcTrade(x); rows.push({ s: t.symbol, side: x.side, t0: x.t0, t1: x.t1, R: r3(x.R), pnl: r3(x.pnl), why: x.exitWhy,
      entry: x.entry, exit: x.exit, stop: x.stop0, target: x.target, tf: x.tf, zone: x.zoneKind, type: x.type ?? 'rev', q: x.q?.score ?? null, maxR: r3(x.maxR ?? 0) }); }
    for (const c of r.scan?.cands ?? []) if (!c.took && c.skip) { const k = c.skip.replace(/[\d.]+/g, '#').split(':')[0].slice(0, 60); skips[k] = (skips[k] ?? 0) + 1; }
  }
  return { rows, open: h.positions().length, equity: r3(h.equity()), skips: Object.fromEntries(Object.entries(skips).sort((a, b) => b[1] - a[1]).slice(0, 12)) };
}

export async function run({ days = 180, top = 10, symbols, now = Date.now() } = {}) {
  const T0 = Date.now(), END = Math.floor(now / M5) * M5, W0 = END - days * DAY, split = W0 + (END - W0) / 2;
  const [exInfo, tickers] = await Promise.all([aster('/fapi/v1/exchangeInfo'), aster('/fapi/v1/ticker/24hr')]);
  const stocks = new Map(exInfo.symbols.filter(isStock).map(s => [s.symbol, s]));
  const list = symbols?.length ? symbols : tickers.filter(t => stocks.has(t.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, top).map(t => t.symbol);
  const specs = Object.fromEntries(list.map(s => [s, specOf(stocks.get(s))]));
  const data = {}, coverage = {};
  for (const s of list) {
    const b = await bars1m(s, W0 - WARM, END);
    if (b.length < 1000) { log(`skip ${s}: ${b.length} bars`); continue; }
    data[s] = b; coverage[s] = { first: b[0].t, bars: b.length };
    log(`${s}: ${b.length} 1m bars from ${new Date(b[0].t).toISOString().slice(0, 10)}`);
  }
  const pmr = pmrRun(data, { from: W0, specs });
  log(`PMR: ${pmr.proposals} proposals, ${pmr.rows.length} trades (${((Date.now() - T0) / 1e3).toFixed(0)} s)`);
  const smc = await smcRun(data, { from: W0, to: END, exInfo });
  log(`SMC: ${smc.rows.length} trades (${((Date.now() - T0) / 1e3).toFixed(0)} s)`);
  return { v: 1, t: Date.now(), from: W0, to: END, days, split, symbols: Object.keys(data), coverage, runS: Math.round((Date.now() - T0) / 1e3),
    pmr: { ...report(pmr.rows, split), proposals: pmr.proposals, declined: pmr.declined, open: pmr.open, equity: pmr.equity, cfg: { riskPct: DEFAULT_CFG.riskPct, maxOpen: DEFAULT_CFG.maxOpen, minNetRR: DEFAULT_CFG.minNetRR, timeExitMin: DEFAULT_CFG.timeExitMin } },
    smc: { ...report(smc.rows, split), open: smc.open, equity: smc.equity, skips: smc.skips, source: SMC_SOURCE, adj: SMC_ADJ },
    notes: ['Report only: never changes live rules or accounts.', 'Every symbol counts as a pick; Fred\'s marks, spread and funding are not modelled.',
      'Symbols are today\'s top stock perps by 24h volume, so delisted ones are missing. Symbols listed less than the window only count from their first bar.',
      'R: PMR = net P&L / planned risk (fees and slippage in the risk); SMC = realized P&L / risk at entry, as on the crypto desk.'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.env.BT_OUT || 'report/stock-backtest.json';
  try {
    const r = await run({ days: +process.env.BT_DAYS || 180, top: +process.env.BT_TOP || 10, symbols: process.env.BT_SYMBOLS?.split(',').filter(Boolean) });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(r));
    const f = s => s.n ? `n ${s.n} win ${s.win}% avg ${s.avgR >= 0 ? '+' : ''}${s.avgR}R tot ${s.totR}R maxDD ${s.maxDD}R` : 'n 0';
    console.log([`Stock backtest ${r.days}d · ${r.symbols.length} symbols · ${r.runS} s`,
      `PMR: ${f(r.pmr.all)} · halves ${f(r.pmr.halves[0])} | ${f(r.pmr.halves[1])} · proposals ${r.pmr.proposals} · declined ${JSON.stringify(r.pmr.declined)}`,
      `SMC: ${f(r.smc.all)} · halves ${f(r.smc.halves[0])} | ${f(r.smc.halves[1])} · open at end ${r.smc.open}`].join('\n'));
    log(`saved ${out} (${fs.statSync(out).size} bytes)`);
  } catch (e) { console.error('BACKTEST FAILED:', e.stack || e.message); process.exit(1); }
}
