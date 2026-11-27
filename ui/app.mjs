import { isStock, loadMarket } from '../core/aster.mjs';
import { applyPmrPreset, choosePicks, cycle, freshState, nearProposal, normalize, persistable, pickInput } from '../core/desk.mjs';
import { LEARN_EVERY, fetchLearnSample, learningRows } from '../core/learn.mjs';
import { store, update } from '../core/github.mjs';
import { PMR_DEFAULT, PMR_PRESETS, Scanner } from '../core/pmr.mjs';
import { coach, digest, weeks } from '../core/digest.mjs';
import { filterReport } from '../core/postmortem.mjs';
import { loadPosture } from '../core/regime.mjs';
import { features, learn, ruleKey, ruleLabel } from '../core/reviewer.mjs';
import { C, ago, drawCandles, fmt, hhmm, money, pct, tradeOverlay } from './charts.mjs';
import { DESKS, createWorld } from './scene.mjs';
import * as zh from './zh.mjs';
import { createChartWall } from './wall.mjs';
import { SMC_ADJ, SMC_SOURCE, smcCore, withSmc } from '../core/smc.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};
// Who trades the shared account (like the crypto desk's Sync): the cloud, or one browser. A browser takes over when the
// cloud has been quiet for 30 min or when Fred clicks "Take over"; another browser that stops cycling for 5 min is gone.
const QUIET = 30 * 60_000, BROWSER_QUIET = 5 * 60_000;
const CODE_REPO = 'fredyu1996/aster-stocl-desk'; // public: its cloud-trader runs are readable without a token

let state = normalize(LS.get('asd_state', null));
const device = () => /Mac/.test(navigator.userAgent) ? 'Mac' : /Windows/.test(navigator.userAgent) ? 'Windows PC' : /iPhone|iPad|Android/.test(navigator.userAgent) ? '手機' : '電腦';
let sync = { repo: 'fredyu1996/aster-desk-data', branch: 'stocks-state', token: '', name: '', dev: '', ...LS.get('asd_sync', {}) };
if (typeof sync.on !== 'boolean') sync.on = !!sync.token;
if (!sync.dev) sync.dev = Math.random().toString(36).slice(2, 10);
if (!sync.name) sync.name = device();
LS.set('asd_sync', sync);
let scanMap = {};
// role: off | connecting | trading | viewing | error. lock = the shared lastCycle (who traded last).
let status = { feed: '連接緊', note: '', source: '本機 paper', at: 0, role: sync.on ? 'connecting' : 'off', err: '', lock: null, takeover: false };
let cloudRuns = { at: 0, runs: null, err: '' };
let draft = {};
let panel = null;
let busy = false;
const cache = {};
const st = () => sync.on && sync.token ? store({ token: sync.token, repo: sync.repo, branch: sync.branch }) : null;

const world = createWorld($('#scene'), {
  onPick(id, uv) {
    if (id === 'board') { openWall(world.boardAt(uv)); return; }
    if (id === 'reviews') { const t = world.reviewAt(uv); open(t ? `review:${t}` : 'reviewer', 'reviews'); return; }
    if (id === 'positions') { open(world.positionsAt(uv) ?? 'trader', 'positions'); return; }
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
    if (cache.info && !(info && isStock(info))) { status.note = `${sym} 唔係 Aster 上面交易緊嘅股票永續`; render(); return; }
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
    <span>淨值 <b>${money(a.equity)}</b> <i class="${a.equity >= a.start ? 'up' : 'down'}">${pct((a.equity / a.start - 1) * 100)}</i></span>
    <span>心水 <b>${state.picks.length}</b> · 持倉 ${state.positions.length} · 掛單 ${state.orders.length} · 交易 ${state.trades.length}</span>
    <span>PMR <b>${esc(PMR_PRESETS[state.cfg.pmrPreset]?.label ?? '自訂')}</b> · ${SRC[state.cfg.pmrSource] ?? '成交'} K 線</span>
    <span>行情 <b class="${status.feed === '即時' ? 'up' : 'warn'}">${esc(status.feed)}</b>${status.at ? ` · ${hhmm(status.at)}` : ''}</span>
    ${syncChip()}
    ${status.note ? `<span class="warn">${esc(status.note)}</span>` : ''}`;
  $('#still').hidden = !world.still;
  $('#reticle').hidden = !world.following || !!panel || !$('#help').hidden || wall.isOpen();
  if (panel) renderPanel();
}

// Symbols always scanned: what the account holds plus Fred's pinned picks.
function held(s) { return [...s.orders, ...s.positions].map(x => x.symbol).concat(s.pins ?? []); }

let again = false;
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    let market;
    try {
      // News is loaded by the cloud runner only: Yahoo and SEC send no CORS headers, so a browser cannot read them.
      market = await loadMarket(state.cfg, held(state), { cache, near: nearProposal(state) });
      if (!(market.t - (state.learn?.at ?? 0) < LEARN_EVERY) && !(market.t - (cache.learnAt ?? 0) < 30 * 60_000)) {
        cache.learnAt = market.t;
        market.learn = await fetchLearnSample(CODE_REPO, { now: market.t }).catch(() => null);
      }
      status.feed = '即時'; status.at = market.t; status.note = '';
      // Market posture (breadth + uptrend CSVs) refreshes at most hourly; display and record only.
      if (!(market.t - (state.market?.at ?? 0) < 60 * 60_000) && !(market.t - (cache.postureAt ?? 0) < 60 * 60_000)) {
        cache.postureAt = market.t;
        market.posture = await loadPosture({ at: market.t }).catch(e => ({ at: market.t, errors: [e.message] }));
      }
    } catch (e) { status.feed = '離線'; status.note = e.message; return; }
    scanMap = Object.fromEntries(market.universe.watch.map(sym => {
      const sc = new Scanner(sym, market.bars[sym] ?? [], { tickSize: market.universe.specs[sym]?.tickSize, params: state.cfg.pmr });
      return [sym, { ...sc.summary(), price: sc.last?.c, h1: sc.history[60].slice(-48), m15: sc.history[15].slice(-64), m5: sc.history[5].slice(-72) }];
    }));
    const core = await smcCore(market.info).catch(e => { status.note = `SMC Trader: ${e.message}`; return null; });
    const store_ = st();
    if (!store_) {
      state = withSmc(cycle(state, market, { by: 'browser' }), market, core);
      LS.set('asd_state', persistable(state));
      status.source = '本機 paper（呢個瀏覽器）'; status.role = 'off';
      return;
    }
    loadCloudRuns();
    try {
      // Decide on the fresh copy inside update(): if someone else took the desk since our read, we view instead.
      const res = await update(store_, s => {
        const n = normalize(s);
        if (!(status.takeover || mayTrade(n.lastCycle))) return null;
        const next = withSmc(cycle(n, market, { by: 'browser' }), market, core);
        next.lastCycle = { ...next.lastCycle, dev: sync.dev, name: sync.name };
        return persistable(next);
      });
      state = normalize(res.state);
      status.takeover = false; status.err = ''; status.lock = state.lastCycle;
      status.role = res.skipped ? 'viewing' : 'trading';
      status.source = res.skipped ? `共用 · 睇緊（${lockName(state.lastCycle)} 交易緊）` : `共用 · 喺呢部 ${sync.name} 交易`;
    } catch (e) { status.role = 'error'; status.err = explain(e.message); }
  } catch (e) {
    status.note = e.message;
  } finally {
    busy = false;
    Object.assign(state.marks, pendingMarks);
    render();
    if (again) { again = false; setTimeout(refresh, 0); }
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
  } catch (e) { status.note = `儲存失敗：${e.message}`; }
  render();
}

// ---------------- sync: who trades the shared account ----------------
function mayTrade(L) {
  if (!L) return true;
  const age = Date.now() - L.t;
  if (L.by === 'browser') return !L.dev || L.dev === sync.dev || age > BROWSER_QUIET; // no dev = saved before devices were named
  return age > QUIET; // the cloud, or handed back to it
}
const explain = m => m + ({ 401: ' — token 錯咗或者過咗期。', 403: ' — token 要有 data repo 嘅 Contents: Read and write。',
  404: ' — 檢查 repo 同 branch 名，同埋 token 睇唔睇到個 data repo。' }[m.match(/HTTP (\d+)/)?.[1]] ?? '');
function lockName(L) {
  if (!L) return '未有人';
  if (L.by === 'browser') return L.dev === sync.dev || !L.dev ? `呢部 ${sync.name}` : (L.name ?? '另一個瀏覽器');
  return L.by === 'handback' ? '雲端（已交返，等緊佢下一次 run）' : '雲端';
}
async function handBack() {
  const store_ = st();
  if (!store_) return;
  try {
    const res = await update(store_, s => { const n = normalize(s); n.lastCycle = { ...(n.lastCycle ?? {}), t: Date.now(), by: 'handback', dev: sync.dev, name: sync.name }; return persistable(n); });
    state = normalize(res.state); status.lock = state.lastCycle; status.role = 'viewing'; status.err = '';
  } catch (e) { status.role = 'error'; status.err = explain(e.message); }
  render();
}
// The cloud trader's recent GitHub Actions runs (public repo, no token): shows a stopped timer or an expired DATA_TOKEN.
async function loadCloudRuns(force = false) {
  if (!force && Date.now() - cloudRuns.at < 4 * 60_000) return;
  cloudRuns.at = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${CODE_REPO}/actions/workflows/cloud-trader.yml/runs?per_page=6`,
      { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    cloudRuns.runs = (await r.json()).workflow_runs.map(w => ({ n: w.run_number, t: Date.parse(w.run_started_at ?? w.created_at), event: w.event, status: w.status, result: w.conclusion, url: w.html_url }));
    cloudRuns.err = '';
  } catch (e) { cloudRuns.err = e.message; }
  render();
}
function cloudHealth() {
  if (!cloudRuns.runs) return null;
  const r = cloudRuns.runs.find(x => x.status === 'completed');
  if (!r) return { level: 'warn', text: '雲端未有完成嘅 run' };
  if (r.result !== 'success') return { level: 'down', text: `雲端上一次 run ${ago(r.t)}前失敗`, url: r.url };
  if (Date.now() - r.t > 20 * 60_000) return { level: 'warn', text: `雲端已經靜咗 ${ago(r.t)}` };
  return { level: 'up', text: `雲端 ${ago(r.t)}前報到` };
}
function syncChip() {
  const R = status.role, L = status.lock, h = sync.on ? cloudHealth() : null;
  let txt = { off: '同步關咗', connecting: '連接緊…', trading: '已同步 · 喺度交易', error: '同步出錯',
    viewing: L?.by === 'browser' ? `睇緊 · ${String(L.name ?? '瀏覽器').slice(0, 14)} 交易緊` : '睇緊 · 雲端交易緊' }[R];
  let c = { off: 'muted', connecting: 'warn', trading: 'up', viewing: 'info', error: 'down' }[R];
  if (h && h.level !== 'up' && (R === 'viewing' || R === 'trading')) { txt += h.level === 'down' ? ' · 雲端失敗' : ' · 雲端靜咗'; c = h.level; }
  const title = R === 'viewing' ? `而家由${lockName(L)}交易。撳一下打開同步，可以接手。` : R === 'error' ? status.err : h ? h.text : '幾部電腦之間同步';
  return `<button id="sSync" class="sync-chip ${c}" title="${esc(title)}"><i></i>${esc(txt)}</button>`;
}
function cloudCard() {
  if (!sync.on) return '';
  const C = state.cloud, h = cloudHealth(), runs = cloudRuns.runs ?? [];
  const ev = e => ({ workflow_dispatch: '定時器', schedule: 'GitHub 排程' })[e] ?? e;
  return `<div class="card edge-${h?.level ?? 'muted'}"><h3>雲端 trader <span class="right ${h?.level ?? 'muted'}">${h ? esc(h.text) : cloudRuns.err ? `讀唔到佢嘅 runs（${esc(cloudRuns.err)}）` : '檢查緊…'}</span></h3>
    <p class="muted">${C ? `上一次交易：run ${esc(C.run ?? '—')} · ${ago(C.t)}前 · ${((C.ms ?? 0) / 1000).toFixed(0)} 秒 · PMR ${money(C.equity)}，持倉 ${C.open}，掛單 ${C.pending}，${C.trades} 單${C.smc ? ` · SMC ${C.smc.equity == null ? '—' : money(C.smc.equity)}，持倉 ${C.smc.open}，${C.smc.trades} 單${C.smc.error ? ` · SMC 出錯：${esc(C.smc.error)}` : ''}` : ''}` : '佢未交易過呢個戶口。'}</p>
    <ul class="runs">${runs.map(r => `<li><span class="${r.status !== 'completed' ? 'warn' : r.result === 'success' ? 'up' : 'down'}">●</span> #${r.n} · ${ev(r.event)} · ${ago(r.t)}前 · ${r.status !== 'completed' ? esc(r.status) : r.result === 'success' ? '成功' : esc(r.result)} <a href="${esc(r.url)}" target="_blank" rel="noopener">log</a></li>`).join('')}</ul>
    <p class="muted">有瀏覽器交易緊嘅時候，雲端 run 只會報到同待命。紅色 run 通常即係 <code>DATA_TOKEN</code> secret 過咗期；20 分鐘冇 run 即係 cron-job.org 定時器停咗。</p></div>`;
}
function syncPanel() {
  const R = status.role, L = status.lock ?? state.lastCycle;
  const [msg, cls] = {
    off: ['關咗。呢個瀏覽器用自己嘅本機 paper 戶口。', 'muted'],
    connecting: ['連接緊…', 'warn'],
    trading: [`喺呢部 ${sync.name} 交易緊。每個 cycle（每 60 秒）都會存去 data repo；雲端待命。`, 'up'],
    viewing: [`睇緊共用戶口。而家由${lockName(L)}交易（上一個 cycle ${L ? `${ago(L.t)}前` : '—'}）。每 60 秒更新。`, 'info'],
    error: [`連唔到 data repo：${status.err}`, 'down'],
  }[R];
  const f = (k, label, extra = '') => `<label>${label}<input data-sync-field="${k}" ${extra} value="${esc(draft[k] ?? (k === 'token' ? '' : sync[k]))}"></label>`;
  return `<h2>幾部電腦之間同步</h2>
    <div class="card edge-${cls} status"><b class="${cls}">${esc(msg)}</b>
      <span class="acts">${R === 'viewing' ? '<button data-sync="take">喺呢度接手交易</button>' : ''}${R === 'trading' ? '<button data-sync="cloud">交返畀雲端交易</button>' : ''}${sync.on ? '<button data-sync="now" class="ghost">即刻同步</button><button data-sync="off" class="ghost">關同步</button>' : ''}</span></div>
    ${cloudCard()}
    <div class="grid2"><div class="card"><h3>連接呢個瀏覽器</h3><div class="grid one">
      ${f('repo', '私人 data repo（owner/name）', 'placeholder="fredyu1996/aster-desk-data"')}${f('branch', 'Branch', 'placeholder="stocks-state"')}
      ${f('token', 'GitHub token（只會留喺呢個瀏覽器）', `type="password" autocomplete="off" placeholder="${sync.token ? '•••••••• 已儲存，留空就照用' : 'github_pat_…'}"`)}
      ${f('name', '呢部電腦嘅名', 'maxlength="24"')}</div>
      <p><button data-sync="connect">${sync.on ? '儲存並重新連接' : '連接'}</button>${sync.token ? ' <button data-sync="forget" class="ghost">刪走 token</button>' : ''}</p>
      ${R === 'error' ? `<p class="down"><b>${esc(status.err)}</b></p>` : ''}
      <p class="muted">連接之後會喺度載入共用戶口。呢個瀏覽器自己嘅本機 paper 戶口會保留，關咗同步就會返嚟。</p></div>
    <div class="card"><h3>點運作</h3><ol class="how">
      <li>兩個 paper 戶口（PMR 同 SMC）、交易、你嘅覆盤、chart 標記、pin / 剔走、規則同設定，全部係你私人 data repo 入面<b>一個檔案</b>（branch <b>${esc(sync.branch)}</b>）。</li>
      <li><b>雲端</b>大約每 5 分鐘交易一次（cron-job.org 觸發 GitHub Actions），就算所有電腦都熄咗都照做。</li>
      <li>瀏覽器係<b>睇同一個戶口嘅窗</b>。「喺呢度接手交易」會令呢個瀏覽器喺開住嘅時候行 cycle，雲端待命。「交返畀雲端交易」就還原；閂咗個 page 都一樣（5 分鐘後雲端接手）。</li>
      <li>如果雲端靜咗 30 分鐘，開住嘅瀏覽器會自己接手。</li>
      <li>Token 只會存喺呢個瀏覽器，唔會入 page 或者 repo。喺 GitHub 整：<b>Settings → Developer settings → Fine-grained tokens</b>，<b>只限 data repo</b>，<b>Contents: Read and write</b>。千祈唔好貼落 chat。</li></ol></div></div>`;
}
function syncAction(a) {
  document.activeElement?.blur?.();
  const local = () => { state = normalize(LS.get('asd_state', null)); status.role = 'off'; status.err = ''; status.lock = null; render(); refresh(); };
  if (a === 'connect') {
    const repo = String(draft.repo ?? sync.repo).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    const token = String(draft.token ?? '').trim() || sync.token;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { status.role = 'error'; status.err = 'Repo 要係 owner/name 咁嘅格式。'; return render(); }
    if (!token) { status.role = 'error'; status.err = '先貼 token。'; return render(); }
    sync = { ...sync, repo, token, on: true, branch: String(draft.branch ?? sync.branch).trim() || 'stocks-state', name: String(draft.name ?? sync.name).trim().slice(0, 24) || sync.name };
    draft = {}; LS.set('asd_sync', sync); status.role = 'connecting'; status.err = '';
    render(); loadCloudRuns(true); return refresh();
  }
  if (a === 'take') { status.takeover = true; status.role = 'connecting'; render(); return refresh(); }
  if (a === 'cloud') return handBack();
  if (a === 'now') { loadCloudRuns(true); return refresh(); }
  if (a === 'off') { sync = { ...sync, on: false }; LS.set('asd_sync', sync); return local(); }
  if (a === 'forget') { sync = { ...sync, on: false, token: '' }; draft = {}; LS.set('asd_sync', sync); return local(); }
}

// ---------------- panels ----------------
function open(id, spot) {
  panel = id;
  world.goTo(spot ?? (id.startsWith('review:') ? 'reviews' : id.startsWith('chart:') ? 'screener' : id), true);
  $('#panel').hidden = false;
  renderPanel();
}
function close() { panel = null; $('#panel').hidden = true; }

const tabs = [['wall', 'B 心水牆'], ['screener', '1 篩選'], ['trader', '2 PMR Trader'], ['reviewer', '3 審核'], ['intel', '4 情報'], ['digest', '5 週報'],
  ['smc', '6 SMC Trader'], ['backtest', '7 回測'], ['sync', '☁ 同步'], ['settings', '⚙ 設定']];
function renderPanel() {
  if (document.activeElement?.closest('#panel input, #panel textarea, #panel select')) return;
  const [kind, arg] = panel.split(/:(.*)/s);
  const body = { screener, trader, reviewer, intel, settings, sync: syncPanel, smc: smcPanel, backtest: backtestPanel, digest: () => digestPanel(arg), review: () => review(arg), chart: () => chart(arg) }[kind]?.() ?? '';
  $('#panel').innerHTML = `<nav>${tabs.map(([id, label]) => `<button data-open="${id}" class="${kind === id ? 'on' : ''}">${label}</button>`).join('')}
    <button data-close title="Esc 關閉">✕</button></nav><div class="body">${body}</div>`;
  for (const cv of $('#panel').querySelectorAll('canvas[data-chart]')) paintChart(cv);
}

function table(head, rows) {
  return `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">未有</td></tr>`}</tbody></table>`;
}

function screener() {
  const pk = new Map(state.picks.map(p => [p.symbol, p]));
  const rows = Object.values(scanMap).map(s => `<tr data-open="chart:${s.symbol}" class="click">
    <td><b>${s.symbol.replace('USDT', '')}</b></td><td>${pk.has(s.symbol) ? (pk.get(s.symbol).why === 'pinned' ? '★ 心水' : '心水') : state.skips.includes(s.symbol) ? '<span class="muted">剔走咗</span>' : ''}</td><td>${fmt(s.price)}</td><td style="color:${s.status === 'QUALIFIED' ? '#fbbf24' : ''}">${zh.st(s.status)}</td>
    <td class="muted">${esc(s.reason ? zh.rsn(s.reason) : '')}</td><td>${s.anchor ? `${zh.pat(s.anchor.type)} ${s.anchor.direction === 1 ? '↑' : '↓'} ${hhmm(s.anchor.t)}` : ''}</td></tr>`);
  const P = { ...PMR_DEFAULT, ...state.cfg.pmr };
  return `<h2>Screener 篩選 · ${esc(PMR_PRESETS[state.cfg.pmrPreset]?.label ?? '自訂 PMR')}</h2>
    <p class="muted">已完成嘅 1H 形態突破 → 突破帶出嘅新鮮 15m OB / FVG（displacement ≥ ${P.dispAtr} ATR，距離 ≤ ${P.poiDistAtr} ATR）→ ${P.retestMin} 分鐘內第一次回測 → ${P.mssMin} 分鐘內 5m MSS + displacement → FVG 中位入場（${P.entryWindowMin} 分鐘入場窗）→ target ${P.targetR ? `固定 ${P.targetR}R` : '1H measured move'}。撳一行睇佢 1H / 15m / 5m chart。</p>
    <p>頭 ${state.cfg.picks} 隻（兩個 trader 持倉中、你 pin 咗、SMC zone 入面、PMR 行得最遠、成交額）會擺上北牆做心水。${state.cfg.picksOnly ? 'PMR Trader 只做心水嘅 proposal。' : ''}SMC Trader 掃${state.cfg.smcScope === 'picks' ? '心水' : '所有 watch 緊嘅股（減你剔走嘅）'}。 <button data-open="wall">打開心水牆（B）</button></p>
    ${table(['股票', '心水', '現價', '狀態', '原因', '1H 形態'], rows)}`;
}

function chart(sym) {
  const s = scanMap[sym];
  if (!s) return '<p class="muted">呢隻股未有數據。</p>';
  const ov = { lines: [], zones: [] };
  if (s.anchor) ov.lines.push({ price: s.anchor.boundary, color: C.boundary, label: 'BRK' }, { price: s.anchor.target, color: C.target, label: 'TGT', dash: [2, 4] });
  if (s.poi) ov.zones.push({ lo: s.poi.lo, hi: s.poi.hi, from: s.poi.knownAt, label: `15m ${s.poi.type}` });
  if (s.plan) Object.assign(ov, tradeOverlay(s.plan));
  CHARTS = { [`${sym}:h1`]: [s.h1, ov], [`${sym}:m15`]: [s.m15, ov], [`${sym}:m5`]: [s.m5, ov] };
  return `<h2>${sym} · ${zh.st(s.status)}</h2><p class="muted">${esc(s.reason ? zh.rsn(s.reason) : '')}</p>
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
  const pos = state.positions.map(p => `<tr><td>${p.symbol}</td><td>${zh.side(p.direction)}</td><td>${p.qty}</td><td>${fmt(p.entry)}</td>
    <td>${fmt(p.stop)} / ${fmt(p.target)}</td><td class="${p.direction * (p.mark - p.entry) >= 0 ? 'up' : 'down'}">${fmt(p.direction * (p.mark - p.entry) * p.qty)}</td><td>${hhmm(p.entryAt)}</td></tr>`);
  const ord = state.orders.map(o => `<tr><td>${o.symbol}</td><td>${o.direction === 1 ? 'Buy' : 'Sell'} limit 掛單</td><td>${o.qty}</td><td>${fmt(o.entry)}</td>
    <td>${fmt(o.stop)} / ${fmt(o.target)}</td><td>${o.netRR.toFixed(2)}R:R</td><td>${hhmm(o.plan.expiresAt)} 前</td></tr>`);
  const log = state.trades.slice(0, 40).map(t => `<tr data-open="review:${t.id}" class="click"><td>${new Date(t.exitAt).toLocaleDateString('en-CA')} ${hhmm(t.exitAt)}</td><td>${t.symbol}</td>
    <td>${t.direction === 1 ? 'L' : 'S'}</td><td>${zh.ex(t.reason)}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r.toFixed(2)}R</td><td>${t.grade?.letter ?? ''}${state.reviews[t.id] ? ' ✎' : ''}</td></tr>`);
  const wins = state.trades.filter(t => t.r > 0).length, totR = state.trades.reduce((s, t) => s + t.r, 0);
  return `<h2>PMR Trader · paper 戶口</h2>
    <div class="stats"><div><small>淨值</small><b>${money(a.equity)}</b></div><div><small>回報</small><b>${pct((a.equity / a.start - 1) * 100)}</b></div>
    <div><small>最大回撤</small><b>${fmt(a.maxDD * 100, 1)}%</b></div><div><small>交易</small><b>${state.trades.length}</b></div>
    <div><small>勝率</small><b>${state.trades.length ? Math.round(wins / state.trades.length * 100) : 0}%</b></div><div><small>總 R</small><b>${totR.toFixed(1)}R</b></div></div>
    <p><label class="switch"><input type="checkbox" data-cfg="on" ${state.cfg.on ? 'checked' : ''}> 新 paper 入場 ${state.cfg.on ? '開' : '關'}</label>
    <span class="muted"> · 起始 $${state.acct.start} · 每單風險 ${state.cfg.riskPct}% · 名義 ≤ ${state.cfg.maxNotional} USDT · 總槓桿上限 ${state.cfg.levCap}× · 策略 ${esc(PMR_PRESETS[state.cfg.pmrPreset]?.label ?? '自訂')}（⚙ 設定改）</span></p>
    <h3>持倉</h3>${table(['股票', '方向', '數量', '入場', 'Stop / Target', '未實現 USDT', '開倉時間'], pos)}
    <h3>掛單</h3>${table(['股票', '單', '數量', '價', 'Stop / Target', 'Net', '到期'], ord)}
    <h3>交易紀錄</h3>${table(['離場', '股票', '', '離場原因', '盈虧', 'R', '評分'], log)}`;
}

function bucketStats() {
  const out = [];
  for (const field of ['pattern', 'side', 'poi', 'grade', 'session', 'marks']) {
    const groups = {};
    for (const t of state.trades) (groups[features(t.plan)[field]] ??= []).push(t.r);
    for (const [v, rs] of Object.entries(groups)) out.push(`<tr><td>${zh.FIELD[field] ?? field}</td><td>${esc(field === 'pattern' ? zh.pat(v) : v)}</td><td>${rs.length}</td><td>${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)}R</td><td>${rs.reduce((a, b) => a + b, 0).toFixed(1)}R</td></tr>`);
  }
  return out;
}

// Time Machine and news on a plan, one short line.
const TM_ZH = { favour: '偏 target', even: '五五波', against: '偏 stop', unknown: '數據唔夠' };
function tmLine(tm) {
  if (!tm) return '時光機：未計';
  return `時光機：target 先到 ${Math.round(tm.pT * 100)}% · stop 先到 ${Math.round(tm.pS * 100)}% · 收支平衡要 ${Math.round(tm.breakeven * 100)}% · 實際 ${tm.share == null ? '—' : Math.round(tm.share * 100) + '%'} → ${TM_ZH[tm.tag] ?? tm.tag}（${tm.days} 日歷史，${tm.n} 次，seed ${tm.seed}）`;
}
const NEWS_ZH = { earnings: '有業績', news: '有新聞', quiet: '冇新聞', unknown: '未知' };
function newsLine(n) {
  if (!n) return '新聞：未查';
  return `新聞：${NEWS_ZH[n.tag] ?? n.tag}${n.earn !== 'unknown' ? ` · 8-K 業績 ${n.earn === 'yes' ? '有' : '冇'}` : ''}${n.items?.length ? ` · ${n.items.slice(0, 2).map(i => i.title).join(' / ')}` : ''}`;
}
function learnHTML() {
  const L = state.learn, I = state.rules.learnInfo, rows = learningRows(state), match = L && L.preset === state.cfg.pmrPreset && L.source === (state.cfg.pmrSource ?? 'trade');
  const need = 2 * 6 + 10;
  const log = (state.rules.log ?? []).slice(0, 8).map(x => `<li class="${x.kind === 'learned' ? 'up' : 'muted'}">${hhmm(x.t)} ${x.kind === 'learned' ? '學到' : '退役'} · ${esc(ruleLabel({ rule: x.key.split(':')[0], value: x.key.split(':').slice(1).join(':') }))} · <span class="muted">${esc(x.evidence)}</span></li>`).join('');
  return `<h3>自己學習</h3>
    <p class="muted">Reviewer 會一齊用三種數據學：每晚回測嘅交易（同 live 用緊嘅版本同 K 線）、live 交易、被拒絕 proposal 嘅重播。數據按時間分兩半，一組 setup 喺前半蝕、喺後半都蝕（每半 n ≥ 6，平均 ≤ −0.15R / −0.1R，合共 ≤ −3R），而且兩半都差過其他交易，就會自動加一條「唔做」規則，即刻生效。你撳「移除」佢就唔會再學返；如果之後嗰組唔再蝕，佢會自動退役。自動規則加埋最多擋一半交易。</p>
    <div class="stats"><div><small>樣本</small><b>${rows.length}</b></div><div><small>回測 / live / 重播</small><b>${['bt', 'live', 'replay'].map(k => rows.filter(r => r.src === k).length).join(' / ')}</b></div>
      <div><small>樣本合共</small><b>${rows.length ? `${rows.reduce((a, r) => a + r.R, 0).toFixed(1)}R` : '—'}</b></div><div><small>自動規則</small><b>${state.rules.active.filter(r => r.auto).length}</b></div></div>
    <p class="muted">回測樣本：${L ? `${hhmm(L.at)} 讀取 · 報告 ${new Date(L.t).toLocaleDateString('en-CA')} · ${L.rows.length} 單 · ${L.days ?? '—'} 日 · ${L.symbols ?? '—'} 隻 · ${esc(PMR_PRESETS[L.preset]?.label ?? L.preset)} · ${L.source === 'mark' ? 'Mark' : '成交'} K 線${match ? '' : ' · <span class="warn">同 live 版本 / K 線唔夾，冇用</span>'}` : '未讀到（每晚回測寫完先有）'}${rows.length < need ? ` · <span class="warn">要 ≥ ${need} 單先開始學（而家 ${rows.length}）</span>` : ''}${I?.split ? ` · 前後分界 ${new Date(I.split).toLocaleDateString('en-CA')}` : ''}</p>
    ${log ? `<ul class="items">${log}</ul>` : ''}`;
}

function reviewer() {
  const active = state.rules.active.map(r => `<li>${r.auto ? '<b class="up">自動</b>' : '✓'} ${esc(ruleLabel(r))} <button data-rule="remove" data-key="${esc(ruleKey(r))}">移除</button>${r.auto ? `<br><span class="muted">${hhmm(r.at)} 學到 · ${esc(r.evidence)}</span>` : ''}</li>`).join('');
  const props = state.rules.proposals.map(p => `<li><b>${esc(ruleLabel(p))}</b><br><span class="muted">${esc(p.evidence)}</span><br>
    <button data-rule="approve" data-key="${esc(ruleKey(p))}">批准</button> <button data-rule="reject" data-key="${esc(ruleKey(p))}">拒絕</button></li>`).join('');
  const dec = (state.decisions ?? []).slice(0, 30).map(d => `<tr><td>${hhmm(d.t)}</td><td>${d.symbol}</td><td class="${d.status === 'Approved' ? 'up' : d.status === 'Declined' ? 'warn' : ''}">${zh.dec(d.status)}</td>
    <td>${esc(zh.rsn(d.reason))}</td><td>${Number.isFinite(d.netRR) ? d.netRR.toFixed(2) : ''}</td><td>${d.plan.grade}</td>
    <td title="${esc(tmLine(d.plan.tm))}">${d.plan.tm ? `${TM_ZH[d.plan.tm.tag]} ${d.plan.tm.share == null ? '' : Math.round(d.plan.tm.share * 100) + '%'}` : '—'}</td><td title="${esc(newsLine(d.plan.news))}">${d.plan.news ? NEWS_ZH[d.plan.news.tag] : '—'}</td></tr>`);
  return `<h2>Reviewer 審核</h2>
    <p class="muted">每個 proposal 都會核：扣埋 taker 手續費（每邊 ${state.cfg.fee * 100}%）、離場滑價（${state.cfg.slip * 100}%）同持倉期內嘅 funding 之後 net R:R ≥ ${state.cfg.minNetRR}、點差 ≤ ${state.cfg.maxSpreadPct}%、交易所 size 限制、持倉上限、你手畫嘅 chart 標記（同你最新 MSS 對頭，或者 entry 喺你反方向 FVG / OB 入面就拒絕），同埋生效規則（自動學到嘅同你批准嘅）。每單平倉後評 A–F。你有三次覆盤講同一樣嘢，會建議新規則，要你批准。</p>
    <h3>生效規則</h3><ul class="rules">${active || '<li class="muted">冇。淨係基本檢查。</li>'}</ul>
    ${learnHTML()}
    <h3>規則建議（嚟自你嘅覆盤）</h3><ul class="rules">${props || '<li class="muted">冇建議：證據未夠。</li>'}</ul>
    <h3>決定</h3>${table(['時間', '股票', '決定', '原因', 'Net R:R', 'Setup', '時光機', '新聞'], dec)}
    <h3>分組結果</h3>${table(['欄位', '值', 'n', '平均', '合共'], bucketStats())}
    <p class="muted">覆盤一單：行去南牆（V）撳佢張卡，或者喺 PMR Trader → 交易紀錄撳一行。</p>`;
}

const zoneClass = z => ['Strong', 'Healthy', 'Strong Bull', 'Bull'].includes(z) ? 'up' : ['Neutral'].includes(z) ? 'warn' : 'down';
function postureHTML() {
  const m = state.market;
  if (!m) return '<p class="muted">第一個 cycle 之後一分鐘內會載入市況（TraderMonty 公開 breadth + uptrend CSV）。</p>';
  const ex = m.exposure, b = m.breadth, u = m.uptrend;
  const rec = ex?.recommendation ?? '—';
  return `<div class="stats">
      <div><small>Exposure coach</small><b class="${rec === 'NEW_ENTRY_ALLOWED' ? 'up' : rec === 'REDUCE_ONLY' ? 'warn' : 'down'}">${esc(zh.rec(rec))}</b></div>
      <div><small>倉位上限</small><b>${ex ? `${ex.ceiling}%` : '—'}</b></div>
      <div><small>S&amp;P 500 breadth（${esc(b?.date ?? 'n/a')}）</small><b class="${b ? zoneClass(b.zone) : ''}">${b ? `${b.composite} ${esc(zh.zone(b.zone))}` : '冇數據'}</b></div>
      <div><small>Uptrend ratio（${esc(u?.date ?? 'n/a')}）</small><b class="${u ? zoneClass(u.zone) : ''}">${u ? `${u.composite} ${esc(zh.zone(u.zone))}` : '冇數據'}</b></div>
      <div><small>板塊健康</small><b>${m.sector ?? '—'}</b></div>
      <div><small>參與度 · 信心</small><b>${esc(zh.lvl(ex?.participation))} · ${esc(zh.lvl(ex?.confidence))}</b></div></div>
    <p class="muted">${b ? `Breadth 8MA ${fmt(b.ma8, 3)}${b.pink_zone ? ' · PINK ZONE（200MA 向下，8MA 喺佢下面）' : ''}${b.caution ? ' · 小心：8MA 轉頭向下' : ''} · ` : ''}${u ? `uptrend ratio ${pct(u.ratio * 100).replace('+', '')}${u.warnings.length ? ` · 警告：${esc(u.warnings.join(', '))}` : ''} · ` : ''}缺少嘅輸入：${esc((ex?.missing ?? []).join(', ') || '冇')}${ex?.missing_critical?.length ? `（缺咗關鍵輸入：${esc(ex.missing_critical.join(', '))}，所以 coach 扣 ${ex.missing_critical.length * 10} 分，永遠唔會講「可以開新倉」）` : ''}。
    ${ago(m.at)}前更新。${m.errors?.length ? ` <span class="warn">數據：${esc(m.errors.join('; '))}</span>` : ''}</p>
    <p class="muted">由 tradermonty/claude-trading-skills 移植（market-breadth-analyzer、uptrend-analyzer、exposure-coach）。每個 proposal 都會記低美股市況；佢唔會擋單，亦唔會影響注碼。</p>`;
}
function intel() {
  const items = (state.intel ?? []).map(i => `<tr><td>${hhmm(i.t)}</td><td>${zh.evt(i.type)}</td><td>${esc(i.title)}</td><td class="muted">${esc(i.detail)}</td></tr>`);
  const movers = (state.board ?? []).slice(0, 30).map(r => `<tr><td>${r.symbol.replace('USDT', '')}</td><td>${fmt(r.last)}</td><td class="${r.change >= 0 ? 'up' : 'down'}">${pct(r.change)}</td><td>${(r.quoteVolume / 1e6).toFixed(2)}M</td></tr>`);
  return `<h2>市場情報</h2><h3>美股市況</h3>${postureHTML()}<h3>Aster 成交</h3><p class="muted">Watch 緊嘅股票永續：taker 買 vs taker 賣嘅名義金額，同埋 5m 成交量爆升（≥ 之前 20 支嘅 2.5 倍）。未有新聞。</p>
    ${table(['時間', '類型', '訊號', '詳情'], items)}<h3>股票永續 24h 成交額排名</h3>${table(['股票', '現價', '24h', '成交額'], movers)}`;
}

const SRC = { mark: 'Mark price', trade: '成交' };
const money0 = n => Number.isFinite(n) ? money(n) : '—';
const r2 = n => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '—';
function bucketTable(title, b) {
  const rows = Object.entries(b).sort((x, y) => y[1].total - x[1].total).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.total}</td><td>${v.wins}/${v.losses}</td><td>${v.win_rate == null ? '—' : `${Math.round(v.win_rate * 100)}%`}</td><td>${r2(v.r)}</td></tr>`);
  return rows.length ? `<h3>按${title}</h3>${table(['值', 'n', '贏/輸', '勝率', '總 R'], rows)}` : '';
}
function digestPanel(arg = '') {
  const [acct, wk] = arg.includes('|') ? arg.split('|') : ['pmr', arg];
  const trades = acct === 'smc' ? state.smc?.trades ?? [] : state.trades;
  const ws = weeks(trades), week = wk === 'all' ? undefined : wk || ws[0];
  const d = digest(trades, { week }), c = coach(trades, { reviews: state.reviews, cfg: state.cfg, start: acct === 'smc' ? state.smc?.acct?.start ?? 1000 : state.acct.start, week });
  const pm = acct === 'smc' ? [] : filterReport(state.decisions ?? []);
  const sev = { critical: 'down', warning: 'warn', info: 'muted' };
  const recent = (state.decisions ?? []).filter(x => x.status === 'Declined').slice(0, 12).map(x => `<tr><td>${hhmm(x.t)}</td><td>${x.symbol.replace('USDT', '')}</td><td>${esc(zh.filt(x.post?.filter ?? ''))}</td>
    <td class="muted">${esc(zh.rsn(x.reason))}</td><td class="${x.post?.outcome === 'MISSED_OPPORTUNITY' ? 'warn' : x.post?.outcome === 'GOOD_SKIP' ? 'up' : ''}">${esc(zh.outcome(x.post?.outcome))}</td><td>${x.post?.filled ? r2(x.post.r) : ''}</td></tr>`);
  return `<h2>週報 · ${acct === 'smc' ? 'SMC Trader' : 'PMR Trader'} · ${week ? `${week} 嗰個星期` : '全部'}</h2>
    <p><button data-open="digest:pmr|" class="${acct !== 'smc' ? 'on' : ''}">PMR Trader</button> <button data-open="digest:smc|" class="${acct === 'smc' ? 'on' : ''}">SMC Trader</button></p>
    <p>${ws.slice(0, 6).map(w => `<button data-open="digest:${acct}|${w}" class="${w === week ? 'on' : ''}">${w}</button>`).join(' ')} <button data-open="digest:${acct}|all" class="${!week ? 'on' : ''}">全部</button></p>
    ${d.trades ? `<div class="stats"><div><small>交易</small><b>${d.trades}</b></div><div><small>勝率</small><b>${Math.round(d.winRate * 100)}%</b></div>
      <div><small>期望值</small><b>${money0(d.expectancy)}</b></div><div><small>Profit factor</small><b>${d.profitFactor == null ? '冇蝕單' : d.profitFactor.toFixed(2)}</b></div>
      <div><small>合共</small><b class="${d.totalPnl >= 0 ? 'up' : 'down'}">${money0(d.totalPnl)} · ${r2(d.totalR)}</b></div><div><small>平均 R ± sd</small><b>${r2(d.avgR)} ± ${d.rStdev?.toFixed(2) ?? '—'}</b></div>
      <div><small>平均贏 / 輸</small><b>${money0(d.avgWin)} / ${money0(d.avgLoss)}</b></div><div><small>持倉時間 贏 / 輸</small><b>${d.holdWinMin?.toFixed(0) ?? '—'} / ${d.holdLossMin?.toFixed(0) ?? '—'} 分鐘</b></div>
      <div><small>平均 MAE / MFE</small><b>${d.maeSamples ? `${d.avgMaeR.toFixed(2)} / ${d.avgMfeR.toFixed(2)}R` : 'n/a'}</b></div></div>
      ${d.smallSample ? `<p class="warn">得 ${d.trades} 單：只可以當方向參考，唔算結論。</p>` : ''}
      ${bucketTable('結果', d.by.outcome)}${bucketTable('離場原因', d.by.exit)}${bucketTable(' 1H 形態', d.by.pattern)}${bucketTable('你嘅標記', d.by.marks)}${bucketTable('訊號時嘅市況', d.by.posture)}`
      : '<p class="muted">呢段時間冇平倉嘅單。</p>'}
    <h3>Coach · ${esc(zh.verdict(c.verdict))}</h3>
    <div class="stats"><div><small>風險</small><b>${c.scores.risk}</b></div><div><small>執行</small><b>${c.scores.execution}</b></div><div><small>流程</small><b>${c.scores.process}</b></div>
      <div><small>市況</small><b>${c.scores.regime}</b></div><div><small>你覆盤咗</small><b>${c.reviewQuality == null ? '—' : `${c.reviewQuality}%`}</b></div></div>
    <ul class="items">${c.findings.map(f => `<li class="${sev[f.severity]}">${zh.SEVERITY[f.severity] ?? f.severity} · ${esc(zh.AXIS[f.axis] ?? f.axis)} · ${esc(f.text)}</li>`).join('') || '<li class="muted">冇發現。</li>'}</ul>
    ${Object.keys(c.rootCauses).length ? `<p class="muted">蝕單根本原因：${esc(Object.entries(c.rootCauses).map(([k, v]) => `${zh.ROOT[k] ?? k} ${v}`).join(' · '))}</p>` : ''}
    ${c.suggestions.length ? `<p><b>建議（未套用）</b></p><ul class="items">${c.suggestions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${acct === 'smc' ? '<p class="muted">SMC Trader 未有 postmortem：佢嘅拒絕係 SMC engine 自己嘅 skip 原因（6 SMC Trader）。呢度嘅 R 係 crypto desk 嘅算法：已實現盈虧 / 入場時嘅風險。</p>' : `<h3>Postmortem · 被拒絕嘅 proposal 如果做咗會點</h3>
    <p class="muted">每個被拒絕嘅 proposal 喺佢個時間窗完咗之後，用完成嘅 1m K 線同 desk 自己嘅成交規則重播。錯過機會 ≥ +0.5R，避得好 ≤ −0.5R。一個 filter 要有 ≥ 8 次成交重播，而且前後兩半同一邊，先會有結論。</p>
    ${table(['Filter', '拒絕', '成交', '錯過', '避得好', '中性', '冇成交', '總 R', '結論'], pm.map(p => `<tr><td>${esc(zh.filt(p.filter))}</td><td>${p.declined}${p.pending ? `（${p.pending} 等緊）` : ''}</td><td>${p.filled}</td><td>${p.missed}</td><td>${p.goodSkip}</td><td>${p.neutral}</td><td>${p.noFill}</td><td>${p.filled ? r2(p.totalR) : '—'}</td><td class="muted">${esc(p.verdict)}</td></tr>`))}
    ${recent.length ? `<h3>最近拒絕</h3>${table(['時間', '股票', 'Filter', '原因', '結果', 'R'], recent)}` : ''}`}
    <p class="muted">改編自 tradermonty/claude-trading-skills：weekly-performance-digest、trade-performance-coach、signal-postmortem。行為標籤（FOMO、報復式交易）要真人落單先有意義，所以 coach 冇用。</p>`;
}

function smcPanel() {
  const m = state.smc ?? {}, a = m.acct ?? { start: 1000, cash: 1000, pos: {} }, tr = m.trades ?? [], on = m.on !== false;
  const wins = tr.filter(t => t.r > 0).length, totR = tr.reduce((x, t) => x + t.r, 0), eq = m.equity ?? a.cash;
  const pos = Object.entries(a.pos ?? {}).map(([s, p]) => { const px = scanMap[s]?.price ?? p.entry, r = (p.side === 'L' ? px - p.entry : p.entry - px) / Math.abs(p.entry - p.stop0);
    return `<tr><td>${s.replace('USDT', '')}</td><td>${zh.side(p.side)}</td><td>${esc(p.tf)} ${esc(p.zoneKind)}</td><td>${fmt(p.entry)}</td><td>${fmt(p.stop)} / ${fmt(p.target)}</td>
      <td class="${r >= 0 ? 'up' : 'down'}">${r.toFixed(2)}R${p.tp1 ? ' · 已平一半' : ''}</td><td>${hhmm(p.t)}</td></tr><tr><td colspan="7" class="muted">${esc(p.why)}</td></tr>`; });
  const scan = (m.scan?.cands ?? []).map(c => `<tr><td>${esc(c.b)}</td><td>${zh.side(c.side)}</td><td>${esc(c.tf)} ${esc(c.zone)}</td><td>${esc(c.q ?? '—')}</td><td>${esc(c.type)}</td>
    <td class="${c.took ? 'up' : /^MARK/.test(c.skip ?? '') ? 'warn' : 'muted'}">${c.took ? '入咗' : esc(zh.rsn(c.skip))}</td></tr>`);
  const log = tr.slice(0, 40).map(t => `<tr><td>${new Date(t.exitAt).toLocaleDateString('en-CA')} ${hhmm(t.exitAt)}</td><td>${t.symbol.replace('USDT', '')}</td><td>${t.direction === 1 ? 'L' : 'S'}</td>
    <td class="muted">${esc(zh.ex(t.reason))}</td><td class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl)}</td><td>${t.r.toFixed(2)}R</td></tr>`);
  const dec = (m.decisions ?? []).slice(0, 12).map(d => `<tr><td>${hhmm(d.t)}</td><td>${esc(d.symbol.replace('USDT', ''))}</td><td>${zh.side(d.side)}</td><td class="${d.status === 'Entered' ? 'up' : 'warn'}">${esc(zh.dec(d.status))}</td><td class="muted">${esc(zh.rsn(d.reason))}</td></tr>`);
  return `<h2>SMC Trader · 第二個 paper 戶口</h2>
    <p class="muted">你 crypto desk 嘅 SMC Trader（small-cap 設定），行佢自己嘅 code（${esc(SMC_SOURCE.code)}），掃${state.cfg.smcScope === 'picks' ? '北牆心水' : '所有 watch 緊嘅股（成交額排名 + 你嘅 pin，減你剔走嘅）'}。
    Setup：liquidity sweep → 帶 displacement 嘅結構轉換 → 15m（1h filter）或者 1h（4h filter）嘅 FVG（冇就 OB）回調，加埋延續單；永遠唔逆大時框。
    由你 crypto Reviewer 帶過嚟嘅規則：${esc(Object.entries(SMC_ADJ).map(([k, v]) => v === true ? k : `${k} ${v}`).join(' · '))}。你手畫嘅 MSS / FVG / OB 標記會否決對頭嘅入場，同 PMR Trader 一樣。
    佢每個 5m 收市行一步（用 5m K 線行持倉，先行不利嗰邊極值），同你 crypto 回測器重播嘅方法一樣。</p>
    ${m.error ? `<p class="down">上一個 cycle 出錯：${esc(m.error)}</p>` : ''}
    <div class="stats"><div><small>淨值</small><b>${money(eq)}</b></div><div><small>回報</small><b>${pct((eq / (a.start || 1000) - 1) * 100)}</b></div>
      <div><small>交易</small><b>${tr.length}</b></div><div><small>勝率</small><b>${tr.length ? Math.round(wins / tr.length * 100) : 0}%</b></div><div><small>總 R</small><b>${totR.toFixed(1)}R</b></div>
      <div><small>上一步</small><b>${m.lastStep ? hhmm(m.lastStep) : '—'}</b></div></div>
    <p><label class="switch"><input type="checkbox" data-smc="on" ${on ? 'checked' : ''}> SMC paper 入場 ${on ? '開' : '關'}</label>
      <span class="muted"> · 起始 $${a.start ?? 1000} · 每單 1% 風險 · 最多 3 個倉 · 10× 上限 · +1.2R 平一半之後 trail · ${state.cfg.on ? '' : '成個 desk 嘅開關（2 PMR Trader）關咗，所以唔會入場'}</span></p>
    <h3>持倉</h3>${table(['股票', '方向', 'Setup', '入場', 'Stop / Target', '而家', '開倉時間'], pos)}
    <h3>上一次掃描 ${m.scan ? `（${hhmm(m.scan.t)}）` : ''}</h3>${scan.length ? table(['股票', '方向', 'Setup', '質素', '類型', '結果'], scan) : '<p class="muted">而家冇股喺 SMC 入場 zone 入面。</p>'}
    ${dec.length ? `<h3>入場同標記否決</h3>${table(['時間', '股票', '方向', '結果', '詳情'], dec)}` : ''}
    <h3>交易紀錄</h3>${table(['離場', '股票', '', '離場原因', '盈虧', 'R'], log)}`;
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
const sR = s => s?.n ? `平均 ${s.avgR >= 0 ? '+' : ''}${s.avgR}R · 合共 ${s.totR >= 0 ? '+' : ''}${s.totR}R · 勝率 ${s.win}% · n ${s.n}` : '冇交易';
function btBlock(name, x) {
  const rows = o => Object.entries(o).sort((a, b) => b[1].n - a[1].n).map(([k, s]) => `<tr><td>${esc(k)}</td><td>${s.n}</td><td>${s.win}%</td><td>${s.avgR >= 0 ? '+' : ''}${s.avgR}R</td><td>${s.totR >= 0 ? '+' : ''}${s.totR}R</td><td>${s.maxDD}R</td></tr>`);
  const h = ['值', 'n', '勝率', '平均 R', '總 R', '最大回撤'];
  const last = x.trades.slice(-15).reverse().map(t => `<tr><td>${new Date(t.t0).toLocaleDateString('en-CA')}</td><td>${esc(t.s.replace('USDT', ''))}</td><td>${t.side}</td><td>${esc(t.pattern ?? `${t.tf ?? ''} ${t.zone ?? ''}`)}</td><td class="muted">${esc(t.why)}</td><td class="${t.R >= 0 ? 'up' : 'down'}">${t.R >= 0 ? '+' : ''}${t.R}R</td></tr>`);
  return `<h3>${name}</h3>
    <div class="stats"><div><small>交易</small><b>${x.all.n}</b></div><div><small>勝率</small><b>${x.all.win == null ? '—' : `${x.all.win}%`}</b></div><div><small>平均 R</small><b>${x.all.avgR ?? '—'}</b></div>
      <div><small>總 R</small><b class="${x.all.totR >= 0 ? 'up' : 'down'}">${x.all.totR}R</b></div><div><small>最大回撤</small><b>${x.all.maxDD}R</b></div><div><small>Profit factor（R）</small><b>${x.all.pf ?? '—'}</b></div></div>
    <p>前半：${sR(x.halves[0])}<br>後半：${sR(x.halves[1])}${x.all.n < 30 ? `<br><span class="warn">得 ${x.all.n} 單：太少，判斷唔到個策略。</span>` : ''}</p>
    ${x.declined ? `<p class="muted">${x.proposals} 個 PMR proposal · 冇做嘅：${esc(Object.entries(x.declined).map(([k, v]) => `${zh.rsn(k)} ${v}`).join(' · ') || '冇')}</p>` : ''}
    ${x.skips ? `<p class="muted">最常見嘅 SMC skip 原因：${esc(Object.entries(x.skips).slice(0, 6).map(([k, v]) => `${k}（${v}）`).join(' · '))}</p>` : ''}
    <details><summary>按股票、月份、離場</summary>${table(h, rows(x.bySymbol))}${table(h, rows(x.months))}${table(h, rows(x.exits))}</details>
    ${last.length ? `<details><summary>最後 15 單</summary>${table(['入場', '股票', '方向', 'Setup', '離場', 'R'], last)}</details>` : ''}`;
}
function backtestPanel() {
  loadBacktest();
  const d = bt.data;
  if (!d) return `<h2>回測</h2><p class="muted">${bt.err ? `未有報告（${esc(bt.err)}）。報告由每晚嘅 workflow「backtest」寫（Actions → backtest → Run workflow）。` : '載入緊最新報告…'}</p>`;
  const flat = Object.entries(d.coverage ?? {}).filter(([, c]) => c.flatPct != null).map(([k, c]) => `${k.replace('USDT', '')} ${c.flatPct}%`);
  return `<h2>回測 · ${d.days} 日 · ${d.symbols.length} 隻股票永續 · ${d.source === 'mark' ? 'Mark price K 線' : '成交 K 線'}</h2>
    ${flat.length ? `<p class="${d.source === 'mark' ? 'muted' : 'warn'}">冇成交（平）嘅 1m K 線比例：${esc(flat.join(' · '))}${d.source === 'mark' ? '。Mark price 冇成交量，實際喺薄 book 成交可能差過 mark。' : '。比例高即係大部分時間冇成交，形態好難成立。'}</p>` : ''}
    <p class="muted">${new Date(d.from).toLocaleDateString('en-CA')} → ${new Date(d.to).toLocaleDateString('en-CA')} · ${new Date(d.t).toLocaleString('en-CA')} 跑 · ${esc(d.symbols.map(s => s.replace('USDT', '')).join(', '))}。
      只係報告：唔會改任何一個 trader。${esc(d.notes.slice(1).join(' '))}</p>
    ${btBlock(`PMR Trader（${esc(PMR_PRESETS[d.pmr.cfg?.preset]?.label ?? 'GMS PMR v1.4 原版')}）`, d.pmr)}${d.pmr.variants ? `<h3>PMR variants（只係報告；live 用緊嘅喺 ⚙ 設定揀）</h3>
      <p class="muted">v1.4 漏斗：${d.pmr.variants[0].funnel.breakouts} 次 1H 突破 → ${d.pmr.variants[0].funnel.poi} 個新鮮 15m zone → ${d.pmr.variants[0].funnel.retest} 次第一次回測 → ${d.pmr.variants[0].funnel.mss} 次 5m MSS → ${d.pmr.variants[0].funnel.proposals} 個 proposal。出到 proposal 嘅時候，大部分都過唔到 net R:R：等到 5m 入場形成，1H measured-move target 已經用咗大半。</p>
      ${table(['Variant', '時間離場', '持倉中位', 'Proposal', '交易', '勝率', '平均 R', '總 R', '前半', '後半'], d.pmr.variants.map(v => `<tr><td>${esc(v.name)}</td><td>${v.timeExitMin === null ? '冇' : `${v.timeExitMin ?? 90} 分鐘`}</td><td>${v.holdMin == null ? '—' : v.holdMin >= 120 ? `${(v.holdMin / 60).toFixed(1)} 粒鐘` : `${Math.round(v.holdMin)} 分鐘`}</td><td>${v.proposals}</td><td>${v.all.n}</td><td>${v.all.win == null ? '—' : `${v.all.win}%`}</td><td>${v.all.avgR ?? '—'}</td><td>${v.all.totR}R</td><td>${v.halves[0].totR}R (n ${v.halves[0].n})</td><td>${v.halves[1].totR}R (n ${v.halves[1].n})</td></tr>`))}` : ''}${btBlock('SMC Trader（crypto desk code，small-cap 設定）', d.smc)}`;
}

const A_CHIPS = [['same', '照做'], ['skip', '唔做'], ['flip', '做反方向'], ['later', '遲啲 / 深啲入'], ['earlier', '早啲入'],
  ['exitE', '早啲走'], ['hold', '揸耐啲'], ['wider', 'Stop 闊啲'], ['tighter', 'Stop 窄啲']];
const B_CHIPS = [['pattern', '1H 形態'], ['poi', '15m OB / FVG'], ['retest', '回測'], ['mss', '5m MSS'], ['fvg', '5m FVG 入場'], ['rr', 'Target / R:R'], ['session', '時段'], ['news', '新聞 / 催化劑']];

function review(id) {
  const t = state.trades.find(x => x.id === id);
  if (!t) return '<p class="muted">搵唔到呢單。</p>';
  const rv = state.reviews[id] ?? {};
  const bars = scanMap[t.symbol]?.m5?.filter(b => b.t >= t.plan.signalAt - 3 * 3600_000 && b.t <= t.exitAt + 3600_000) ?? [];
  CHARTS = { [`trade:${id}`]: [bars, tradeOverlay(t)] };
  const chip = (group, [k, label]) => `<label class="chip"><input type="checkbox" name="${group}" value="${k}" ${rv[group]?.includes(k) ? 'checked' : ''}>${label}</label>`;
  return `<h2>${t.symbol} ${t.direction === 1 ? 'long' : 'short'} · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R · 評分 ${t.grade?.letter}</h2>
    <p class="muted">${zh.pat(t.plan.pattern.type)} · 15m ${t.plan.poi.type} · ${t.plan.grade} · entry ${fmt(t.entry)} ${hhmm(t.entryAt)} → ${zh.ex(t.reason)} ${fmt(t.exit)} ${hhmm(t.exitAt)} · 入場時 net R:R ${t.netRR.toFixed(2)} · 手續費 ${money(t.fees)}${t.plan.marks ? ` · 你嘅標記：${t.plan.marks.confluence ? '中咗同方向 zone ✓' : '冇中 zone'}${t.plan.marks.mss ? `，最新 MSS ${t.plan.marks.mss}` : ''}` : ''}</p>
    <p class="muted">${esc(tmLine(t.plan.tm))}<br>${esc(newsLine(t.plan.news))}</p>
    <canvas data-chart="trade:${id}" data-title="${t.symbol} 5m"></canvas>
    <ul class="items">${t.grade.items.map(i => `<li class="${i.ok ? 'up' : 'down'}">${i.ok ? '✓' : '✗'} ${esc(zh.item(i.text))}</li>`).join('')}</ul>
    <form id="rvform" data-id="${esc(id)}">
      <h3>你嘅覆盤</h3>
      <p>評分 ${['A', 'B', 'C', 'D', 'F'].map(g => `<label class="chip"><input type="radio" name="grade" value="${g}" ${rv.grade === g ? 'checked' : ''}>${g}</label>`).join('')}
      <label class="chip"><input type="checkbox" name="disagree" ${rv.agree === false ? 'checked' : ''}>我唔同意 Reviewer 嘅評分</label></p>
      <p>我會點做<br>${A_CHIPS.map(c => chip('a', c)).join('')}</p>
      <p>Setup 弱嘅地方<br>${B_CHIPS.map(c => chip('b', c)).join('')}</p>
      <textarea name="comment" rows="4" placeholder="評語（廣東話或者 English）">${esc(rv.comment ?? '')}</textarea>
      <p><label class="chip"><input type="checkbox" name="exclude" ${rv.exclude ? 'checked' : ''}>唔好用呢單嚟學嘢</label></p>
      <button type="submit">儲存覆盤</button> <span class="muted">${rv.t ? `${ago(rv.t)}前儲存` : ''}</span>
    </form>`;
}

function settings() {
  const c = state.cfg;
  const num = (k, label, step = 'any', ph = '') => `<label>${label}<input type="number" step="${step}" data-cfg="${k}" value="${c[k] ?? ''}" placeholder="${ph}"></label>`;
  const preset = PMR_PRESETS[c.pmrPreset], P = { ...PMR_DEFAULT, ...c.pmr }, edited = preset && c.minNetRR !== preset.minNetRR;
  return `<h2>設定</h2>
    <h3>PMR 策略版本</h3>
    <label>PMR Trader 用<select data-pmr>${Object.entries(PMR_PRESETS).map(([k, p]) => `<option value="${k}" ${c.pmrPreset === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}${preset ? '' : '<option selected>自訂</option>'}</select></label>
    <p class="muted">而家：displacement ≥ ${P.dispAtr} ATR · POI 距離 ≤ ${P.poiDistAtr} ATR · 回測 ≤ ${P.retestMin} 分鐘 · 5m MSS ≤ ${P.mssMin} 分鐘 · 入場窗 ${P.entryWindowMin} 分鐘 · target ${P.targetR ? `固定 ${P.targetR}R` : '1H measured move'} · ${c.timeExitMin ? `${c.timeExitMin} 分鐘時間離場` : '冇時間離場（揸到 stop 或 target）'} · net R:R ≥ ${c.minNetRR}${edited ? '（R:R 手動改過）' : ''}。
    轉版本會一齊改 Scanner 參數同 net R:R 下限；已經掛咗嘅單同持倉照舊。「放寬 + 1.5R · 冇時間離場」喺 mark price 回測（12 隻 × 499 日）得 20 單、+12.3R，前後兩半 +2.8R（4 單）/ +9.5R（16 單），持倉中位 13 粒鐘，冇計 funding：樣本細，係 paper 試驗。</p>
    <h3>戶口同風險</h3>
    <div class="grid">${num('universe', 'Watch 幾多隻（成交額排名）', 1)}${num('minVolume', '最少 24h 成交額（USDT）', 1000)}
    ${num('riskPct', '每單風險（淨值 %）')}${num('maxNotional', '每單最大名義（USDT）')}${num('levCap', '總槓桿上限（×）')}
    ${num('maxOpen', '持倉 + 掛單上限', 1)}${num('picks', '北牆心水數目', 1)}${num('minNetRR', '最少 net R:R')}${num('maxSpreadPct', '最大點差 %')}
    ${num('fee', '每邊 taker 手續費（0.0004 = 0.04%）')}${num('slip', '離場滑價（0.0005 = 0.05%）')}${num('timeExitMin', '時間離場（分鐘，留空 = 冇）', 1, '冇')}
    <label>一定要 watch（逗號分隔）<input data-cfg="always" value="${esc(c.always.join(','))}"></label>
    <label>排除（逗號分隔）<input data-cfg="exclude" value="${esc(c.exclude.join(','))}"></label></div>
    <p><label class="switch"><input type="checkbox" data-cfg="picksOnly" ${c.picksOnly ? 'checked' : ''}> PMR Trader 只做心水牆上面嘅 proposal</label></p>
    <h3>K 線來源</h3>
    <div class="grid">${[['pmrSource', 'PMR Trader 用'], ['smcSource', 'SMC Trader 用']].map(([k, l]) => `<label>${l}<select data-cfg="${k}">${[['mark', 'Mark price K 線'], ['trade', '成交 K 線']].map(([v, t]) => `<option value="${v}" ${(c[k] ?? 'trade') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('')}</div>
    <p class="muted">Aster 股票 perp 成交好薄：成交 1m K 線喺美股交易時段都有 36–97% 係平嘅（冇成交），形態好難成立。Mark price K 線每分鐘都郁，但冇成交量，薄 book 實際成交可能差過 mark。PMR 預設用 mark；SMC 預設用成交，因為佢喺 499 日 mark 數據回測入面 0 單。心水牆 chart 跟 PMR 嘅來源。Taker 資金流同成交量情報永遠用成交 K 線。轉來源唔會郁已經有嘅倉同掛單，但之後會用新 K 線管理。</p>
    <label>SMC Trader 掃<select data-cfg="smcScope">${[['watch', '所有 watch 緊嘅股（減剔走）'], ['picks', '淨係心水牆']].map(([v, l]) => `<option value="${v}" ${c.smcScope === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <h3>新聞 / 業績</h3>
    <label>SEC User-Agent（你嘅名同 email，例如 "Fred Yu you@example.com"）<input data-cfg="secUserAgent" value="${esc(c.secUserAgent ?? '')}" placeholder="留空 = 唔讀 SEC 8-K"></label>
    <p class="muted">SEC 要自動程式表明身份先可以讀 8-K（業績公告）。填咗之後雲端 trader 會讀；只會存喺你私人 data repo 嘅設定入面。Yahoo 新聞標題唔使填。瀏覽器讀唔到 Yahoo / SEC（冇 CORS），所以新聞由雲端讀。回測要業績日子，就喺 repo Settings → Variables 加 <code>SEC_USER_AGENT</code>。</p>
    <h3>3D 房</h3><label>滑鼠視角<select data-look>${[['follow', '跟住滑鼠位置（唔使撳）'], ['fast', '跟住滑鼠位置，轉得多啲'], ['drag', '淨係拖住先轉']].map(([v, l]) => `<option value="${v}" ${world.look === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="muted">跟住滑鼠：視線跟 cursor 喺畫面嘅位置，cursor 擺返正中（有個細圈）就望返正前面，所以 cursor 走遠咗都唔會迷失方向；擺去左右最邊就繼續轉。C 將視線擺返水平。撳一下照樣可以揀枱同牆。</p>
    <p class="muted">Esc（乜都冇開嘅時候）定住視角；再按 Esc 就再跟滑鼠。</p>
    <h3>共用戶口</h3><p>同步、雲端 trader、而家邊個交易緊：<button data-open="sync">☁ 同步</button></p>
    <h3>本機 paper 戶口</h3><p><button data-reset>本機戶口重設做 $1,000</button> <span class="muted">只影響淨係喺呢個瀏覽器嘅戶口，唔會郁共用戶口。</span></p>`;
}

// ---------------- events ----------------
$('#panel').addEventListener('click', e => {
  const sy = e.target.closest('[data-sync]');
  if (sy) return syncAction(sy.dataset.sync);
  const el = e.target.closest('[data-open],[data-close],[data-rule],[data-reset]');
  if (!el) return;
  if (el.dataset.open === 'wall') return openWall();
  if (el.dataset.open) return open(el.dataset.open);
  if (el.hasAttribute('data-close')) return close();
  if (el.hasAttribute('data-reset')) { if (confirm('重設本機 paper 戶口？')) { state = freshState(); LS.set('asd_state', state); render(); } return; }
  const key = el.dataset.key, [rule, value] = key.split(/:(.*)/s);
  if (el.dataset.rule === 'approve') mutate(s => { s.rules.active.push({ rule, ...(value ? { value } : {}) }); s.rules.decided[key] = 'approved'; });
  if (el.dataset.rule === 'reject') mutate(s => { s.rules.decided[key] = 'rejected'; });
  if (el.dataset.rule === 'remove') mutate(s => { s.rules.active = s.rules.active.filter(r => ruleKey(r) !== key); s.rules.decided[key] = 'removed'; });
});
$('#panel').addEventListener('change', e => {
  if (e.target.matches('[data-look]')) { world.setLook(e.target.value); return; }
  if (e.target.matches('[data-pmr]')) { const v = e.target.value; if (PMR_PRESETS[v]) mutate(s => { applyPmrPreset(s.cfg, v); }); return; }
  if (e.target.dataset.smc === 'on') { const v = e.target.checked; mutate(s => { s.smc = { ...(s.smc ?? { trades: [], decisions: [] }), on: v }; }); return; }
  const k = e.target.dataset.cfg;
  if (!k) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (['always', 'exclude'].includes(k)) v = String(v).toUpperCase().split(',').map(x => x.trim()).filter(Boolean);
  else if (k === 'smcScope') v = v === 'picks' ? 'picks' : 'watch';
  else if (k === 'pmrSource' || k === 'smcSource') v = v === 'mark' ? 'mark' : 'trade';
  else if (k === 'secUserAgent') v = String(v).trim().slice(0, 120);
  else if (k === 'timeExitMin' && String(v).trim() === '') v = null;
  else if (typeof v === 'string') { v = Number(v); if (!Number.isFinite(v)) return; }
  mutate(s => { s.cfg[k] = v; });
});
$('#panel').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const id = e.target.dataset.id;
  const rv = { grade: f.get('grade'), agree: !f.get('disagree'), a: f.getAll('a'), b: f.getAll('b'), comment: f.get('comment').trim(), exclude: !!f.get('exclude'), t: Date.now(), by: 'Fred' };
  document.activeElement?.blur();
  mutate(s => { s.reviews[id] = rv; });
});
addEventListener('keydown', e => {
  if (wall.isOpen()) return wall.key(e);
  if (e.target.closest('input,textarea,select')) { if (e.key === 'Escape') e.target.blur(); return; }
  // Esc closes what is open; with nothing open it holds the view still (and again to follow the mouse).
  if (e.key === 'Escape') {
    if (!$('#help').hidden || panel) { $('#help').hidden = true; close(); return; }
    world.setStill(!world.still); render(); return;
  }
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
});
$('#hud').addEventListener('click', e => { if (e.target.closest('#sSync')) open('sync', 'smc'); });
$('#still').addEventListener('click', () => { world.setStill(false); render(); });
$('#panel').addEventListener('input', e => { const k = e.target.dataset.syncField; if (k) draft[k] = e.target.value; });
$('#help').hidden = LS.get('asd_help_seen', false);
$('#help').addEventListener('click', () => { $('#help').hidden = true; LS.set('asd_help_seen', true); });
$('#settingsBtn').addEventListener('click', () => open('settings'));

addEventListener('pagehide', () => { flushMarks(); });

globalThis.__desk = { world, wall, render, get state() { return state; } };
render();
// Wall and monitor textures are canvas text: redraw once the Chinese web font has arrived.
document.fonts?.ready.then(() => render());
refresh();
setInterval(refresh, 60_000);
