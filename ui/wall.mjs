// Picks wall: the Screener's shortlist as interactive charts (zoom, pan, timeframes, older history on demand)
// where Fred marks FVG / OB / MSS / HH HL LH LL / liquidity. Marks are notes saved to state.marks; they never gate trades.
// Chart candles come from Aster klines for display only. The scanner and paper fills keep using completed 1m bars.
import { chartBars } from '../core/aster.mjs';
import { C, fmt, pct, statusColor } from './charts.mjs';

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const SPAN = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const TOOLS = [['cursor', 'Cursor', 'V'], ['fvg', 'FVG', 'F'], ['ob', 'OB', 'O'], ['mss', 'MSS', 'M'], ['liq', 'Liquidity', 'L'],
  ['HH', 'HH', '1'], ['HL', 'HL', '2'], ['LH', 'LH', '3'], ['LL', 'LL', '4'], ['erase', 'Erase', 'E']];
const HINT = {
  cursor: '拖動平移 · 滾輪縮放 · Shift + 滾輪左右移 · 雙擊重設 · 拖到最左會自動載入更早嘅 K 線',
  fvg: 'FVG：喺圖上拖一個框，會吸附 K 線嘅開收高低。Bull / Bear 用 B 轉。', ob: 'OB：拖一個框標 order block。',
  mss: 'MSS：由轉勢位拖一條橫線。', liq: 'Liquidity：撳一下。高過現價係 BSL，低過係 SSL。',
  HH: 'HH：撳一支 K 線，標喺最高位。', HL: 'HL：撳一支 K 線，標喺最低位。', LH: 'LH：撳一支 K 線，標喺最高位。', LL: 'LL：撳一支 K 線，標喺最低位。',
  erase: 'Erase：撳一個你嘅標記刪走佢。Ctrl+Z 復原。',
};
const DRAG = new Set(['fvg', 'ob', 'mss']), TAGS = new Set(['HH', 'HL', 'LH', 'LL']);
const AX = 70, BX = 22, MAX_BARS = 4000, MAX_MARKS = 120;
const FONT = 'Inter, system-ui, sans-serif';
const UP = C.up, DOWN = C.down, LIQ = '#fbbf24';
const WHY = { held: '持倉中', pinned: '★ 你 pin 咗', setup: 'PMR setup', volume: '成交額' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const uid = () => Math.random().toString(36).slice(2, 10);
const short = s => String(s).replace(/USDT$/, '');
const pad = n => String(n).padStart(2, '0');
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
function tlabel(t, tf, mode) {
  const d = new Date(t), md = `${d.getMonth() + 1}/${d.getDate()}`, hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (mode === 'full') return tf === '1d' ? md : `${md} ${hm}`;
  return mode === 'day' ? md : hm;
}
function niceStep(range, n) {
  const raw = range / n, m = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * m >= raw) return k * m;
  return 10 * m;
}
const mergeBars = (a = [], b = []) => { const m = new Map(a.map(x => [x.t, x])); for (const x of b) m.set(x.t, x); return [...m.values()].sort((p, q) => p.t - q.t); };
const cache = {};

class Chart {
  constructor(wall, el, sym) {
    Object.assign(this, { wall, el, sym, bars: [], bw: 7, end: 0, W: 0, H: 0, hover: null, down: null, prev: null, err: '' });
    this.fig = el.querySelector('.cw-fig'); this.cv = this.fig.querySelector('canvas'); this.ctx = this.cv.getContext('2d');
    this.hud = this.fig.querySelector('.cw-hud');
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.fig);
    const cv = this.cv;
    cv.addEventListener('wheel', e => this.wheel(e), { passive: false });
    cv.addEventListener('pointerdown', e => this.pdown(e));
    cv.addEventListener('pointermove', e => this.pmove(e));
    cv.addEventListener('pointerup', e => this.pup(e));
    cv.addEventListener('pointercancel', () => { this.down = null; this.prev = null; this.draw(); });
    cv.addEventListener('pointerleave', () => { if (!this.down) { this.hover = null; this.draw(); } });
    cv.addEventListener('dblclick', () => this.reset());
    this.setTf(wall.tfOf(sym));
  }
  setTf(tf) {
    this.tf = TFS.includes(tf) ? tf : '15m'; this.span = SPAN[this.tf]; this.noOlder = false;
    this.el.querySelectorAll('.cw-tfs button').forEach(b => { const on = b.dataset.tf === this.tf; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    this.bars = cache[`${this.sym}|${this.tf}`]?.bars ?? [];
    this.reset();
    this.load();
  }
  async load(force = false) {
    const tf = this.tf, key = `${this.sym}|${tf}`, c = cache[key];
    if (c && !force && Date.now() - c.at < 25_000) return;
    try {
      const rows = await chartBars(this.sym, tf, { limit: c ? 60 : 600 });
      cache[key] = { bars: mergeBars(cache[key]?.bars, rows), at: Date.now() };
      this.err = '';
    } catch (e) { this.err = e.message; }
    if (tf !== this.tf) return;
    const had = this.bars.length;
    this.bars = cache[key]?.bars ?? [];
    if (!had) this.reset();
    else if (this.end >= had - 2) this.end += this.bars.length - had; // follow the right edge as new candles arrive
    this.draw();
  }
  async older() {
    if (this.oldBusy || this.noOlder || !this.bars.length || this.bars.length >= MAX_BARS) return;
    this.oldBusy = true;
    const tf = this.tf, key = `${this.sym}|${tf}`;
    try {
      const rows = await chartBars(this.sym, tf, { limit: 500, endTime: this.bars[0].t - 1 });
      if (tf !== this.tf) return;
      if (!rows.length) { this.noOlder = true; return; }
      const before = this.bars.length, merged = mergeBars(rows, this.bars);
      cache[key] = { bars: merged, at: cache[key]?.at ?? Date.now() };
      this.bars = merged; this.end += merged.length - before; this.draw();
    } catch { /* keep what we have */ } finally { this.oldBusy = false; }
  }
  reset() { this.bw = 7; this.end = this.bars.length + 4; this.draw(); }
  resize() {
    const r = this.fig.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.W = r.width; this.H = r.height;
    const d = devicePixelRatio || 1;
    this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d); this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.draw();
  }
  get cw() { return Math.max(10, this.W - AX); }
  get ch() { return Math.max(10, this.H - BX); }
  get start() { return this.end - this.cw / this.bw; }
  last() { return this.bars.at(-1)?.c; }
  xc(i) { return (i + 0.5 - this.start) * this.bw; }
  ix(x) { return x / this.bw + this.start - 0.5; }
  tIdx(t) {
    const b = this.bars, n = b.length;
    if (t <= b[0].t) return (t - b[0].t) / this.span;
    if (t >= b[n - 1].t) return n - 1 + (t - b[n - 1].t) / this.span;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].t <= t) lo = m; else hi = m; }
    return lo + (t - b[lo].t) / (b[hi].t - b[lo].t);
  }
  iT(i) {
    const b = this.bars, n = b.length;
    if (i <= 0) return b[0].t + i * this.span;
    if (i >= n - 1) return b[n - 1].t + (i - n + 1) * this.span;
    const lo = Math.floor(i);
    return b[lo].t + (i - lo) * (b[lo + 1].t - b[lo].t);
  }
  y(p) { return 10 + (this.hi - p) / (this.hi - this.lo) * (this.ch - 20); }
  py(y) { return this.hi - (y - 10) / (this.ch - 20) * (this.hi - this.lo); }
  clampEnd() { const n = this.bars.length, v = this.cw / this.bw; this.end = Math.max(5, Math.min(n + v * 0.6, this.end)); }
  zoom(f, x) {
    const px = x ?? this.cw * 0.85, i = this.ix(px);
    this.bw = Math.min(40, Math.max(1.2, this.bw * f));
    this.end = i + 0.5 - px / this.bw + this.cw / this.bw;
    this.clampEnd(); this.draw();
    if (this.start < 5) this.older();
  }
  // PMR levels and the Trader's live order / position for this symbol (read-only).
  layer() {
    if (!this.wall.layerOn()) return { zones: [], lines: [] };
    const s = this.wall.api.scan()[this.sym], st = this.wall.api.state(), zones = [], lines = [];
    if (s?.anchor) {
      lines.push({ price: s.anchor.boundary, color: C.boundary, label: `PMR ${s.anchor.type.replaceAll('_', ' ')} ${s.anchor.direction === 1 ? '↑' : '↓'}`, from: s.anchor.t - 36e5, dash: [6, 4] });
      lines.push({ price: s.anchor.target, color: C.target, label: 'PMR 1H target', from: s.anchor.t, dash: [2, 4] });
    }
    if (s?.poi) zones.push({ lo: s.poi.lo, hi: s.poi.hi, from: s.poi.knownAt - 9e5, label: `PMR 15m ${s.poi.type}` });
    const live = [...st.positions, ...st.orders].find(x => x.symbol === this.sym) ?? s?.plan;
    if (live) {
      const from = live.entryAt ?? live.plan?.signalAt ?? live.signalAt;
      lines.push({ price: live.entry, color: C.entry, label: live.entryAt ? 'Trader entry' : 'Trader limit', from, dash: [] },
        { price: live.stop, color: C.stop, label: 'SL', from, dash: [] }, { price: live.target, color: C.target, label: 'TP', from, dash: [] });
    }
    return { zones, lines };
  }
  scale(layer) {
    const b = this.bars, n = b.length, s = Math.max(0, Math.floor(this.start)), e = Math.min(n - 1, Math.ceil(this.end));
    let hi = -Infinity, lo = Infinity;
    for (let i = s; i <= e; i++) { if (b[i].h > hi) hi = b[i].h; if (b[i].l < lo) lo = b[i].l; }
    if (!Number.isFinite(hi)) { hi = b[n - 1].h; lo = b[n - 1].l; }
    const span = hi - lo || hi * 0.01;
    // Pull in nearby PMR / trade levels so they stay visible, but not ones far away on a zoomed-in view.
    for (const l of layer.lines) if (Number.isFinite(l.price) && l.price > lo - span && l.price < hi + span) { hi = Math.max(hi, l.price); lo = Math.min(lo, l.price); }
    const pd = (hi - lo) * 0.08 || hi * 0.01;
    this.hi = hi + pd; this.lo = lo - pd;
    return [s, e];
  }
  draw() {
    const c = this.ctx, W = this.W, H = this.H;
    if (!W) return;
    c.clearRect(0, 0, W, H);
    if (!this.bars.length) {
      c.fillStyle = C.text; c.font = `13px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(this.err ? `讀唔到 K 線：${this.err}` : '載入緊 K 線…', 14, H / 2);
      this.hud.textContent = '';
      return;
    }
    const cw = this.cw, ch = this.ch, b = this.bars, n = b.length, layer = this.layer(), [s, e] = this.scale(layer);
    c.lineWidth = 1; c.setLineDash([]); c.globalAlpha = 1;
    c.font = `11.5px ${FONT}`; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillStyle = C.text; c.strokeStyle = C.grid;
    const st = niceStep(this.hi - this.lo, Math.max(2, Math.round(ch / 56)));
    for (let p = Math.ceil(this.lo / st) * st; p <= this.hi; p += st) {
      const yy = Math.round(this.y(p)) + 0.5;
      c.beginPath(); c.moveTo(0, yy); c.lineTo(cw, yy); c.stroke(); c.fillText(fmt(p), cw + 6, yy);
    }
    const every = Math.max(1, Math.ceil(100 / this.bw));
    let lastDay = null;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    for (let i = Math.ceil(s / every) * every; i <= e; i += every) {
      const xx = this.xc(i);
      if (xx < 24 || xx > cw - 24) continue;
      const day = new Date(b[i].t).getDate();
      c.fillText(tlabel(b[i].t, this.tf, this.tf === '1d' || this.tf === '4h' || day !== lastDay ? 'day' : 'time'), xx, H - 6);
      lastDay = day;
      c.beginPath(); c.moveTo(Math.round(xx) + 0.5, 0); c.lineTo(Math.round(xx) + 0.5, ch); c.stroke();
    }
    c.save(); c.beginPath(); c.rect(0, 0, cw, ch); c.clip();
    for (const z of layer.zones) {
      const x0 = Math.max(0, this.xc(this.tIdx(z.from))), y0 = this.y(z.hi), y1 = this.y(z.lo);
      c.fillStyle = C.zone; c.fillRect(x0, y0, cw - x0, y1 - y0);
      c.strokeStyle = C.zoneEdge; c.strokeRect(x0, y0, cw - x0, y1 - y0);
      c.fillStyle = C.zoneEdge; c.textAlign = 'left'; c.fillText(z.label, x0 + 4, y0 - 4);
    }
    const marks = this.wall.marksOf(this.sym);
    for (const m of marks) if (m.type === 'fvg' || m.type === 'ob') this.drawMark(m, 1);
    const body = Math.max(1, this.bw * 0.68);
    for (let i = s; i <= e; i++) {
      const k = b[i], xx = this.xc(i), up = k.c >= k.o, xr = Math.round(xx) + 0.5;
      c.globalAlpha = k.closed === false ? 0.5 : 1;
      c.strokeStyle = c.fillStyle = up ? UP : DOWN;
      c.beginPath(); c.moveTo(xr, this.y(k.h)); c.lineTo(xr, this.y(k.l)); c.stroke();
      const y1 = this.y(Math.max(k.o, k.c)), y2 = this.y(Math.min(k.o, k.c));
      c.fillRect(xx - body / 2, y1, body, Math.max(1, y2 - y1));
    }
    c.globalAlpha = 1;
    for (const l of layer.lines) {
      if (!Number.isFinite(l.price)) continue;
      const yy = Math.round(this.y(l.price)) + 0.5, x0 = Math.max(0, this.xc(this.tIdx(l.from ?? b[0].t)));
      c.strokeStyle = l.color; c.lineWidth = 1.4; c.setLineDash(l.dash ?? [6, 4]);
      c.beginPath(); c.moveTo(x0, yy); c.lineTo(cw, yy); c.stroke(); c.setLineDash([]); c.lineWidth = 1;
      c.fillStyle = l.color; c.textAlign = 'right'; c.fillText(`${l.label} ${fmt(l.price)}`, cw - 6, yy - 4);
    }
    for (const m of marks) if (m.type !== 'fvg' && m.type !== 'ob') this.drawMark(m, 1);
    if (this.prev) this.drawMark(this.prev, 0.75);
    const h = this.hover, lc = b[n - 1].c, ly = Math.round(this.y(lc)) + 0.5, lup = lc >= b[n - 1].o;
    c.setLineDash([2, 3]); c.strokeStyle = 'rgba(226,232,240,.35)'; c.beginPath(); c.moveTo(0, ly); c.lineTo(cw, ly); c.stroke();
    let hx = null;
    if (h && h.x < cw && h.y < ch) {
      hx = this.xc(Math.round(this.ix(h.x)));
      c.setLineDash([3, 4]); c.strokeStyle = 'rgba(226,232,240,.4)';
      c.beginPath(); c.moveTo(hx, 0); c.lineTo(hx, ch); c.moveTo(0, h.y); c.lineTo(cw, h.y); c.stroke();
    }
    c.setLineDash([]); c.restore();
    c.font = `600 11.5px ${FONT}`; c.textBaseline = 'middle'; c.textAlign = 'left';
    const box = (txt, yy, bg, fg) => { c.fillStyle = bg; c.fillRect(cw, yy - 9, AX, 18); c.fillStyle = fg; c.fillText(txt, cw + 6, yy); };
    box(fmt(lc), ly, lup ? UP : DOWN, '#0b1120');
    let hi = n - 1;
    if (hx != null) {
      box(fmt(this.py(h.y)), h.y, '#334155', '#e2e8f0');
      hi = Math.min(n - 1, Math.max(0, Math.round(this.ix(h.x))));
      const tl = tlabel(b[hi].t, this.tf, 'full'), tw = c.measureText(tl).width + 12;
      c.fillStyle = '#334155'; c.fillRect(hx - tw / 2, ch + 1, tw, BX - 2); c.fillStyle = '#e2e8f0'; c.textAlign = 'center'; c.fillText(tl, hx, ch + BX / 2);
    }
    const k = b[hi];
    this.hud.textContent = `${this.tf}  O ${fmt(k.o)}  H ${fmt(k.h)}  L ${fmt(k.l)}  C ${fmt(k.c)}${k.closed === false ? '  (forming)' : ''}`;
  }
  drawMark(m, al) {
    const c = this.ctx, cw = this.cw, col = m.dir === 'bear' ? DOWN : UP, ga = al * (m.auto ? 0.55 : 1);
    const x1 = this.xc(this.tIdx(m.t1)), x2 = m.t2 != null ? this.xc(this.tIdx(m.t2)) : x1;
    c.globalAlpha = ga; c.setLineDash([]); c.lineWidth = 1.5;
    c.font = `600 11.5px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    if (m.type === 'fvg' || m.type === 'ob') {
      const L = Math.min(x1, x2), R = Math.max(x1, x2), T = this.y(Math.max(m.p1, m.p2)), B = this.y(Math.min(m.p1, m.p2));
      c.fillStyle = rgba(col, m.type === 'fvg' ? 0.2 : 0.12); c.fillRect(L, T, R - L, B - T);
      c.fillStyle = rgba(col, 0.07); c.fillRect(R, T, cw - R, B - T);
      c.strokeStyle = col;
      if (m.type === 'ob') c.strokeRect(L, T, R - L, B - T);
      else { c.globalAlpha = ga * 0.6; c.beginPath(); c.moveTo(L, T); c.lineTo(cw, T); c.moveTo(L, B); c.lineTo(cw, B); c.stroke(); c.globalAlpha = ga; }
      c.fillStyle = col; c.fillText(m.type.toUpperCase(), L + 4, B - T > 16 ? T + 13 : T - 4);
    } else if (m.type === 'mss') {
      const yy = this.y(m.p1);
      c.strokeStyle = col; c.setLineDash([6, 4]); c.beginPath(); c.moveTo(Math.min(x1, x2), yy); c.lineTo(Math.max(x1, x2), yy); c.stroke(); c.setLineDash([]);
      c.fillStyle = col; c.textAlign = 'center'; c.fillText('MSS', (x1 + x2) / 2, m.dir === 'bear' ? yy + 14 : yy - 5);
    } else if (m.type === 'liq') {
      const yy = this.y(m.p1);
      c.strokeStyle = LIQ; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(x1, yy); c.lineTo(cw, yy); c.stroke(); c.setLineDash([]);
      c.fillStyle = LIQ; c.fillText(`$$$ ${m.side === 'SSL' ? 'SSL' : 'BSL'}`, x1 + 4, m.side === 'SSL' ? yy + 14 : yy - 5);
    } else if (m.type === 'tag') {
      const lb = String(m.label), top = lb[1] === 'H', tc = lb === 'HH' || lb === 'HL' ? UP : DOWN, ty = this.y(m.p1) + (top ? -13 : 13);
      c.font = `700 11px ${FONT}`;
      const w = c.measureText(lb).width + 10;
      c.fillStyle = rgba(tc, 0.22); c.beginPath(); if (c.roundRect) c.roundRect(x1 - w / 2, ty - 8, w, 16, 4); else c.rect(x1 - w / 2, ty - 8, w, 16); c.fill();
      c.fillStyle = tc; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(lb, x1, ty);
    }
    c.globalAlpha = 1;
  }
  pt(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  at(p) {
    const n = this.bars.length, i = Math.round(this.ix(p.x));
    let price = this.py(p.y);
    if (i >= 0 && i < n) {
      const k = this.bars[i];
      let best = 10;
      for (const v of [k.o, k.h, k.l, k.c]) { const d = Math.abs(this.y(v) - p.y); if (d < best) { best = d; price = v; } }
    }
    return { i, t: this.iT(i), p: price };
  }
  wheel(e) {
    e.preventDefault();
    if (!this.bars.length) return;
    const p = this.pt(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.end += (e.deltaX || e.deltaY) / this.bw / 2; this.clampEnd(); this.draw();
      if (this.start < 5) this.older();
      return;
    }
    this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x);
  }
  pdown(e) {
    if (e.button > 0 || !this.bars.length) return;
    this.wall.setActive(this.sym);
    const p = this.pt(e);
    try { this.cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    this.down = { x: p.x, y: p.y, end: this.end, moved: false, a: this.at(p) };
  }
  pmove(e) {
    const p = this.pt(e), d = this.down, tool = this.wall.tool();
    this.hover = p;
    if (d) {
      if (Math.abs(p.x - d.x) + Math.abs(p.y - d.y) > 4) d.moved = true;
      if (DRAG.has(tool)) {
        if (d.moved) {
          const q = this.at(p), dir = this.wall.dir();
          this.prev = tool === 'mss' ? { type: 'mss', dir, t1: d.a.t, t2: q.t, p1: d.a.p, tf: this.tf } : { type: tool, dir, t1: d.a.t, t2: q.t, p1: d.a.p, p2: q.p, tf: this.tf };
        }
      } else if (d.moved) {
        this.end = d.end - (p.x - d.x) / this.bw; this.clampEnd();
        if (this.start < 5) this.older();
      }
    }
    this.draw();
  }
  pup(e) {
    const d = this.down, tool = this.wall.tool();
    this.down = null;
    if (!d) return;
    const p = this.pt(e);
    if (DRAG.has(tool)) {
      const a = this.prev; this.prev = null;
      if (a && d.moved && (a.type === 'mss' || Math.abs(this.y(a.p1) - this.y(a.p2)) > 2)) this.wall.addMark(this.sym, a); else this.draw();
      return;
    }
    if (d.moved) return this.draw();
    const q = this.at(p), n = this.bars.length;
    if (tool === 'liq') this.wall.addMark(this.sym, { type: 'liq', t1: q.t, p1: q.p, side: q.p >= this.last() ? 'BSL' : 'SSL', tf: this.tf });
    else if (TAGS.has(tool)) {
      if (q.i < 0 || q.i >= n) return;
      const k = this.bars[q.i];
      this.wall.addMark(this.sym, { type: 'tag', label: tool, t1: k.t, p1: tool[1] === 'H' ? k.h : k.l, tf: this.tf });
    } else if (tool === 'erase') { const m = this.hit(p); if (m) this.wall.removeMark(this.sym, m.id); }
  }
  hit(p) {
    const A = this.wall.marksOf(this.sym);
    for (let j = A.length - 1; j >= 0; j--) {
      const m = A[j], x1 = this.xc(this.tIdx(m.t1)), x2 = m.t2 != null ? this.xc(this.tIdx(m.t2)) : x1;
      if (m.type === 'fvg' || m.type === 'ob') {
        const T = this.y(Math.max(m.p1, m.p2)), B = this.y(Math.min(m.p1, m.p2));
        if (p.x >= Math.min(x1, x2) - 4 && p.y >= T - 5 && p.y <= B + 5) return m;
      } else if (m.type === 'mss' || m.type === 'liq') {
        const yy = this.y(m.p1), R = m.type === 'liq' ? this.cw : Math.max(x1, x2);
        if (Math.abs(p.y - yy) < 8 && p.x >= Math.min(x1, x2) - 6 && p.x <= R + 6) return m;
      } else if (m.type === 'tag') {
        const ty = this.y(m.p1) + (String(m.label)[1] === 'H' ? -13 : 13);
        if (Math.abs(p.x - x1) < 14 && Math.abs(p.y - ty) < 11) return m;
      }
    }
    return null;
  }
}

// Visible-range FVGs (3-candle gaps ≥ 0.3 × average range) and fractal swings (4 bars each side) as faded auto marks.
function detect(ch) {
  const b = ch.bars.filter(x => x.closed !== false), n = b.length;
  const s = Math.max(1, Math.floor(ch.end - Math.max(ch.cw / ch.bw, 140))), e = Math.min(n - 2, Math.ceil(ch.end));
  let avg = 0, cnt = 0;
  for (let i = s; i <= e; i++) { avg += b[i].h - b[i].l; cnt++; }
  avg /= cnt || 1;
  const fvg = [];
  for (let i = s; i <= e; i++) {
    const a = b[i - 1], z = b[i + 1];
    if (z.l > a.h && z.l - a.h > 0.3 * avg) fvg.push({ type: 'fvg', dir: 'bull', t1: a.t, t2: z.t, p1: a.h, p2: z.l });
    else if (z.h < a.l && a.l - z.h > 0.3 * avg) fvg.push({ type: 'fvg', dir: 'bear', t1: a.t, t2: z.t, p1: a.l, p2: z.h });
  }
  const k = 4, piv = [];
  for (let i = Math.max(k, s); i <= Math.min(n - 1 - k, e); i++) {
    let H = true, L = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (b[j].h >= b[i].h) H = false; if (b[j].l <= b[i].l) L = false; }
    if (H) piv.push({ i, hi: true }); if (L) piv.push({ i, hi: false });
  }
  let lh = null, ll = null;
  const tags = [];
  for (const p of piv) {
    const q = b[p.i];
    if (p.hi) { if (lh != null) tags.push({ type: 'tag', label: q.h > lh ? 'HH' : 'LH', t1: q.t, p1: q.h }); lh = q.h; }
    else { if (ll != null) tags.push({ type: 'tag', label: q.l > ll ? 'HL' : 'LL', t1: q.t, p1: q.l }); ll = q.l; }
  }
  return { fvg: fvg.slice(-6), tags: tags.slice(-10) };
}

// api: { state(), scan(), setMarks(sym, list), togglePick(sym, 'pin' | 'skip'), addPin(text), onClose() }
export function createChartWall(root, api) {
  let open = false, tool = 'cursor', dir = 'bull', layerOn = LS.get('asd_wall_layer', true), active = null, built = '', timer = 0, hintT = 0;
  const charts = {}, hist = {}, tfs = LS.get('asd_wall_tf', {});
  root.innerHTML = `
    <div class="cw-top"><h2>Picks wall</h2><span class="muted" data-sub></span><button data-close title="Esc">✕ 返去 desk</button></div>
    <div class="cw-tools" role="toolbar" aria-label="Chart tools">
      ${TOOLS.map(([k, l, s]) => `<button data-tool="${k}" aria-pressed="false">${l}<kbd>${s}</kbd></button>`).join('')}
      <span class="sep"></span><button data-dir="bull" class="on" aria-pressed="true">Bull<kbd>B</kbd></button><button data-dir="bear" class="bear" aria-pressed="false">Bear</button>
      <span class="sep"></span><button data-do="auto" title="Visible range of the selected chart">Auto FVG / swings<kbd>A</kbd></button>
      <button data-do="layer" aria-pressed="false">PMR + Trader levels<kbd>G</kbd></button>
      <button data-do="in" title="Zoom in">＋</button><button data-do="out" title="Zoom out">－</button>
      <button data-do="undo">Undo<kbd>Ctrl Z</kbd></button><button data-do="clear">Clear this chart</button>
    </div>
    <p class="cw-hint" aria-live="polite"></p>
    <section class="cw-grid" aria-label="Picks"></section>
    <aside class="cw-rail" aria-label="Trader"></aside>`;
  const $ = s => root.querySelector(s);
  const grid = $('.cw-grid'), rail = $('.cw-rail'), hintEl = $('.cw-hint');

  const picks = () => api.state().picks ?? [];
  const marksOf = sym => api.state().marks?.[sym] ?? [];
  const hint = msg => { clearTimeout(hintT); hintEl.textContent = msg; hintT = setTimeout(() => { hintEl.textContent = HINT[tool]; }, 5000); };

  function commit(sym, next) {
    (hist[sym] ??= []).push(marksOf(sym));
    if (hist[sym].length > 60) hist[sym].shift();
    while (next.length > MAX_MARKS) { const i = next.findIndex(m => m.auto); next.splice(i >= 0 ? i : 0, 1); }
    api.setMarks(sym, next);
    redraw(sym);
  }
  const wall = {
    api, tool: () => tool, dir: () => dir, layerOn: () => layerOn, marksOf,
    tfOf: sym => tfs[sym] ?? '15m',
    setActive(sym) {
      active = sym;
      for (const el of grid.querySelectorAll('.cw-tile')) el.classList.toggle('on', el.dataset.sym === sym);
    },
    addMark(sym, m) { commit(sym, [...marksOf(sym), { ...m, id: uid(), at: Date.now() }]); },
    removeMark(sym, id) { commit(sym, marksOf(sym).filter(m => m.id !== id)); },
  };
  function redraw(sym) { if (sym) charts[sym]?.draw(); else for (const c of Object.values(charts)) c.draw(); headers(); }

  function traderNote(sym) {
    const st = api.state(), s = api.scan()[sym] ?? picks().find(p => p.symbol === sym);
    const pos = st.positions.find(x => x.symbol === sym), ord = st.orders.find(x => x.symbol === sym);
    if (pos) return [`Trader 持倉 ${pos.direction === 1 ? 'long' : 'short'} @ ${fmt(pos.entry)}`, 'up'];
    if (ord) return [`Trader 掛 ${ord.direction === 1 ? 'buy' : 'sell'} limit @ ${fmt(ord.entry)}`, 'warn'];
    if (st.skips.includes(sym)) return ['你剔走咗：Trader 唔會做', 'muted'];
    const d = (st.decisions ?? []).find(x => x.symbol === sym && Date.now() - x.t < 6 * 36e5);
    if (d) return [`Reviewer ${d.status === 'Approved' ? '批准' : d.status === 'Declined' ? '拒絕' : d.status}：${String(d.reason).replaceAll('_', ' ')}`, d.status === 'Approved' ? 'up' : 'warn'];
    if (s?.status === 'QUALIFIED') return ['PMR 出咗 proposal，交 Reviewer 核', 'warn'];
    return ['等 PMR setup 完成先會落單', 'muted'];
  }
  function tileHTML(sym) {
    return `<article class="cw-tile" data-sym="${esc(sym)}">
      <div class="cw-th"><b class="cw-sym">${esc(short(sym))}</b><span class="cw-px"></span><span class="cw-chg"></span><span class="cw-stage"></span>
        <div class="cw-acts"><button data-pin title="Pin: always on the wall">★ Pin</button><button data-skip title="Skip: the Trader won't trade it">Skip</button><button data-big>Expand</button></div></div>
      <div class="cw-sub"><span class="cw-trader"></span><div class="cw-tfs">${TFS.map(t => `<button data-tf="${t}">${t}</button>`).join('')}</div></div>
      <div class="cw-fig"><canvas aria-label="${esc(short(sym))} chart"></canvas><div class="cw-hud"></div></div></article>`;
  }
  function build() {
    const syms = picks().map(p => p.symbol), key = syms.join(',');
    if (key !== built) {
      built = key;
      for (const k of Object.keys(charts)) { charts[k].ro.disconnect(); delete charts[k]; }
      grid.innerHTML = syms.length ? syms.map(tileHTML).join('')
        : '<p class="cw-empty">Screener 未揀到心水。第一次 scan 大約要一分鐘；你亦可以喺右邊 pin 一隻。</p>';
      for (const el of grid.querySelectorAll('.cw-tile')) charts[el.dataset.sym] = new Chart(wall, el, el.dataset.sym);
    }
    if (!charts[active]) wall.setActive(syms[0] ?? null); else wall.setActive(active);
    headers(); renderRail();
  }
  function headers() {
    const st = api.state(), scan = api.scan(), board = new Map((st.board ?? []).map(r => [r.symbol, r]));
    for (const p of picks()) {
      const el = grid.querySelector(`.cw-tile[data-sym="${CSS.escape(p.symbol)}"]`);
      if (!el) continue;
      const s = scan[p.symbol], bars = charts[p.symbol]?.bars, price = bars?.at(-1)?.c ?? s?.price ?? p.price, chg = board.get(p.symbol)?.change;
      el.querySelector('.cw-px').textContent = fmt(price);
      const c = el.querySelector('.cw-chg'); c.textContent = Number.isFinite(chg) ? `${pct(chg)} 24h` : ''; c.className = `cw-chg ${chg >= 0 ? 'up' : 'down'}`;
      const status = s?.status ?? p.status;
      const sg = el.querySelector('.cw-stage'); sg.textContent = `${String(status).replaceAll('_', ' ')} · ${WHY[p.why] ?? p.why}`; sg.style.color = statusColor(status);
      const [txt, cls] = traderNote(p.symbol), tr = el.querySelector('.cw-trader'); tr.textContent = txt; tr.className = `cw-trader ${cls}`;
      const pin = st.pins.includes(p.symbol), skip = st.skips.includes(p.symbol);
      const pb = el.querySelector('[data-pin]'); pb.classList.toggle('on', pin); pb.setAttribute('aria-pressed', pin);
      const sb = el.querySelector('[data-skip]'); sb.classList.toggle('on', skip); sb.setAttribute('aria-pressed', skip);
    }
    const st2 = api.state();
    $('[data-sub]').textContent = `Screener 心水 ${picks().length} 隻 · ${st2.cfg.picksOnly ? 'Trader 只會喺呢度揀單' : 'Picks-only 已關：Trader 會做所有 watch 嘅股'} · 標記只係筆記，唔會影響落單`;
  }
  function renderRail() {
    if (document.activeElement?.closest('.cw-rail input')) return;
    const st = api.state(), scan = api.scan(), ps = picks(), inPicks = new Set(ps.map(p => p.symbol));
    const others = Object.values(scan).filter(s => !inPicks.has(s.symbol));
    const dec = (st.decisions ?? []).filter(d => inPicks.has(d.symbol) || d.reason === 'NOT_IN_PICKS').slice(0, 8);
    const sym = s => `<b>${esc(short(s))}</b>`;
    rail.innerHTML = `
      <h3>Trader 揀單範圍</h3>
      <p class="muted">PMR 喺下面呢 ${ps.length} 隻出 proposal，Reviewer 核完先會落 paper 單。其他股就算出 proposal 都會記做 NOT IN PICKS。</p>
      <ol>${ps.map(p => `<li data-go="${esc(p.symbol)}">${sym(p.symbol)}<span style="color:${statusColor(p.status)}">${esc(String(p.status).replaceAll('_', ' '))}</span><span class="why">${esc(WHY[p.why] ?? p.why)}</span></li>`).join('') || '<li class="muted">未有</li>'}</ol>
      <h3>加入心水</h3>
      <form data-addpin><input name="sym" placeholder="例如 MU 或 MUUSDT" autocomplete="off" aria-label="Symbol to pin"><button type="submit">★ Pin</button></form>
      <p class="muted">Pin 咗會一直喺牆上，下一次 scan（≤ 1 分鐘）開始掃。要係 Aster 股票永續。</p>
      ${st.skips.length ? `<h3>你剔走咗</h3><ul>${st.skips.map(s => `<li>${sym(s)}<span class="why"><button data-unskip="${esc(s)}">放返入嚟</button></span></li>`).join('')}</ul>` : ''}
      <h3>其他掃描中</h3>
      <ul>${others.map(s => `<li>${sym(s.symbol)}<span style="color:${statusColor(s.status)}">${esc(String(s.status).replaceAll('_', ' '))}</span><span class="why"><button data-pinsym="${esc(s.symbol)}">★</button></span></li>`).join('') || '<li class="muted">冇</li>'}</ul>
      <h3>Reviewer 最近決定</h3>
      <ul>${dec.map(d => `<li>${sym(d.symbol)}<span class="${d.status === 'Approved' ? 'up' : 'warn'}">${esc(d.status)}</span><span class="why">${esc(String(d.reason).replaceAll('_', ' '))}</span></li>`).join('') || '<li class="muted">未有 proposal</li>'}</ul>`;
  }

  function setTool(t) {
    tool = t;
    root.querySelectorAll('[data-tool]').forEach(b => { const on = b.dataset.tool === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    for (const c of Object.values(charts)) { c.prev = null; c.cv.style.cursor = t === 'cursor' ? 'grab' : t === 'erase' ? 'pointer' : 'crosshair'; c.draw(); }
    clearTimeout(hintT); hintEl.textContent = HINT[t];
  }
  function setDir(d) {
    dir = d;
    root.querySelectorAll('[data-dir]').forEach(b => { const on = b.dataset.dir === d; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  }
  function setLayer(on) {
    layerOn = on; LS.set('asd_wall_layer', on);
    const b = $('[data-do="layer"]'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    redraw();
  }
  function autoLabel() {
    const ch = charts[active];
    if (!ch?.bars.length) return hint('揀一個有 K 線嘅圖先。');
    const cur = marksOf(ch.sym), had = cur.some(m => m.auto && m.tf === ch.tf);
    if (had) { commit(ch.sym, cur.filter(m => !(m.auto && m.tf === ch.tf))); return hint(`已清走 ${short(ch.sym)} ${ch.tf} 嘅自動標記。`); }
    const { fvg, tags } = detect(ch);
    commit(ch.sym, [...cur, ...[...fvg, ...tags].map(m => ({ ...m, id: uid(), at: Date.now(), auto: true, tf: ch.tf }))]);
    hint(`${short(ch.sym)} ${ch.tf}：自動標咗 ${fvg.length} 個 FVG、${tags.length} 個 swing（淡色）。再撳一次就清走。`);
  }
  function undo() {
    const h = hist[active];
    if (!h?.length) return hint('冇嘢可以復原。');
    api.setMarks(active, h.pop()); redraw(active);
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('button,[data-go]');
    if (!b) return;
    const tile = b.closest('.cw-tile'), sym = tile?.dataset.sym;
    if (b.hasAttribute('data-close')) return wall.close();
    if (b.dataset.tool) return setTool(b.dataset.tool);
    if (b.dataset.dir) return setDir(b.dataset.dir);
    if (b.dataset.do === 'auto') return autoLabel();
    if (b.dataset.do === 'layer') return setLayer(!layerOn);
    if (b.dataset.do === 'in') return charts[active]?.zoom(1.3);
    if (b.dataset.do === 'out') return charts[active]?.zoom(1 / 1.3);
    if (b.dataset.do === 'undo') return undo();
    if (b.dataset.do === 'clear' && active) { commit(active, []); return hint(`已清除 ${short(active)} 所有標記。Undo 可以攞返。`); }
    if (b.dataset.tf && sym) { wall.setActive(sym); tfs[sym] = b.dataset.tf; LS.set('asd_wall_tf', tfs); return charts[sym].setTf(b.dataset.tf); }
    if (b.hasAttribute('data-pin') && sym) return api.togglePick(sym, 'pin');
    if (b.hasAttribute('data-skip') && sym) return api.togglePick(sym, 'skip');
    if (b.hasAttribute('data-big') && sym) {
      const on = !tile.classList.contains('big'); tile.classList.toggle('big', on); b.classList.toggle('on', on); b.textContent = on ? 'Shrink' : 'Expand';
      wall.setActive(sym); if (on) tile.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (b.dataset.pinsym) return api.togglePick(b.dataset.pinsym, 'pin');
    if (b.dataset.unskip) return api.togglePick(b.dataset.unskip, 'skip');
    if (b.dataset.go) { wall.setActive(b.dataset.go); grid.querySelector(`.cw-tile[data-sym="${CSS.escape(b.dataset.go)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });
  root.addEventListener('submit', e => {
    e.preventDefault();
    if (!e.target.matches('[data-addpin]')) return;
    const v = String(new FormData(e.target).get('sym') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!v) return;
    e.target.reset(); document.activeElement?.blur();
    api.addPin(v.endsWith('USDT') ? v : `${v}USDT`);
  });

  Object.assign(wall, {
    isOpen: () => open,
    show(sym) {
      open = true; root.hidden = false; document.body.classList.add('wall-open');
      build(); setTool(tool); setLayer(layerOn);
      if (sym && charts[sym]) { wall.setActive(sym); charts[sym].el.scrollIntoView({ block: 'nearest' }); }
      for (const c of Object.values(charts)) c.load();
      clearInterval(timer);
      timer = setInterval(() => { for (const c of Object.values(charts)) c.load(); }, 30_000);
    },
    close() {
      open = false; root.hidden = true; document.body.classList.remove('wall-open'); clearInterval(timer);
      for (const c of Object.values(charts)) c.prev = c.down = null;
      api.onClose?.();
    },
    update() { if (open) { build(); redraw(); } },
    // Keyboard while the wall is open. Returns nothing; the desk's own shortcuts are off meanwhile.
    key(e) {
      if (e.target.closest('input,textarea,select')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return undo(); }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') return tool !== 'cursor' ? setTool('cursor') : wall.close();
      const t = TOOLS.find(x => x[2].toLowerCase() === k);
      if (t) return setTool(t[0]);
      if (k === 'b') return setDir(dir === 'bull' ? 'bear' : 'bull');
      if (k === 'a') return autoLabel();
      if (k === 'g') return setLayer(!layerOn);
      if ((k === '+' || k === '=') && charts[active]) return charts[active].zoom(1.3);
      if (k === '-' && charts[active]) return charts[active].zoom(1 / 1.3);
    },
  });
  return wall;
}
