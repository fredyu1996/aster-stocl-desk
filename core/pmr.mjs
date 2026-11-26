// GMS PMR v1.4 scanner for Aster stock perpetuals.
// Ported from Market Floor (public/market.mjs), perpetual path only: continuous UTC bars, no options.
// Every state change is keyed to event time. A partial source interval never forms a completed candle.

export const MIN = 60_000;
export const PATTERNS = ['FLAG', 'TRIANGLE', 'DOUBLE_TOP', 'DOUBLE_BOTTOM', 'HNS', 'INVERSE_HNS'];

// 1m bars use `t` = close time (open time + 1 minute), like Market Floor.
function aggregate(bars, span) {
  const completed = new Map();
  let bucket;
  for (const bar of bars) {
    const minute = (bar.t / MIN - 1) % 1440;
    const offset = minute - minute % span;
    const end = bar.t + (offset + span - minute - 1) * MIN;
    if (bucket?.t !== end) bucket = { t: end, start: end - span * MIN, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: 0, q: 0, tb: 0, count: 0 };
    bucket.h = Math.max(bucket.h, bar.h);
    bucket.l = Math.min(bucket.l, bar.l);
    bucket.c = bar.c;
    bucket.v += bar.v;
    bucket.q += bar.q ?? bar.v * bar.c;
    bucket.tb += bar.tb ?? 0;
    bucket.count++;
    if (bucket.count === span && bar.t === end) completed.set(end, bucket);
  }
  return completed;
}

export function validBar(b) {
  return b && Number.isSafeInteger(b.t) && b.t % MIN === 0 && [b.o, b.h, b.l, b.c].every(n => Number.isFinite(n) && n > 0) &&
    b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c) && Number.isFinite(b.v) && b.v >= 0;
}

export function atr(bars, before = bars.length) {
  if (before < 15) return null;
  let sum = 0;
  for (let i = before - 14; i < before; i++) {
    const { h, l } = bars[i];
    const prev = bars[i - 1].c;
    sum += Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  }
  return sum / 14;
}

export function pivots(bars, side, before = bars.length, width = 3) {
  const out = [];
  for (let i = Math.max(width, before - 80); i + width < before; i++) {
    const price = bars[i][side];
    let ok = true;
    for (let j = i - width; j <= i + width && ok; j++) if (j !== i) ok = side === 'h' ? bars[j].h < price : bars[j].l > price;
    if (ok) out.push({ price, i, t: bars[i].t, knownAt: bars[i + width].t });
  }
  return out;
}

const signed = (dir, price, level) => dir * (price - level);
const line = (p, q, i) => p.price + (q.price - p.price) * (i - p.i) / (q.i - p.i);
const overlap = (a, b) => Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
export const hits = (bar, zone) => bar.l <= zone.hi && bar.h >= zone.lo;
const roundTo = (n, step) => Math.round(n / step) * step;

function automaticPatterns(bars, a) {
  const i = bars.length - 1;
  const highs = pivots(bars, 'h', i);
  const lows = pivots(bars, 'l', i);
  const result = [];
  for (const dir of [1, -1]) {
    const tops = (dir === 1 ? highs : lows).map(p => ({ ...p, price: p.price * dir }));
    const bottoms = (dir === 1 ? lows : highs).map(p => ({ ...p, price: p.price * dir }));
    const [l, m, r] = bottoms.slice(-3);
    const [p, q] = tops.slice(-2);
    const make = (type, boundary, stop, target, slope, structureEnd) => {
      if (i - structureEnd > 18 || target <= boundary || stop >= boundary) return;
      const closer = tops.filter(x => x.price > boundary && x.price < target).at(-1);
      result.push({ type, direction: dir, boundary: dir * boundary, stop: dir * stop, target: dir * (closer?.price ?? target),
        slope: dir * slope, knownAt: bars[i - 1].t, reference: bars[i].t });
    };
    const between = (first, second) => tops.filter(x => first.i < x.i && x.i < second.i).at(-1);
    if (m && r) {
      const neck = between(m, r);
      if (neck && Math.abs(m.price - r.price) <= 0.45 * a && neck.price - Math.max(m.price, r.price) >= a) {
        const base = Math.min(m.price, r.price);
        make(dir === 1 ? 'DOUBLE_BOTTOM' : 'DOUBLE_TOP', neck.price, base, neck.price * 2 - base, 0, r.i);
      }
      if (l && m.price + 0.5 * a < Math.min(l.price, r.price) && Math.abs(l.price - r.price) <= 0.8 * a) {
        const n1 = between(l, m), n2 = between(m, r);
        if (n1 && n2) {
          const neckline = line(n1, n2, i);
          make(dir === 1 ? 'INVERSE_HNS' : 'HNS', neckline, r.price, neckline + line(n1, n2, m.i) - m.price, (n2.price - n1.price) / (n2.i - n1.i), r.i);
        }
      }
      if (p && q && Math.min(p.i, m.i) < Math.min(q.i, r.i)) {
        const upper = line(p, q, i), lower = line(m, r, i);
        const atStart = Math.max(p.i, m.i);
        const width = line(p, q, atStart) - line(m, r, atStart);
        const uSlope = (q.price - p.price) / (q.i - p.i);
        const lSlope = (r.price - m.price) / (r.i - m.i);
        const end = Math.max(q.i, r.i);
        if (upper > lower && width >= a && upper - lower <= width * 0.8 && uSlope <= 0.08 * a && lSlope >= -0.08 * a) {
          make('TRIANGLE', upper, lower, upper + width, uSlope, end);
        }
        const pole = bottoms.filter(x => x.i < p.i && p.i - x.i <= 8).at(-1);
        const flagBase = Math.min(m.price, r.price);
        if (pole && p.price - pole.price >= 2 * a && m.i > pole.i && r.i > p.i && uSlope < 0 && lSlope < 0 &&
            p.price - flagBase <= 0.65 * (p.price - pole.price) && upper > lower) {
          make('FLAG', upper, Math.min(lower, flagBase), upper + p.price - pole.price, uSlope, end);
        }
      }
    }
  }
  return result;
}

export function confirmPattern(tracker, now) {
  const bars = tracker.history[60];
  const a = atr(bars, bars.length - 1);
  if (!a) return null;
  const [prev, bar] = bars.slice(-2);
  for (const p of automaticPatterns(bars, a)) {
    const boundary = p.boundary + p.slope * (now - p.reference) / (60 * MIN);
    const previousBoundary = boundary - p.slope * (p.reference === now ? 1 : (now - prev.t) / (60 * MIN));
    if (signed(p.direction, bar.c, boundary) < 0.1 * a || signed(p.direction, prev.c, previousBoundary) > 0 ||
        signed(p.direction, p.target, boundary) <= 0 || signed(p.direction, boundary, p.stop) <= 0) continue;
    return Object.freeze({ ...p, id: `${tracker.symbol}-${p.type}-${now}`, t: now, boundary, atr: a });
  }
  return null;
}

function displacement(bar, a, dir, k = 1.2) {
  return a > 0 && signed(dir, bar.c, bar.o) >= k * a && Math.abs(bar.c - bar.o) >= 0.6 * (bar.h - bar.l);
}

function gap(bars, i, a, dir) {
  const [first, , last] = bars.slice(i - 1, i + 2);
  if (!first || !last || last.t - first.t !== 2 * (last.t - last.start)) return null;
  const [lo, hi] = dir === 1 ? [first.h, last.l] : [last.h, first.l];
  return hi - lo >= 0.10 * a ? { lo, hi, createdAt: last.t, knownAt: last.t, type: 'FVG' } : null;
}

export function findPOI(tracker, now) {
  const { anchor } = tracker, P = tracker.P ?? PMR_DEFAULT;
  const bars = tracker.history[15];
  const dir = anchor.direction;
  const candidates = [];
  for (let i = Math.max(15, bars.length - (now === anchor.t ? 8 : 8 + Math.ceil(P.poiWaitMin / 15))); i < bars.length; i++) {
    const b = bars[i];
    const a = atr(bars, i);
    if (b.t < anchor.t - 7 * 15 * MIN || b.t > anchor.t + P.poiAfterBars * 15 * MIN || !displacement(b, a, dir, P.dispAtr)) continue;
    const level = anchor.boundary;
    const crosses = signed(dir, dir === 1 ? b.l : b.h, level) <= 0 && signed(dir, b.c, level) > 0;
    const continues = b.t > anchor.t && signed(dir, b.o, level) > 0 && Math.abs(b.o - level) <= 0.5 * anchor.atr;
    if (!crosses && !continues) continue;
    const pivot = pivots(bars, dir === 1 ? 'h' : 'l', i).at(-1);
    const bos = pivot && signed(dir, b.c, pivot.price) > 0;
    const origin = bos && bars.slice(Math.max(0, i - 4), i).findLast(x => signed(dir, x.c, x.o) < 0);
    const here = [origin && { lo: origin.l, hi: origin.h, createdAt: origin.t, knownAt: b.t, type: 'OB' }, gap(bars, i, a, dir)];
    for (const zone of here.filter(Boolean)) {
      const distance = Math.max(0, zone.lo - level, level - zone.hi);
      if (distance <= P.poiDistAtr * anchor.atr && !bars.slice(i + 1).some(x => x.t > zone.knownAt && hits(x, zone))) {
        candidates.push({ ...zone, distance, impulse: b.t, crosses });
      }
    }
  }
  candidates.sort((a, b) => Number(b.crosses) - Number(a.crosses) || a.distance - b.distance || b.impulse - a.impulse || a.type.localeCompare(b.type));
  const selected = candidates[0];
  if (!selected) return null;
  const other = candidates.find(p => p.impulse === selected.impulse && p.type !== selected.type);
  return { ...selected, other: other ?? null,
    confluence: !!other && overlap(selected, other) >= 0.2 * Math.min(selected.hi - selected.lo, other.hi - other.lo) };
}

export const TERMINAL = new Set(['SKIPPED', 'EXPIRED', 'CANCELLED']);
// GMS PMR v1.4 timing and size limits. The live desk uses exactly these (cfg.pmr overrides only after Fred approves a change).
// targetR null = the 1H pattern's measured-move target (v1.4); a number = a fixed multiple of the entry-to-stop distance.
export const PMR_DEFAULT = Object.freeze({ poiWaitMin: 30, poiAfterBars: 2, poiDistAtr: 0.5, retestMin: 120, mssMin: 45, fvgMin: 15, dispAtr: 1.2, entryWindowMin: 60, targetR: null });
// Live PMR presets (Settings → PMR 版本). Fred, 2026-11-26: 「放寬條件」, with a switch; trade the loosened + 2.5R target
// version on paper now (backtest top 10 × 180 d before the switch: n 14, −0.7R, halves −2.8R n 8 / +2.1R n 6).
// A preset sets cfg.pmr (Scanner params) and cfg.minNetRR together; cfg.pmrPreset names it.
export const PMR_W2 = Object.freeze({ poiWaitMin: 60, retestMin: 240, mssMin: 90, fvgMin: 30, entryWindowMin: 120 });
export const PMR_PRESETS = Object.freeze({
  'v1.4': { label: 'GMS PMR v1.4 原版', pmr: {}, minNetRR: 2.0 },
  'loose-2.5R': { label: '放寬 + 固定 2.5R target', pmr: { ...PMR_W2, dispAtr: 0.8, poiDistAtr: 1.0, targetR: 2.5 }, minNetRR: 1.5 },
  loose: { label: '淨係放寬（measured-move target）', pmr: { ...PMR_W2, dispAtr: 0.8, poiDistAtr: 1.0 }, minNetRR: 1.5 },
});
export const PMR_PRESET_DEFAULT = 'loose-2.5R';
const AGENT = { PATTERN_CONFIRMED: 'screener', WAIT_POI: 'screener', WAIT_RETEST: 'screener', POI_TOUCHED: 'trader',
  LTF_CONFIRMED: 'trader', QUALIFIED: 'trader', SKIPPED: 'reviewer', EXPIRED: 'reviewer', CANCELLED: 'reviewer' };

// Scans one symbol's completed 1m bars and returns the setup state at the last bar plus every proposal made on the way.
export class Scanner {
  constructor(symbol, bars, { tickSize = 0.01, params } = {}) {
    this.symbol = symbol;
    this.tickSize = tickSize;
    this.P = { ...PMR_DEFAULT, ...(params ?? {}) };
    this.status = 'WAIT';
    this.history = { 1: [], 5: [], 15: [], 60: [] };
    this.events = [];
    this.proposals = [];
    this.anchor = this.poi = this.plan = this.mss = null;
    const one = bars.filter(validBar).sort((a, b) => a.t - b.t);
    const frames = Object.fromEntries([5, 15, 60].map(n => [n, aggregate(one, n)]));
    for (const bar of one) this.process(bar, frames);
  }

  emit(t, agent, title, text, reason) {
    this.events.push({ t, agent, title, text, reason, symbol: this.symbol });
  }

  transition(t, status, reason, text) {
    if (this.status === 'QUALIFIED' && this.plan) Object.assign(this.plan, { endedAt: t, endReason: reason });
    this.status = status;
    this.reason = reason;
    this.emit(t, AGENT[status], status, text, reason);
  }

  process(b, frames) {
    const { t } = b;
    this.last = b;
    this.history[1].push(b);
    const closed = {};
    for (const tf of [5, 15, 60]) {
      const candle = frames[tf].get(t);
      if (candle) { closed[tf] = candle; this.history[tf].push(candle); }
    }
    const P = this.P;
    if (this.status === 'QUALIFIED' && t > this.plan.signalAt + P.entryWindowMin * MIN) {
      this.transition(t, 'EXPIRED', 'ENTRY_WINDOW_PASSED', 'The 60-minute entry window ended.');
    }
    if (closed[60] && this.anchor && !TERMINAL.has(this.status) && this.status !== 'WAIT' &&
        signed(this.anchor.direction, b.c, this.anchor.boundary + this.anchor.slope * (t - this.anchor.t) / (60 * MIN)) < 0) {
      this.transition(t, 'CANCELLED', '1H_CLOSE_BACK_INSIDE', 'The hourly candle closed back inside the breakout boundary.');
      return;
    }
    if (closed[15] && this.poi && !TERMINAL.has(this.status) && this.status !== 'WAIT' &&
        signed(this.anchor.direction, b.c, this.anchor.direction === 1 ? this.poi.lo : this.poi.hi) < 0) {
      this.transition(t, 'CANCELLED', 'PARENT_POI_INVALIDATED', 'The 15m close broke through the far edge of the parent zone.');
      return;
    }
    if (closed[60] && (this.status === 'WAIT' || TERMINAL.has(this.status))) {
      const anchor = confirmPattern(this, t);
      if (anchor) {
        Object.assign(this, { anchor, poi: null, touched: null, mss: null, plan: null });
        this.transition(t, 'PATTERN_CONFIRMED', 'CONFIRMED_1H_BREAKOUT',
          `${anchor.type.replaceAll('_', ' ')} ${anchor.direction === 1 ? 'up' : 'down'} confirmed on a completed 1H candle at ${anchor.boundary.toFixed(2)}.`);
        this.transition(t, 'WAIT_POI', 'SEARCH_CAUSAL_15M_ZONE', 'Looking for a fresh 15m zone from the breakout impulse.');
        this.choosePOI(t);
      }
    } else if (closed[15] && this.status === 'WAIT_POI') this.choosePOI(t);
    if (this.status === 'WAIT_POI' && t >= this.anchor.t + P.poiWaitMin * MIN) {
      this.transition(t, 'SKIPPED', 'NO_FRESH_CAUSAL_POI', 'No fresh breakout-linked 15m zone in the allowed window.');
    }
    if (this.status === 'WAIT_RETEST' && t > Math.max(this.anchor.t, this.poi.knownAt)) {
      if (t > this.anchor.t + P.retestMin * MIN) this.transition(t, 'EXPIRED', 'EXPIRED_NO_TOUCH', `No first touch within ${P.retestMin} minutes.`);
      else if (hits(b, this.poi)) {
        const dir = this.anchor.direction;
        this.touched = t;
        this.retestExtreme = dir === 1 ? b.l : b.h;
        this.sweepLevel = pivots(this.history[5], dir === 1 ? 'l' : 'h', this.history[5].length - Number(!!closed[5])).at(-1)?.price;
        this.swept = this.sweep(b);
        this.transition(t, 'POI_TOUCHED', 'FIRST_PARENT_RETEST', 'First parent-zone touch. Waiting for a new 5m structure break.');
      }
    }
    if (this.status === 'POI_TOUCHED' || this.status === 'LTF_CONFIRMED') {
      const dir = this.anchor.direction;
      this.retestExtreme = dir === 1 ? Math.min(this.retestExtreme, b.l) : Math.max(this.retestExtreme, b.h);
      if (t <= this.touched + 15 * MIN && this.sweep(b)) this.swept = true;
      if (this.status === 'POI_TOUCHED' && t > this.touched + P.mssMin * MIN) {
        this.transition(t, 'EXPIRED', 'NO_LTF_CONFIRMATION', `No qualifying 5m structure break within ${P.mssMin} minutes.`);
      } else if (this.status === 'LTF_CONFIRMED' && t > this.mss.t + P.fvgMin * MIN) {
        this.transition(t, 'EXPIRED', 'NO_ASSOCIATED_FVG', 'The displacement did not produce an associated fresh gap.');
      } else if (closed[5]) this.checkEntry(t);
    }
  }

  choosePOI(t) {
    const poi = findPOI(this, t);
    if (!poi) return;
    this.poi = Object.freeze(poi);
    this.transition(t, 'WAIT_RETEST', 'FRESH_CAUSAL_15M_POI', `15m ${poi.type} ${poi.lo.toFixed(2)}–${poi.hi.toFixed(2)}. Monitoring the first retest.`);
  }

  sweep(b) {
    const dir = this.anchor.direction;
    return this.sweepLevel !== undefined && signed(dir, dir === 1 ? b.l : b.h, this.sweepLevel) < 0 && signed(dir, b.c, this.sweepLevel) > 0;
  }

  checkEntry(t) {
    const bars = this.history[5];
    const i = bars.length - 1;
    const b = bars[i];
    const dir = this.anchor.direction;
    const a = atr(bars, i);
    if (!a || b.start < this.touched) return;
    if (this.status === 'POI_TOUCHED') {
      const pivot = pivots(bars, dir === 1 ? 'h' : 'l', i).at(-1);
      if (pivot && signed(dir, b.c, pivot.price) >= 0.05 * a && signed(dir, bars[i - 1].c, pivot.price) <= 0 && displacement(b, a, dir, this.P.dispAtr)) {
        this.mss = { t: b.t, i, atr: a };
        this.transition(t, 'LTF_CONFIRMED', '5M_MSS_DISPLACEMENT', '5m structure break confirmed. Waiting for the third candle to complete the gap.');
      }
      return;
    }
    if (i !== this.mss.i + 1 || bars[i - 2].start < this.touched) return;
    const fvg = gap(bars, this.mss.i, this.mss.atr, dir);
    if (!fvg) return;
    const step = this.tickSize;
    const entry = roundTo((fvg.lo + fvg.hi) / 2, step);
    const far = dir === 1 ? Math.min(this.retestExtreme, this.poi.lo) : Math.max(this.retestExtreme, this.poi.hi);
    const raw = (far - dir * 0.15 * a) / step;
    const stop = (dir === 1 ? Math.floor(raw) : Math.ceil(raw)) * step;
    const risk = signed(dir, entry, stop);
    const target = roundTo(this.P.targetR ? entry + dir * this.P.targetR * risk : this.anchor.target, step);
    const reward = signed(dir, target, entry);
    if (risk <= 0 || reward <= 0) {
      this.transition(t, 'SKIPPED', 'INVALID_PERPETUAL_PLAN', 'Entry, stop and target do not form a valid trade.');
      return;
    }
    const grade = this.poi.confluence && this.swept ? 'A+' : 'A';
    this.plan = {
      id: `${this.symbol}-${t}`, symbol: this.symbol, direction: dir, entry, stop, target, grossRR: reward / risk, grade,
      signalAt: t, expiresAt: t + this.P.entryWindowMin * MIN, atr5: a, fvg,
      pattern: { type: this.anchor.type, t: this.anchor.t, boundary: this.anchor.boundary, target: this.anchor.target, atr: this.anchor.atr },
      poi: { type: this.poi.type, lo: this.poi.lo, hi: this.poi.hi, knownAt: this.poi.knownAt, confluence: this.poi.confluence },
      firstRetestAt: this.touched, mssAt: this.mss.t, sweep: !!this.swept,
    };
    this.proposals.push(this.plan);
    this.transition(t, 'QUALIFIED', 'PROPOSAL', `${dir === 1 ? 'Long' : 'Short'} proposal at ${entry} · stop ${stop} · target ${target} · ${grade}.`);
  }

  summary() {
    return { symbol: this.symbol, status: this.status, reason: this.reason ?? null, last: this.last ?? null,
      anchor: this.anchor && { type: this.anchor.type, direction: this.anchor.direction, boundary: this.anchor.boundary, target: this.anchor.target, t: this.anchor.t },
      poi: this.poi && { type: this.poi.type, lo: this.poi.lo, hi: this.poi.hi, knownAt: this.poi.knownAt },
      plan: this.status === 'QUALIFIED' ? this.plan : null };
  }
}

// Taker-flow and volume intel from completed 5m candles (Market Intel desk).
export function intel(scanner) {
  const out = [];
  const five = scanner.history[5];
  for (let i = Math.max(20, five.length - 36); i < five.length; i++) {
    const b = five[i];
    const base = five.slice(i - 20, i).reduce((s, x) => s + x.q, 0) / 20;
    const ratio = base ? b.q / base : 0;
    if (ratio >= 2.5) out.push({ t: b.t, symbol: scanner.symbol, type: 'VOLUME', title: `${scanner.symbol} 5m volume ${ratio.toFixed(1)}× baseline`,
      detail: `Price ${b.c >= b.o ? 'up' : 'down'} ${Math.abs((b.c - b.o) / b.o * 100).toFixed(2)}% in the bar.` });
    if (b.q > 0 && b.tb >= 0) {
      const net = 2 * b.tb - b.q;
      if (Math.abs(net) / b.q >= 0.35 && b.q >= 20_000) out.push({ t: b.t, symbol: scanner.symbol, type: 'FLOW',
        title: `${scanner.symbol} ${Math.round(Math.abs(net) / b.q * 100)}% taker ${net > 0 ? 'buy' : 'sell'} imbalance`,
        detail: `${Math.round(Math.abs(net)).toLocaleString('en-US')} USDT net taker notional in 5m.` });
    }
  }
  return out;
}
