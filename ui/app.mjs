import { loadMarket } from '../core/aster.mjs';
import { cycle, freshState, normalize, persistable } from '../core/desk.mjs';
import { store, update } from '../core/github.mjs';
import { Scanner } from '../core/pmr.mjs';
import { features, learn, ruleKey, ruleLabel } from '../core/reviewer.mjs';
import { C, ago, drawCandles, fmt, hhmm, money, pct, tradeOverlay } from './charts.mjs';
import { DESKS, createWorld } from './scene.mjs';

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
    if (id === 'reviews') { const t = world.reviewAt(uv); open(t ? `review:${t}` : 'reviewer', 'reviews'); return; }
    const to = { board: 'screener', positions: 'trader', rules: 'reviewer' }[id];
    open(to ?? id, to ? id : undefined);
  },
});

function render() {
  const view = { state, scanMap, source: status.source, ruleLabel };
  world.update(view);
  const a = state.acct;
  $('#hud').innerHTML = `
    <b>Aster Stock Desk</b>
    <span>Equity <b>${money(a.equity)}</b> <i class="${a.equity >= a.start ? 'up' : 'down'}">${pct((a.equity / a.start - 1) * 100)}</i></span>
    <span>Open ${state.positions.length} · Pending ${state.orders.length} · Trades ${state.trades.length}</span>
    <span>Feed <b class="${status.feed === 'Live' ? 'up' : 'warn'}">${esc(status.feed)}</b>${status.at ? ` · ${hhmm(status.at)}` : ''}</span>
    <span>${esc(status.source)}${state.lastCycle ? ` · last cycle ${esc(state.lastCycle.by)} ${ago(state.lastCycle.t)} ago` : ''}</span>
    ${status.note ? `<span class="warn">${esc(status.note)}</span>` : ''}`;
  if (panel) renderPanel();
}

function held(s) { return [...s.orders, ...s.positions].map(x => x.symbol); }

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    let market;
    try {
      market = await loadMarket(state.cfg, held(state), { cache });
      status.feed = 'Live'; status.at = market.t; status.note = '';
    } catch (e) { status.feed = 'Offline'; status.note = e.message; return; }
    scanMap = Object.fromEntries(market.universe.watch.map(sym => {
      const sc = new Scanner(sym, market.bars[sym] ?? [], { tickSize: market.universe.specs[sym]?.tickSize });
      return [sym, { ...sc.summary(), price: sc.last?.c, h1: sc.history[60].slice(-48), m15: sc.history[15].slice(-64), m5: sc.history[5].slice(-72) }];
    }));
    const store_ = st();
    if (!store_) {
      state = cycle(state, market, { by: 'browser' });
      LS.set('asd_state', persistable(state));
      status.source = 'local paper (this browser)';
      return;
    }
    const { state: remote } = await store_.read();
    const shared = normalize(remote);
    const cloudQuiet = !shared.lastCycle || Date.now() - shared.lastCycle.t > QUIET || shared.lastCycle.by === 'browser';
    if (cloudQuiet) {
      const res = await update(store_, s => persistable(cycle(normalize(s), market, { by: 'browser' })));
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
    render();
  }
}

// Apply a change to the account (reviews, rules, settings): local storage, or read → change → write on the data repo.
async function mutate(fn) {
  const store_ = st();
  const apply = s => { const n = normalize(s); fn(n); n.rules.proposals = learn(n.trades, n.reviews, { ...n.rules.decided, ...Object.fromEntries(n.rules.active.map(r => [ruleKey(r), 'active'])) }); return n; };
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

const tabs = [['screener', '1 Screener'], ['trader', '2 Trader'], ['reviewer', '3 Reviewer'], ['intel', '4 Intel'], ['settings', '⚙ Settings']];
function renderPanel() {
  if (document.activeElement?.closest('#panel input, #panel textarea, #panel select')) return;
  const [kind, arg] = panel.split(/:(.*)/s);
  const body = { screener, trader, reviewer, intel, settings, review: () => review(arg), chart: () => chart(arg) }[kind]?.() ?? '';
  $('#panel').innerHTML = `<nav>${tabs.map(([id, label]) => `<button data-open="${id}" class="${kind === id ? 'on' : ''}">${label}</button>`).join('')}
    <button data-close title="Esc">✕</button></nav><div class="body">${body}</div>`;
  for (const cv of $('#panel').querySelectorAll('canvas[data-chart]')) paintChart(cv);
}

function table(head, rows) {
  return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">Nothing yet</td></tr>`}</tbody></table>`;
}

function screener() {
  const rows = Object.values(scanMap).map(s => `<tr data-open="chart:${s.symbol}" class="click">
    <td><b>${s.symbol.replace('USDT', '')}</b></td><td>${fmt(s.price)}</td><td style="color:${s.status === 'QUALIFIED' ? '#fbbf24' : ''}">${s.status.replaceAll('_', ' ')}</td>
    <td class="muted">${esc(s.reason ?? '')}</td><td>${s.anchor ? `${s.anchor.type.replaceAll('_', ' ')} ${s.anchor.direction === 1 ? '↑' : '↓'} ${hhmm(s.anchor.t)}` : ''}</td></tr>`);
  return `<h2>Screener · GMS PMR v1.4</h2>
    <p class="muted">Completed 1H breakout from a known pattern → fresh causal 15m OB/FVG → first retest within 120 min → 5m MSS + displacement within 45 min → FVG midpoint entry (60 min window). Click a row for its 1H / 15m / 5m charts.</p>
    ${table(['Symbol', 'Last', 'State', 'Reason', '1H pattern'], rows)}`;
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
  for (const field of ['pattern', 'side', 'poi', 'grade', 'session']) {
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
    <p class="muted">Checks every proposal: net R:R ≥ ${state.cfg.minNetRR} after taker fees (${state.cfg.fee * 100}%/side), exit slippage (${state.cfg.slip * 100}%) and funding due inside the hold, spread ≤ ${state.cfg.maxSpreadPct}%, exchange size filters, position limits, and the rules you approved. After each close it grades the trade A–F. It proposes a rule only when a bucket loses in <i>both</i> halves of its trades (n ≥ 8, ≤ −3R total) or when three of your reviews say the same thing. Nothing changes until you approve.</p>
    <h3>Active rules</h3><ul class="rules">${active || '<li class="muted">None. Base checks only.</li>'}</ul>
    <h3>Proposals</h3><ul class="rules">${props || '<li class="muted">No proposal: not enough evidence yet.</li>'}</ul>
    <h3>Decisions</h3>${table(['Time', 'Symbol', 'Decision', 'Reason', 'Net R:R', 'Setup'], dec)}
    <h3>Results by bucket</h3>${table(['Field', 'Value', 'n', 'Avg', 'Total'], bucketStats())}
    <p class="muted">Review a trade: walk to the south wall (V) and click its card, or click a row in Trader → Trade log.</p>`;
}

function intel() {
  const items = (state.intel ?? []).map(i => `<tr><td>${hhmm(i.t)}</td><td>${i.type}</td><td>${esc(i.title)}</td><td class="muted">${esc(i.detail)}</td></tr>`);
  const movers = (state.board ?? []).slice(0, 30).map(r => `<tr><td>${r.symbol.replace('USDT', '')}</td><td>${fmt(r.last)}</td><td class="${r.change >= 0 ? 'up' : 'down'}">${pct(r.change)}</td><td>${(r.quoteVolume / 1e6).toFixed(2)}M</td></tr>`);
  return `<h2>Market Intel</h2><p class="muted">Aster taker-buy vs taker-sell notional and 5m volume spikes (≥ 2.5× the prior 20 bars) on the watched stock perps. No news feed yet.</p>
    ${table(['Time', 'Type', 'Signal', 'Detail'], items)}<h3>Stock perps by 24h volume</h3>${table(['Symbol', 'Last', '24h', 'Volume'], movers)}`;
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
    <p class="muted">${t.plan.pattern.type.replaceAll('_', ' ')} · 15m ${t.plan.poi.type} · ${t.plan.grade} · entry ${fmt(t.entry)} ${hhmm(t.entryAt)} → ${t.reason} ${fmt(t.exit)} ${hhmm(t.exitAt)} · net R:R at entry ${t.netRR.toFixed(2)} · fees ${money(t.fees)}</p>
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
    ${num('maxOpen', 'Max open + pending', 1)}${num('minNetRR', 'Min net R:R')}${num('maxSpreadPct', 'Max spread %')}
    ${num('fee', 'Taker fee per side (0.0004 = 0.04%)')}${num('slip', 'Exit slippage (0.0005 = 0.05%)')}${num('timeExitMin', 'Time exit (min)', 1)}
    <label>Always watch (comma list)<input data-cfg="always" value="${esc(c.always.join(','))}"></label>
    <label>Exclude (comma list)<input data-cfg="exclude" value="${esc(c.exclude.join(','))}"></label></div>
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
  if (e.target.closest('input,textarea,select')) return;
  const d = DESKS.find(x => x.key === e.key);
  if (d) return open(d.id);
  const k = e.key.toLowerCase();
  if (k === 'v') return open('reviewer', 'reviews');
  if (k === 'b') return world.goTo('board');
  if (k === 'p') return world.goTo('positions');
  if (k === 'r') return world.goTo('rules');
  if (k === 's' && e.altKey) return open('settings');
  if (k === 'h' || k === '?') $('#help').hidden = !$('#help').hidden;
  if (e.key === 'Escape') { $('#help').hidden = true; close(); }
});
$('#help').hidden = LS.get('asd_help_seen', false);
$('#help').addEventListener('click', () => { $('#help').hidden = true; LS.set('asd_help_seen', true); });
$('#settingsBtn').addEventListener('click', () => open('settings'));

globalThis.__desk = { world, get state() { return state; } };
render();
refresh();
setInterval(refresh, 60_000);
