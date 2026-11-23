// Reviewer: pre-trade checks, post-trade grading, and rule proposals learned from trades and Fred's reviews.
// Learned rules are PROPOSALS. They only gate trades after Fred approves them in the Reviewer panel.

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

export function features(plan) {
  return { pattern: plan.pattern.type, side: plan.direction === 1 ? 'long' : 'short', poi: plan.poi.type,
    grade: plan.grade, session: usSession(plan.signalAt) ? 'us' : 'off', sweep: plan.sweep ? 'sweep' : 'nosweep' };
}

export const RULES = {
  avoidPattern: { label: v => `No ${v.replaceAll('_', ' ')} setups`, test: (f, v) => f.pattern === v },
  avoidSide: { label: v => `No ${v} trades`, test: (f, v) => f.side === v },
  avoidPoi: { label: v => `No 15m ${v} entries`, test: (f, v) => f.poi === v },
  aPlusOnly: { label: () => 'A+ setups only (confluence + sweep)', test: f => f.grade !== 'A+' },
  usHoursOnly: { label: () => 'US regular hours only', test: f => f.session !== 'us' },
};
export const ruleKey = r => `${r.rule}:${r.value ?? ''}`;
export const ruleLabel = r => RULES[r.rule]?.label(r.value ?? '') ?? r.rule;

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
  const due = funding && funding.next > plan.signalAt && funding.next < plan.expiresAt + cfg.timeExitMin * 60_000;
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
  add(trade.plan.sweep, 'Liquidity sweep at the retest', 10);
  add(trade.plan.poi.confluence, '15m OB/FVG confluence', 10);
  add(trade.netRR >= 3, `Net R:R ${trade.netRR.toFixed(2)} (≥ 3 is strong)`, 10);
  add(trade.entryAt - trade.plan.signalAt <= 15 * 60_000, 'Filled within 15 min of the signal', 5);
  add(usSession(trade.plan.signalAt), 'Signal during US regular hours', 5);
  if (trade.r >= 1.5) score += 30; else if (trade.r > 0) score += 15; else if (trade.r <= -0.9) score -= 15;
  if (trade.reason === 'Time exit' && trade.r < 0) { score -= 5; items.push({ ok: false, text: 'Time exit at a loss: no follow-through' }); }
  const letter = score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : score >= 25 ? 'D' : 'F';
  return { letter, score, items };
}

const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

// Learn rule proposals. Trades: bucket with n ≥ minN, both time halves losing, total ≤ −3R.
// Reviews: the same complaint on ≥ 3 of Fred's reviews in a bucket.
export function learn(trades, reviews, decided = {}, minN = 8) {
  const out = [];
  const consider = (rule, value, evidence) => {
    const key = ruleKey({ rule, value });
    if (decided[key] || out.some(p => ruleKey(p) === key)) return;
    out.push({ rule, value, evidence });
  };
  const closed = trades.filter(t => Number.isFinite(t.r)).sort((a, b) => a.exitAt - b.exitAt);
  const buckets = [['pattern', 'avoidPattern'], ['side', 'avoidSide'], ['poi', 'avoidPoi'], ['grade', 'aPlusOnly', 'A'], ['session', 'usHoursOnly', 'off']];
  for (const [field, rule, only] of buckets) {
    const values = new Set(closed.map(t => features(t.plan)[field]));
    for (const v of values) {
      if (only && v !== only) continue;
      const set = closed.filter(t => features(t.plan)[field] === v);
      const rest = closed.filter(t => features(t.plan)[field] !== v);
      if (set.length < minN) continue;
      const half = Math.floor(set.length / 2);
      const h1 = avg(set.slice(0, half).map(t => t.r)), h2 = avg(set.slice(half).map(t => t.r));
      const total = set.reduce((s, t) => s + t.r, 0);
      if (h1 < -0.1 && h2 < -0.1 && total <= -3) {
        consider(rule, only ? undefined : v, `Trades: ${field} ${v} ${avg(set.map(t => t.r)).toFixed(2)}R n${set.length} (halves ${h1.toFixed(2)} / ${h2.toFixed(2)}) vs rest ${avg(rest.map(t => t.r)).toFixed(2)}R n${rest.length}`);
      }
    }
  }
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
