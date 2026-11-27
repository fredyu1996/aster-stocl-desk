// Reviewer: pre-trade checks, post-trade grading, and rule proposals learned from trades and Fred's reviews.
// Rules: Fred's approvals of proposals from his own reviews, plus auto-learned `avoid` rules (core/learn.mjs, Fred
// 2026-11-27: learned rules are tried at once and he can remove them).

const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
export function usSession(t) {
  const p = Object.fromEntries(ny.formatToParts(t).map(x => [x.type, x.value]));
  const m = +p.hour * 60 + +p.minute;
  return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m < 960;
}

// Per-unit costs for one round trip: taker fee on entry and exit, slippage on the market exit, estimated funding.
export function economics(plan, cfg, fundingRate = 0, fundingDue = false) {
  const { entry, stop, target, direction: d } = plan;
  const funding = fundingDue ? Math.max(0, d * fundingRate) * entry : 0;
  const riskUnit = d * (entry - stop) + (entry + stop) * cfg.fee + stop * cfg.slip + funding;
  const rewardUnit = d * (target - entry) - (entry + target) * cfg.fee - target * cfg.slip - funding;
  return { riskUnit, rewardUnit, netRR: riskUnit > 0 ? rewardUnit / riskUnit : -Infinity, funding };
}

// New York time-of-day bucket of a signal: pre (4:00–9:30), open (9:30–10:30), mid (10:30–14:00), close (14:00–16:00),
// after (16:00–20:00), night, weekend.
const nyh = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
export function hourBucket(t) {
  const p = Object.fromEntries(nyh.formatToParts(t).map(x => [x.type, x.value]));
  if (['Sat', 'Sun'].includes(p.weekday)) return 'weekend';
  const m = +p.hour * 60 + +p.minute;
  return m < 240 ? 'night' : m < 570 ? 'pre' : m < 630 ? 'open' : m < 840 ? 'mid' : m < 960 ? 'close' : m < 1200 ? 'after' : 'night';
}
export function features(plan) {
  return { pattern: plan.pattern.type, side: plan.direction === 1 ? 'long' : 'short', poi: plan.poi.type,
    grade: plan.grade, session: usSession(plan.signalAt) ? 'us' : 'off', sweep: plan.sweep ? 'sweep' : 'nosweep',
    marks: plan.marks?.confluence ? 'confluence' : 'none', hour: hourBucket(plan.signalAt), symbol: String(plan.symbol ?? '').replace(/USDT$/, ''),
    tm: plan.tm?.tag ?? 'unknown', news: plan.news?.tag ?? 'unknown', earn: plan.news?.earn ?? 'unknown' };
}
// Chinese names for learned features (rule labels and the Reviewer panel).
export const FEATURE_ZH = { pattern: '1H 形態', side: '方向', poi: '15m POI', grade: 'Setup 級別', session: '時段', hour: '紐約時段', symbol: '股票',
  tm: '時光機', news: '新聞', earn: '業績' };
export const VALUE_ZH = { pre: '盤前', open: '開市第一個鐘', mid: '午市', close: '收市前', after: '盤後', night: '夜晚', weekend: '週末', us: '美股時段', off: '非美股時段',
  favour: '偏 target', even: '五五波', against: '偏 stop', earnings: '有業績', news: '有新聞', quiet: '冇新聞', yes: '有', no: '冇', long: 'long', short: 'short' };

// Fred's hand-drawn chart marks against one proposal. Auto marks and marks placed after the signal bar don't count.
// Veto: his latest MSS points the other way, or the entry sits inside one of his opposite-direction FVG / OB zones.
// Confluence (recorded, not required): one of his same-direction FVG / OB zones overlaps the 15m POI or the 5m entry FVG.
const sideOf = d => d === 1 ? 'bull' : 'bear';
const hand = (marks, at) => (Array.isArray(marks) ? marks : []).filter(m => m && !m.auto && Number.isFinite(m.t1) && m.t1 <= at);
export function latestMss(marks, at = Infinity) {
  return hand(marks, at).filter(m => m.type === 'mss' && (m.dir === 'bull' || m.dir === 'bear'))
    .sort((a, b) => a.t1 - b.t1 || (a.at ?? 0) - (b.at ?? 0)).at(-1) ?? null;
}
export function markCheck(plan, marks) {
  const mine = hand(marks, plan.signalAt), side = sideOf(plan.direction), px = n => Number(n).toFixed(2);
  const zone = m => ({ lo: Math.min(m.p1, m.p2), hi: Math.max(m.p1, m.p2) });
  const zones = mine.filter(m => (m.type === 'fvg' || m.type === 'ob') && Number.isFinite(m.p1) && Number.isFinite(m.p2));
  const mss = latestMss(mine);
  const ranges = [plan.poi, plan.fvg].filter(r => r && Number.isFinite(r.lo) && Number.isFinite(r.hi));
  const withIds = zones.filter(m => m.dir === side && ranges.some(r => zone(m).lo <= r.hi && zone(m).hi >= r.lo)).map(m => m.id);
  const summary = { confluence: withIds.length > 0, with: withIds, mss: mss?.dir ?? null, count: mine.length };
  if (mss && mss.dir !== side) return { veto: `MARK · your ${mss.dir} MSS ${mss.tf ?? ''} @ ${px(mss.p1)} is against this ${side === 'bull' ? 'long' : 'short'}`, against: mss.id, summary };
  const inside = zones.find(m => m.dir !== side && zone(m).lo <= plan.entry && plan.entry <= zone(m).hi);
  if (inside) return { veto: `MARK · entry ${px(plan.entry)} is inside your ${inside.dir} ${inside.type.toUpperCase()} ${inside.tf ?? ''} ${px(zone(inside).lo)}–${px(zone(inside).hi)}`, against: inside.id, summary };
  return { veto: null, against: null, summary };
}

export const RULES = {
  avoidPattern: { label: v => `唔做 ${v.replaceAll('_', ' ')} setup`, test: (f, v) => f.pattern === v },
  avoidSide: { label: v => `唔做 ${v}`, test: (f, v) => f.side === v },
  avoidPoi: { label: v => `唔做 15m ${v} 入場`, test: (f, v) => f.poi === v },
  aPlusOnly: { label: () => '只做 A+ setup（confluence + sweep）', test: f => f.grade !== 'A+' },
  usHoursOnly: { label: () => '只做美股正常交易時段', test: f => f.session !== 'us' },
  marksConfluenceOnly: { label: () => '只做中咗你同方向 FVG / OB 標記嘅 setup', test: f => f.marks !== 'confluence' },
  // value 'field=value' (auto-learned, core/learn.mjs)
  avoid: { label: v => { const [f, x] = String(v).split('='); return `唔做 ${FEATURE_ZH[f] ?? f} = ${VALUE_ZH[x] ?? x}`; }, test: (f, v) => { const [k, x] = String(v).split('='); return String(f[k]) === x; } },
};
export const ruleKey = r => `${r.rule}:${r.value ?? ''}`;
export const ruleLabel = r => RULES[r.rule]?.label(r.value ?? '') ?? r.rule;

// Time exit in ms after entry; Infinity when cfg.timeExitMin is null / 0 (held until stop or target).
export const timeExitMs = cfg => Number.isFinite(cfg.timeExitMin) && cfg.timeExitMin > 0 ? cfg.timeExitMin * 60_000 : Infinity;

// Decide on one proposal. Returns { ok, reason, size } where size has qty, riskUSDT, netRR.
export function preTrade(plan, { cfg, equity, openNotional, openCount, holding, spec, book, funding, active }) {
  const f = features(plan);
  for (const r of active) if (RULES[r.rule]?.test(f, r.value)) return { ok: false, reason: `RULE · ${ruleLabel(r)}` };
  if (holding) return { ok: false, reason: 'ALREADY_IN_SYMBOL' };
  if (openCount >= cfg.maxOpen) return { ok: false, reason: 'MAX_OPEN_POSITIONS' };
  if (book && book.bid > 0 && book.ask > 0) {
    const spread = (book.ask - book.bid) / ((book.ask + book.bid) / 2) * 100;
    if (spread > cfg.maxSpreadPct) return { ok: false, reason: `SPREAD ${spread.toFixed(2)}% > ${cfg.maxSpreadPct}%` };
  }
  // With no time exit the hold is open-ended, so the next funding always counts.
  const due = funding && funding.next > plan.signalAt && funding.next < plan.expiresAt + timeExitMs(cfg);
  const e = economics(plan, cfg, funding?.rate ?? 0, due);
  if (!(e.netRR >= cfg.minNetRR)) return { ok: false, reason: `NET_RR ${Number.isFinite(e.netRR) ? e.netRR.toFixed(2) : '—'} < ${cfg.minNetRR}`, netRR: e.netRR };
  const riskUSDT = equity * cfg.riskPct / 100;
  const room = Math.min(cfg.maxNotional, equity * cfg.levCap - openNotional);
  const step = spec?.stepSize || 0.001;
  const qty = Math.floor(Math.min(riskUSDT / e.riskUnit, room / plan.entry) / step + 1e-9) * step;
  const q = Number(qty.toFixed(10));
  if (!(q > 0) || q < (spec?.minQty ?? 0) || q * plan.entry < (spec?.minNotional ?? 5)) return { ok: false, reason: 'SIZE_BELOW_EXCHANGE_MINIMUM' };
  return { ok: true, reason: 'APPROVED', size: { qty: q, riskUSDT: q * e.riskUnit, netRR: e.netRR, notional: q * plan.entry } };
}

// Post-trade grade: process and outcome, with the ✓/✗ items shown on the review wall.
export function grade(trade) {
  const items = [];
  let score = 25;
  const add = (ok, text, pts) => { items.push({ ok, text }); score += ok ? pts : 0; };
  add(trade.plan.sweep, '回測時有 liquidity sweep', 10);
  add(trade.plan.poi.confluence, '15m OB / FVG 重疊', 10);
  add(trade.netRR >= 3, `Net R:R ${trade.netRR.toFixed(2)}（≥ 3 算強）`, 10);
  add(trade.entryAt - trade.plan.signalAt <= 15 * 60_000, '訊號後 15 分鐘內成交', 5);
  add(usSession(trade.plan.signalAt), '訊號喺美股正常交易時段', 5);
  add(!!trade.plan.marks?.confluence, '中咗你同方向嘅 FVG / OB 標記', 0);
  if (trade.r >= 1.5) score += 30; else if (trade.r > 0) score += 15; else if (trade.r <= -0.9) score -= 15;
  if (trade.reason === 'Time exit' && trade.r < 0) { score -= 5; items.push({ ok: false, text: '時間離場又蝕：冇 follow-through' }); }
  const letter = score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : score >= 25 ? 'D' : 'F';
  return { letter, score, items };
}

const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

// Rule proposals from Fred's reviews: the same complaint on ≥ 3 of his reviews. Trade buckets are learned automatically
// (core/learn.mjs); these stay proposals because they are his opinion, not the numbers.
export function learn(trades, reviews, decided = {}) {
  const out = [];
  const consider = (rule, value, evidence) => {
    const key = ruleKey({ rule, value });
    if (decided[key] || out.some(p => ruleKey(p) === key)) return;
    out.push({ rule, value, evidence });
  };
  const byId = new Map(trades.map(t => [t.id, t]));
  const tally = new Map();
  for (const [id, rv] of Object.entries(reviews)) {
    const t = byId.get(id);
    if (!t || rv.exclude) continue;
    const f = features(t.plan);
    const bump = (rule, value) => tally.set(ruleKey({ rule, value }), { rule, value, n: (tally.get(ruleKey({ rule, value }))?.n ?? 0) + 1 });
    const skip = rv.a?.includes('skip');
    if (skip && rv.b?.includes('pattern')) bump('avoidPattern', f.pattern);
    if (skip && rv.b?.includes('poi')) bump('avoidPoi', f.poi);
    if (skip && rv.b?.includes('session') && f.session === 'off') bump('usHoursOnly');
    if (skip && f.grade === 'A' && (rv.b?.includes('retest') || rv.b?.includes('fvg'))) bump('aPlusOnly');
    if (rv.a?.includes('flip')) bump('avoidSide', f.side);
  }
  for (const r of tally.values()) if (r.n >= 3) consider(r.rule, r.value, `Fred's reviews: ${r.n} say skip / other side`);
  return out;
}
