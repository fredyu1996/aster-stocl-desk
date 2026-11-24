// Weekly performance digest and process coach for the paper account, adapted from
// tradermonty/claude-trading-skills `weekly-performance-digest` and `trade-performance-coach` (MIT).
// Digest metrics follow references/weekly-digest-metrics.md (win rate, expectancy, profit factor, R stats,
// MAE / MFE clamped on read, pattern buckets with win_rate = wins / (wins + losses)).
// The coach keeps the skill's evidence standard and verdict ladder but only uses axes that apply to an
// automated paper trader (risk, execution, regime context, Fred's reviews). Behavior tags such as FOMO or
// revenge trading need a human executing trades, so they are not produced. Suggestions are never applied.
import { classifyTrade } from './postmortem.mjs';

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
const DAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
// Monday (New York) of the week containing t, as YYYY-MM-DD.
export function weekOf(t) {
  const p = Object.fromEntries(NY.formatToParts(t).map(x => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - DAYS[p.weekday] * 864e5);
  return d.toISOString().slice(0, 10);
}

const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : null;
const stdev = xs => { if (xs.length < 2) return xs.length ? 0 : null; const m = mean(xs); return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1)); };
const bucket = (trades, key) => {
  const out = {};
  for (const t of trades) {
    const k = String(key(t) ?? 'unknown'), b = (out[k] ??= { wins: 0, losses: 0, total: 0, r: 0 });
    b.total++; b.r += t.r; if (t.pnl > 0) b.wins++; else if (t.pnl < 0) b.losses++;
  }
  for (const b of Object.values(out)) b.win_rate = b.wins + b.losses ? b.wins / (b.wins + b.losses) : null;
  return out;
};

export function digest(trades, { week } = {}) {
  const set = trades.filter(t => Number.isFinite(t.pnl) && (!week || weekOf(t.exitAt) === week));
  const win = set.filter(t => t.pnl > 0), loss = set.filter(t => t.pnl < 0);
  const gp = sum(win.map(t => t.pnl)), gl = sum(loss.map(t => t.pnl)), hold = ts => mean(ts.map(t => (t.exitAt - t.entryAt) / 60_000));
  const rs = set.map(t => t.r).filter(Number.isFinite);
  const mae = set.map(t => t.mae).filter(Number.isFinite).map(v => Math.min(v, 0)), mfe = set.map(t => t.mfe).filter(Number.isFinite).map(v => Math.max(v, 0));
  return {
    week: week ?? 'all', trades: set.length, wins: win.length, losses: loss.length, breakeven: set.length - win.length - loss.length,
    winRate: set.length ? win.length / set.length : null, expectancy: mean(set.map(t => t.pnl)), profitFactor: loss.length ? gp / Math.abs(gl) : null,
    totalPnl: sum(set.map(t => t.pnl)), avgWin: mean(win.map(t => t.pnl)), avgLoss: mean(loss.map(t => t.pnl)),
    largestWin: win.length ? Math.max(...win.map(t => t.pnl)) : null, largestLoss: loss.length ? Math.min(...loss.map(t => t.pnl)) : null,
    holdWinMin: hold(win), holdLossMin: hold(loss), avgR: mean(rs), totalR: sum(rs), rStdev: stdev(rs),
    avgMaeR: mean(mae), avgMfeR: mean(mfe), maeSamples: mae.length,
    by: {
      exit: bucket(set, t => t.reason), pattern: bucket(set, t => t.plan?.pattern?.type), grade: bucket(set, t => t.plan?.grade),
      side: bucket(set, t => t.direction === 1 ? 'long' : 'short'), poi: bucket(set, t => t.plan?.poi?.type),
      marks: bucket(set, t => t.plan?.marks ? (t.plan.marks.confluence ? 'your zone hit' : 'no zone hit') : 'no marks data'),
      posture: bucket(set, t => t.plan?.market?.rec ?? 'not recorded'), outcome: bucket(set, classifyTrade),
    },
    smallSample: set.length < 20,
  };
}
export const weeks = trades => [...new Set(trades.filter(t => Number.isFinite(t.exitAt)).map(t => weekOf(t.exitAt)))].sort().reverse();

// ---------------- coach ----------------
const PTS = { info: 3, warning: 15, critical: 30 };
export function coach(trades, { reviews = {}, cfg = {}, start = 1000, week } = {}) {
  const set = trades.filter(t => Number.isFinite(t.r) && (!week || weekOf(t.exitAt) === week)).sort((a, b) => a.exitAt - b.exitAt);
  const findings = [];
  const add = (axis, severity, text, trade) => findings.push({ axis, severity, text, trade: trade?.id ?? null, symbol: trade?.symbol ?? null });
  const roots = {};
  for (const t of set) {
    let root = null;
    if (t.r < -1.25) { add('risk', 'critical', `${t.symbol}: lost ${t.r.toFixed(2)}R vs a planned 1R (stop gapped or slipped).`, t); root = 'risk_sizing'; }
    else if (t.r < -1.02) { add('risk', 'warning', `${t.symbol}: lost ${t.r.toFixed(2)}R, more than the planned 1R.`, t); root = 'risk_sizing'; }
    const delay = (t.entryAt - (t.plan?.signalAt ?? t.entryAt)) / 60_000;
    if (delay > 15) { add('execution', t.r < 0 ? 'warning' : 'info', `${t.symbol}: filled ${Math.round(delay)} min after the signal (late fill).`, t); if (t.r < 0) root ??= 'execution'; }
    const rec = t.plan?.market?.rec;
    if (rec && rec !== 'NEW_ENTRY_ALLOWED') { add('regime', 'warning', `${t.symbol}: taken while the exposure coach said ${rec}. You have no regime gate, so this is not a rule breach.`, t); if (t.r < 0) root ??= 'market_environment'; }
    if (t.reason === 'Time exit' && t.r < 0) { add('process', 'info', `${t.symbol}: time exit at ${t.r.toFixed(2)}R, no follow-through.`, t); root ??= 'thesis_quality'; }
    const rv = reviews[t.id];
    if (rv && rv.agree === false) add('process', 'warning', `${t.symbol}: you disagreed with the Reviewer's grade${rv.comment ? ` ("${String(rv.comment).slice(0, 80)}")` : ''}.`, t);
    if (t.r < 0) { root ??= 'randomness'; roots[root] = (roots[root] ?? 0) + 1; }
  }
  // Streak and weekly loss: the desk has no limits for these, so they are reported as unclear, never as violations.
  let streak = 0;
  for (let i = set.length - 1; i >= 0 && set[i].r < 0; i--) streak++;
  if (streak >= 3) add('risk', 'warning', `${streak} losses in a row. No losing-streak limit is set, so this is unclear rather than a breach.`);
  const byWeek = {};
  for (const t of set) byWeek[weekOf(t.exitAt)] = (byWeek[weekOf(t.exitAt)] ?? 0) + t.pnl;
  for (const [w, pnl] of Object.entries(byWeek)) if (pnl / start <= -0.05) add('risk', 'warning', `Week of ${w}: ${(pnl / start * 100).toFixed(1)}% of start equity. No weekly loss limit is set.`);

  const score = axis => Math.max(0, 100 - sum(findings.filter(f => f.axis === axis).map(f => PTS[f.severity])));
  const crit = findings.filter(f => f.severity === 'critical').length, warn = findings.filter(f => f.severity === 'warning').length;
  const verdict = !set.length ? 'NO_TRADES' : crit >= 2 ? 'COOL_DOWN' : crit >= 1 || warn >= 3 ? 'REVIEW_REQUIRED' : warn ? 'WARN' : 'OK';
  const reviewed = set.filter(t => reviews[t.id]).length;
  const suggestions = [];
  const lost = (pred) => set.filter(t => t.r < 0 && pred(t));
  if (findings.some(f => f.axis === 'risk' && f.severity === 'critical')) suggestions.push('Check exit slippage and stop gaps: some losses were larger than the planned 1R. Consider a higher slippage setting so sizing reflects it.');
  const regimeLosses = lost(t => t.plan?.market?.rec && t.plan.market.rec !== 'NEW_ENTRY_ALLOWED');
  if (regimeLosses.length >= 3) suggestions.push(`${regimeLosses.length} losses came while the exposure coach said reduce / cash. A regime gate would need your approval and more trades first.`);
  if (lost(t => t.reason === 'Time exit').length >= 3) suggestions.push('Several time exits ended at a loss. Look at whether the 90-minute exit fits these stocks before changing it.');
  if (set.length && reviewed / set.length < 0.5) suggestions.push(`Review more trades on the south wall (${reviewed}/${set.length} reviewed). The coach and the Reviewer learn from your reviews.`);
  return { week: week ?? 'all', trades: set.length, verdict, scores: { risk: score('risk'), execution: score('execution'), process: score('process'), regime: score('regime') },
    reviewQuality: set.length ? Math.round(reviewed / set.length * 100) : null, rootCauses: roots, findings, suggestions, losingStreak: streak, smallSample: set.length < 20 };
}
