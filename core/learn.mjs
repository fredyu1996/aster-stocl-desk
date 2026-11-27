// Self-learning from losing trades (Fred, 2026-11-27: 「我想啲 agent 可以自己從輸咗嘅 trade 入面學習」, and he chose
// 「自動試用，你可以否決」). Live PMR trades are rare (about one a month), so the Reviewer learns from three sources at once:
//   bt     the nightly backtest's PMR trades for the live preset and bar source (state.learn.rows, from stock-backtest.json)
//   live   the desk's own closed PMR trades
//   replay declined proposals replayed by the postmortem (what they would have done)
// A rule is learned only when it holds out of sample: the pooled rows are split in time; the bucket must lose in the first
// half (discovery) AND in the second half (validation), lose ≥ 3R in total, and do worse than everything else in both
// halves. Learned rules become active at once, marked auto, with their evidence. Fred removes one with a click; a removed
// key goes into rules.decided and is never learned again. An auto rule whose bucket stops losing is retired by itself.
// Guards: at most half of the rows can be blocked by auto rules together, and at least 10 rows must stay.
import { features } from './reviewer.mjs';

export const LEARN_FIELDS = ['pattern', 'side', 'poi', 'grade', 'session', 'hour', 'symbol', 'tm', 'news', 'earn'];
export const LEARN = { minHalf: 6, discAvg: -0.15, valAvg: -0.1, total: -3, maxBlocked: 0.5, minRest: 10 };

const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const r2 = v => Math.round(v * 100) / 100;
export const autoKey = (field, value) => `avoid:${field}=${value}`;

// All learning rows, oldest first. A backtest row that duplicates a live trade or replay (same symbol and signal minute) is dropped.
export function learningRows(state) {
  const rows = [];
  for (const t of state.trades ?? []) if (Number.isFinite(t.r) && t.plan) rows.push({ k: `${t.symbol}|${Math.floor(t.plan.signalAt / 60_000)}`, t: t.plan.signalAt, R: t.r, f: features(t.plan), src: 'live' });
  for (const d of state.decisions ?? []) {
    if (d.status !== 'Declined' || !d.post?.done || !d.post.filled || !Number.isFinite(d.post.r) || !d.plan) continue;
    rows.push({ k: `${d.symbol}|${Math.floor(d.plan.signalAt / 60_000)}`, t: d.plan.signalAt, R: d.post.r, f: features(d.plan), src: 'replay' });
  }
  const seen = new Set(rows.map(r => r.k));
  const L = state.learn;
  if (L?.rows?.length && L.preset === state.cfg.pmrPreset && L.source === (state.cfg.pmrSource ?? 'trade')) {
    for (const b of L.rows) { const k = `${b.s}|${Math.floor(b.t / 60_000)}`; if (!seen.has(k)) rows.push({ k, t: b.t, R: b.R, f: b.f, src: 'bt' }); }
  }
  return rows.sort((a, b) => a.t - b.t);
}

function bucketStats(rows, field, value, split) {
  const inB = r => String(r.f?.[field]) === value;
  const part = (xs, test) => xs.filter(test);
  const h1 = rows.filter(r => r.t < split), h2 = rows.filter(r => r.t >= split);
  const b1 = part(h1, inB), b2 = part(h2, inB), o1 = part(h1, r => !inB(r)), o2 = part(h2, r => !inB(r));
  return { n1: b1.length, n2: b2.length, a1: avg(b1.map(r => r.R)), a2: avg(b2.map(r => r.R)), o1: avg(o1.map(r => r.R)), o2: avg(o2.map(r => r.R)),
    total: [...b1, ...b2].reduce((s, r) => s + r.R, 0), n: b1.length + b2.length, srcs: [...b1, ...b2].reduce((m, r) => (m[r.src] = (m[r.src] ?? 0) + 1, m), {}) };
}
const qualifies = (s, L = LEARN) => s.n1 >= L.minHalf && s.n2 >= L.minHalf && s.a1 <= L.discAvg && s.a2 <= L.valAvg && s.total <= L.total && s.a1 < s.o1 && s.a2 < s.o2;
const evidenceOf = (field, value, s) => `${field}=${value}: 前半 ${r2(s.a1)}R（n ${s.n1}）vs 其他 ${r2(s.o1)}R · 後半 ${r2(s.a2)}R（n ${s.n2}）vs 其他 ${r2(s.o2)}R · 合共 ${r2(s.total)}R · 來源 ${Object.entries(s.srcs).map(([k, v]) => `${k} ${v}`).join(' / ')}`;

// Returns the new active list and what changed. `decided` = keys Fred approved / rejected / removed (never auto-learned again).
export function autoLearn(rows, active = [], decided = {}, { now = Date.now(), L = LEARN } = {}) {
  const added = [], retired = [];
  if (rows.length < 2 * L.minHalf + L.minRest) return { active, added, retired, n: rows.length };
  const split = rows[Math.floor(rows.length / 2)].t;
  const blockedBy = (list, r) => list.some(a => { const [f, v] = String(a.value).split('='); return String(r.f?.[f]) === v; });
  // 1. retire auto rules whose bucket no longer loses in the second half
  let kept = active.filter(a => {
    if (!a.auto) return true;
    const [f, v] = String(a.value).split('=');
    const s = bucketStats(rows, f, v, split);
    if (s.n2 >= L.minHalf && s.a2 > 0) { retired.push({ ...a, why: `後半 ${r2(s.a2)}R（n ${s.n2}）唔再蝕` }); return false; }
    return true;
  });
  // 2. learn new ones, worst first, within the coverage guard
  const cands = [];
  for (const field of LEARN_FIELDS) {
    const values = new Set(rows.map(r => String(r.f?.[field])).filter(v => v && v !== 'undefined' && v !== 'unknown' && v !== 'null'));
    for (const value of values) {
      const key = autoKey(field, value);
      if (decided[key] || kept.some(a => `${a.rule}:${a.value}` === key)) continue;
      const s = bucketStats(rows, field, value, split);
      if (qualifies(s, L)) cands.push({ field, value, s });
    }
  }
  cands.sort((a, b) => a.s.total - b.s.total);
  for (const c of cands) {
    const next = [...kept.filter(a => a.auto), { value: `${c.field}=${c.value}` }];
    const blocked = rows.filter(r => blockedBy(next, r)).length;
    if (blocked > L.maxBlocked * rows.length || rows.length - blocked < L.minRest) continue;
    const rule = { rule: 'avoid', value: `${c.field}=${c.value}`, auto: true, at: now, evidence: evidenceOf(c.field, c.value, c.s) };
    kept = [...kept, rule]; added.push(rule);
  }
  return { active: kept, added, retired, n: rows.length, split };
}

// The nightly backtest's PMR trades (stock-backtest.json → pmr.sample) as the learning sample. Public file, no token.
export function learnFromReport(report, at = Date.now()) {
  const x = report?.pmr?.sample;
  if (!x?.rows) return null;
  return { at, t: report.t, preset: x.preset, source: x.source, days: report.days, symbols: report.symbols?.length ?? null, rows: x.rows };
}
export const REPORT_URL = repo => `https://raw.githubusercontent.com/${repo}/backtest-report/stock-backtest.json`;
export async function fetchLearnSample(repo, { fetchFn = fetch, now = Date.now() } = {}) {
  const r = await fetchFn(`${REPORT_URL(repo)}?t=${Math.floor(now / 6e5)}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`report ${r.status}`);
  return learnFromReport(await r.json(), now);
}
export const LEARN_EVERY = 6 * 3600_000;

// Summary for the Reviewer panel.
export function learnSummary(rows) {
  const by = rows.reduce((m, r) => (m[r.src] = (m[r.src] ?? 0) + 1, m), {});
  return { n: rows.length, by, totalR: r2(rows.reduce((s, r) => s + r.R, 0)), from: rows[0]?.t ?? null, to: rows.at(-1)?.t ?? null };
}
