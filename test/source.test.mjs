// Bar sources (Fred, 2026-11-26: 改用 mark price): the PMR Trader reads mark-price klines, the SMC Trader traded klines by
// default, and intel always reads traded klines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBars, loadMarket } from '../core/aster.mjs';
import { DEFAULT_CFG, freshState, normalize } from '../core/desk.mjs';

const MIN = 60_000, NOW = Date.UTC(2026, 10, 26, 15, 0, 30);
const kl = (t, px, vol) => [t, String(px), String(px + 1), String(px - 1), String(px), String(vol), t + MIN - 1, String(vol * px), 1, String(vol * px / 2), String(vol / 2), '0'];

function fakeGet(calls) {
  return async (p, q = {}) => {
    calls.push([p, q.symbol]);
    if (p.endsWith('exchangeInfo')) return { symbols: [{ symbol: 'NVDAUSDT', status: 'TRADING', quoteAsset: 'USDT', contractType: 'PERPETUAL', underlyingSubType: ['STOCK'], baseAsset: 'NVDA', filters: [] }] };
    if (p.endsWith('ticker/24hr')) return [{ symbol: 'NVDAUSDT', lastPrice: '100', priceChangePercent: '1', quoteVolume: '9000000', highPrice: '101', lowPrice: '99' }];
    if (p.endsWith('bookTicker') || p.endsWith('premiumIndex')) return [];
    const mark = p.endsWith('markPriceKlines'), end = Math.floor(NOW / MIN) * MIN;
    if (q.startTime > end - 10 * MIN) return [];
    return Array.from({ length: 10 }, (_, i) => kl(end - (10 - i) * MIN, mark ? 200 : 100, mark ? 0 : 5));
  };
}

test('fetchBars reads markPriceKlines for source mark, klines otherwise', async () => {
  const calls = [];
  const mark = await fetchBars('NVDAUSDT', { now: NOW, minutes: 10, get: fakeGet(calls), source: 'mark' });
  const trade = await fetchBars('NVDAUSDT', { now: NOW, minutes: 10, get: fakeGet(calls) });
  assert.ok(calls.some(([p]) => p === '/fapi/v1/markPriceKlines') && calls.some(([p]) => p === '/fapi/v1/klines'));
  assert.equal(mark[0].c, 200); assert.equal(mark[0].v, 0);
  assert.equal(trade[0].c, 100);
});

test('defaults: PMR on mark, SMC on traded klines; loadMarket loads both and keeps traded bars for intel', async () => {
  assert.equal(freshState().cfg.pmrSource, 'mark');
  assert.equal(freshState().cfg.smcSource, 'trade');
  const { pmrSource, smcSource, ...saved } = DEFAULT_CFG; // an account saved before sources existed
  assert.equal(normalize({ cfg: saved }).cfg.pmrSource, 'mark');
  const m = await loadMarket({ ...DEFAULT_CFG }, [], { get: fakeGet([]), now: NOW });
  assert.equal(m.pmrSource, 'mark'); assert.equal(m.smcSource, 'trade');
  assert.equal(m.bars.NVDAUSDT.at(-1).c, 200);
  assert.equal(m.smcBars.NVDAUSDT.at(-1).c, 100);
  assert.equal(m.tradeBars, m.smcBars);
  const t = await loadMarket({ ...DEFAULT_CFG, pmrSource: 'trade' }, [], { get: fakeGet([]), now: NOW });
  assert.equal(t.bars, t.tradeBars);
});
