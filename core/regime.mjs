// Market posture for the Intel desk, ported from tradermonty/claude-trading-skills (MIT):
//   market-breadth-analyzer (6 components), uptrend-analyzer (5 components), exposure-coach (composite, ceiling, recommendation).
// Same thresholds, weights and rounding as the Python scripts (Python round = half to even). test/regime.test.mjs
// checks parity against outputs produced by the original scripts. Display and record only: it never gates a trade.

export const BREADTH_URLS = {
  detail: 'https://tradermonty.github.io/market-breadth-analysis/market_breadth_data.csv',
  summary: 'https://tradermonty.github.io/market-breadth-analysis/market_breadth_summary.csv',
};
export const UPTREND_URLS = {
  timeseries: 'https://raw.githubusercontent.com/tradermonty/uptrend-dashboard/main/data/uptrend_ratio_timeseries.csv',
  sectors: 'https://raw.githubusercontent.com/tradermonty/uptrend-dashboard/main/data/sector_summary.csv',
};

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
// Python's round(): exact binary value, ties to even (round(20.05, 1) == 20.1, round(2.5) == 2).
const DV = new DataView(new ArrayBuffer(8));
function exact(v) { // v = num / den exactly
  DV.setFloat64(0, v);
  const hi = DV.getUint32(0), lo = DV.getUint32(4), sign = hi >>> 31 ? -1n : 1n, e = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo), exp;
  if (e === 0) exp = -1074; else { mant |= 1n << 52n; exp = e - 1075; }
  return exp >= 0 ? { num: sign * (mant << BigInt(exp)), den: 1n } : { num: sign * mant, den: 1n << BigInt(-exp) };
}
export function pyRound(v, nd = 0) {
  if (!Number.isFinite(v)) return v;
  const { num, den } = exact(v), m = 10n ** BigInt(nd), n = num * m;
  let f = n / den; if (n < 0n && f * den !== n) f -= 1n; // floor
  const r2 = 2n * (n - f * den);
  const q = r2 < den ? f : r2 > den ? f + 1n : (f % 2n === 0n ? f : f + 1n);
  const out = Number(q) / Number(m);
  return out === 0 ? 0 : out;
}
const int = v => Math.trunc(v); // Python int() on a float

// ---------------- CSV ----------------
export function parseCSV(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const split = line => { const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const head = split(lines[0]).map(h => h.trim());
  return lines.slice(1).map(l => { const v = split(l); return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ''])); });
}
const num = v => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = v => { const s = String(v).trim().toLowerCase(); if (['true', '1', 'yes'].includes(s)) return true; if (['false', '0', 'no'].includes(s)) return false; throw new Error(`bad boolean ${v}`); };

export function breadthRows(text) {
  const out = [];
  for (const r of parseCSV(text)) {
    try {
      const row = { Date: r.Date.trim(), 'S&P500_Price': num(r['S&P500_Price']), Breadth_Index_Raw: num(r.Breadth_Index_Raw),
        Breadth_Index_200MA: num(r.Breadth_Index_200MA), Breadth_Index_8MA: num(r.Breadth_Index_8MA), Breadth_200MA_Trend: int(Number(r.Breadth_200MA_Trend)),
        Bearish_Signal: bool(r.Bearish_Signal), Is_Peak: bool(r.Is_Peak), Is_Trough: bool(r.Is_Trough), Is_Trough_8MA_Below_04: bool(r.Is_Trough_8MA_Below_04) };
      if ([row['S&P500_Price'], row.Breadth_Index_200MA, row.Breadth_Index_8MA].every(Number.isFinite) && Number.isFinite(row.Breadth_200MA_Trend)) out.push(row);
    } catch { /* skip malformed row */ }
  }
  return out.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));
}
export const breadthSummary = text => Object.fromEntries(parseCSV(text).map(r => [String(r.Metric ?? '').trim(), String(r.Value ?? '').trim()]));
export function uptrendSeries(text) {
  return parseCSV(text).map(r => ({ worksheet: (r.worksheet ?? '').trim(), date: (r.date ?? '').trim(), count: num(r.count), total: num(r.total),
    ratio: num(r.ratio), ma_10: num(r.ma_10), slope: num(r.slope), trend: (r.trend ?? '').trim() }));
}
export const sectorSummary = text => parseCSV(text).map(r => ({ Sector: (r.Sector ?? '').trim(), Ratio: num(r.Ratio), '10MA': num(r['10MA']),
  Trend: (r.Trend ?? '').trim(), Slope: num(r.Slope), Status: (r.Status ?? '').trim() }));

// ---------------- market-breadth-analyzer ----------------
const MA8 = r => r.Breadth_Index_8MA;
function bLevel(rows) {
  if (!rows.length) return { score: 50, data_available: false };
  const L = rows.at(-1), ma8 = MA8(L), trend = L.Breadth_200MA_Trend;
  const level = ma8 >= 0.7 ? 95 : ma8 >= 0.6 ? 80 : ma8 >= 0.5 ? 65 : ma8 >= 0.4 ? 50 : ma8 >= 0.3 ? 35 : ma8 >= 0.2 ? 20 : 5;
  let mod = 0;
  if (rows.length >= 6) {
    const past = MA8(rows.at(-6)), dir = ma8 > past ? 'rising' : ma8 < past ? 'falling' : 'flat';
    if (dir === 'falling' && ma8 > 0.6) mod = -10; else if (dir === 'falling' && ma8 < 0.4) mod = 5; else if (dir === 'rising' && ma8 < 0.6) mod = 5;
  }
  return { score: clamp(pyRound(0.7 * level + 0.3 * (trend === 1 ? 80 : 20)) + mod), data_available: true, ma8, trend, modifier: mod };
}
function bCross(rows) {
  if (rows.length < 6) return { score: 50, data_available: false };
  const L = rows.at(-1), gap = MA8(L) - L.Breadth_Index_200MA, rising = MA8(L) > MA8(rows.at(-6));
  const gs = gap >= 0.15 ? 95 : gap >= 0.1 ? 80 : gap >= 0.05 ? 65 : gap >= 0 ? 50 : gap >= -0.05 ? 35 : gap >= -0.1 ? 20 : 5;
  const mod = gap < 0 && rising ? 10 : gap > 0 && !rising ? -10 : 0;
  return { score: clamp(pyRound(gs + mod)), data_available: true, gap, modifier: mod };
}
function bCycle(rows) {
  if (rows.length < 10) return { score: 50, data_available: false };
  const recent = rows.slice(-Math.min(120, rows.length)), ma8 = MA8(rows.at(-1));
  const rising = rows.length >= 6 && ma8 > MA8(rows.at(-6));
  let type = null, days = null, idx = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].Is_Peak) { type = 'PEAK'; idx = i; break; }
    if (recent[i].Is_Trough || recent[i].Is_Trough_8MA_Below_04) { type = 'TROUGH'; idx = i; break; }
  }
  if (type) days = recent.length - 1 - idx;
  let base = 50;
  if (type === 'TROUGH') { base = days <= 20 ? (rising ? 85 : 30) : days <= 60 ? (rising ? 75 : 35) : (rising ? 65 : 40); if (recent[idx].Is_Trough_8MA_Below_04) base += 10; }
  else if (type === 'PEAK') base = days <= 20 ? (rising ? 60 : 20) : days <= 60 ? (rising ? 45 : 15) : (rising ? 50 : 10);
  return { score: clamp(base), data_available: type !== null, marker: type, days_since: days };
}
function bBearish(rows) {
  if (!rows.length) return { score: 50, data_available: false };
  const L = rows.at(-1), on = L.Bearish_Signal, trend = L.Breadth_200MA_Trend, ma8 = MA8(L), pink = trend === -1 && ma8 < L.Breadth_Index_200MA;
  const base = !on && trend === 1 ? 85 : !on && trend === -1 ? 50 : on && trend === 1 ? 30 : 10;
  const ctx = on ? (ma8 > 0.5 ? 15 : ma8 < 0.25 ? -5 : 0) : 0;
  return { score: clamp(pyRound(base + ctx + (pink && !on ? -10 : 0))), data_available: true, signal_active: on, pink_zone: pink };
}
function bHistory(rows, summary) {
  if (!rows.length) return { score: 50, data_available: false };
  const all = rows.map(MA8), cur = all.at(-1), pct = all.filter(v => v < cur).length / all.length * 100;
  const base = pct >= 80 ? 90 : pct >= 60 ? 70 : pct >= 40 ? 50 : pct >= 20 ? 30 : 10;
  const peak = num(summary?.['Average Peaks (200MA)']), trough = num(summary?.['Average Troughs (8MA < 0.4)']);
  const adj = peak != null && cur >= peak * 0.95 ? -10 : trough != null && cur <= trough * 1.05 ? 10 : 0;
  return { score: clamp(pyRound(base + adj)), data_available: true, percentile: pct };
}
function divWindow(rows, lookback) {
  const n = Math.min(lookback, rows.length), L = rows.at(-1), P = rows.at(-n);
  if (P['S&P500_Price'] <= 0) return { score: 50, type: 'Invalid data' };
  const sp = (L['S&P500_Price'] - P['S&P500_Price']) / P['S&P500_Price'] * 100, br = MA8(L) - MA8(P);
  let s, type;
  if (sp > 3 && br < -0.05) [s, type] = [10, 'Dangerous bearish divergence'];
  else if (sp > 1 && br < -0.03) [s, type] = [25, 'Moderate bearish divergence'];
  else if (sp < -3 && br > 0.05) [s, type] = [80, 'Strong bullish divergence'];
  else if (sp < -1 && br > 0.03) [s, type] = [65, 'Moderate bullish divergence'];
  else if (Math.abs(sp) < 0.5 && Math.abs(br) < 0.01) [s, type] = [50, 'Near-flat'];
  else if (sp > 0 && br > 0) [s, type] = [70, 'Healthy alignment'];
  else if (!(sp > 0) && !(br > 0)) [s, type] = [30, 'Consistent decline'];
  else [s, type] = [50, 'Mixed signals'];
  return { score: clamp(s), type, sp, br };
}
function bDivergence(rows) {
  if (rows.length < 20) return { score: 50, data_available: false };
  const w60 = divWindow(rows, 60), w20 = divWindow(rows, 20);
  return { score: clamp(pyRound(w60.score * 0.6 + w20.score * 0.4, 1)), data_available: true, type: w60.type, early_warning: w20.score <= 25 && w60.score >= 50 };
}
const B_WEIGHTS = { breadth_level_trend: 0.25, ma_crossover: 0.20, cycle_position: 0.20, bearish_signal: 0.15, historical_percentile: 0.10, divergence: 0.10 };
const B_ZONES = [[80, 'Strong', '90-100%'], [60, 'Healthy', '75-90%'], [40, 'Neutral', '60-75%'], [20, 'Weakening', '40-60%'], [-1, 'Critical', '25-40%']];
export function scoreBreadth(rows, summary = {}) {
  const comps = { breadth_level_trend: bLevel(rows), ma_crossover: bCross(rows), cycle_position: bCycle(rows), bearish_signal: bBearish(rows),
    historical_percentile: bHistory(rows, summary), divergence: bDivergence(rows) };
  const avail = Object.keys(B_WEIGHTS).filter(k => comps[k].data_available);
  const tw = avail.reduce((s, k) => s + B_WEIGHTS[k], 0);
  let composite = 50;
  if (tw > 0) { composite = 0; for (const k of avail) composite += comps[k].score * (B_WEIGHTS[k] / tw); composite = pyRound(composite, 1); }
  const [, zone, exposure] = B_ZONES.find(([min]) => composite >= min);
  const caution = (comps.breadth_level_trend.modifier ?? 0) < 0 || (comps.ma_crossover.modifier ?? 0) < 0;
  return { composite, zone: tw > 0 ? zone : 'Neutral', exposure, caution, available: avail.length, date: rows.at(-1)?.Date ?? null,
    ma8: rows.at(-1)?.Breadth_Index_8MA ?? null, pink_zone: !!comps.bearish_signal.pink_zone, components: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, v.score])) };
}

// ---------------- uptrend-analyzer ----------------
const UP = 0.37, LOW = 0.097;
export function ratioToScore(r) {
  if (r >= 0.5) return Math.min(100, 90 + (r - 0.5) / 0.1 * 10);
  if (r >= UP) return 70 + (r - UP) / (0.5 - UP) * 19;
  if (r >= 0.25) return 40 + (r - 0.25) / (UP - 0.25) * 29;
  if (r >= LOW) return 10 + (r - LOW) / (0.25 - LOW) * 29;
  return Math.max(0, r / LOW * 9);
}
function uBreadth(latest) {
  if (!latest || latest.ratio == null) return { score: 50, data_available: false };
  const t = (latest.trend ?? '').toLowerCase(), adj = t === 'up' && latest.slope > 0 ? 5 : t === 'down' && latest.slope != null && latest.slope < 0 ? -5 : 0;
  return { score: pyRound(Math.min(100, Math.max(0, ratioToScore(latest.ratio) + adj))), data_available: true, ratio: latest.ratio };
}
const WS = { sec_basic_materials: 'Basic Materials', sec_communication_services: 'Communication Services', sec_consumer_cyclical: 'Consumer Cyclical',
  sec_consumer_defensive: 'Consumer Defensive', sec_energy: 'Energy', sec_financial: 'Financial', sec_healthcare: 'Healthcare', sec_industrials: 'Industrials',
  sec_real_estate: 'Real Estate', sec_technology: 'Technology', sec_utilities: 'Utilities' };
function summaryFromSeries(series) {
  const latest = {};
  for (const r of series) if (r.worksheet !== 'all' && (!latest[r.worksheet] || r.date > latest[r.worksheet].date)) latest[r.worksheet] = r;
  return Object.entries(latest).map(([ws, r]) => ({ Sector: WS[ws] ?? ws, Ratio: r.ratio, '10MA': r.ma_10, Trend: r.trend ? r.trend[0].toUpperCase() + r.trend.slice(1).toLowerCase() : '', Slope: r.slope }));
}
function uParticipation(sectors) {
  if (!sectors.length) return { score: 50, data_available: false, spread: null };
  const up = sectors.filter(s => (s.Trend ?? '').toLowerCase() === 'up').length, ratios = sectors.map(s => s.Ratio).filter(v => v != null);
  const spread = ratios.length ? Math.max(...ratios) - Math.min(...ratios) : null;
  const cs = up >= 10 ? 100 : up >= 8 ? 80 : up >= 6 ? 60 : up >= 4 ? 40 : up >= 2 ? 20 : 0;
  const ss = spread == null ? 50 : spread < 0.15 ? 100 : spread < 0.25 ? 100 - (spread - 0.15) / 0.1 * 20 : spread < 0.35 ? 80 - (spread - 0.25) / 0.1 * 20
    : spread < 0.45 ? 60 - (spread - 0.35) / 0.1 * 30 : Math.max(0, 30 - (spread - 0.45) / 0.1 * 30);
  return { score: pyRound(Math.min(100, Math.max(0, cs * 0.6 + ss * 0.4))), data_available: true, spread, uptrend_count: up, total: sectors.length };
}
const CYC = ['Technology', 'Consumer Cyclical', 'Communication Services', 'Financial', 'Industrials'];
const DEF = ['Utilities', 'Consumer Defensive', 'Healthcare', 'Real Estate'];
const COM = ['Energy', 'Basic Materials'];
function groupDiv(map, names) {
  const rows = names.map(n => map[n]).filter(s => s && s.Ratio != null);
  if (rows.length < 2) return false;
  const rs = rows.map(s => s.Ratio), mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length), spread = Math.max(...rs) - Math.min(...rs);
  const tr = rows.map(s => (s.Trend ?? '').toLowerCase()), upN = tr.filter(t => t === 'up').length, dnN = tr.filter(t => t === 'down').length;
  const maj = upN >= dnN ? 'up' : 'down';
  return sd > 0.08 || spread > 0.2 || tr.some(t => t && t !== maj);
}
function uRotation(sectors) {
  if (!sectors.length) return { score: 50, data_available: false };
  const map = Object.fromEntries(sectors.filter(s => s.Sector).map(s => [s.Sector, s]));
  const avg = names => { const rs = names.map(n => map[n]?.Ratio).filter(v => v != null); return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null; };
  const c = avg(CYC), d = avg(DEF), m = avg(COM);
  if (c == null || d == null) return { score: 50, data_available: false };
  const diff = c - d;
  const base = diff > 0.15 ? Math.min(100, 90 + (diff - 0.15) / 0.1 * 10) : diff > 0.05 ? 70 + (diff - 0.05) / 0.1 * 19 : diff > -0.05 ? 45 + (diff + 0.05) / 0.1 * 24
    : diff > -0.15 ? 20 + (diff + 0.15) / 0.1 * 24 : Math.max(0, 19 + (diff + 0.15) / 0.1 * 19);
  const late = m != null && m > c && m > d, cpen = late ? (m - Math.max(c, d) > 0.1 ? -10 : -5) : 0;
  const div = groupDiv(map, CYC) || groupDiv(map, DEF);
  return { score: pyRound(Math.min(100, Math.max(0, base + cpen + (div ? -5 : 0)))), data_available: true, difference: diff, late_cycle: late, divergence: div };
}
function ema(vals, span = 3) { if (!vals.length) return []; const a = 2 / (span + 1), out = [vals[0]]; for (let i = 1; i < vals.length; i++) out.push(a * vals[i] + (1 - a) * out.at(-1)); return out; }
function accel(sm) {
  const cls = x => x > 0.005 ? 90 : x > 0.001 ? 75 : x > -0.001 ? 50 : x > -0.005 ? 25 : 10;
  const w = sm.length >= 20 ? 10 : 5;
  if (sm.length < w * 2) return 50;
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  return cls(pyRound(avg(sm.slice(-w)) - avg(sm.slice(-2 * w, -w)), 6));
}
function uMomentum(all, sectors) {
  if (!all.length) return { score: 50, data_available: false };
  const slopes = all.map(r => r.slope).filter(v => v != null), sm = ema(slopes), eff = sm.length ? sm.at(-1) : all.at(-1).slope;
  const s = eff == null ? 50 : eff >= 0.02 ? Math.min(100, 95 + (eff - 0.02) / 0.01 * 5) : eff >= 0.01 ? 75 + (eff - 0.01) / 0.01 * 19 : eff >= 0 ? 55 + eff / 0.01 * 19
    : eff >= -0.01 ? 35 + (eff + 0.01) / 0.01 * 19 : eff >= -0.02 ? 10 + (eff + 0.02) / 0.01 * 24 : Math.max(0, 9 + (eff + 0.02) / 0.01 * 9);
  const br = sectors.length ? sectors.filter(x => x.Slope != null && x.Slope > 0).length / sectors.length * 100 : 50;
  return { score: pyRound(Math.min(100, Math.max(0, s * 0.5 + accel(sm) * 0.3 + br * 0.2))), data_available: true, slope: eff };
}
function uHistory(all) {
  const rs = all.map(r => r.ratio).filter(v => v != null);
  if (rs.length < 2) return { score: 50, data_available: false };
  const cur = rs.at(-1), pct = pyRound((rs.filter(r => r < cur).length + rs.filter(r => r === cur).length * 0.5) / rs.length * 100, 1);
  return { score: pyRound(Math.min(100, Math.max(0, pct))), data_available: true, percentile: pct, points: rs.length };
}
const U_WEIGHTS = { market_breadth: 0.30, sector_participation: 0.25, sector_rotation: 0.15, momentum: 0.20, historical_context: 0.10 };
const U_ZONES = [[80, 'Strong Bull', 'Full Exposure (100%)'], [60, 'Bull', 'Normal Exposure (80-100%)'], [40, 'Neutral', 'Reduced Exposure (60-80%)'],
  [20, 'Cautious', 'Defensive (30-60%)'], [-1, 'Bear', 'Capital Preservation (0-30%)']];
export function scoreUptrend(series, sectors = []) {
  const all = series.filter(r => r.worksheet === 'all').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sec = sectors.length ? sectors : summaryFromSeries(series);
  const comps = { market_breadth: uBreadth(all.at(-1)), sector_participation: uParticipation(sec), sector_rotation: uRotation(sec), momentum: uMomentum(all, sectors), historical_context: uHistory(all) };
  const raw = pyRound(Object.entries(U_WEIGHTS).reduce((s, [k, w]) => s + comps[k].score * w, 0), 1);
  const flags = { late_cycle: !!comps.sector_rotation.late_cycle, high_spread: comps.sector_participation.spread != null && comps.sector_participation.spread > 0.4, divergence: !!comps.sector_rotation.divergence };
  const pens = { late_cycle: -5, high_spread: -3, divergence: -3 };
  const on = Object.keys(pens).filter(k => flags[k]);
  const penalty = on.reduce((s, k) => s + pens[k], 0) + (on.length >= 2 ? 1 : 0);
  const composite = pyRound(Math.min(100, Math.max(0, raw + penalty)), 1);
  const [, zone, exposure] = U_ZONES.find(([min]) => composite >= min);
  return { composite, raw, penalty, zone, exposure, warnings: on, ratio: all.at(-1)?.ratio ?? null, date: all.at(-1)?.date ?? null,
    components: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, v.score])) };
}

// ---------------- exposure-coach (breadth + uptrend + sector inputs) ----------------
const SECTORS11 = [...CYC, ...DEF, ...COM];
export function sectorHealth(sectors) {
  const map = Object.fromEntries(sectors.map(s => [String(s.Sector).trim().toLowerCase(), s]));
  const rows = SECTORS11.map(n => map[n.toLowerCase()]);
  if (rows.some(r => !r || !(r.Ratio >= 0 && r.Ratio <= 1))) return null;
  if (rows.every(r => r.Slope == null)) return null;
  const h = rows.map(r => { const t = String(r.Trend ?? '').trim().toLowerCase();
    const adj = t === 'up' && r.Slope != null && r.Slope > 0 ? 5 : t === 'down' && r.Slope != null && r.Slope < 0 ? -5 : 0;
    return Math.min(100, Math.max(0, ratioToScore(r.Ratio) + adj)); });
  return pyRound(h.reduce((a, b) => a + b, 0) / SECTORS11.length);
}
const X_WEIGHTS = { regime: 0.25, top_risk: 0.20, breadth: 0.15, uptrend: 0.15, institutional: 0.10, sector: 0.05, theme: 0.05, ftd: 0.05 };
const CRITICAL = ['regime', 'top_risk', 'breadth'];
export function exposure(scores) {
  const provided = [], missing = [];
  let ws = 0, tw = 0;
  for (const [k, w] of Object.entries(X_WEIGHTS)) { const s = scores[k]; if (s != null) { ws += s * w; tw += w; provided.push(k); } else missing.push(k); }
  const missCrit = missing.filter(k => CRITICAL.includes(k)).length;
  const composite = tw === 0 ? 50 : Math.max(0, ws / tw - missCrit * 10);
  const c = composite;
  const ceiling = c >= 80 ? Math.min(100, int(90 + (c - 80))) : c >= 65 ? int(70 + (c - 65) * 1.3) : c >= 50 ? int(50 + (c - 50) * 1.3)
    : c >= 35 ? int(30 + (c - 35) * 1.3) : c >= 20 ? int(10 + (c - 20) * 1.3) : Math.max(0, int(c / 2));
  const tr = scores.top_risk;
  const recommendation = c < 30 || (tr != null && tr < 25) ? 'CASH_PRIORITY' : c < 50 || (tr != null && tr < 40) || missCrit >= 2 ? 'REDUCE_ONLY' : 'NEW_ENTRY_ALLOWED';
  const upB = scores.uptrend != null && scores.uptrend >= 50, brB = scores.breadth != null && scores.breadth >= 50;
  const participation = upB && brB ? 'BROAD' : upB || brB ? 'MODERATE' : 'NARROW';
  const confidence = provided.length >= 6 && missCrit === 0 ? 'HIGH' : provided.length >= 4 || missCrit <= 1 ? 'MEDIUM' : 'LOW';
  return { composite: pyRound(composite, 1), ceiling, recommendation, participation, confidence, provided, missing, missing_critical: missing.filter(k => CRITICAL.includes(k)) };
}

// One posture snapshot from whatever sources loaded. `get(url)` returns text.
export function posture({ breadthText, breadthSummaryText, uptrendText, sectorText, at = Date.now() } = {}) {
  const errors = [];
  let breadth = null, uptrend = null, sector = null;
  try { const rows = breadthRows(breadthText ?? ''); if (rows.length) breadth = scoreBreadth(rows, breadthSummary(breadthSummaryText ?? '')); else if (breadthText != null) errors.push('breadth CSV had no rows'); } catch (e) { errors.push(`breadth: ${e.message}`); }
  try {
    const series = uptrendSeries(uptrendText ?? ''), secs = sectorSummary(sectorText ?? '');
    if (series.some(r => r.worksheet === 'all' && r.ratio != null)) uptrend = scoreUptrend(series, secs);
    sector = sectorHealth(secs.length ? secs : summaryFromSeries(series));
  } catch (e) { errors.push(`uptrend: ${e.message}`); }
  const scores = { breadth: breadth ? int(breadth.composite) : null, uptrend: uptrend ? int(uptrend.composite) : null, sector };
  return { at, breadth, uptrend, sector, exposure: exposure(scores), errors };
}

export async function loadPosture({ fetchImpl = globalThis.fetch, at = Date.now(), timeout = 20_000 } = {}) {
  const errors = [];
  const text = async url => {
    try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeout), referrerPolicy: 'no-referrer' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
    catch (e) { errors.push(`${url.split('/').pop()}: ${e.message}`); return null; }
  };
  const [breadthText, breadthSummaryText, uptrendText, sectorText] = await Promise.all([BREADTH_URLS.detail, BREADTH_URLS.summary, UPTREND_URLS.timeseries, UPTREND_URLS.sectors].map(text));
  const p = posture({ breadthText, breadthSummaryText, uptrendText, sectorText, at });
  p.errors.unshift(...errors);
  return p;
}
