// Signal postmortem, adapted from tradermonty/claude-trading-skills `signal-postmortem` (MIT).
// The skill compares a signal's predicted direction with realized returns and labels it TRUE_POSITIVE,
// FALSE_POSITIVE, MISSED_OPPORTUNITY or REGIME_MISMATCH. Here every proposal has an exact plan, so instead of
// 5d / 20d returns we replay the plan on completed 1m bars with the desk's own fill rules and measure R.
// Declined proposals get a counterfactual so Fred can see whether each filter (picks, his marks, net R:R,
// spread, rules) kept him out of losers or out of winners. Record only: it never changes a decision.
import { MIN } from './pmr.mjs';
import { economics, timeExitMs } from './reviewer.mjs';

export const BAND = { missed: 0.5, skip: -0.5, tp: 0.25, fp: -0.25, severe: -1.1 };

// Replays one plan exactly like desk.mjs work() + manage(): limit live for bars that open after `activeAfter`,
// fill at min(open, entry) for a long, stop beats target, target cannot fill on the entry bar, time exit.
export function simulatePlan(plan, bars, cfg, { activeAfter, endedAt = Infinity }) {
  const d = plan.direction, unit = economics(plan, cfg).riskUnit;
  let pos = null, mae = 0, mfe = 0;
  const close = (b, price, reason) => {
    const exit = price * (1 - d * cfg.slip);
    const pnl = d * (exit - pos.entry) - (pos.entry + exit) * cfg.fee;
    return { done: true, filled: true, entry: pos.entry, entryAt: pos.entryAt, exit, exitAt: b.t, reason, r: pnl / unit, mae, mfe };
  };
  for (const b of bars) {
    if (!pos) {
      if (b.t - MIN < activeAfter) continue;
      if (b.t > plan.expiresAt || b.t > endedAt) return { done: true, filled: false, reason: b.t > endedAt ? 'CANCELLED' : 'NO_FILL' };
      if (d === 1 ? b.l > plan.entry : b.h < plan.entry) continue;
      pos = { entry: d === 1 ? Math.min(b.o, plan.entry) : Math.max(b.o, plan.entry), entryAt: b.t };
    }
    mae = Math.min(mae, (d === 1 ? b.l - pos.entry : pos.entry - b.h) / unit);
    mfe = Math.max(mfe, (d === 1 ? b.h - pos.entry : pos.entry - b.l) / unit);
    if (d === 1 ? b.l <= plan.stop : b.h >= plan.stop) return close(b, d === 1 ? Math.min(b.o, plan.stop) : Math.max(b.o, plan.stop), 'Stop');
    if (b.t > pos.entryAt && (d === 1 ? b.h >= plan.target : b.l <= plan.target)) return close(b, d === 1 ? Math.max(b.o, plan.target) : Math.min(b.o, plan.target), 'Target');
    if (b.t >= pos.entryAt + timeExitMs(cfg)) return close(b, b.c, 'Time exit');
  }
  return { done: false, filled: !!pos };
}

export function classifySkip(post) {
  if (!post.filled) return post.reason === 'CANCELLED' ? 'CANCELLED' : 'NO_FILL';
  return post.r >= BAND.missed ? 'MISSED_OPPORTUNITY' : post.r <= BAND.skip ? 'GOOD_SKIP' : 'NEUTRAL';
}
export function classifyTrade(t) {
  if (t.r >= BAND.tp) return 'TRUE_POSITIVE';
  if (t.r <= BAND.fp) {
    const regimeChanged = t.plan?.market?.rec && t.marketAtExit && t.plan.market.rec !== t.marketAtExit;
    if (regimeChanged) return 'REGIME_MISMATCH';
    return t.r < BAND.severe ? 'FALSE_POSITIVE_SEVERE' : 'FALSE_POSITIVE';
  }
  return 'NEUTRAL';
}

// Group a decline reason into the filter that made it.
export function filterOf(reason = '') {
  const r = String(reason);
  if (r.startsWith('MARK · your')) return /MSS/.test(r) ? 'Your MSS mark' : 'Your FVG / OB mark';
  if (r.startsWith('MARK')) return 'Your marks';
  if (r.startsWith('RULE')) return 'Approved rule';
  if (r.startsWith('NET_RR')) return 'Net R:R < min';
  if (r.startsWith('SPREAD')) return 'Spread';
  return { NOT_IN_PICKS: 'Not in picks', MAX_OPEN_POSITIONS: 'Max open', ALREADY_IN_SYMBOL: 'Already in symbol', SIZE_BELOW_EXCHANGE_MINIMUM: 'Size minimum', TRADING_OFF: 'Trading off' }[r] ?? r;
}

// Called at the end of each cycle: resolve counterfactuals for declined proposals whose window has finished.
export function postmortem(state, { bars, scanners, cfg, now }) {
  const lastClosed = Math.floor(now / MIN) * MIN;
  for (const d of state.decisions) {
    if (d.status !== 'Declined' || d.post?.done || !d.plan) continue;
    const series = bars[d.symbol];
    const horizon = d.plan.expiresAt + Math.min(timeExitMs(cfg), 3 * 1440 * MIN) + 5 * MIN; // no time exit: give up after 3 days
    if (!series?.length) { if (lastClosed > horizon + 6 * 60 * MIN) d.post = { done: true, outcome: 'NO_DATA' }; continue; }
    const endedAt = scanners[d.symbol]?.proposals?.find(p => p.id === d.id)?.endedAt ?? Infinity;
    const sim = simulatePlan(d.plan, series, cfg, { activeAfter: Math.floor(d.t / MIN) * MIN, endedAt });
    if (!sim.done) { if (lastClosed > horizon + 6 * 60 * MIN) d.post = { done: true, outcome: 'NO_DATA' }; continue; }
    d.post = { ...sim, outcome: classifySkip(sim), r: sim.r == null ? null : Math.round(sim.r * 1000) / 1000, filter: filterOf(d.reason) };
  }
}

const sum = xs => xs.reduce((a, b) => a + b, 0);
// Per filter: what the declined proposals would have done. Halves are by decision time, like the Reviewer's learning test.
export function filterReport(decisions, minN = 8) {
  const groups = {};
  for (const d of decisions) if (d.status === 'Declined') (groups[filterOf(d.reason)] ??= []).push(d);
  return Object.entries(groups).map(([filter, ds]) => {
    const done = ds.filter(d => d.post?.done && d.post.outcome !== 'NO_DATA').sort((a, b) => a.t - b.t);
    const filled = done.filter(d => d.post.filled), rs = filled.map(d => d.post.r);
    const half = Math.floor(rs.length / 2), h1 = sum(rs.slice(0, half)), h2 = sum(rs.slice(half));
    const total = sum(rs);
    let verdict = rs.length < minN ? `樣本太細（成交 ${rs.length} < ${minN}）`
      : total <= -3 && h1 < 0 && h2 < 0 ? `幫你避開咗 ${total.toFixed(1)}R 蝕`
      : total >= 3 && h1 > 0 && h2 > 0 ? `走漏咗 ${total.toFixed(1)}R 贏單；可能太嚴（你決定）`
      : '暫時睇唔出效果';
    return { filter, declined: ds.length, resolved: done.length, filled: filled.length, pending: ds.length - done.length,
      missed: done.filter(d => d.post.outcome === 'MISSED_OPPORTUNITY').length, goodSkip: done.filter(d => d.post.outcome === 'GOOD_SKIP').length,
      neutral: done.filter(d => d.post.outcome === 'NEUTRAL').length, noFill: done.filter(d => !d.post.filled).length,
      totalR: total, avgR: rs.length ? total / rs.length : null, verdict };
  }).sort((a, b) => b.declined - a.declined);
}
