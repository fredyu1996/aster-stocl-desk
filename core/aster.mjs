// Aster DEX public market data (Binance-style USDT-M futures API). Works in Node 22 and browsers.
import { MIN } from './pmr.mjs';

export const ASTER = 'https://fapi.asterdex.com';
export const HISTORY_MIN = 6000; // 100 hours of 1m bars: enough 1H bars for ATR and 80-bar pivots

export class AsterError extends Error {
  constructor(status, code, path) {
    super(`Aster request ${path} failed (HTTP ${status}${Number.isInteger(code) ? `, code ${code}` : ''}).`);
    Object.assign(this, { status, code });
  }
}

export async function asterGet(path, params = {}, { fetchImpl = globalThis.fetch, timeout = 10_000 } = {}) {
  const query = new URLSearchParams(params);
  const response = await fetchImpl(`${ASTER}${path}${query.size ? `?${query}` : ''}`, {
    signal: AbortSignal.timeout(timeout), referrerPolicy: 'no-referrer', redirect: 'error',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code < 0) throw new AsterError(response.status, body?.code, path);
  return body;
}

// Kline row → bar with t = close time (open + 1m). q = quote volume, tb = taker-buy quote volume.
export function klineBar(k) {
  const bar = { t: Number(k[0]) + MIN, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], tb: +k[10] };
  return Number(k[6]) + 1 === bar.t ? bar : null;
}

const tags = s => Array.isArray(s.underlyingSubType) ? s.underlyingSubType : [];
export const isStock = s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' &&
  tags(s).includes('STOCK') && !tags(s).includes('pre-launch');

export function specOf(s) {
  const f = type => s.filters.find(x => x.filterType === type) ?? {};
  return { symbol: s.symbol, base: s.baseAsset, name: s.name ?? s.baseAsset, tags: tags(s),
    tickSize: +f('PRICE_FILTER').tickSize || 0.01, stepSize: +f('LOT_SIZE').stepSize || 0.001,
    minQty: +f('LOT_SIZE').minQty || 0, minNotional: +f('MIN_NOTIONAL').notional || 5 };
}

// Universe: top stock perps by 24h quote volume (minimum volume), plus any symbol the account still holds.
export function pickUniverse(info, tickers, cfg, held = []) {
  const specs = new Map(info.symbols.filter(isStock).map(s => [s.symbol, specOf(s)]));
  const rows = tickers.filter(t => specs.has(t.symbol)).map(t => ({ symbol: t.symbol, last: +t.lastPrice, change: +t.priceChangePercent,
    quoteVolume: +t.quoteVolume, high: +t.highPrice, low: +t.lowPrice }));
  rows.sort((a, b) => b.quoteVolume - a.quoteVolume);
  const watch = rows.filter(r => r.quoteVolume >= cfg.minVolume && !cfg.exclude.includes(r.symbol)).slice(0, cfg.universe).map(r => r.symbol);
  for (const s of [...cfg.always, ...held]) if (specs.has(s) && !watch.includes(s)) watch.push(s);
  return { watch, board: rows, specs: Object.fromEntries(watch.map(s => [s, specs.get(s)])) };
}

// source 'trade' = traded klines; 'mark' = mark-price klines (Fred, 2026-11-26: the traded 1m klines of Aster stock perps are
// 36–97 % flat even in US hours; mark klines move every minute). Mark klines have zero volume.
export const BAR_SOURCES = ['mark', 'trade'];
const KLINES = { trade: '/fapi/v1/klines', mark: '/fapi/v1/markPriceKlines' };
export async function fetchBars(symbol, { since = 0, minutes = HISTORY_MIN, now = Date.now(), get = asterGet, source = 'trade' } = {}) {
  const lastClosed = Math.floor(now / MIN) * MIN; // close time of the latest fully completed minute
  const from = Math.max(since + 1, lastClosed - minutes * MIN);
  const bars = [];
  let start = from - MIN;
  for (let guard = 0; guard < 8 && start + MIN <= lastClosed; guard++) {
    const rows = await get(KLINES[source] ?? KLINES.trade, { symbol, interval: '1m', startTime: start, limit: 1500 });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const b = klineBar(r);
      if (b && b.t <= lastClosed && b.t > since) bars.push(b);
    }
    const next = Number(rows.at(-1)[0]) + MIN;
    if (rows.length < 1500 || next <= start) break;
    start = next;
  }
  const seen = new Set();
  return bars.filter(b => !seen.has(b.t) && seen.add(b.t)).sort((a, b) => a.t - b.t);
}

// One snapshot of everything a cycle needs. `cache` (browser) keeps bars between calls so only new minutes are fetched.
export async function loadMarket(cfg, held = [], { get = asterGet, now = Date.now(), cache } = {}) {
  const [info, tickers, books, premium] = await Promise.all([
    cache?.info && now - cache.infoAt < 3600_000 ? cache.info : get('/fapi/v1/exchangeInfo'),
    get('/fapi/v1/ticker/24hr'), get('/fapi/v1/ticker/bookTicker'), get('/fapi/v1/premiumIndex'),
  ]);
  if (cache && cache.info !== info) Object.assign(cache, { info, infoAt: now });
  const universe = pickUniverse(info, tickers, cfg, held);
  // Bars per source: the PMR Trader's (cfg.pmrSource), the SMC Trader's (cfg.smcSource), and traded klines always (intel).
  const pmrSource = cfg.pmrSource === 'mark' ? 'mark' : 'trade', smcSource = cfg.smcSource === 'mark' ? 'mark' : 'trade';
  const sources = [...new Set([pmrSource, smcSource, 'trade'])];
  const barsBy = Object.fromEntries(sources.map(s => [s, {}]));
  const queue = sources.flatMap(source => universe.watch.map(symbol => [source, symbol]));
  const worker = async () => {
    for (let job; (job = queue.shift());) {
      const [source, symbol] = job;
      const old = cache?.barsBy?.[source]?.[symbol] ?? [];
      const fresh = await fetchBars(symbol, { since: old.at(-1)?.t ?? 0, now, get, source });
      barsBy[source][symbol] = old.concat(fresh).filter(b => b.t > now - HISTORY_MIN * MIN - MIN);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (cache) cache.barsBy = barsBy;
  const bars = barsBy[pmrSource];
  const book = Object.fromEntries(books.filter(b => universe.specs[b.symbol]).map(b => [b.symbol, { bid: +b.bidPrice, ask: +b.askPrice, t: b.time }]));
  const funding = Object.fromEntries(premium.filter(p => universe.specs[p.symbol]).map(p => [p.symbol,
    { rate: +p.lastFundingRate, next: +p.nextFundingTime, mark: +p.markPrice }]));
  return { t: now, universe, bars, smcBars: barsBy[smcSource], tradeBars: barsBy.trade, pmrSource, smcSource, book, funding, info };
}

// Chart-only klines for the Picks wall. t = open time; `closed` is false for the forming candle.
// Never used for trading decisions: the scanner and paper fills only use completed 1m bars from fetchBars.
export const CHART_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
export async function chartBars(symbol, interval, { limit = 600, endTime, get = asterGet, now = Date.now(), source = 'trade' } = {}) {
  if (!CHART_INTERVALS.includes(interval)) throw new Error(`Unsupported chart interval ${interval}`);
  const rows = await get(KLINES[source] ?? KLINES.trade, { symbol, interval, limit: Math.min(1500, limit), ...(endTime ? { endTime } : {}) });
  return (Array.isArray(rows) ? rows : []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closed: +k[6] < now }))
    .filter(b => Number.isFinite(b.t) && [b.o, b.h, b.l, b.c].every(n => n > 0));
}
