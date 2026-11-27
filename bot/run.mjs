// Cloud trader: one cycle per run (GitHub Actions, every ~5 min).
// State comes from the private data repo (DATA_TOKEN, DATA_REPO, DATA_BRANCH) or local files (STATE_IN / STATE_OUT).
import { readFile, writeFile } from 'node:fs/promises';
import { loadMarket } from '../core/aster.mjs';
import { cycle, nearProposal, normalize, persistable } from '../core/desk.mjs';
import { LEARN_EVERY, fetchLearnSample } from '../core/learn.mjs';
import { loadNews } from '../core/news.mjs';
import { loadPosture } from '../core/regime.mjs';
import { smcCore, withSmc } from '../core/smc.mjs';
import { store, update } from '../core/github.mjs';

const env = process.env;
const now = Date.now();

function held(state) {
  // Held symbols and Fred's pinned picks are always scanned.
  return [...(state?.orders ?? []), ...(state?.positions ?? [])].map(x => x.symbol).concat(state?.pins ?? []);
}

function summary(state, ms) {
  return { t: now, ms, run: env.GITHUB_RUN_NUMBER ?? null, equity: state.acct.equity, open: state.positions.length,
    pending: state.orders.length, trades: state.trades.length, watch: state.lastCycle.watch,
    smc: state.smc ? { equity: state.smc.equity ?? null, open: Object.keys(state.smc.acct?.pos ?? {}).length, trades: state.smc.trades.length, error: state.smc.error ?? null } : null };
}

async function step(prev) {
  const base = normalize(prev);
  // A browser that is trading (it cycles every 60 s) keeps the desk; once it has been silent for 5 min (page closed,
  // laptop asleep) the cloud takes over. "Hand back to the cloud" (by: 'handback') lets the cloud run at once.
  if (base.lastCycle?.by === 'browser' && now - base.lastCycle.t < 5 * 60_000 && !env.FORCE) return null;
  const ua = base.cfg.secUserAgent || env.SEC_USER_AGENT || '';
  const market = await loadMarket(base.cfg, held(base), { now, near: nearProposal(base), newsLoader: s => loadNews(s, { userAgent: ua, now }) });
  // The Reviewer's learning sample (nightly backtest trades) is re-read every 6 h.
  if (!(now - (base.learn?.at ?? 0) < LEARN_EVERY)) market.learn = await fetchLearnSample(env.GITHUB_REPOSITORY || 'fredyu1996/aster-stocl-desk', { now }).catch(e => { console.error('learn sample:', e.message); return null; });
  // Market posture (breadth + uptrend CSVs) changes at most twice a day: refresh hourly.
  if (!(now - (base.market?.at ?? 0) < 60 * 60_000)) market.posture = await loadPosture({ at: now }).catch(e => ({ at: now, errors: [e.message] }));
  const core = await smcCore(market.info).catch(e => { console.error('SMC core:', e.message); return null; });
  const next = withSmc(cycle(base, market, { now, by: 'cloud' }), market, core, { now });
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
