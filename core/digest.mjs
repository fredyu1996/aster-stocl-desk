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
    if (t.r < -1.25) { add('risk', 'critical', `${t.symbol}：蝕咗 ${t.r.toFixed(2)}R，計劃係 1R（stop 跳空或者滑價）。`, t); root = 'risk_sizing'; }
    else if (t.r < -1.02) { add('risk', 'warning', `${t.symbol}：蝕咗 ${t.r.toFixed(2)}R，多過計劃嘅 1R。`, t); root = 'risk_sizing'; }
    const delay = (t.entryAt - (t.plan?.signalAt ?? t.entryAt)) / 60_000;
    if (delay > 15) { add('execution', t.r < 0 ? 'warning' : 'info', `${t.symbol}：訊號後 ${Math.round(delay)} min 先成交（遲入）。`, t); if (t.r < 0) root ??= 'execution'; }
    const rec = t.plan?.market?.rec;
    if (rec && rec !== 'NEW_ENTRY_ALLOWED') { add('regime', 'warning', `${t.symbol}：exposure coach 講緊 ${rec} 嗰陣入嘅。你冇設市況閘，所以唔算犯規。`, t); if (t.r < 0) root ??= 'market_environment'; }
    if (t.reason === 'Time exit' && t.r < 0) { add('process', 'info', `${t.symbol}：${t.r.toFixed(2)}R 時間離場，冇 follow-through。`, t); root ??= 'thesis_quality'; }
    const rv = reviews[t.id];
    if (rv && rv.agree === false) add('process', 'warning', `${t.symbol}：你唔同意 Reviewer 嘅評分${rv.comment ? `（「${String(rv.comment).slice(0, 80)}」）` : ''}。`, t);
    if (t.r < 0) { root ??= 'randomness'; roots[root] = (roots[root] ?? 0) + 1; }
  }
  // Streak and weekly loss: the desk has no limits for these, so they are reported as unclear, never as violations.
  let streak = 0;
  for (let i = set.length - 1; i >= 0 && set[i].r < 0; i--) streak++;
  if (streak >= 3) add('risk', 'warning', `連蝕 ${streak} 單。冇設連蝕上限，所以係未清楚，唔係犯規。`);
  const byWeek = {};
  for (const t of set) byWeek[weekOf(t.exitAt)] = (byWeek[weekOf(t.exitAt)] ?? 0) + t.pnl;
  for (const [w, pnl] of Object.entries(byWeek)) if (pnl / start <= -0.05) add('risk', 'warning', `${w} 嗰個星期：起始本金嘅 ${(pnl / start * 100).toFixed(1)}%。冇設每週虧損上限。`);

  const score = axis => Math.max(0, 100 - sum(findings.filter(f => f.axis === axis).map(f => PTS[f.severity])));
  const crit = findings.filter(f => f.severity === 'critical').length, warn = findings.filter(f => f.severity === 'warning').length;
  const verdict = !set.length ? 'NO_TRADES' : crit >= 2 ? 'COOL_DOWN' : crit >= 1 || warn >= 3 ? 'REVIEW_REQUIRED' : warn ? 'WARN' : 'OK';
  const reviewed = set.filter(t => reviews[t.id]).length;
  const suggestions = [];
  const lost = (pred) => set.filter(t => t.r < 0 && pred(t));
  if (findings.some(f => f.axis === 'risk' && f.severity === 'critical')) suggestions.push('睇下離場滑價同 stop 跳空：有啲蝕單大過計劃嘅 1R。可以考慮將滑價設定調高，等注碼計返入去。');
  const regimeLosses = lost(t => t.plan?.market?.rec && t.plan.market.rec !== 'NEW_ENTRY_ALLOWED');
  if (regimeLosses.length >= 3) suggestions.push(`有 ${regimeLosses.length} 單蝕單係 exposure coach 叫減倉 / 持現金時入嘅。要加市況閘，先要你批准，同埋要多啲交易做證據。`);
  if (lost(t => t.reason === 'Time exit').length >= 3) suggestions.push('幾單時間離場都係蝕。改之前先睇下 90 分鐘離場啱唔啱呢啲股。');
  if (set.length && reviewed / set.length < 0.5) suggestions.push(`去南牆多覆盤幾單（覆咗 ${reviewed}/${set.length}）。Coach 同 Reviewer 係靠你嘅覆盤學嘢。`);
  return { week: week ?? 'all', trades: set.length, verdict, scores: { risk: score('risk'), execution: score('execution'), process: score('process'), regime: score('regime') },
    reviewQuality: set.length ? Math.round(reviewed / set.length * 100) : null, rootCauses: roots, findings, suggestions, losingStreak: streak, smallSample: set.length < 20 };
}
