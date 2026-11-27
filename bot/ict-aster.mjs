// ICT New York AM reversal (core/ict.mjs) on Aster stock perps. REPORT ONLY: never touches the live desk.
// Fred, 2026-11-28: "我想用呢份 code 入面既 strategy 去 back test 下".
// One run per symbol (one instrument and one bar source per study, as ICT-STUDY.md asks), then pooled stats.
//  · Bars: Aster 1m klines, mark price by default (ICT_SOURCE=trade for traded klines; those are mostly flat, see CLAUDE.md).
//  · Calendar: NYSE weekdays from the first bar, minus holidays; early closes = 'short'. 'news' = FOMC decision days only
//    (CPI and Employment Situation dates are not in this file, so 08:30 ET release days are NOT skipped).
//  · Instrument: Aster tick size, pointValue 1 (P&L per one share-equivalent), minRange = ICT_RANGE_PCT (default 0.05 %) of
//    the symbol's median price, the MNQ model's 10 points on ~20,000 scaled to a percentage.
//  · Costs: taker fee 0.04 % per side as feeRate (on entry + exit notional), stop and time exits slipped by ~0.05 % in ticks.
//    No funding (exits by noon). Aster perps trade around the clock, so there are no venue closures.
// Env: ICT_SYMBOLS (comma list), ICT_SOURCE (mark | trade), ICT_RANGE_PCT, ICT_FEE (0.0004), ICT_SLIP (0.0005), ICT_CACHE (dir),
//      ICT_OUT (JSON report path). Run: NODE_USE_ENV_PROXY=1 ICT_CACHE=/tmp/bars node bot/ict-aster.mjs
import fs from 'node:fs';
import path from 'node:path';
import { isStock, specOf } from '../core/aster.mjs';
import { backtestIct } from '../core/ict.mjs';
import { MIN } from '../core/pmr.mjs';
import { bars1m, report } from './backtest.mjs';

export const NYSE_HOLIDAYS = new Set(['2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16',
  '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
export const NYSE_EARLY = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24']);
export const FOMC = new Set(['2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10', '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09']);
// US-listed underlyings only: the model is built on the New York cash session.
export const ICT_DEFAULT = ['NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'AMZNUSDT', 'METAUSDT', 'MSFTUSDT', 'QQQUSDT', 'GOOGLUSDT', 'MUUSDT', 'SNDKUSDT',
  'MSTRUSDT', 'AMDUSDT', 'COINUSDT', 'PLTRUSDT', 'HOODUSDT', 'CRCLUSDT', 'INTCUSDT', 'AVGOUSDT', 'ORCLUSDT', 'TSMUSDT'];

export function calendar(from, to) {
  const out = [];
  for (let d = Math.floor(from / 864e5) * 864e5; d <= to; d += 864e5) {
    const date = new Date(d).toISOString().slice(0, 10), wd = new Date(d).getUTCDay();
    if (wd === 0 || wd === 6 || NYSE_HOLIDAYS.has(date)) continue;
    out.push({ date, kind: NYSE_EARLY.has(date) ? 'short' : 'regular', news: FOMC.has(date) });
  }
  return out;
}
const median = xs => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

export function runSymbol(symbol, bars, spec, { rangePct = 0.0005, fee = 0.0004, slip = 0.0005 } = {}) {
  const px = median(bars.slice(-20_000).map(b => b.c)), tick = spec?.tickSize || 0.01;
  const instrument = { symbol, tickSize: tick, pointValue: 1, minRange: px * rangePct };
  const slipTicks = Math.max(0, Math.round(px * slip / tick));
  const costs = { roundTrip: 0, feeRate: fee, stopSlippageTicks: slipTicks, timeSlippageTicks: slipTicks };
  const study = backtestIct({ bars, sessions: calendar(bars[0].t, bars.at(-1).t), instrument, costs });
  return { instrument, costs, study };
}

// cache: a { from, bars } file or a plain array (both shapes written by bot/backtest.mjs)
async function loadBars(symbol, from, to, source, dir) {
  const file = dir && path.join(dir, `${source}-${symbol}.json`);
  if (file && fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')), have = Array.isArray(c) ? c : c.bars ?? [];
    if (have.length && have.at(-1).t < to) have.push(...await bars1m(symbol, have.at(-1).t, to, undefined, source));
    if (have.length) return have;
  }
  const b = await bars1m(symbol, from, to, undefined, source);
  if (file) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ from, bars: b })); }
  return b;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const env = process.env, source = env.ICT_SOURCE === 'trade' ? 'trade' : 'mark';
  const list = env.ICT_SYMBOLS ? env.ICT_SYMBOLS.split(',').filter(Boolean) : ICT_DEFAULT;
  const opt = { rangePct: +env.ICT_RANGE_PCT || 0.0005, fee: env.ICT_FEE ? +env.ICT_FEE : 0.0004, slip: env.ICT_SLIP ? +env.ICT_SLIP : 0.0005 };
  const info = await (await fetch('https://fapi.asterdex.com/fapi/v1/exchangeInfo')).json();
  const specs = Object.fromEntries(info.symbols.filter(isStock).map(s => [s.symbol, specOf(s)]));
  const END = Math.floor(Date.now() / MIN) * MIN, FROM = Date.UTC(2025, 6, 1);
  const trades = [], perSymbol = {}, reasons = {};
  for (const s of list) {
    if (!specs[s]) { console.error(`skip ${s}: not a trading Aster stock perp`); continue; }
    const t0 = Date.now(), bars = await loadBars(s, FROM, END, source, env.ICT_CACHE);
    if (bars.length < 10_000) { console.error(`skip ${s}: ${bars.length} bars`); continue; }
    const { instrument, costs, study } = runSymbol(s, bars, specs[s], opt);
    const st = {}; for (const d of study.days) { const k = `${d.status}${d.reason ? ' ' + d.reason : ''}`; st[k] = (st[k] ?? 0) + 1; reasons[k] = (reasons[k] ?? 0) + 1; }
    perSymbol[s] = { days: study.days.length, trades: study.trades.length, totR: +study.trades.reduce((a, t) => a + t.R, 0).toFixed(2), first: new Date(bars[0].t).toISOString().slice(0, 10), instrument, costs, statuses: st };
    trades.push(...study.trades);
    console.error(`${s}: ${bars.length} bars · ${study.days.length} days · ${study.trades.length} trades · ${perSymbol[s].totR}R · ${((Date.now() - t0) / 1e3).toFixed(0)} s`);
  }
  const sorted = [...trades].sort((a, b) => a.t0 - b.t0), split = sorted.length ? sorted[Math.floor(sorted.length / 2)].t0 : Infinity;
  const rep = report(trades, split);
  const out = { strategy: 'ICT_NY_AM_REVERSAL', source, pricePathOnly: source === 'mark', options: opt, split, symbols: list, perSymbol, statuses: reasons,
    metrics: { all: rep.all, halves: rep.halves, bySymbol: rep.bySymbol, bySide: rep.bySide, months: rep.months, exits: rep.exits },
    ambiguous: trades.filter(t => t.ambiguous).length, trades: sorted };
  if (env.ICT_OUT) fs.writeFileSync(env.ICT_OUT, JSON.stringify(out, null, 1));
  const f = s => s.n ? `n ${s.n} · win ${s.win}% · avg ${s.avgR}R · total ${s.totR}R · max DD ${s.maxDD}R · PF ${s.pf}` : 'n 0';
  console.log([`ICT NY AM reversal · ${source} bars · minRange ${opt.rangePct * 100}% · ${Object.keys(perSymbol).length} symbols`,
    `all: ${f(rep.all)}`, `halves (split ${Number.isFinite(split) ? new Date(split).toISOString().slice(0, 10) : '—'}): ${f(rep.halves[0])} | ${f(rep.halves[1])}`,
    `exits: ${Object.entries(rep.exits).map(([k, v]) => `${k} ${v.n} (${v.totR}R)`).join(' · ')}`,
    `statuses: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`].join('\n'));
}
