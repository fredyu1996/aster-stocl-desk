// Time Machine (Fred, 2026-11-27): before a PMR proposal is decided, replay the rest of the trade thousands of times from
// the symbol's own recent 5m bars and report the odds of target first vs stop first. Method adapted from
// Jakeschincariol/day-trader-skill `trader-timemachine` (MIT): bootstrap bars from the same time of day (± 2 bars), scale
// each to the current price, check the stop before the target in every bar, seeded PRNG so a result repeats. Differences:
// Aster perps trade 24 h, so the day has 288 five-minute slots and the replay runs `horizonBars` (default 24 h) instead of
// stopping at the US close; it works on the desk's own bars (mark or traded) and never touches the network.
// Record only: the result is stored on the plan (`plan.tm`) and is a feature the Reviewer can learn from.

const M5 = 5 * 60_000, SLOTS = 288, DAY = 864e5;

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const slotOf = t => Math.floor(((t - M5) % DAY) / M5); // 5m bar with close time t → slot of its open time (0..287)

// Pool of bar shapes per slot: open / high / low / close as ratios to the previous close. Only consecutive bars count.
export function buildPool(bars5, { from = -Infinity, to = Infinity } = {}) {
  const pool = Array.from({ length: SLOTS }, () => []);
  const days = new Set();
  for (let i = 1; i < bars5.length; i++) {
    const b = bars5[i], p = bars5[i - 1];
    if (b.t <= from || b.t > to || b.t - p.t !== M5 || !(p.c > 0)) continue;
    pool[slotOf(b.t)].push([b.o / p.c, b.h / p.c, b.l / p.c, b.c / p.c]);
    days.add(Math.floor(b.t / DAY));
  }
  return { pool, days: days.size };
}

// Odds for one plan. bars5 = completed 5m bars (t = close time) of the symbol, any length; only bars at or before the
// signal and within `lookbackDays` are used. Returns null when there are fewer than `minDays` days of bars.
export function timeMachine(plan, bars5, { n = 10_000, seed = 19, horizonBars = 288, lookbackDays = 60, minDays = 20 } = {}) {
  const at = plan.signalAt;
  const { pool, days } = buildPool(bars5, { from: at - lookbackDays * DAY, to: at });
  if (days < minDays) return null;
  const d = plan.direction, entry = plan.entry, risk = Math.abs(entry - plan.stop), reward = Math.abs(plan.target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const R = reward / risk, rand = rng(seed), start = slotOf(Math.floor(at / M5) * M5 + M5);
  let tFirst = 0, sFirst = 0, sumR = 0;
  for (let k = 0; k < n; k++) {
    let px = entry, out = null;
    for (let j = 0; j < horizonBars && out === null; j++) {
      const s = (start + j) % SLOTS;
      // a random shape from the same time of day ± 2 bars
      let shape = null;
      for (let tries = 0; tries < 6 && !shape; tries++) { const list = pool[(s + Math.floor(rand() * 5) - 2 + SLOTS) % SLOTS]; if (list.length) shape = list[Math.floor(rand() * list.length)]; }
      if (!shape) continue;
      const hi = px * shape[1], lo = px * shape[2];
      if (d === 1 ? lo <= plan.stop : hi >= plan.stop) out = -1;
      else if (d === 1 ? hi >= plan.target : lo <= plan.target) out = R;
      px *= shape[3];
    }
    if (out === -1) sFirst++; else if (out === R) tFirst++;
    sumR += out ?? d * (px - entry) / risk;
  }
  const hit = tFirst + sFirst, share = hit ? tFirst / hit : null, breakeven = 1 / (1 + R);
  const lean = share == null ? null : share - breakeven;
  const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
  return { pT: r3(tFirst / n), pS: r3(sFirst / n), pN: r3((n - hit) / n), avgR: r3(sumR / n), share: r3(share), breakeven: r3(breakeven), lean: r3(lean),
    tag: lean == null ? 'unknown' : lean >= 0.05 ? 'favour' : lean <= -0.05 ? 'against' : 'even', days, n, seed, horizonH: horizonBars * 5 / 60 };
}
