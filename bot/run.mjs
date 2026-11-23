// Cloud trader: one cycle per run (GitHub Actions, every ~5 min).
// State comes from the private data repo (DATA_TOKEN, DATA_REPO, DATA_BRANCH) or local files (STATE_IN / STATE_OUT).
import { readFile, writeFile } from 'node:fs/promises';
import { loadMarket } from '../core/aster.mjs';
import { cycle, normalize, persistable } from '../core/desk.mjs';
import { store, update } from '../core/github.mjs';

const env = process.env;
const now = Date.now();

function held(state) {
  return [...(state?.orders ?? []), ...(state?.positions ?? [])].map(x => x.symbol);
}

function summary(state, ms) {
  return { t: now, ms, run: env.GITHUB_RUN_NUMBER ?? null, equity: state.acct.equity, open: state.positions.length,
    pending: state.orders.length, trades: state.trades.length, watch: state.lastCycle.watch };
}

async function step(prev) {
  const base = normalize(prev);
  // A browser that took over within the last 30 minutes keeps trading; the cloud steps aside.
  if (base.lastCycle?.by === 'browser' && now - base.lastCycle.t < 30 * 60_000 && !env.FORCE) return null;
  const market = await loadMarket(base.cfg, held(base), { now });
  const next = cycle(base, market, { now, by: 'cloud' });
  next.cloud = summary(next, Date.now() - now);
  return persistable(next);
}

if (env.STATE_IN || env.STATE_OUT) {
  const prev = env.STATE_IN ? JSON.parse(await readFile(env.STATE_IN, 'utf8').catch(() => '{}')) : {};
  const next = await step(prev);
  if (env.STATE_OUT && next) await writeFile(env.STATE_OUT, JSON.stringify(next, null, 1));
  console.log(next ? JSON.stringify(next.cloud) : 'browser holds the desk; skipped');
} else {
  if (!env.DATA_TOKEN) throw new Error('Set DATA_TOKEN (fine-grained token, Contents read/write on the data repo only).');
  const st = store({ token: env.DATA_TOKEN, repo: env.DATA_REPO || 'fredyu1996/aster-desk-data', branch: env.DATA_BRANCH || 'stocks-state' });
  const { state, skipped } = await update(st, step);
  console.log(skipped ? 'browser holds the desk; skipped' : JSON.stringify(state.cloud));
}
