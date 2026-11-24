// Candle charts on a 2D canvas (panels and wall textures).
export const C = { bg: '#0b1120', grid: 'rgba(120,150,210,.12)', text: '#9fb1d4', up: '#34d399', down: '#f87171',
  entry: '#60a5fa', stop: '#f87171', target: '#34d399', zone: 'rgba(250,204,21,.18)', zoneEdge: 'rgba(250,204,21,.7)', boundary: '#c084fc' };

export const statusColor = s => ({ QUALIFIED: '#fbbf24', LTF_CONFIRMED: '#f97316', POI_TOUCHED: '#fb923c', WAIT_RETEST: '#38bdf8', WAIT_POI: '#38bdf8',
  PATTERN_CONFIRMED: '#38bdf8', SKIPPED: '#64748b', EXPIRED: '#64748b', CANCELLED: '#64748b' })[s] ?? '#475569';

// Fred's chart marks (state.marks[symbol]) as drawCandles overlays, for the wall texture.
export function marksOverlay(list = []) {
  const zones = [], lines = [], marks = [];
  for (const m of list) {
    const col = m.dir === 'bear' ? C.down : C.up;
    if (m.type === 'fvg' || m.type === 'ob') zones.push({ lo: Math.min(m.p1, m.p2), hi: Math.max(m.p1, m.p2), from: m.t1,
      color: m.dir === 'bear' ? 'rgba(248,113,113,.18)' : 'rgba(52,211,153,.18)', edge: col, label: m.type.toUpperCase() });
    else if (m.type === 'mss') lines.push({ price: m.p1, color: col, label: 'MSS', from: m.t1 });
    else if (m.type === 'liq') lines.push({ price: m.p1, color: '#fbbf24', label: m.side === 'SSL' ? 'SSL' : 'BSL', from: m.t1, dash: [2, 4] });
    else if (m.type === 'tag') marks.push({ t: m.t1, price: m.p1, color: m.label === 'HH' || m.label === 'HL' ? C.up : C.down, label: m.label, above: String(m.label)[1] === 'H' });
  }
  return { zones, lines, marks };
}

export function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const dp = a >= 1 || a === 0 ? d : 4;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export const money = n => `${n < 0 ? '−' : ''}$${fmt(Math.abs(n))}`;
export const pct = n => Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : '—';
export const hhmm = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

// bars: [{t,start?,o,h,l,c}], lines: [{price,color,label,from?}], zones: [{lo,hi,from,to,color,label}]
export function drawCandles(ctx, box, bars, { lines = [], zones = [], marks = [], title = '', font = 12 } = {}) {
  const { x, y, w, h } = box;
  ctx.save();
  ctx.fillStyle = C.bg; ctx.fillRect(x, y, w, h);
  if (!bars?.length) {
    ctx.fillStyle = C.text; ctx.font = `${font}px Inter, system-ui, sans-serif`; ctx.fillText('No completed candles yet', x + 10, y + h / 2);
    ctx.restore(); return;
  }
  const pad = { l: 6, r: font * 5, t: font * 1.8, b: font * 1.6 };
  const prices = bars.flatMap(b => [b.h, b.l]).concat(lines.map(l => l.price), zones.flatMap(z => [z.lo, z.hi])).filter(Number.isFinite);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo || hi * 0.01 || 1; lo -= span * 0.06; hi += span * 0.06;
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const Y = p => y + pad.t + (hi - p) / (hi - lo) * ph;
  const t0 = bars[0].t, step = bars.length > 1 ? (bars.at(-1).t - t0) / (bars.length - 1) : 60000;
  const X = t => x + pad.l + ((t - t0) / step + 0.5) * pw / bars.length;
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text; ctx.font = `${font * 0.85}px Inter, system-ui, sans-serif`;
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4, yy = Y(p);
    ctx.beginPath(); ctx.moveTo(x + pad.l, yy); ctx.lineTo(x + w - pad.r, yy); ctx.stroke();
    ctx.fillText(fmt(p), x + w - pad.r + 4, yy + 4);
  }
  for (const z of zones) {
    const x0 = Math.max(x + pad.l, z.from ? X(z.from) : x + pad.l), x1 = z.to ? Math.min(X(z.to), x + w - pad.r) : x + w - pad.r;
    ctx.fillStyle = z.color ?? C.zone; ctx.fillRect(x0, Y(z.hi), Math.max(2, x1 - x0), Math.max(1, Y(z.lo) - Y(z.hi)));
    ctx.strokeStyle = z.edge ?? C.zoneEdge; ctx.strokeRect(x0, Y(z.hi), Math.max(2, x1 - x0), Math.max(1, Y(z.lo) - Y(z.hi)));
    if (z.label) { ctx.fillStyle = z.edge ?? C.zoneEdge; ctx.fillText(z.label, x0 + 3, Y(z.hi) - 3); }
  }
  const bw = Math.max(1, pw / bars.length * 0.68);
  for (const b of bars) {
    const xx = X(b.t), up = b.c >= b.o;
    ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
    ctx.beginPath(); ctx.moveTo(xx, Y(b.h)); ctx.lineTo(xx, Y(b.l)); ctx.stroke();
    ctx.fillRect(xx - bw / 2, Math.min(Y(b.o), Y(b.c)), bw, Math.max(1, Math.abs(Y(b.o) - Y(b.c))));
  }
  for (const l of lines) {
    if (!Number.isFinite(l.price)) continue;
    const yy = Y(l.price), x0 = l.from ? Math.max(x + pad.l, X(l.from)) : x + pad.l;
    ctx.strokeStyle = l.color; ctx.setLineDash(l.dash ?? [6, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x + w - pad.r, yy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = l.color; ctx.fillRect(x + w - pad.r, yy - font * 0.65, pad.r, font * 1.3);
    ctx.fillStyle = '#0b1120'; ctx.fillText(`${l.label ?? ''} ${fmt(l.price)}`.trim(), x + w - pad.r + 3, yy + font * 0.35);
  }
  for (const m of marks) {
    if (m.t < t0) continue;
    ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(X(m.t), Y(m.price), font * 0.35, 0, Math.PI * 2); ctx.fill();
    if (m.label) { ctx.textAlign = 'center'; ctx.fillText(m.label, X(m.t), Y(m.price) + (m.above ? -font * 0.6 : font * 1.2)); ctx.textAlign = 'left'; }
  }
  if (title) { ctx.fillStyle = '#e2e8f0'; ctx.font = `600 ${font}px Inter, system-ui, sans-serif`; ctx.fillText(title, x + 8, y + font * 1.25); }
  ctx.fillStyle = C.text; ctx.font = `${font * 0.8}px Inter, system-ui, sans-serif`;
  ctx.fillText(hhmm(bars[0].t), x + pad.l, y + h - 4);
  ctx.fillText(hhmm(bars.at(-1).t), x + w - pad.r - font * 3, y + h - 4);
  ctx.restore();
}

export function drawLine(ctx, box, points, { color = '#60a5fa', base, title = '', font = 12 } = {}) {
  const { x, y, w, h } = box;
  ctx.save(); ctx.fillStyle = C.bg; ctx.fillRect(x, y, w, h);
  if (title) { ctx.fillStyle = '#e2e8f0'; ctx.font = `600 ${font}px Inter, system-ui, sans-serif`; ctx.fillText(title, x + 8, y + font * 1.25); }
  if (points.length < 2) { ctx.fillStyle = C.text; ctx.font = `${font}px Inter, sans-serif`; ctx.fillText('Waiting for closed trades', x + 10, y + h / 2); ctx.restore(); return; }
  const vs = points.map(p => p.v).concat(base ?? []);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const X = i => x + 8 + i / (points.length - 1) * (w - 16), Y = v => y + font * 2 + (hi - v) / span * (h - font * 3);
  if (Number.isFinite(base)) { ctx.strokeStyle = C.grid; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, Y(base)); ctx.lineTo(x + w, Y(base)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))); ctx.stroke();
  ctx.restore();
}

export function tradeOverlay(t) {
  const lines = [{ price: t.entry, color: C.entry, label: 'E', from: t.entryAt ?? t.plan?.signalAt },
    { price: t.stop, color: C.stop, label: 'SL', from: t.entryAt ?? t.plan?.signalAt }, { price: t.target, color: C.target, label: 'TP', from: t.entryAt ?? t.plan?.signalAt }];
  const p = t.plan ?? t;
  const zones = [p.poi && { lo: p.poi.lo, hi: p.poi.hi, from: p.poi.knownAt, label: `15m ${p.poi.type}` },
    p.fvg && { lo: p.fvg.lo, hi: p.fvg.hi, from: p.fvg.knownAt, color: 'rgba(96,165,250,.18)', label: '5m FVG' }].filter(Boolean);
  if (p.pattern) lines.push({ price: p.pattern.boundary, color: C.boundary, label: p.pattern.type.slice(0, 4), dash: [2, 3] });
  const marks = [t.entryAt && { t: t.entryAt, price: t.entry, color: C.entry }, t.exitAt && { t: t.exitAt, price: t.exit, color: '#fbbf24' }].filter(Boolean);
  return { lines, zones, marks };
}
