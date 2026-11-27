// Walkable 3D room: five agent desks (PMR Screener / Trader / Reviewer / Intel + the SMC Trader), the Screener picks wall (north), positions wall (east),
// review wall (south) and the Reviewer's rules + agent comms wall (west).
import * as THREE from 'three';
import { C, FONT, drawCandles, fmt, hhmm, marksOverlay, money, pct, statusColor, tradeOverlay } from './charts.mjs';
import { dec, evt, ex, pat, rec, rsn, st, zone } from './zh.mjs';

export const DESKS = [
  { id: 'screener', key: '1', name: 'Screener 篩選', role: '1H 形態 → 15m POI → 5m 入場', color: 0x38bdf8, x: -6, z: -4 },
  { id: 'trader', key: '2', name: 'PMR Trader', role: 'Paper 成交 · stop · target', color: 0x818cf8, x: 6, z: -4 },
  { id: 'reviewer', key: '3', name: 'Reviewer 審核', role: 'Net R:R 把關 · 評分 · 規則', color: 0xc084fc, x: -6, z: 3 },
  { id: 'intel', key: '4', name: '市場情報', role: 'Taker 資金流 · 成交量 · 市況', color: 0x34d399, x: 6, z: 3 },
  { id: 'smc', key: '6', name: 'SMC Trader', role: 'Crypto desk 嘅 SMC 做股票 perp', color: 0xf472b6, x: 11, z: -7.6 },
];
const RX = 15, RZ = 10, RH = 4.6;

function tex(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
  return { cv, ctx: cv.getContext('2d'), t, w, h };
}
const hex = c => `#${c.toString(16).padStart(6, '0')}`;
function header(ctx, w, text, color, size) {
  ctx.fillStyle = '#060a14'; ctx.fillRect(0, 0, w, size * 2);
  ctx.fillStyle = color; ctx.fillRect(0, size * 2 - 4, w, 4);
  ctx.fillStyle = '#e2e8f0'; ctx.font = `700 ${size}px ${FONT}`; ctx.fillText(text, size * 0.8, size * 1.35);
}
function clip(ctx, s, max) {
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

export function createWorld(canvas, { onPick }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04060c);
  scene.fog = new THREE.Fog(0x04060c, 26, 50);
  const camera = new THREE.PerspectiveCamera(66, 1, 0.05, 120);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 1.65, 8.5);
  const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();

  const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: .7, metalness: .1, ...o });
  const glow = c => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const box = (w, h, d, m, x, y, z, parent = scene) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); parent.add(o); return o; };
  const solids = [];
  const pickables = [];

  scene.add(new THREE.HemisphereLight(0x7080b8, 0x0a0a14, 0.8));
  scene.add(new THREE.AmbientLight(0x1a2240, 0.4));
  for (const [x, z] of [[-8, -4], [8, -4], [-8, 5], [8, 5], [0, 0]]) { const p = new THREE.PointLight(0xbfd2ff, 0.5, 16, 2); p.position.set(x, RH - 0.3, z); scene.add(p); }

  { // floor
    const T = tex(1536, 1024), c = T.ctx;
    c.fillStyle = '#0a0f1c'; c.fillRect(0, 0, 1536, 1024);
    c.strokeStyle = 'rgba(80,110,180,.16)'; c.lineWidth = 2;
    for (let i = 0; i <= 30; i++) { c.beginPath(); c.moveTo(i * 51.2, 0); c.lineTo(i * 51.2, 1024); c.stroke(); }
    for (let j = 0; j <= 20; j++) { c.beginPath(); c.moveTo(0, j * 51.2); c.lineTo(1536, j * 51.2); c.stroke(); }
    const f = new THREE.Mesh(new THREE.PlaneGeometry(RX * 2, RZ * 2), mat(0xffffff, { map: T.t, roughness: .45, metalness: .35 }));
    f.rotation.x = -Math.PI / 2; scene.add(f);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RX * 2, RZ * 2), mat(0x080c16, { roughness: .9 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = RH; scene.add(ceil);
    for (const z of [-6, -2, 2, 6]) for (const x of [-9, 0, 9]) box(5, 0.04, 0.22, glow(0xcfe0ff), x, RH - 0.03, z);
    const wallM = mat(0x0c1222, { roughness: .85 });
    box(RX * 2, RH, 0.3, wallM, 0, RH / 2, -RZ - 0.15); box(RX * 2, RH, 0.3, wallM, 0, RH / 2, RZ + 0.15);
    box(0.3, RH, RZ * 2, wallM, -RX - 0.15, RH / 2, 0); box(0.3, RH, RZ * 2, wallM, RX + 0.15, RH / 2, 0);
    solids.push([-RX - 1, -RZ - 1, RX + 1, -RZ + 0.4], [-RX - 1, RZ - 0.4, RX + 1, RZ + 1], [-RX - 1, -RZ, -RX + 0.4, RZ], [RX - 0.4, -RZ, RX + 1, RZ]);
  }

  // A wall screen: canvas texture on a plane with a glowing frame. `rot` = rotation.y, (x, z) = centre on the wall.
  function screen(id, w, h, pxW, x, z, rot, color) {
    const T = tex(pxW, Math.round(pxW * h / w));
    const g = new THREE.Group(); g.position.set(x, 2.35, z); g.rotation.y = rot; scene.add(g);
    box(w + 0.3, h + 0.3, 0.08, mat(0x05070d, { metalness: .7, roughness: .3 }), 0, 0, -0.05, g);
    box(w + 0.3, 0.04, 0.1, glow(color), 0, h / 2 + 0.17, 0, g); box(w + 0.3, 0.04, 0.1, glow(color), 0, -h / 2 - 0.17, 0, g);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: T.t, toneMapped: false, fog: false }));
    m.position.z = 0.001; m.userData.pick = id; g.add(m); pickables.push(m);
    const l = new THREE.PointLight(color, 0.35, 8, 2); l.position.set(0, 0, 1.5); g.add(l);
    return T;
  }
  const BOARD = screen('board', 16, 3.4, 3200, 0, -RZ + 0.2, 0, 0x4f7cff);
  const POS = screen('positions', 15, 3.2, 3000, RX - 0.2, 0, -Math.PI / 2, 0xffd166);
  const REVIEW = screen('reviews', 16, 3.2, 3200, 0, RZ - 0.2, Math.PI, 0xc084fc);
  const RULES = screen('rules', 15, 3.2, 3000, -RX + 0.2, 0, Math.PI / 2, 0x34d399);

  // Desks with a monitor each and an agent figure.
  const monitors = {};
  const figures = [];
  for (const d of DESKS) {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.z); scene.add(g);
    box(3.4, 0.08, 1.6, mat(0x111827, { metalness: .5, roughness: .4 }), 0, 0.78, 0, g);
    box(3.4, 0.03, 0.04, glow(d.color), 0, 0.8, 0.8, g);
    for (const sx of [-1.55, 1.55]) box(0.08, 0.78, 1.4, mat(0x0b1220), sx, 0.39, 0, g);
    const T = tex(1000, 600);
    const mon = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.56), new THREE.MeshBasicMaterial({ map: T.t, toneMapped: false }));
    mon.position.set(0, 1.75, -0.45); mon.rotation.x = -0.08; mon.userData.pick = d.id; g.add(mon); pickables.push(mon);
    box(2.7, 1.66, 0.05, mat(0x05070d, { metalness: .7 }), 0, 1.75, -0.49, g).rotation.x = -0.08;
    box(0.1, 0.55, 0.1, mat(0x1f2937), 0, 1.0, -0.5, g);
    const deskHit = box(3.4, 0.8, 1.6, new THREE.MeshBasicMaterial({ visible: false }), 0, 0.4, 0, g);
    deskHit.userData.pick = d.id; pickables.push(deskHit);
    const fig = new THREE.Group(); fig.position.set(0, 0, 1.25); g.add(fig);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.7, 6, 12), mat(d.color, { emissive: d.color, emissiveIntensity: 0.25 }));
    body.position.y = 0.85; fig.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), mat(0xe2e8f0)); head.position.y = 1.55; fig.add(head);
    const visor = box(0.3, 0.07, 0.05, glow(d.color), 0, 1.57, -0.18, fig);
    body.userData.pick = head.userData.pick = visor.userData.pick = d.id; pickables.push(body, head);
    figures.push({ fig, phase: Math.random() * 6, id: d.id });
    const L = tex(512, 128);
    L.ctx.fillStyle = 'rgba(6,10,20,.85)'; L.ctx.fillRect(0, 0, 512, 128);
    L.ctx.fillStyle = hex(d.color); L.ctx.fillRect(0, 120, 512, 8);
    L.ctx.fillStyle = '#e2e8f0'; L.ctx.font = `700 54px ${FONT}`; L.ctx.fillText(`${d.key} · ${d.name}`, 22, 62);
    L.ctx.fillStyle = '#94a3b8'; L.ctx.font = `30px ${FONT}`; L.ctx.fillText(d.role, 22, 104); L.t.needsUpdate = true;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: L.t, toneMapped: false, depthTest: false }));
    sp.scale.set(2.2, 0.55, 1); sp.position.set(0, 2.95, -0.45); g.add(sp);
    monitors[d.id] = T;
    solids.push([d.x - 1.9, d.z - 1.0, d.x + 1.9, d.z + 1.0]);
  }

  // Walking: WASD / arrows, wheel to step. Looking (Fred, 2026-11-26: with the old relative follow, a cursor that ran off
  // the screen left the view stuck off-centre): the view is a heading (baseYaw / basePitch) plus an offset set by where the
  // cursor sits on screen, eased like a spring. Cursor in the middle = looking along the heading, so bringing the mouse
  // back to the middle always recentres. The outer 8 % of the screen turns the heading; leaving the window keeps the
  // offset where it was. Drag turns the heading (the only mode on touch). C levels the view. Esc with nothing open holds
  // the view still (no follow, no edge turning) until Esc again; dragging still turns.
  const keys = new Set();
  let baseYaw = 0, basePitch = -0.05, yaw = 0, pitch = -0.05, drag = null, moved = 0, lastPt = null, edge = 0, still = false;
  const off = { y: 0, p: 0 }, offT = { y: 0, p: 0 };
  const LOOK = { follow: { y: 0.55, p: 0.3 }, fast: { y: 0.95, p: 0.45 }, drag: null }, BAND = 0.08;
  let look = (() => { try { return JSON.parse(localStorage.getItem('asd_look')) ?? 'follow'; } catch { return 'follow'; } })();
  const following = () => !still && !!LOOK[look] && !document.body.classList.contains('wall-open');
  const clampP = v => Math.max(-1.2, Math.min(1.2, v));
  // Offset for a cursor position: ±range at the screen edges, 0 in the middle.
  const offsetAt = pt => { const R = LOOK[look] ?? { y: 0, p: 0 }; return { y: -(pt.x / innerWidth - 0.5) * 2 * R.y, p: -(pt.y / innerHeight - 0.5) * 2 * R.p }; };
  // Change the offset without moving the view: the heading absorbs the difference.
  function rebase(o) { baseYaw += off.y - o.y; basePitch += off.p - o.p; off.y = offT.y = o.y; off.p = offT.p = o.p; }
  addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select') || document.body.classList.contains('wall-open')) return;
    keys.add(e.code);
    if (e.code === 'KeyC' && !e.metaKey && !e.ctrlKey) { basePitch = -0.05 - offT.p; flight = null; }
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; moved = 0; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') lastPt = { x: e.clientX, y: e.clientY };
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; moved += Math.abs(dx) + Math.abs(dy);
      baseYaw -= dx * 0.004; basePitch = Math.max(-1.1, Math.min(1.1, basePitch - dy * 0.004)); drag = { x: e.clientX, y: e.clientY };
      // The cursor moved with the drag: keep its offset in step so letting go does not swing the view.
      if (following() && e.pointerType === 'mouse') rebase(offsetAt(lastPt));
      edge = 0; flight = null; return;
    }
    if (e.pointerType !== 'mouse' || !following()) { edge = 0; return; }
    Object.assign(offT, offsetAt(lastPt));
    const fx = e.clientX / innerWidth;
    edge = fx < BAND ? (BAND - fx) / BAND : fx > 1 - BAND ? -(fx - (1 - BAND)) / BAND : 0;
  });
  canvas.addEventListener('pointerleave', () => { edge = 0; });
  addEventListener('blur', () => { edge = 0; });
  const ray = new THREE.Raycaster();
  canvas.addEventListener('pointerup', e => {
    drag = null;
    if (moved > 6) return;
    ray.setFromCamera({ x: e.clientX / innerWidth * 2 - 1, y: -(e.clientY / innerHeight) * 2 + 1 }, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) onPick(hit.object.userData.pick, hit.uv);
  });
  canvas.addEventListener('wheel', e => { walk(0, -Math.sign(e.deltaY) * 0.6); e.preventDefault(); }, { passive: false });
  function blocked(x, z) { return solids.some(([a, b, c, d]) => x > a - 0.3 && x < c + 0.3 && z > b - 0.3 && z < d + 0.3); }
  function walk(strafe, fwd) {
    const nx = camera.position.x + (-Math.sin(yaw) * fwd + Math.cos(yaw) * strafe);
    const nz = camera.position.z + (-Math.cos(yaw) * fwd - Math.sin(yaw) * strafe);
    if (!blocked(nx, camera.position.z)) camera.position.x = nx;
    if (!blocked(camera.position.x, nz)) camera.position.z = nz;
  }
  // Fly to a spot in front of something.
  let flight = null;
  function goTo(x, z, faceYaw) { flight = { x, z, yaw: faceYaw, t: 0, from: { x: camera.position.x, z: camera.position.z, yaw } }; }
  const SPOTS = { board: [0, -1.6, 0], positions: [3.5, -0.5, -Math.PI / 2], reviews: [0, 1.5, Math.PI], rules: [-3.5, -0.5, Math.PI / 2],
    ...Object.fromEntries(DESKS.map(d => [d.id, [d.x + 0.9, Math.min(d.z + 4.4, RZ - 1), 0]])) };

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now(), real = (now - last) / 1000, dt = Math.min(0.05, real); last = now;
    const sp = (keys.has('ShiftLeft') ? 7 : 3.6) * dt;
    const f = (keys.has('KeyW') || keys.has('ArrowUp')) - (keys.has('KeyS') || keys.has('ArrowDown'));
    const s = (keys.has('KeyD')) - (keys.has('KeyA'));
    if (keys.has('ArrowLeft')) baseYaw += 1.8 * dt;
    if (keys.has('ArrowRight')) baseYaw -= 1.8 * dt;
    if (edge && !drag && following()) { baseYaw += edge * 1.6 * dt; flight = null; }
    // Spring-like easing of the cursor offset (exponential approach: no overshoot, frame-rate independent).
    const ease = 1 - Math.exp(-dt * 11);
    off.y += (offT.y - off.y) * ease; off.p += (offT.p - off.p) * ease;
    if (f || s) { flight = null; walk(s * sp, f * sp); }
    if (flight) {
      flight.t = Math.min(1, flight.t + Math.min(real, 0.5) * 1.4);
      const k = flight.t * flight.t * (3 - 2 * flight.t);
      camera.position.x = flight.from.x + (flight.x - flight.from.x) * k;
      camera.position.z = flight.from.z + (flight.z - flight.from.z) * k;
      let dy = flight.yaw - flight.from.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      // The flight steers the total view; the heading takes whatever the cursor offset is not covering.
      baseYaw = flight.from.yaw + dy * k - off.y;
      basePitch += (-0.05 - off.p - basePitch) * Math.min(1, k * 0.25);
      if (flight.t >= 1) flight = null;
    }
    yaw = baseYaw + off.y; pitch = clampP(basePitch + off.p);
    camera.rotation.set(pitch, yaw, 0);
    for (const fg of figures) { fg.fig.position.y = Math.sin(now / 700 + fg.phase) * 0.03; fg.fig.rotation.y = Math.sin(now / 2100 + fg.phase) * 0.25; }
    renderer.render(scene, camera);
  });

  // ---- wall and monitor drawing ----
  // North wall: the Screener's picks as 15m charts with PMR levels and Fred's marks. Click a chart to open the Picks wall.
  const PICK_COLS = 3, PICK_TOP = 112;
  function drawBoard(view) {
    const { ctx, w, h } = BOARD, s = view.state, picks = (s.picks ?? []).slice(0, 6);
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, w, h);
    header(ctx, w, `Screener 心水 · Trader 只做呢幾隻 · 牆上 ${picks.length} 隻 · 撳 chart 去畫標記`, '#4f7cff', 50);
    const rows = Math.max(1, Math.ceil(picks.length / PICK_COLS)), cw = w / PICK_COLS, ch = (h - PICK_TOP) / Math.max(2, rows);
    picks.forEach((p, i) => {
      const x = (i % PICK_COLS) * cw + 12, y = PICK_TOP + Math.floor(i / PICK_COLS) * ch + 6, bw = cw - 24, bh = ch - 12;
      const scan = view.scanMap[p.symbol], bars = scan?.m15 ?? [], live = [...s.positions, ...s.orders].find(o => o.symbol === p.symbol);
      const ov = { lines: [], zones: [], marks: [] };
      if (scan?.anchor) ov.lines.push({ price: scan.anchor.boundary, color: C.boundary, label: 'BRK' });
      if (scan?.poi) ov.zones.push({ lo: scan.poi.lo, hi: scan.poi.hi, from: scan.poi.knownAt, label: `15m ${scan.poi.type}` });
      if (live) { const t = tradeOverlay(live); ov.lines.push(...t.lines.slice(0, 3)); }
      if (bars.length) {
        const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h)), pad = (hi - lo) * 0.5;
        const near = (s.marks?.[p.symbol] ?? []).filter(m => [m.p1, m.p2].filter(Number.isFinite).every(v => v >= lo - pad && v <= hi + pad));
        const mo = marksOverlay(near.slice(-14));
        ov.lines.push(...mo.lines); ov.zones.push(...mo.zones); ov.marks.push(...mo.marks);
      }
      const tag = live ? (live.entryAt ? ' · 持倉' : ' · 掛單') : p.why === 'pinned' ? ' · ★' : '';
      drawCandles(ctx, { x, y, w: bw, h: bh }, bars, { ...ov, font: 30, title: `${p.symbol.replace('USDT', '')} ${fmt(p.price)}${tag}` });
      ctx.font = `600 28px ${FONT}`; ctx.fillStyle = statusColor(p.status); ctx.textAlign = 'right';
      ctx.fillText(clip(ctx, st(p.status), bw * 0.45), x + bw - 160, y + 38); ctx.textAlign = 'left';
    });
    if (!picks.length) { ctx.fillStyle = '#64748b'; ctx.font = `44px ${FONT}`; ctx.fillText('等緊第一次掃描，心水會喺呢度出現。', 60, h / 2); }
    BOARD.t.needsUpdate = true;
    BOARD.ids = picks.map(p => p.symbol);
    BOARD.rows = Math.max(2, rows);
  }

  // East wall (P): 交易直播 (Fred, 2026-11-26: a wall showing what the traders are doing now). Live cards for both traders'
  // positions and pending limits (5m chart with E / SL / TP, live R, time held, setup), or what each trader is waiting for
  // when flat; a merged activity feed on the right. Click a card or the feed to open the trader's panel.
  const LIVE_TOP = 112, LIVE_COLS = 3, FEED_W = 880;
  function liveItems(view) {
    const s = view.state, px = sym => view.scanMap[sym]?.price;
    const pmr = [...s.positions.map(p => ({ ...p, kind: 'OPEN' })), ...s.orders.map(o => ({ ...o, kind: 'PENDING' }))].map(p => {
      const now = px(p.symbol) ?? p.mark ?? p.entry, unit = p.riskUSDT && p.qty ? p.riskUSDT / p.qty : Math.abs(p.entry - p.stop);
      return { ...p, who: 'PMR', panel: 'trader', now, r: p.kind === 'OPEN' ? p.direction * (now - p.entry) / unit : null,
        setup: `${pat(p.plan?.pattern?.type)} · 15m ${p.plan?.poi?.type ?? ''} · ${p.plan?.grade ?? ''}` };
    });
    const smc = Object.entries(s.smc?.acct?.pos ?? {}).map(([sym, p]) => {
      const now = px(sym) ?? p.entry, d = p.side === 'L' ? 1 : -1;
      return { symbol: sym, direction: d, entry: p.entry, stop: p.stop, target: p.target, entryAt: p.t, qty: p.qty, kind: 'OPEN', who: 'SMC', panel: 'smc', now,
        r: d * (now - p.entry) / Math.abs(p.entry - (p.stop0 ?? p.stop)), setup: `${p.tf ?? ''} ${p.zoneKind ?? ''}${p.tp1 ? ' · 已平一半' : ''}` };
    });
    return [...pmr.filter(x => x.kind === 'OPEN'), ...smc, ...pmr.filter(x => x.kind === 'PENDING')];
  }
  const held = t => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m} 分鐘` : `${Math.floor(m / 60)} 粒鐘 ${m % 60} 分`; };
  function drawPositions(view) {
    const { ctx, w, h } = POS, s = view.state;
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, w, h);
    const a = s.acct, m = s.smc, items = liveItems(view), open = items.filter(x => x.kind === 'OPEN').length;
    header(ctx, w, `交易直播 · 持倉 ${open} · 掛單 ${items.length - open} · PMR ${money(a.equity)}（${pct((a.equity / a.start - 1) * 100)}）· SMC ${m?.equity != null ? money(m.equity) : '—'}`, '#ffd166', 48);
    const areaW = w - FEED_W - 40, cw = areaW / LIVE_COLS, ch = h - LIVE_TOP - 16;
    POS.cards = [];
    items.slice(0, LIVE_COLS).forEach((p, i) => {
      const x = 20 + i * cw, y = LIVE_TOP, bw = cw - 20, chartH = ch - 150;
      ctx.fillStyle = '#0d1426'; ctx.fillRect(x, y, bw, ch);
      const col = p.who === 'SMC' ? '#f472b6' : '#818cf8';
      ctx.fillStyle = col; ctx.fillRect(x, y, 8, ch);
      drawCandles(ctx, { x: x + 14, y, w: bw - 20, h: chartH }, view.scanMap[p.symbol]?.m5 ?? [], { ...tradeOverlay(p), font: 26,
        title: `${p.who} · ${p.symbol.replace('USDT', '')} ${p.direction === 1 ? 'LONG' : 'SHORT'} · ${p.kind === 'OPEN' ? '持倉中' : '掛 limit'}` });
      let ty = y + chartH + 42;
      ctx.font = `600 30px ${FONT}`; ctx.fillStyle = '#e2e8f0';
      ctx.fillText(clip(ctx, `入場 ${fmt(p.entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)}`, bw - 40), x + 24, ty); ty += 46;
      if (p.kind === 'OPEN') {
        ctx.fillStyle = p.r >= 0 ? C.up : C.down; ctx.font = `800 34px ${FONT}`;
        const rs = `${p.r >= 0 ? '+' : ''}${Number.isFinite(p.r) ? p.r.toFixed(2) : '—'}R`; ctx.fillText(rs, x + 24, ty);
        const rw = ctx.measureText(rs).width;
        ctx.fillStyle = '#cbd5e1'; ctx.font = `30px ${FONT}`; ctx.fillText(clip(ctx, ` · 而家 ${fmt(p.now)} · 揸咗 ${held(p.entryAt)}`, bw - 60 - rw), x + 24 + rw, ty);
      } else {
        ctx.fillStyle = '#fbbf24'; ctx.font = `30px ${FONT}`;
        ctx.fillText(clip(ctx, `等成交 · 而家 ${fmt(p.now)} · ${p.plan?.expiresAt ? `${hhmm(p.plan.expiresAt)} 前有效` : ''}`, bw - 40), x + 24, ty);
      }
      ty += 42; ctx.fillStyle = '#94a3b8'; ctx.font = `28px ${FONT}`; ctx.fillText(clip(ctx, p.setup, bw - 40), x + 24, ty);
      POS.cards.push(p.panel);
    });
    if (items.length > LIVE_COLS) { ctx.fillStyle = '#94a3b8'; ctx.font = `28px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(`仲有 ${items.length - LIVE_COLS} 單 · 撳去 Trader panel 睇`, areaW + 10, LIVE_TOP - 14); ctx.textAlign = 'left'; }
    if (!items.length) drawWaiting(ctx, view, 20, LIVE_TOP, areaW - 20, ch);
    drawFeed(ctx, view, w - FEED_W - 10, LIVE_TOP, FEED_W - 10, ch);
    POS.t.needsUpdate = true;
  }
  // Flat: what each trader is closest to.
  function drawWaiting(ctx, view, x, y, ww, hh) {
    const s = view.state;
    ctx.fillStyle = '#0d1426'; ctx.fillRect(x, y, ww, hh);
    ctx.fillStyle = '#e2e8f0'; ctx.font = `600 38px ${FONT}`; ctx.fillText('兩個 Trader 而家都冇倉，等緊：', x + 30, y + 60);
    const half = ww / 2;
    const col = (cx, title, color, rows) => {
      let yy = y + 130; ctx.fillStyle = color; ctx.font = `700 32px ${FONT}`; ctx.fillText(title, cx, yy); yy += 52;
      ctx.font = `30px ${FONT}`;
      for (const [a, b, c] of rows.slice(0, 6)) { ctx.fillStyle = '#e2e8f0'; ctx.fillText(a, cx, yy); ctx.fillStyle = c ?? '#94a3b8'; ctx.fillText(clip(ctx, b, half - 240), cx + 190, yy); yy += 46; }
      if (!rows.length) { ctx.fillStyle = '#64748b'; ctx.fillText('冇 setup 進行緊', cx, yy); }
    };
    const order = ['QUALIFIED', 'LTF_CONFIRMED', 'POI_TOUCHED', 'WAIT_RETEST', 'WAIT_POI', 'PATTERN_CONFIRMED'];
    const pmrRows = Object.values(view.scanMap).filter(x => order.includes(x.status)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
      .map(x => [x.symbol.replace('USDT', ''), `${st(x.status)}${x.anchor ? ` · ${pat(x.anchor.type)} ${x.anchor.direction === 1 ? '↑' : '↓'}` : ''}`, statusColor(x.status)]);
    const smcRows = (s.smc?.scan?.cands ?? []).map(c => [c.b, `${c.side === 'L' ? 'Long' : 'Short'} ${c.tf} ${c.zone} · ${c.took ? '入咗' : rsn(c.skip)}`]);
    col(x + 30, `PMR（${pmrRows.length} 隻有 setup）`, '#818cf8', pmrRows);
    col(x + 30 + half, `SMC（${smcRows.length} 個喺 zone）`, '#f472b6', smcRows);
  }
  // Activity feed: PMR events + SMC entries / exits, newest first.
  function drawFeed(ctx, view, x, y, ww, hh) {
    const s = view.state;
    ctx.fillStyle = '#0d1426'; ctx.fillRect(x, y, ww, hh);
    ctx.fillStyle = '#e2e8f0'; ctx.font = `600 34px ${FONT}`; ctx.fillText('最新動作', x + 24, y + 50);
    const pmr = (s.events ?? []).filter(e => ['PROPOSAL', 'APPROVED', 'DECLINED', 'FILLED', 'CLOSED', 'NO FILL'].includes(e.title))
      .map(e => ({ t: e.t, who: 'PMR', what: evt(e.title), text: e.text.replace(/USDT/g, ''), c: e.title === 'CLOSED' ? '#ffd166' : e.title === 'DECLINED' || e.title === 'NO FILL' ? '#64748b' : '#818cf8' }));
    const smcIn = (s.smc?.decisions ?? []).filter(d => d.status === 'Entered').map(d => ({ t: d.t, who: 'SMC', what: '入場', text: `${d.symbol.replace('USDT', '')} ${d.side === 'L' ? 'long' : 'short'} · ${d.reason}`, c: '#f472b6' }));
    const smcOut = (s.smc?.trades ?? []).map(t => ({ t: t.exitAt, who: 'SMC', what: '平倉', text: `${t.symbol.replace('USDT', '')} ${ex(t.reason)} · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`, c: '#ffd166' }));
    const feed = [...pmr, ...smcIn, ...smcOut].sort((a, b) => b.t - a.t);
    let yy = y + 104;
    for (const f of feed) {
      if (yy > y + hh - 12) break;
      ctx.font = `26px ${FONT}`; ctx.fillStyle = '#64748b'; ctx.fillText(hhmm(f.t), x + 24, yy);
      ctx.fillStyle = f.c; ctx.font = `700 26px ${FONT}`; ctx.fillText(`${f.who} ${f.what}`, x + 120, yy);
      ctx.fillStyle = '#cbd5e1'; ctx.font = `26px ${FONT}`; ctx.fillText(clip(ctx, f.text, ww - 300), x + 280, yy);
      yy += 40;
    }
    if (!feed.length) { ctx.fillStyle = '#64748b'; ctx.font = `28px ${FONT}`; ctx.fillText('未有動作。', x + 24, yy); }
  }

  const CARDS = 8;
  function drawReviews(view) {
    const { ctx, w, h } = REVIEW, s = view.state;
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, w, h);
    const reviewed = s.trades.filter(t => s.reviews[t.id]).length;
    header(ctx, w, `覆盤牆 · 撳一單去覆盤 · 你覆咗 ${reviewed}/${s.trades.length}`, '#c084fc', 50);
    const trades = s.trades.slice(0, CARDS), cw = w / 4, chh = (h - 110) / 2;
    trades.forEach((t, i) => {
      const x = (i % 4) * cw + 14, y = 110 + Math.floor(i / 4) * chh + 8, cwi = cw - 28, chi = chh - 16;
      ctx.fillStyle = '#0d1426'; ctx.fillRect(x, y, cwi, chi);
      const g = t.grade?.letter ?? '?', gc = { A: '#34d399', B: '#a3e635', C: '#fbbf24', D: '#fb923c', F: '#f87171' }[g];
      ctx.fillStyle = gc; ctx.font = `800 120px ${FONT}`; ctx.fillText(g, x + 24, y + 130);
      ctx.fillStyle = '#e2e8f0'; ctx.font = `700 44px ${FONT}`; ctx.fillText(`${t.symbol.replace('USDT', '')} ${t.direction === 1 ? 'L' : 'S'}`, x + 150, y + 60);
      ctx.fillStyle = t.r >= 0 ? C.up : C.down; ctx.fillText(`${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`, x + 150, y + 115);
      ctx.fillStyle = '#94a3b8'; ctx.font = `30px ${FONT}`;
      ctx.fillText(clip(ctx, `${pat(t.plan.pattern.type)} · ${ex(t.reason)} · ${new Date(t.exitAt).toLocaleDateString('en-CA')} ${hhmm(t.exitAt)}`, cwi - 40), x + 24, y + 180);
      const rv = s.reviews[t.id];
      ctx.fillStyle = rv ? '#c084fc' : '#475569'; ctx.font = `600 32px ${FONT}`;
      ctx.fillText(rv ? `你畀 ${rv.grade ?? '—'} · ${rv.agree === false ? '唔同意' : '同意'}` : '未覆盤', x + 24, y + chi - 30);
    });
    if (!trades.length) { ctx.fillStyle = '#64748b'; ctx.font = `44px ${FONT}`; ctx.fillText('平咗倉嘅單會喺呢度出現，等你評分同覆盤。', 60, h / 2); }
    REVIEW.t.needsUpdate = true;
    REVIEW.ids = trades.map(t => t.id);
  }

  function drawRules(view) {
    const { ctx, w, h } = RULES, s = view.state;
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, w, h);
    header(ctx, w, 'Reviewer 規則 · Agent 通訊', '#34d399', 50);
    ctx.font = `600 36px ${FONT}`; ctx.fillStyle = '#e2e8f0'; ctx.fillText('生效規則（你批准咗）', 40, 160);
    let y = 215; ctx.font = `34px ${FONT}`;
    const base = [`扣埋手續費、滑價、funding 後 Net R:R ≥ ${s.cfg.minNetRR}`, `每單風險 ${s.cfg.riskPct}% · 最多 ${s.cfg.maxOpen} 個倉 · 點差 ≤ ${s.cfg.maxSpreadPct}%`, s.cfg.timeExitMin ? `${s.cfg.timeExitMin} 分鐘時間離場` : '冇時間離場：揸到 stop 或 target'];
    for (const r of base) { ctx.fillStyle = '#94a3b8'; ctx.fillText(`• ${r}`, 40, y); y += 50; }
    for (const r of s.rules.active) { ctx.fillStyle = '#34d399'; ctx.fillText(`✓ ${view.ruleLabel(r)}`, 40, y); y += 50; }
    y += 20; ctx.font = `600 36px ${FONT}`; ctx.fillStyle = '#e2e8f0'; ctx.fillText(`等你批嘅規則建議：${s.rules.proposals.length}`, 40, y); y += 55;
    ctx.font = `32px ${FONT}`;
    for (const p of s.rules.proposals.slice(0, 4)) { ctx.fillStyle = '#fbbf24'; ctx.fillText(clip(ctx, `? ${view.ruleLabel(p)} — ${p.evidence}`, w / 2 - 80), 40, y); y += 48; }
    const x = w / 2 + 20; y = 160;
    ctx.font = `600 36px ${FONT}`; ctx.fillStyle = '#e2e8f0'; ctx.fillText('Agent 通訊', x, y); y += 50;
    const colors = Object.fromEntries(DESKS.map(d => [d.id, hex(d.color)]));
    for (const e of (s.events ?? []).slice(0, 15)) {
      ctx.font = `28px ${FONT}`; ctx.fillStyle = '#64748b'; ctx.fillText(hhmm(e.t), x, y);
      ctx.fillStyle = colors[e.agent] ?? '#94a3b8'; ctx.font = `600 28px ${FONT}`; ctx.fillText(clip(ctx, evt(e.title), 230), x + 100, y);
      ctx.fillStyle = '#cbd5e1'; ctx.font = `28px ${FONT}`; ctx.fillText(clip(ctx, `${e.symbol?.replace('USDT', '') ?? ''} ${e.text}`, w / 2 - 400), x + 340, y);
      y += 44;
    }
    RULES.t.needsUpdate = true;
  }

  function drawMonitor(id, view) {
    const T = monitors[id], { ctx, w, h } = T, s = view.state, d = DESKS.find(x => x.id === id);
    ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, w, h);
    header(ctx, w, d.name, hex(d.color), 34);
    ctx.font = `26px ${FONT}`;
    let y = 110;
    const row = (a, b, color = '#cbd5e1') => { ctx.fillStyle = '#94a3b8'; ctx.fillText(clip(ctx, a, 520), 24, y); ctx.fillStyle = color; ctx.fillText(clip(ctx, b, 420), 560, y); y += 38; };
    if (id === 'screener') {
      const scans = Object.values(view.scanMap).sort((a, b) => (statusColor(b.status) !== '#475569') - (statusColor(a.status) !== '#475569'));
      for (const sc of scans.slice(0, 12)) row(sc.symbol.replace('USDT', ''), st(sc.status), statusColor(sc.status));
    } else if (id === 'trader') {
      row('淨值', money(s.acct.equity)); row('持倉 / 掛單', `${s.positions.length} / ${s.orders.length}`);
      row('已平倉', String(s.trades.length)); row('交易', s.cfg.on ? '開（paper）' : '關', s.cfg.on ? C.up : C.down);
      for (const p of s.positions.slice(0, 4)) row(`${p.symbol} ${p.direction === 1 ? 'L' : 'S'} ${p.qty}`, `${fmt(p.entry)} → ${fmt(p.mark)}`);
    } else if (id === 'smc') {
      const m = s.smc, pos = Object.entries(m?.acct?.pos ?? {}), tr = m?.trades ?? [], totR = tr.reduce((a, t) => a + t.r, 0);
      row('淨值', m?.equity != null ? money(m.equity) : '—'); row('持倉 · 已平倉', `${pos.length} · ${tr.length} (${totR >= 0 ? '+' : ''}${totR.toFixed(1)}R)`);
      row('交易', m?.on === false || !s.cfg.on ? '關' : '開（paper）', m?.on === false || !s.cfg.on ? C.down : C.up);
      if (m?.error) row('出錯', m.error, C.down);
      for (const [sym, p] of pos.slice(0, 2)) row(`${sym.replace('USDT', '')} ${p.side} ${p.tf}`, `${fmt(p.entry)} · SL ${fmt(p.stop)}`);
      for (const c of (m?.scan?.cands ?? []).slice(0, Math.max(0, 6 - pos.length))) row(`${c.b} ${c.side} ${c.tf}`, c.took ? '入咗' : rsn(c.skip), c.took ? C.up : '#94a3b8');
      if (!m?.scan?.cands?.length) row('冇 setup 喺 zone 入面', '');
    } else if (id === 'reviewer') {
      for (const dcs of (s.decisions ?? []).slice(0, 7)) row(`${dcs.symbol.replace('USDT', '')} ${hhmm(dcs.t)}`, `${dec(dcs.status)} · ${rsn(dcs.reason)}`, dcs.status === 'Approved' ? C.up : '#fbbf24');
      if (!s.decisions?.length) row('未有 proposal', '');
      y += 10; row('規則建議', String(s.rules.proposals.length), '#fbbf24');
    } else {
      const m = s.market, ex = m?.exposure;
      if (ex) {
        row('美股市況', `${rec(ex.recommendation)} · 上限 ${ex.ceiling}%`, ex.recommendation === 'NEW_ENTRY_ALLOWED' ? C.up : ex.recommendation === 'REDUCE_ONLY' ? '#fbbf24' : C.down);
        row('Breadth · uptrend', `${m.breadth ? `${m.breadth.composite} ${zone(m.breadth.zone)}` : 'n/a'} · ${m.uptrend ? `${m.uptrend.composite} ${zone(m.uptrend.zone)}` : 'n/a'}`);
        y += 6;
      }
      for (const it of (s.intel ?? []).slice(0, ex ? 8 : 11)) row(`${hhmm(it.t)} ${evt(it.type)}`, it.title.replace('USDT', ''), it.type === 'FLOW' ? '#34d399' : '#38bdf8');
      if (!s.intel?.length) row('成交好靜', '');
    }
    T.t.needsUpdate = true;
  }

  return {
    camera,
    get look() { return look; },
    get still() { return still; },
    get following() { return following(); },
    // Holding still freezes the offset; letting go rebases so the view does not jump to the cursor.
    setStill(v) { still = !!v; edge = 0; if (still) { offT.y = off.y; offT.p = off.p; } else rebase(lastPt && LOOK[look] ? offsetAt(lastPt) : { y: 0, p: 0 }); },
    setLook(v) {
      look = v in LOOK ? v : 'follow'; edge = 0;
      rebase(lastPt && LOOK[look] ? offsetAt(lastPt) : { y: 0, p: 0 });
      try { localStorage.setItem('asd_look', JSON.stringify(look)); } catch { /* storage blocked */ }
    },
    goTo: (id, panel) => { const sp = SPOTS[id]; if (sp) goTo(sp[0], sp[1], sp[2] - (panel && innerWidth > 900 ? 0.3 : 0)); },
    boardAt: uv => {
      const cy = (1 - uv.y) * BOARD.h, col = Math.min(PICK_COLS - 1, Math.floor(uv.x * PICK_COLS)), rowI = Math.floor((cy - PICK_TOP) / ((BOARD.h - PICK_TOP) / (BOARD.rows ?? 2)));
      return rowI < 0 ? null : BOARD.ids?.[rowI * PICK_COLS + col] ?? null;
    },
    // East wall click: the card's trader panel ('trader' / 'smc'), the feed → trader.
    positionsAt: uv => {
      const px = uv.x * POS.w, py = (1 - uv.y) * POS.h, areaW = POS.w - FEED_W - 40;
      if (py < LIVE_TOP) return null;
      if (px > POS.w - FEED_W - 10) return 'trader';
      return POS.cards?.[Math.floor((px - 20) / (areaW / LIVE_COLS))] ?? null;
    },
    reviewAt: uv => {
      const cy = (1 - uv.y) * REVIEW.h, col = Math.min(3, Math.floor(uv.x * 4)), rowI = Math.floor((cy - 110) / ((REVIEW.h - 110) / 2));
      return rowI < 0 || rowI > 1 ? null : REVIEW.ids?.[rowI * 4 + col] ?? null;
    },
    update(view) {
      drawBoard(view); drawPositions(view); drawReviews(view); drawRules(view);
      for (const d of DESKS) drawMonitor(d.id, view);
    },
  };
}
