import { isStock, loadMarket } from '../core/aster.mjs';
import { choosePicks, cycle, freshState, normalize, persistable, pickInput } from '../core/desk.mjs';
import { store, update } from '../core/github.mjs';
import { Scanner } from '../core/pmr.mjs';
import { coach, digest, weeks } from '../core/digest.mjs';
import { filterReport } from '../core/postmortem.mjs';
import { loadPosture } from '../core/regime.mjs';
import { features, learn, ruleKey, ruleLabel } from '../core/reviewer.mjs';
import { C, ago, drawCandles, fmt, hhmm, money, pct, tradeOverlay } from './charts.mjs';
import { DESKS, createWorld } from './scene.mjs';
import { createChartWall } from './wall.mjs';
import { SMC_ADJ, SMC_SOURCE, smcCore, withSmc } from '../core/smc.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
const QUIET = 30 * 60_000;

let state = normalize(LS.get('asd_state', null));
let sync = LS.get('asd_sync', { repo: 'fredyu1996/aster-desk-data', branch: 'stocks-state', token: '' });
let scanMap = {};
let status = { feed: 'Connecting', note: '', source: 'local paper', at: 0 };
let panel = null;
let busy = false;
const cache = {};
const st = () => sync.token ? store({ token: sync.token, repo: sync.repo, branch: sync.branch }) : null;

const world = createWorld($('#scene'), {
  onPick(id, uv) {
    if (id === 'board') { openWall(world.boardAt(uv)); return; }
    if (id === 'reviews') { const t = world.reviewAt(uv); open(t ? `review:${t}` : 'reviewer', 'reviews'); return; }
    const to = { positions: 'trader', rules: 'reviewer' }[id];
    open(to ?? id, to ? id : undefined);
  },
});

// Picks wall (north wall, B): interactive charts of the Screener's picks. Fred's marks save to state.marks.
let pendingMarks = {}, marksTimer = 0;
const wall = createChartWall($('#chartwall'), {
  state: () => state, scan: () => scanMap,
  setMarks(sym, list) {
    state.marks = { ...state.marks, [sym]: list };
    pendingMarks[sym] = list;
    clearTimeout(marksTimer); marksTimer = setTimeout(flushMarks, sync.token ? 1500 : 250);
    world.update({ state, scanMap, source: status.source, ruleLabel });
  },
  togglePick(sym, kind) {
    const [list, other] = kind === 'pin' ? ['pins', 'skips'] : ['skips', 'pins'];
    mutate(s => {
      s[list] = s[list].includes(sym) ? s[list].filter(x => x !== sym) : [...s[list], sym];
      s[other] = s[other].filter(x => x !== sym);
    }).then(() => { if (kind === 'pin') refresh(); });
  },
  addPin(sym) {
    const info = cache.info?.symbols?.find(x => x.symbol === sym);
    if (cache.info && !(info && isStock(info))) { status.note = `${sym} is not a trading Aster stock perp`; render(); return; }
    if (state.pins.includes(sym)) return;
    mutate(s => { s.pins = [...s.pins.filter(x => x !== sym), sym]; s.skips = s.skips.filter(x => x !== sym); }).then(refresh);
  },
  onClose() { render(); },
});
async function flushMarks() {
  const batch = pendingMarks;
  pendingMarks = {};
  if (!Object.keys(batch).length) return;
  await mutate(s => { Object.assign(s.marks, batch); });
  Object.assign(state.marks, pendingMarks); // edits made while saving stay visible until the next flush
}
function openWall(sym) {
  close();
  world.goTo('board');
  wall.show(sym);
}

function render() {
  const view = { state, scanMap, source: status.source, ruleLabel };
  world.update(view);
  wall.update();
  const a = state.acct;
  $('#hud').innerHTML = `
    <b>Aster Stock Desk</b>
    <span>Equity <b>${money(a.equity)}</b> <i class="${a.equity >= a.start ? 'up' : 'down'}">${pct((a.equity / a.start - 1) * 100)}</i></span>
    <span>Picks <b>${state.picks.length}</b> · Open ${state.positions.length} · Pending ${state.orders.length} · Trades ${state.trades.length}</span>
    <span>Feed <b class="${status.feed === 'Live' ? 'up' : 'warn'}">${esc(status.feed)}</b>${status.at ? ` · ${hhmm(status.at)}` : ''}</span>
    <span>${esc(status.source)}${state.lastCycle ? ` · last cycle ${esc(state.lastCycle.by)} ${ago(state.lastCycle.t)} ago` : ''}</span>
    ${status.note ? `<span class="warn">${esc(status.note)}</span>` : ''}`;
  if (panel) renderPanel();
}

// Symbols always scanned: what the account holds plus Fred's pinned picks.
function held(s) { return [...s.orders, ...s.positions].map(x => x.symbol).concat(s.pins ?? []); }

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    let market;
    try {
      market = await loadMarket(state.cfg, held(state), { cache });
      status.feed = 'Live'; status.at = market.t; status.note = '';
      // Market posture (breadth + uptrend CSVs) refreshes at most hourly; display and record only.
      if (!(market.t - (state.market?.at ?? 0) < 60 * 60_000) && !(market.t - (cache.postureAt ?? 0) < 60 * 60_000)) {
        cache.postureAt = market.t;
        market.posture = await loadPosture({ at: market.t }).catch(e => ({ at: market.t, errors: [e.message] }));
      }
    } catch (e) { status.feed = 'Offline'; status.note = e.message; return; }
    scanMap = Object.fromEntries(market.universe.watch.map(sym => {
      const sc = new Scanner(sym, market.bars[sym] ?? [], { tickSize: market.universe.specs[sym]?.tickSize });
      return [sym, { ...sc.summary(), price: sc.last?.c, h1: sc.history[60].slice(-48), m15: sc.history[15].slice(-64), m5: sc.history[5].slice(-72) }];
    }));
    const core = await smcCore(market.info).catch(e => { status.note = `SMC Trader: ${e.message}`; return null; });
    const store_ = st();
    if (!store_) {
      state = withSmc(cycle(state, market, { by: 'browser' }), market, core);
      LS.set('asd_state', persistable(state));
      status.source = 'local paper (this browser)';
      return;
    }
    const { state: remote } = await store_.read();
    const shared = normalize(remote);
    const cloudQuiet = !shared.lastCycle || Date.now() - shared.lastCycle.t > QUIET || shared.lastCycle.by === 'browser';
    if (cloudQuiet) {
      const res = await update(store_, s => persistable(withSmc(cycle(normalize(s), market, { by: 'browser' }), market, core)));
      state = normalize(res.state);
      status.source = `shared · this browser trades (cloud quiet${shared.cloud ? ` ${ago(shared.cloud.t)}` : ''})`;
    } else {
      state = shared;
      status.source = `shared · cloud trades (run ${shared.cloud?.run ?? '—'}, ${ago(shared.cloud?.t ?? shared.lastCycle.t)} ago)`;
    }
  } catch (e) {
    status.note = e.message;
  } finally {
    busy = false;
    Object.assign(state.marks, pendingMarks);
    render();
  }
}

// Apply a change to the account (reviews, rules, settings): local storage, or read → change → write on the data repo.
async function mutate(fn) {
  const store_ = st();
  const apply = s => { const n = normalize(s); fn(n); n.picks = choosePicks(n.scan, pickInput(n)); n.rules.proposals = learn(n.trades, n.reviews, { ...n.rules.decided, ...Object.fromEntries(n.rules.active.map(r => [ruleKey(r), 'active'])) }); return n; };
  try {
    if (store_) state = normalize((await update(store_, s => persistable(apply(s)))).state);
    else { state = apply(state); LS.set('asd_state', persistable(state)); }
    status.note = '';
  } catch (e) { status.note = `Save failed: ${e.message}`; }
  render();
}

// ---------------- panels ----------------
function open(id, spot) {
  panel = id;
  world.goTo(spot ?? (id.startsWith('review:') ? 'reviews' : id.startsWith('chart:') ? 'screener' : id), true);
  $('#panel').hidden = false;
  renderPanel();
}
function close() { panel = null; $('#panel').hidden = true; }

const tabs = [['wall', 'B Picks wall'], ['screener', '1 Screener'], ['trader', '2 Trader'], ['reviewer', '3 Reviewer'], ['intel', '4 Intel'], ['digest', '5 Digest'],
  ['smc', '6 SMC Trader'], ['backtest', '7 Backtest'], ['settings', '⚙ Settings']];
function renderPanel() {
  if (document.activeElement?.closest('#panel input, #panel textarea, #panel select')) return;
  const [kind, arg] = panel.split(/:(.*)/s);
  const body = { screener, trader, reviewer, intel, settings, smc: smcPanel, backtest: backtestPanel, digest: () => digestPanel(arg), review: () => review(arg), chart: () => chart(arg) }[kind]?.() ?? '';
  $('#panel').innerHTML = `<nav>${tabs.map(([id, label]) => `<button data-open="${id}" class="${kind === id ? 'on' : ''}">${label}</button>`).join('')}
    <button data-close title="Esc">✕</button></nav><div class="body">${body}</div>`;
  for (const cv of $('#panel').querySelectorAll('canvas[data-chart]')) paintChart(cv);
}

function table(head, rows) {
  return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Nothing yet</td></tr>`}</tbody></table>`;
}

function screener() {
  const pk = new Map(state.picks.map(p => [p.symbol, p]));
  const rows = Object.values(scanMap).map(s => `<tr data-open="chart:${s.symbol}" class="click">
    <td><b>${s.symbol.replace('USDT', '')}</b></td><td>${pk.has(s.symbol) ? (pk.get(s.symbol).why === 'pinned' ? '★ pick' : 'pick') : state.skips.includes(s.symbol) ? '<span class="muted">skipped</span>' : ''}</td><td>${fmt(s.price)}</td><td style="color:${s.status === 'QUALIFIED' ? '#fbbf24' : ''}">${s.status.replaceAll('_', ' ')}</td>
    <td class="muted">${esc(s.reason ?? '')}</td><td>${s.anchor ? `${s.anchor.type.replaceAll('_', ' ')} ${s.anchor.direction === 1 ? '↑' : '↓'} ${hhmm(s.anchor.t)}` : ''}</td></tr>`);
  return `<h2>Screener · GMS PMR v1.4</h2>
    <p class="muted">Completed 1H breakout from a known pattern → fresh causal 15m OB/FVG → first retest within 120 min → 5m MSS + displacement within 45 min → FVG midpoint entry (60 min window). Click a row for its 1H / 15m / 5m charts.</p>
    <p>The top ${state.cfg.picks} (held, your pins, then furthest PMR stage, then volume) go on the north wall as picks.${state.cfg.picksOnly ? ' The Trader only takes proposals on picks.' : ''} <button data-open="wall">Open picks wall (B)</button></p>
    ${table(['Symbol', 'Pick', 'Last', 'State', 'Reason', '1H pattern'], rows)}`;
}

function chart(sym) {
  const s = scanMap[sym];
  if (!s) return '<p class="muted">No data for this symbol yet.</p>';
  const ov = { lines: [], zones: [] };
  if (s.anchor) ov.lines.push({ price: s.anchor.boundary, color: C.boundary, label: 'BRK' }, { price: s.anchor.target, color: C.target, label: 'TGT', dash: [2, 4] });
  if (s.poi) ov.zones.push({ lo: s.poi.lo, hi: s.poi.hi, from: s.poi.knownAt, label: `15m ${s.poi.type}` });
  if (s.plan) Object.assign(ov, tradeOverlay(s.plan));
  CHARTS = { [`${sym}:h1`]: [s.h1, ov], [`${sym}:m15`]: [s.m15, ov], [`${sym}:m5`]: [s.m5, ov] };
  return `<h2>${sym} · ${s.status.replaceAll('_', ' ')}</h2><p class="muted">${esc(s.reason ?? '')}</p>
    ${['h1', 'm15', 'm5'].map(tf => `<canvas data-chart="${sym}:${tf}" data-title="${sym} ${{ h1: '1H', m15: '15m', m5: '5m' }[tf]}"></canvas>`).join('')}`;
}
let CHARTS = {};
function paintChart(cv) {
  const [bars, ov] = CHARTS[cv.dataset.chart] ?? [[], {}];
  const w = cv.clientWidth || 520, h = 260, r = devicePixelRatio || 1;
  cv.width = w * r; cv.height = h * r; cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d'); ctx.scale(r, r);
  drawCandles(ctx, { x: 0, y: 0, w, h }, bars, { ...ov, title: cv.dataset.title, font: 12 });
}

function trader() {
  const a = state.acct;
  const pos = state.positions.map(p => `<tr><td>${p.symbol}</td><td>${p.direction === 1 ? 'Long' : 'Short'}</td><td>${p.qty}</td><td>${fmt(p.entry)}</td>
    <td>${fmt(p.stop)} / ${fmt(p.target)}</td><td class="${p.direction * (p.mark - p.entry) >= 0 ? 'up' : 'down'}">${fmt(p.direction * (p.mark - p.entry) * p.qty)}</td><td>${hhmm(p.entryAt)}</td></tr>`);
  const ord = state.orders.map(o => `<tr><td>${o.symbol}</td><td>${o.direction === 1 ? 'Buy' : 'Sell'} limit</td><td>${o.qty}</td><td>${fmt(o.entry)}</td>
    <td>${fmt(o.stop)} / ${fmt(o.target)}</td><td>${o.netRR.toFixed(2)}R:R</td><td>until ${hhmm(o.plan.expiresAt)}</td></tr>`);
  const log = state.trades.slice(0, 40).map(t => `<tr data-open="review:${t.id}" class="click"><td>${new Date(t.exitAt).toLocaleDateString('en-CA')} ${hhmm(t.exitAt)}</td><td>${t.symbol}</td>
    <td>${t.direction === 1 ? 'L' : 'S'}</td><td>${t.reason}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r.toFixed(2)}R</td><td>${t.grade?.letter ?? ''}${state.reviews[t.id] ? ' ✎' : ''}</td></tr>`);
  const wins = state.trades.filter(t => t.r > 0).length, totR = state.trades.reduce((s, t) => s + t.r, 0);
  return `<h2>Trader · paper account</h2>
    <div class="stats"><div><small>Equity</small><b>${money(a.equity)}</b></div><div><small>Return</small><b>${pct((a.equity / a.start - 1) * 100)}</b></div>
    <div><small>Max drawdown</small><b>${fmt(a.maxDD * 100, 1)}%</b></div><div><small>Trades</small><b>${state.trades.length}</b></div>
    <div><small>Win rate</small><b>${state.trades.length ? Math.round(wins / state.trades.length * 100) : 0}%</b></div><div><small>Total R</small><b>${totR.toFixed(1)}R</b></div></div>
    <p><label class="switch"><input type="checkbox" data-cfg="on" ${state.cfg.on ? 'checked' : ''}> New paper entries ${state.cfg.on ? 'ON' : 'OFF'}</label>
    <span class="muted"> · start $${state.acct.start} · ${state.cfg.riskPct}% risk per trade · notional ≤ ${state.cfg.maxNotional} USDT · ${state.cfg.levCap}× total cap</span></p>
    <h3>Open positions</h3>${table(['Symbol', 'Side', 'Qty', 'Entry', 'Stop / Target', 'Unreal. USDT', 'Since'], pos)}
    <h3>Pending limits</h3>${table(['Symbol', 'Order', 'Qty', 'Price', 'Stop / Target', 'Net', 'Expires'], ord)}
    <h3>Trade log</h3>${table(['Exit', 'Symbol', '', 'Exit reason', 'P&amp;L', 'R', 'Grade'], log)}`;
}

function bucketStats() {
  const out = [];
  for (const field of ['pattern', 'side', 'poi', 'grade', 'session', 'marks']) {
    const groups = {};
    for (const t of state.trades) (groups[features(t.plan)[field]] ??= []).push(t.r);
    for (const [v, rs] of Object.entries(groups)) out.push(`<tr><td>${field}</td><td>${esc(v)}</td><td>${rs.length}</td><td>${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)}R</td><td>${rs.reduce((a, b) => a + b, 0).toFixed(1)}R</td></tr>`);
  }
  return out;
}

function reviewer() {
  const active = state.rules.active.map(r => `<li>✓ ${esc(ruleLabel(r))} <button data-rule="remove" data-key="${esc(ruleKey(r))}">Remove</button></li>`).join('');
  const props = state.rules.proposals.map(p => `<li><b>${esc(ruleLabel(p))}</b><br><span class="muted">${esc(p.evidence)}</span><br>
    <button data-rule="approve" data-key="${esc(ruleKey(p))}">Approve</button> <button data-rule="reject" data-key="${esc(ruleKey(p))}">Reject</button></li>`).join('');
  const dec = (state.decisions ?? []).slice(0, 30).map(d => `<tr><td>${hhmm(d.t)}</td><td>${d.symbol}</td><td class="${d.status === 'Approved' ? 'up' : d.status === 'Declined' ? 'warn' : ''}">${d.status}</td>
    <td>${esc(d.reason)}</td><td>${Number.isFinite(d.netRR) ? d.netRR.toFixed(2) : ''}</td><td>${d.plan.grade}</td></tr>`);
  return `<h2>Reviewer</h2>
    <p class="muted">Checks every proposal: net R:R ≥ ${state.cfg.minNetRR} after taker fees (${state.cfg.fee * 100}%/side), exit slippage (${state.cfg.slip * 100}%) and funding due inside the hold, spread ≤ ${state.cfg.maxSpreadPct}%, exchange size filters, position limits, your hand-drawn chart marks (declines a proposal against your latest MSS or with its entry inside your opposite FVG / OB), and the rules you approved. After each close it grades the trade A–F. It proposes a rule only when a bucket loses in <i>both</i> halves of its trades (n ≥ 8, ≤ −3R total) or when three of your reviews say the same thing. Nothing changes until you approve.</p>
    <h3>Active rules</h3><ul class="rules">${active || '<li class="muted">None. Base checks only.</li>'}</ul>
    <h3>Proposals</h3><ul class="rules">${props || '<li class="muted">No proposal: not enough evidence yet.</li>'}</ul>
    <h3>Decisions</h3>${table(['Time', 'Symbol', 'Decision', 'Reason', 'Net R:R', 'Setup'], dec)}
    <h3>Results by bucket</h3>${table(['Field', 'Value', 'n', 'Avg', 'Total'], bucketStats())}
    <p class="muted">Review a trade: walk to the south wall (V) and click its card, or click a row in Trader → Trade log.</p>`;
}

const zoneClass = z => ['Strong', 'Healthy', 'Strong Bull', 'Bull'].includes(z) ? 'up' : ['Neutral'].includes(z) ? 'warn' : 'down';
function postureHTML() {
  const m = state.market;
  if (!m) return '<p class="muted">Market posture loads within a minute of the first cycle (TraderMonty public breadth + uptrend CSVs).</p>';
  const ex = m.exposure, b = m.breadth, u = m.uptrend;
  const rec = ex?.recommendation ?? '—';
  return `<div class="stats">
      <div><small>Exposure coach</small><b class="${rec === 'NEW_ENTRY_ALLOWED' ? 'up' : rec === 'REDUCE_ONLY' ? 'warn' : 'down'}">${esc(rec.replaceAll('_', ' '))}</b></div>
      <div><small>Exposure ceiling</small><b>${ex ? `${ex.ceiling}%` : '—'}</b></div>
      <div><small>S&amp;P 500 breadth (${esc(b?.date ?? 'n/a')})</small><b class="${b ? zoneClass(b.zone) : ''}">${b ? `${b.composite} ${esc(b.zone)}` : 'unavailable'}</b></div>
      <div><small>Uptrend ratio (${esc(u?.date ?? 'n/a')})</small><b class="${u ? zoneClass(u.zone) : ''}">${u ? `${u.composite} ${esc(u.zone)}` : 'unavailable'}</b></div>
      <div><small>Sector health</small><b>${m.sector ?? '—'}</b></div>
      <div><small>Participation · confidence</small><b>${esc(ex?.participation ?? '—')} · ${esc(ex?.confidence ?? '—')}</b></div></div>
    <p class="muted">${b ? `Breadth 8MA ${fmt(b.ma8, 3)}${b.pink_zone ? ' · PINK ZONE (200MA falling, 8MA below it)' : ''}${b.caution ? ' · caution: 8MA turning down' : ''} · ` : ''}${u ? `uptrend ratio ${pct(u.ratio * 100).replace('+', '')}${u.warnings.length ? ` · warnings: ${esc(u.warnings.join(', '))}` : ''} · ` : ''}missing inputs: ${esc((ex?.missing ?? []).join(', ') || 'none')}${ex?.missing_critical?.length ? ` (critical missing: ${esc(ex.missing_critical.join(', '))}, so the coach takes ${ex.missing_critical.length * 10} points off and cannot say NEW ENTRY ALLOWED)` : ''}.
    Updated ${ago(m.at)} ago.${m.errors?.length ? ` <span class="warn">Data: ${esc(m.errors.join('; '))}</span>` : ''}</p>
    <p class="muted">Ported from tradermonty/claude-trading-skills (market-breadth-analyzer, uptrend-analyzer, exposure-coach). US-market context recorded on every proposal; it does not gate or size trades.</p>`;
}
function intel() {
  const items = (state.intel ?? []).map(i => `<tr><td>${hhmm(i.t)}</td><td>${i.type}</td><td>${esc(i.title)}</td><td class="muted">${esc(i.detail)}</td></tr>`);
  const movers = (state.board ?? []).slice(0, 30).map(r => `<tr><td>${r.symbol.replace('USDT', '')}</td><td>${fmt(r.last)}</td><td class="${r.change >= 0 ? 'up' : 'down'}">${pct(r.change)}</td><td>${(r.quoteVolume / 1e6).toFixed(2)}M</td></tr>`);
  return `<h2>Market Intel</h2><h3>US market posture</h3>${postureHTML()}<h3>Aster tape</h3><p class="muted">Aster taker-buy vs taker-sell notional and 5m volume spikes (≥ 2.5× the prior 20 bars) on the watched stock perps. No news feed yet.</p>
    ${table(['Time', 'Type', 'Signal', 'Detail'], items)}<h3>Stock perps by 24h volume</h3>${table(['Symbol', 'Last', '24h', 'Volume'], movers)}`;
}

const money0 = n => Number.isFinite(n) ? money(n) : '—';
const r2 = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '—';
function bucketTable(title, b) {
  const rows = Object.entries(b).sort((x, y) => y[1].total - x[1].total).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.total}</td><td>${v.wins}/${v.losses}</td><td>${v.win_rate == null ? '—' : `${Math.round(v.win_rate * 100)}%`}</td><td>${r2(v.r)}</td></tr>`);
  return rows.length ? `<h3>By ${title}</h3>${table(['Value', 'n', 'W/L', 'Win rate', 'Total R'], rows)}` : '';
}
function digestPanel(arg = '') {
  const [acct, wk] = arg.includes('|') ? arg.split('|') : ['pmr', arg];
  const trades = acct === 'smc' ? state.smc?.trades ?? [] : state.trades;
  const ws = weeks(trades), week = wk === 'all' ? undefined : wk || ws[0];
  const d = digest(trades, { week }), c = coach(trades, { reviews: state.reviews, cfg: state.cfg, start: acct === 'smc' ? state.smc?.acct?.start ?? 1000 : state.acct.start, week });
  const pm = acct === 'smc' ? [] : filterReport(state.decisions ?? []);
  const sev = { critical: 'down', warning: 'warn', info: 'muted' };
  const recent = (state.decisions ?? []).filter(x => x.status === 'Declined').slice(0, 12).map(x => `<tr><td>${hhmm(x.t)}</td><td>${x.symbol.replace('USDT', '')}</td><td>${esc(x.post?.filter ?? '')}</td>
    <td class="muted">${esc(String(x.reason).replaceAll('_', ' '))}</td><td class="${x.post?.outcome === 'MISSED_OPPORTUNITY' ? 'warn' : x.post?.outcome === 'GOOD_SKIP' ? 'up' : ''}">${esc(x.post?.outcome?.replaceAll('_', ' ') ?? 'pending')}</td><td>${x.post?.filled ? r2(x.post.r) : ''}</td></tr>`);
  return `<h2>Digest · ${acct === 'smc' ? 'SMC Trader' : 'PMR Trader'} · ${week ? `week of ${week}` : 'all time'}</h2>
    <p><button data-open="digest:pmr|" class="${acct !== 'smc' ? 'on' : ''}">PMR Trader</button> <button data-open="digest:smc|" class="${acct === 'smc' ? 'on' : ''}">SMC Trader</button></p>
    <p>${ws.slice(0, 6).map(w => `<button data-open="digest:${acct}|${w}" class="${w === week ? 'on' : ''}">${w}</button>`).join(' ')} <button data-open="digest:${acct}|all" class="${!week ? 'on' : ''}">All time</button></p>
    ${d.trades ? `<div class="stats"><div><small>Trades</small><b>${d.trades}</b></div><div><small>Win rate</small><b>${Math.round(d.winRate * 100)}%</b></div>
      <div><small>Expectancy</small><b>${money0(d.expectancy)}</b></div><div><small>Profit factor</small><b>${d.profitFactor == null ? 'no losers' : d.profitFactor.toFixed(2)}</b></div>
      <div><small>Total</small><b class="${d.totalPnl >= 0 ? 'up' : 'down'}">${money0(d.totalPnl)} · ${r2(d.totalR)}</b></div><div><small>Avg R ± sd</small><b>${r2(d.avgR)} ± ${d.rStdev?.toFixed(2) ?? '—'}</b></div>
      <div><small>Avg win / loss</small><b>${money0(d.avgWin)} / ${money0(d.avgLoss)}</b></div><div><small>Hold W / L</small><b>${d.holdWinMin?.toFixed(0) ?? '—'} / ${d.holdLossMin?.toFixed(0) ?? '—'} min</b></div>
      <div><small>Avg MAE / MFE</small><b>${d.maeSamples ? `${d.avgMaeR.toFixed(2)} / ${d.avgMfeR.toFixed(2)}R` : 'n/a'}</b></div></div>
      ${d.smallSample ? `<p class="warn">${d.trades} trades: treat this as directional, not conclusive.</p>` : ''}
      ${bucketTable('outcome', d.by.outcome)}${bucketTable('exit reason', d.by.exit)}${bucketTable('1H pattern', d.by.pattern)}${bucketTable('your marks', d.by.marks)}${bucketTable('market posture at signal', d.by.posture)}`
      : '<p class="muted">No closed trades in this period.</p>'}
    <h3>Coach · ${esc(c.verdict.replaceAll('_', ' '))}</h3>
    <div class="stats"><div><small>Risk</small><b>${c.scores.risk}</b></div><div><small>Execution</small><b>${c.scores.execution}</b></div><div><small>Process</small><b>${c.scores.process}</b></div>
      <div><small>Regime context</small><b>${c.scores.regime}</b></div><div><small>Your reviews</small><b>${c.reviewQuality == null ? '—' : `${c.reviewQuality}%`}</b></div></div>
    <ul class="items">${c.findings.map(f => `<li class="${sev[f.severity]}">${f.severity.toUpperCase()} · ${esc(f.axis)} · ${esc(f.text)}</li>`).join('') || '<li class="muted">No findings.</li>'}</ul>
    ${Object.keys(c.rootCauses).length ? `<p class="muted">Losing-trade root causes: ${esc(Object.entries(c.rootCauses).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · '))}</p>` : ''}
    ${c.suggestions.length ? `<p><b>Suggestions (not applied)</b></p><ul class="items">${c.suggestions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${acct === 'smc' ? '<p class="muted">The SMC Trader has no postmortem yet: its declines are the SMC engine\'s own skip reasons (6 SMC Trader). R here is the crypto desk\'s: realized P&amp;L / risk at entry.</p>' : `<h3>Postmortem · what the declined proposals would have done</h3>
    <p class="muted">Each declined proposal is replayed on completed 1m bars with the desk's own fill rules once its window ends. Missed ≥ +0.5R, good skip ≤ −0.5R. A filter needs ≥ 8 filled replays and both halves on the same side before a verdict.</p>
    ${table(['Filter', 'Declined', 'Filled', 'Missed', 'Good skip', 'Neutral', 'No fill', 'Total R', 'Verdict'], pm.map(p => `<tr><td>${esc(p.filter)}</td><td>${p.declined}${p.pending ? ` (${p.pending} pending)` : ''}</td><td>${p.filled}</td><td>${p.missed}</td><td>${p.goodSkip}</td><td>${p.neutral}</td><td>${p.noFill}</td><td>${p.filled ? r2(p.totalR) : '—'}</td><td class="muted">${esc(p.verdict)}</td></tr>`))}
    ${recent.length ? `<h3>Recent declines</h3>${table(['Time', 'Symbol', 'Filter', 'Reason', 'Outcome', 'R'], recent)}` : ''}`}
    <p class="muted">Adapted from tradermonty/claude-trading-skills: weekly-performance-digest, trade-performance-coach, signal-postmortem. Behavior tags (FOMO, revenge) need a human executing trades, so the coach leaves them out.</p>`;
}

function smcPanel() {
  const m = state.smc ?? {}, a = m.acct ?? { start: 1000, cash: 1000, pos: {} }, tr = m.trades ?? [], on = m.on !== false;
  const wins = tr.filter(t => t.r > 0).length, totR = tr.reduce((x, t) => x + t.r, 0), eq = m.equity ?? a.cash;
  const pos = Object.entries(a.pos ?? {}).map(([s, p]) => { const px = scanMap[s]?.price ?? p.entry, r = (p.side === 'L' ? px - p.entry : p.entry - px) / Math.abs(p.entry - p.stop0);
    return `<tr><td>${s.replace('USDT', '')}</td><td>${p.side === 'L' ? 'Long' : 'Short'}</td><td>${esc(p.tf)} ${esc(p.zoneKind)}</td><td>${fmt(p.entry)}</td><td>${fmt(p.stop)} / ${fmt(p.target)}</td>
      <td class="${r >= 0 ? 'up' : 'down'}">${r.toFixed(2)}R${p.tp1 ? ' · half off' : ''}</td><td>${hhmm(p.t)}</td></tr><tr><td colspan="7" class="muted">${esc(p.why)}</td></tr>`; });
  const scan = (m.scan?.cands ?? []).map(c => `<tr><td>${esc(c.b)}</td><td>${c.side === 'L' ? 'Long' : 'Short'}</td><td>${esc(c.tf)} ${esc(c.zone)}</td><td>${esc(c.q ?? '—')}</td><td>${esc(c.type)}</td>
    <td class="${c.took ? 'up' : /^MARK/.test(c.skip ?? '') ? 'warn' : 'muted'}">${c.took ? 'ENTERED' : esc(c.skip)}</td></tr>`);
  const log = tr.slice(0, 40).map(t => `<tr><td>${new Date(t.exitAt).toLocaleDateString('en-CA')} ${hhmm(t.exitAt)}</td><td>${t.symbol.replace('USDT', '')}</td><td>${t.direction === 1 ? 'L' : 'S'}</td>
    <td class="muted">${esc(t.reason)}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r.toFixed(2)}R</td></tr>`);
  const dec = (m.decisions ?? []).slice(0, 12).map(d => `<tr><td>${hhmm(d.t)}</td><td>${esc(d.symbol.replace('USDT', ''))}</td><td>${d.side === 'L' ? 'Long' : 'Short'}</td><td class="${d.status === 'Entered' ? 'up' : 'warn'}">${esc(d.status)}</td><td class="muted">${esc(d.reason)}</td></tr>`);
  return `<h2>SMC Trader · second paper account</h2>
    <p class="muted">Your crypto desk's SMC Trader (small-cap settings) running its own code (${esc(SMC_SOURCE.code)}) on the north-wall picks${state.cfg.picksOnly ? '' : ' (picks-only is off: every watched stock)'}.
    Setup: liquidity sweep → structure shift with displacement → FVG (else OB) pullback on 15m (1h filter) or 1h (4h filter), plus continuations; never against its higher timeframe.
    Rules in force from your crypto Reviewer: ${esc(Object.entries(SMC_ADJ).map(([k, v]) => v === true ? k : `${k} ${v}`).join(' · '))}. Your hand-drawn MSS / FVG / OB marks veto entries against them, as for the PMR Trader.
    It steps at each 5m close (5m candles walk open positions, adverse extreme first), the same way your crypto backtester replays.</p>
    ${m.error ? `<p class="down">Last cycle error: ${esc(m.error)}</p>` : ''}
    <div class="stats"><div><small>Equity</small><b>${money(eq)}</b></div><div><small>Return</small><b>${pct((eq / (a.start || 1000) - 1) * 100)}</b></div>
      <div><small>Trades</small><b>${tr.length}</b></div><div><small>Win rate</small><b>${tr.length ? Math.round(wins / tr.length * 100) : 0}%</b></div><div><small>Total R</small><b>${totR.toFixed(1)}R</b></div>
      <div><small>Last step</small><b>${m.lastStep ? hhmm(m.lastStep) : '—'}</b></div></div>
    <p><label class="switch"><input type="checkbox" data-smc="on" ${on ? 'checked' : ''}> SMC paper entries ${on ? 'ON' : 'OFF'}</label>
      <span class="muted"> · start $${a.start ?? 1000} · 1% risk · max 3 open · 10× cap · half at +1.2R then trail · ${state.cfg.on ? '' : 'the desk-wide switch (2 Trader) is OFF, so no entries'}</span></p>
    <h3>Open positions</h3>${table(['Symbol', 'Side', 'Setup', 'Entry', 'Stop / Target', 'Now', 'Since'], pos)}
    <h3>Last scan ${m.scan ? `(${hhmm(m.scan.t)})` : ''}</h3>${scan.length ? table(['Symbol', 'Side', 'Setup', 'Quality', 'Type', 'Result'], scan) : '<p class="muted">No pick is inside an SMC entry zone right now.</p>'}
    ${dec.length ? `<h3>Entries and mark vetoes</h3>${table(['Time', 'Symbol', 'Side', 'Result', 'Detail'], dec)}` : ''}
    <h3>Trade log</h3>${table(['Exit', 'Symbol', '', 'Exit reason', 'P&amp;L', 'R'], log)}`;
}

// Backtest report: written nightly by .github/workflows/backtest.yml to branch backtest-report of this public repo.
let bt = { at: 0, data: null, err: '' };
const btURL = () => { const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'fredyu1996';
  const repo = location.hostname.endsWith('.github.io') ? location.pathname.split('/').filter(Boolean)[0] || 'aster-stocl-desk' : 'aster-stocl-desk';
  return `https://raw.githubusercontent.com/${owner}/${repo}/backtest-report/stock-backtest.json`; };
async function loadBacktest() {
  if (Date.now() - bt.at < 10 * 60_000) return;
  bt.at = Date.now();
  try { const r = await fetch(`${btURL()}?t=${Math.floor(Date.now() / 6e5)}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); bt.data = await r.json(); bt.err = ''; }
  catch (e) { bt.err = e.message; }
  if (panel === 'backtest') renderPanel();
}
const sR = s => s?.n ? `${s.avgR >= 0 ? '+' : ''}${s.avgR}R avg · ${s.totR >= 0 ? '+' : ''}${s.totR}R · ${s.win}% win · n ${s.n}` : 'no trades';
function btBlock(name, x) {
  const rows = o => Object.entries(o).sort((a, b) => b[1].n - a[1].n).map(([k, s]) => `<tr><td>${esc(k)}</td><td>${s.n}</td><td>${s.win}%</td><td>${s.avgR >= 0 ? '+' : ''}${s.avgR}R</td><td>${s.totR >= 0 ? '+' : ''}${s.totR}R</td><td>${s.maxDD}R</td></tr>`);
  const h = ['Value', 'n', 'Win', 'Avg R', 'Total R', 'Max DD'];
  const last = x.trades.slice(-15).reverse().map(t => `<tr><td>${new Date(t.t0).toLocaleDateString('en-CA')}</td><td>${esc(t.s.replace('USDT', ''))}</td><td>${t.side}</td><td>${esc(t.pattern ?? `${t.tf ?? ''} ${t.zone ?? ''}`)}</td><td class="muted">${esc(t.why)}</td><td class="${t.R >= 0 ? 'up' : 'down'}">${t.R >= 0 ? '+' : ''}${t.R}R</td></tr>`);
  return `<h3>${name}</h3>
    <div class="stats"><div><small>Trades</small><b>${x.all.n}</b></div><div><small>Win rate</small><b>${x.all.win ?? '—'}%</b></div><div><small>Avg R</small><b>${x.all.avgR ?? '—'}</b></div>
      <div><small>Total R</small><b class="${x.all.totR >= 0 ? 'up' : 'down'}">${x.all.totR}R</b></div><div><small>Max drawdown</small><b>${x.all.maxDD}R</b></div><div><small>Profit factor (R)</small><b>${x.all.pf ?? '—'}</b></div></div>
    <p>First half: ${sR(x.halves[0])}<br>Second half: ${sR(x.halves[1])}${x.all.n < 30 ? `<br><span class="warn">${x.all.n} trades: too few to judge the strategy.</span>` : ''}</p>
    ${x.declined ? `<p class="muted">${x.proposals} PMR proposals · not taken: ${esc(Object.entries(x.declined).map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · ') || 'none')}</p>` : ''}
    ${x.skips ? `<p class="muted">Most common SMC skip reasons: ${esc(Object.entries(x.skips).slice(0, 6).map(([k, v]) => `${k} (${v})`).join(' · '))}</p>` : ''}
    <details><summary>By symbol, month, exit</summary>${table(h, rows(x.bySymbol))}${table(h, rows(x.months))}${table(h, rows(x.exits))}</details>
    ${last.length ? `<details><summary>Last 15 trades</summary>${table(['Entry', 'Symbol', 'Side', 'Setup', 'Exit', 'R'], last)}</details>` : ''}`;
}
function backtestPanel() {
  loadBacktest();
  const d = bt.data;
  if (!d) return `<h2>Backtest</h2><p class="muted">${bt.err ? `No report yet (${esc(bt.err)}). It is written by the nightly workflow “backtest” (Actions tab → backtest → Run workflow).` : 'Loading the latest report…'}</p>`;
  return `<h2>Backtest · ${d.days} days · ${d.symbols.length} stock perps</h2>
    <p class="muted">${new Date(d.from).toLocaleDateString('en-CA')} → ${new Date(d.to).toLocaleDateString('en-CA')} · run ${new Date(d.t).toLocaleString('en-CA')} · ${esc(d.symbols.map(s => s.replace('USDT', '')).join(', '))}.
      Report only: it never changes either trader. ${esc(d.notes.slice(1).join(' '))}</p>
    ${btBlock('PMR Trader (GMS PMR v1.4)', d.pmr)}${btBlock(`SMC Trader (${esc(d.smc.source?.account ?? 'crypto desk SMC')})`, d.smc)}`;
}

const A_CHIPS = [['same', 'Same trade'], ['skip', 'Skip it'], ['flip', 'Other side'], ['later', 'Enter later / deeper'], ['earlier', 'Enter earlier'],
  ['exitE', 'Exit earlier'], ['hold', 'Hold longer'], ['wider', 'Wider stop'], ['tighter', 'Tighter stop']];
const B_CHIPS = [['pattern', '1H pattern'], ['poi', '15m OB/FVG'], ['retest', 'Retest'], ['mss', '5m MSS'], ['fvg', '5m FVG entry'], ['rr', 'Target / R:R'], ['session', 'Time of day'], ['news', 'News / catalyst']];

function review(id) {
  const t = state.trades.find(x => x.id === id);
  if (!t) return '<p class="muted">Trade not found.</p>';
  const rv = state.reviews[id] ?? {};
  const bars = scanMap[t.symbol]?.m5?.filter(b => b.t >= t.plan.signalAt - 3 * 3600_000 && b.t <= t.exitAt + 3600_000) ?? [];
  CHARTS = { [`trade:${id}`]: [bars, tradeOverlay(t)] };
  const chip = (group, [k, label]) => `<label class="chip"><input type="checkbox" name="${group}" value="${k}" ${rv[group]?.includes(k) ? 'checked' : ''}>${label}</label>`;
  return `<h2>${t.symbol} ${t.direction === 1 ? 'long' : 'short'} · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R · grade ${t.grade?.letter}</h2>
    <p class="muted">${t.plan.pattern.type.replaceAll('_', ' ')} · 15m ${t.plan.poi.type} · ${t.plan.grade} · entry ${fmt(t.entry)} ${hhmm(t.entryAt)} → ${t.reason} ${fmt(t.exit)} ${hhmm(t.exitAt)} · net R:R at entry ${t.netRR.toFixed(2)} · fees ${money(t.fees)}${t.plan.marks ? ` · your marks: ${t.plan.marks.confluence ? 'same-direction zone hit ✓' : 'no zone hit'}${t.plan.marks.mss ? `, latest MSS ${t.plan.marks.mss}` : ''}` : ''}</p>
    <canvas data-chart="trade:${id}" data-title="${t.symbol} 5m"></canvas>
    <ul class="items">${t.grade.items.map(i => `<li class="${i.ok ? 'up' : 'down'}">${i.ok ? '✓' : '✗'} ${esc(i.text)}</li>`).join('')}</ul>
    <form id="rvform" data-id="${esc(id)}">
      <h3>Your review</h3>
      <p>Grade ${['A', 'B', 'C', 'D', 'F'].map(g => `<label class="chip"><input type="radio" name="grade" value="${g}" ${rv.grade === g ? 'checked' : ''}>${g}</label>`).join('')}
      <label class="chip"><input type="checkbox" name="disagree" ${rv.agree === false ? 'checked' : ''}>I disagree with the Reviewer's grade</label></p>
      <p>What I'd have done<br>${A_CHIPS.map(c => chip('a', c)).join('')}</p>
      <p>Weak part of the setup<br>${B_CHIPS.map(c => chip('b', c)).join('')}</p>
      <textarea name="comment" rows="4" placeholder="Comment (English or 廣東話)">${esc(rv.comment ?? '')}</textarea>
      <p><label class="chip"><input type="checkbox" name="exclude" ${rv.exclude ? 'checked' : ''}>Leave this trade out of learning</label></p>
      <button type="submit">Save review</button> <span class="muted">${rv.t ? `Saved ${ago(rv.t)} ago` : ''}</span>
    </form>`;
}

function settings() {
  const c = state.cfg;
  const num = (k, label, step = 'any') => `<label>${label}<input type="number" step="${step}" data-cfg="${k}" value="${c[k]}"></label>`;
  return `<h2>Settings</h2>
    <div class="grid">${num('universe', 'Symbols watched (top by volume)', 1)}${num('minVolume', 'Min 24h volume (USDT)', 1000)}
    ${num('riskPct', 'Risk per trade (% equity)')}${num('maxNotional', 'Max notional per trade (USDT)')}${num('levCap', 'Total leverage cap (×)')}
    ${num('maxOpen', 'Max open + pending', 1)}${num('picks', 'Picks on the north wall', 1)}${num('minNetRR', 'Min net R:R')}${num('maxSpreadPct', 'Max spread %')}
    ${num('fee', 'Taker fee per side (0.0004 = 0.04%)')}${num('slip', 'Exit slippage (0.0005 = 0.05%)')}${num('timeExitMin', 'Time exit (min)', 1)}
    <label>Always watch (comma list)<input data-cfg="always" value="${esc(c.always.join(','))}"></label>
    <label>Exclude (comma list)<input data-cfg="exclude" value="${esc(c.exclude.join(','))}"></label></div>
    <p><label class="switch"><input type="checkbox" data-cfg="picksOnly" ${c.picksOnly ? 'checked' : ''}> Both traders only take setups on the picks wall</label></p>
    <h3>3D room</h3><label>Mouse look<select data-look>${[['follow', 'Follow the mouse (no click)'], ['fast', 'Follow the mouse, faster'], ['drag', 'Only while dragging']].map(([v, l]) => `<option value="${v}" ${world.look === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="muted">Follow: the view turns as the mouse moves; keep the cursor at the left or right edge to keep turning. Clicks still pick desks and walls.</p>
    <h3>Shared account (GitHub sync)</h3>
    <p class="muted">With a token, this browser shows the cloud trader's account and saves your reviews there. The token stays in this browser only (localStorage). Use a fine-grained token with Contents read/write on the private data repo only. Never paste it into chat.</p>
    <form id="syncform" class="grid"><label>Data repo<input name="repo" value="${esc(sync.repo)}"></label>
    <label>Branch<input name="branch" value="${esc(sync.branch)}"></label>
    <label>Token<input name="token" type="password" value="${esc(sync.token)}" autocomplete="off"></label>
    <div><button type="submit">Save sync</button> <button type="button" data-unsync>Use local paper only</button></div></form>
    <h3>Local paper account</h3><p><button data-reset>Reset local account to $1,000</button> <span class="muted">Only affects the browser-only account, not the shared one.</span></p>`;
}

// ---------------- events ----------------
$('#panel').addEventListener('click', e => {
  const el = e.target.closest('[data-open],[data-close],[data-rule],[data-reset],[data-unsync]');
  if (!el) return;
  if (el.dataset.open === 'wall') return openWall();
  if (el.dataset.open) return open(el.dataset.open);
  if (el.hasAttribute('data-close')) return close();
  if (el.hasAttribute('data-reset')) { if (confirm('Reset the local paper account?')) { state = freshState(); LS.set('asd_state', state); render(); } return; }
  if (el.hasAttribute('data-unsync')) { sync = { ...sync, token: '' }; LS.set('asd_sync', sync); state = normalize(LS.get('asd_state', null)); refresh(); return; }
  const key = el.dataset.key, [rule, value] = key.split(/:(.*)/s);
  if (el.dataset.rule === 'approve') mutate(s => { s.rules.active.push({ rule, ...(value ? { value } : {}) }); s.rules.decided[key] = 'approved'; });
  if (el.dataset.rule === 'reject') mutate(s => { s.rules.decided[key] = 'rejected'; });
  if (el.dataset.rule === 'remove') mutate(s => { s.rules.active = s.rules.active.filter(r => ruleKey(r) !== key); s.rules.decided[key] = 'removed'; });
});
$('#panel').addEventListener('change', e => {
  if (e.target.matches('[data-look]')) { world.setLook(e.target.value); return; }
  if (e.target.dataset.smc === 'on') { const v = e.target.checked; mutate(s => { s.smc = { ...(s.smc ?? { trades: [], decisions: [] }), on: v }; }); return; }
  const k = e.target.dataset.cfg;
  if (!k) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (['always', 'exclude'].includes(k)) v = String(v).toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
  else if (typeof v === 'string') { v = Number(v); if (!Number.isFinite(v)) return; }
  mutate(s => { s.cfg[k] = v; });
});
$('#panel').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (e.target.id === 'syncform') {
    sync = { repo: f.get('repo').trim(), branch: f.get('branch').trim() || 'stocks-state', token: f.get('token').trim() };
    LS.set('asd_sync', sync); document.activeElement?.blur(); refresh(); return;
  }
  const id = e.target.dataset.id;
  const rv = { grade: f.get('grade'), agree: !f.get('disagree'), a: f.getAll('a'), b: f.getAll('b'), comment: f.get('comment').trim(), exclude: !!f.get('exclude'), t: Date.now(), by: 'Fred' };
  document.activeElement?.blur();
  mutate(s => { s.reviews[id] = rv; });
});
addEventListener('keydown', e => {
  if (wall.isOpen()) return wall.key(e);
  if (e.target.closest('input,textarea,select')) return;
  const d = DESKS.find(x => x.key === e.key);
  if (d) return open(d.id);
  if (e.key === '5') return open('digest', 'reviewer');
  if (e.key === '7') return open('backtest', 'smc');
  const k = e.key.toLowerCase();
  if (k === 'v') return open('reviewer', 'reviews');
  if (k === 'b') return openWall();
  if (k === 'p') return world.goTo('positions');
  if (k === 'r') return world.goTo('rules');
  if (k === 's' && e.altKey) return open('settings');
  if (k === 'h' || k === '?') $('#help').hidden = !$('#help').hidden;
  if (e.key === 'Escape') { $('#help').hidden = true; close(); }
});
$('#help').hidden = LS.get('asd_help_seen', false);
$('#help').addEventListener('click', () => { $('#help').hidden = true; LS.set('asd_help_seen', true); });
$('#settingsBtn').addEventListener('click', () => open('settings'));

addEventListener('pagehide', () => { flushMarks(); });

globalThis.__desk = { world, wall, get state() { return state; } };
render();
refresh();
setInterval(refresh, 60_000);
