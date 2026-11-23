// Desk state and one trading cycle. The same code runs in the browser and in the cloud bot (bot/run.mjs).
// Paper only: fills, stops and targets are simulated on completed Aster 1m bars.
import { MIN, Scanner, intel } from './pmr.mjs';
import { grade, learn, preTrade, ruleKey } from './reviewer.mjs';

export const START = 1000;
export const DEFAULT_CFG = {
  on: true, universe: 10, minVolume: 300_000, always: [], exclude: [],
  riskPct: 1, maxNotional: 1000, levCap: 10, maxOpen: 3,
  fee: 0.0004, slip: 0.0005, minNetRR: 2.0, maxSpreadPct: 0.15, timeExitMin: 90,
};

export function freshState() {
  return { v: 1, cfg: { ...DEFAULT_CFG }, acct: { start: START, balance: START, equity: START, peak: START, maxDD: 0 },
    seen: {}, orders: [], positions: [], trades: [], decisions: [], events: [], intel: [], reviews: {},
    rules: { active: [], decided: {}, proposals: [] }, scan: [], board: [], cloud: null, lastCycle: null };
}

export function normalize(state) {
  const base = freshState();
  const s = Object.assign(base, state ?? {});
  s.cfg = Object.assign({ ...DEFAULT_CFG }, state?.cfg ?? {});
  s.acct = Object.assign(base.acct, state?.acct ?? {});
  s.rules = Object.assign({ active: [], decided: {}, proposals: [] }, state?.rules ?? {});
  return s;
}

const fix = n => Math.round(n * 1e6) / 1e6;

function event(state, t, agent, title, text, symbol) {
  state.events.unshift({ t, agent, title, text, symbol });
}

function closePosition(state, p, bar, price, reason, cfg) {
  const d = p.direction;
  const gross = d * (price - p.entry) * p.qty;
  const fees = (p.entry + price) * p.qty * cfg.fee;
  const pnl = fix(gross - fees - (p.fundingPaid ?? 0));
  state.acct.balance = fix(state.acct.balance + pnl);
  const trade = { ...p, exit: price, exitAt: bar.t, reason, pnl, fees: fix(fees), r: fix(pnl / p.riskUSDT) };
  trade.grade = grade(trade);
  state.trades.unshift(trade);
  state.positions = state.positions.filter(x => x.id !== p.id);
  event(state, bar.t, 'trader', 'CLOSED', `${p.symbol} ${reason} · ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)} (${trade.r.toFixed(2)}R)`, p.symbol);
  event(state, bar.t, 'reviewer', `GRADE ${trade.grade.letter}`, `${p.symbol} ${trade.grade.items.filter(i => i.ok).length}/${trade.grade.items.length} ✓ · ${trade.r.toFixed(2)}R`, p.symbol);
}

// Walk completed 1m bars after `checkedTo` for one open position. Stop wins when stop and target share a bar.
function manage(state, p, bars, cfg, funding) {
  const d = p.direction;
  for (const b of bars) {
    if (b.t <= p.checkedTo || b.t < p.entryAt) continue;
    p.checkedTo = b.t;
    p.mark = b.c;
    if (p.fundNext && b.t >= p.fundNext) {
      p.fundingPaid = fix((p.fundingPaid ?? 0) + d * (p.fundRate ?? 0) * p.entry * p.qty);
      p.fundNext = p.fundNext + 8 * 60 * MIN;
    }
    const stopHit = d === 1 ? b.l <= p.stop : b.h >= p.stop;
    const targetHit = b.t > p.entryAt && (d === 1 ? b.h >= p.target : b.l <= p.target);
    if (stopHit) {
      const at = d === 1 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop);
      return closePosition(state, p, b, fix(at * (1 - d * cfg.slip)), 'Stop', cfg);
    }
    if (targetHit) {
      const at = d === 1 ? Math.max(b.o, p.target) : Math.min(b.o, p.target);
      return closePosition(state, p, b, fix(at * (1 - d * cfg.slip)), 'Target', cfg);
    }
    if (b.t >= p.entryAt + cfg.timeExitMin * MIN) return closePosition(state, p, b, fix(b.c * (1 - d * cfg.slip)), 'Time exit', cfg);
  }
  if (funding && !p.fundNext) Object.assign(p, { fundNext: funding.next, fundRate: funding.rate });
}

// Pending limit at the FVG midpoint: fills on the first bar that opened after the order went live and trades through it.
function work(state, o, bars, scanner, cfg, funding) {
  const live = scanner?.proposals.find(p => p.id === o.id);
  const endedAt = live?.endedAt ?? Infinity;
  for (const b of bars) {
    if (b.t <= o.checkedTo) continue;
    if (b.t - MIN < o.activeAfter) { o.checkedTo = b.t; continue; }
    if (b.t > o.plan.expiresAt || b.t > endedAt) {
      state.orders = state.orders.filter(x => x.id !== o.id);
      const reason = b.t > endedAt ? live.endReason : 'ENTRY_WINDOW_PASSED';
      state.decisions.unshift({ id: o.id, t: b.t, symbol: o.symbol, status: 'No fill', reason, plan: o.plan });
      event(state, b.t, 'trader', 'NO FILL', `${o.symbol} limit cancelled · ${reason.toLowerCase().replaceAll('_', ' ')}.`, o.symbol);
      return;
    }
    o.checkedTo = b.t;
    const d = o.direction;
    if (d === 1 ? b.l > o.entry : b.h < o.entry) continue;
    const price = d === 1 ? Math.min(b.o, o.entry) : Math.max(b.o, o.entry);
    state.orders = state.orders.filter(x => x.id !== o.id);
    const p = { ...o, entry: price, entryAt: b.t, checkedTo: b.t - MIN, mark: b.c };
    delete p.activeAfter;
    state.positions.push(p);
    event(state, b.t, 'trader', 'FILLED', `${o.symbol} ${d === 1 ? 'long' : 'short'} ${o.qty} @ ${price} · stop ${o.stop} · target ${o.target}`, o.symbol);
    manage(state, p, bars, cfg, funding);
    return;
  }
}

export function equityOf(state) {
  const open = state.positions.reduce((s, p) => s + p.direction * ((p.mark ?? p.entry) - p.entry) * p.qty - (p.fundingPaid ?? 0), 0);
  return fix(state.acct.balance + open);
}

// One cycle: scan → manage orders/positions → review new proposals → grade → learn. `market` comes from loadMarket().
export function cycle(input, market, { now = market.t, by = 'cloud', makeScanner = (symbol, series, opts) => new Scanner(symbol, series, opts) } = {}) {
  const state = normalize(structuredClone(input));
  const cfg = state.cfg;
  const { universe, bars, book, funding } = market;
  const scanners = {};
  const intelItems = [];
  for (const symbol of universe.watch) {
    const series = bars[symbol] ?? [];
    if (!series.length) continue;
    const sc = makeScanner(symbol, series, { tickSize: universe.specs[symbol]?.tickSize });
    scanners[symbol] = sc;
    intelItems.push(...intel(sc));
  }

  for (const o of [...state.orders]) work(state, o, bars[o.symbol] ?? [], scanners[o.symbol], cfg, funding[o.symbol]);
  for (const p of [...state.positions]) manage(state, p, bars[p.symbol] ?? [], cfg, funding[p.symbol]);

  const lastClosed = Math.floor(now / MIN) * MIN;
  const proposals = Object.values(scanners).flatMap(sc => sc.proposals)
    .filter(p => !state.seen[p.id] && p.expiresAt > lastClosed && !(p.endedAt <= lastClosed)).sort((a, b) => a.signalAt - b.signalAt);
  for (const plan of proposals) {
    state.seen[plan.id] = now;
    event(state, plan.signalAt, 'trader', 'PROPOSAL', `${plan.symbol} ${plan.direction === 1 ? 'long' : 'short'} @ ${plan.entry} · ${plan.pattern.type.replaceAll('_', ' ')} · ${plan.grade}`, plan.symbol);
    const openNotional = state.positions.reduce((s, p) => s + p.entry * p.qty, 0) + state.orders.reduce((s, o) => s + o.entry * o.qty, 0);
    const decision = !cfg.on ? { ok: false, reason: 'TRADING_OFF' } : preTrade(plan, {
      cfg, equity: equityOf(state), openNotional, openCount: state.positions.length + state.orders.length,
      holding: [...state.positions, ...state.orders].some(x => x.symbol === plan.symbol),
      spec: universe.specs[plan.symbol], book: book[plan.symbol], funding: funding[plan.symbol], active: state.rules.active,
    });
    state.decisions.unshift({ id: plan.id, t: now, symbol: plan.symbol, status: decision.ok ? 'Approved' : 'Declined', reason: decision.reason, plan,
      netRR: decision.size?.netRR ?? decision.netRR ?? null });
    if (!decision.ok) {
      event(state, now, 'reviewer', 'DECLINED', `${plan.symbol} · ${decision.reason}`, plan.symbol);
      continue;
    }
    const { qty, riskUSDT, netRR } = decision.size;
    event(state, now, 'reviewer', 'APPROVED', `${plan.symbol} qty ${qty} · risk $${riskUSDT.toFixed(2)} · net R:R ${netRR.toFixed(2)}`, plan.symbol);
    const order = { id: plan.id, symbol: plan.symbol, direction: plan.direction, entry: plan.entry, stop: plan.stop, target: plan.target,
      qty, riskUSDT: fix(riskUSDT), netRR: fix(netRR), plan, by, activeAfter: lastClosed, checkedTo: lastClosed };
    state.orders.push(order);
    work(state, order, bars[plan.symbol] ?? [], scanners[plan.symbol], cfg, funding[plan.symbol]);
  }

  const equity = equityOf(state);
  Object.assign(state.acct, { equity, peak: Math.max(state.acct.peak, equity) });
  state.acct.maxDD = Math.max(state.acct.maxDD, (state.acct.peak - equity) / state.acct.peak);
  state.rules.proposals = learn(state.trades, state.reviews, { ...state.rules.decided,
    ...Object.fromEntries(state.rules.active.map(r => [ruleKey(r), 'active'])) });

  const scanEvents = Object.values(scanners).flatMap(sc => sc.events.filter(e => e.t > now - 6 * 60 * MIN));
  const merged = [...state.events.filter(e => e.agent === 'trader' || e.agent === 'reviewer' && e.title !== 'SKIPPED'), ...scanEvents];
  const keys = new Set();
  state.events = merged.filter(e => { const k = `${e.t}|${e.title}|${e.symbol}|${e.text}`; return !keys.has(k) && keys.add(k); })
    .sort((a, b) => b.t - a.t).slice(0, 300);
  state.intel = intelItems.sort((a, b) => b.t - a.t).slice(0, 80);
  state.scan = Object.values(scanners).map(sc => ({ ...sc.summary(), price: sc.last?.c,
    h1: sc.history[60].slice(-48), m15: sc.history[15].slice(-64), m5: sc.history[5].slice(-72) }));
  state.board = universe.board.slice(0, 40);
  for (const [id, t] of Object.entries(state.seen)) if (t < now - 7 * 24 * 60 * MIN) delete state.seen[id];
  state.decisions = state.decisions.slice(0, 200);
  state.lastCycle = { t: now, by, watch: universe.watch.length };
  return state;
}

// Strip chart payloads before saving to the shared data repo.
export function persistable(state) {
  const { scan, ...rest } = state;
  return { ...rest, scan: scan.map(({ h1, m15, m5, ...s }) => s) };
}
