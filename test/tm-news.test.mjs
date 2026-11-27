// Time Machine (core/timemachine.mjs) and news / earnings tags (core/news.mjs), Fred 2026-11-27.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, timeMachine } from '../core/timemachine.mjs';
import { newsTag, parseFilings, parseRss, tickerOf } from '../core/news.mjs';

const M5 = 5 * 60_000, DAY = 864e5, T = Date.UTC(2026, 9, 1);

// 30 days of 5m bars: a seeded random walk, symmetric, or with an up drift.
function walk(days, drift = 0, seed = 3) {
  let a = seed, x = 100;
  const rnd = () => (a = (a * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 1; i <= days * 288; i++) {
    const o = x; x = x * (1 + drift + (rnd() - 0.5) * 0.004);
    out.push({ t: T + i * M5, o, h: Math.max(o, x) * 1.0005, l: Math.min(o, x) * 0.9995, c: x });
  }
  return out;
}
const planAt = (bars, over = {}) => { const last = bars.at(-1); return { signalAt: last.t, direction: 1, entry: last.c, stop: last.c * 0.99, target: last.c * 1.01, ...over }; };

test('time machine: symmetric walk at 1R is close to a coin flip; seeded and repeatable', () => {
  const bars = walk(30);
  const a = timeMachine(planAt(bars), bars, { n: 3000 }), b = timeMachine(planAt(bars), bars, { n: 3000 });
  assert.deepEqual(a, b);
  assert.equal(a.breakeven, 0.5);
  assert.ok(Math.abs(a.share - 0.5) < 0.08, `share ${a.share}`);
  assert.ok(a.pT + a.pS + a.pN > 0.99 && a.pT + a.pS + a.pN < 1.01);
  assert.equal(a.days >= 20, true);
});

test('time machine: an up-drifting pool favours a long target and goes against a short', () => {
  const bars = walk(30, 0.0002);
  const long = timeMachine(planAt(bars), bars, { n: 2000 });
  const last = bars.at(-1).c, short = timeMachine(planAt(bars, { direction: -1, stop: last * 1.01, target: last * 0.99 }), bars, { n: 2000 });
  assert.equal(long.tag, 'favour');
  assert.equal(short.tag, 'against');
});

test('time machine: only bars at or before the signal count, and too little history gives null', () => {
  const bars = walk(30), mid = bars[Math.floor(bars.length / 2)];
  assert.equal(timeMachine(planAt(bars, { signalAt: mid.t }), bars), null); // only 15 days before mid
  assert.equal(buildPool(bars, { to: bars[288 * 2].t }).days, 3);
});

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Nvidia Q3 earnings beat; guidance strong</title><pubDate>Wed, 19 Nov 2026 21:10:00 +0000</pubDate></item>
<item><title><![CDATA[Nvidia & partners unveil chip]]></title><pubDate>Thu, 20 Nov 2026 14:00:00 +0000</pubDate></item>
<item><title>Old story</title><pubDate>Mon, 10 Nov 2026 14:00:00 +0000</pubDate></item>
</channel></rss>`;

test('news: RSS parsing, earnings vs news vs quiet, only items before the signal', () => {
  const heads = parseRss(RSS);
  assert.equal(heads.length, 3);
  assert.equal(heads[1].title, 'Nvidia & partners unveil chip');
  assert.equal(newsTag({ headlines: heads }, Date.parse('2026-11-20T10:00:00Z')).tag, 'earnings');
  assert.equal(newsTag({ headlines: heads }, Date.parse('2026-11-20T23:00:00Z')).tag, 'news');
  assert.equal(newsTag({ headlines: heads }, Date.parse('2026-11-25T12:00:00Z')).tag, 'quiet');
  assert.equal(newsTag({ headlines: heads }, Date.parse('2026-11-19T20:00:00Z')).tag, 'quiet'); // the earnings item came later
  assert.equal(newsTag(null, 0).tag, 'unknown');
  assert.equal(newsTag({ headlines: heads }, 0).earn, 'unknown');
});

test('news: SEC 8-K item 2.02 marks earnings; tickers map from Aster symbols', () => {
  const filings = parseFilings({ filings: { recent: { form: ['8-K', '10-Q', '8-K'], acceptanceDateTime: ['2026-11-19T21:05:00.000Z', '2026-11-19T21:00:00.000Z', '2026-10-01T12:00:00.000Z'],
    items: ['2.02,9.01', '', '5.02'] } } });
  assert.equal(filings.length, 2);
  const at = Date.parse('2026-11-20T15:00:00Z');
  assert.deepEqual([newsTag({ headlines: [], filings }, at).earn, newsTag({ headlines: [], filings }, at).tag], ['yes', 'earnings']);
  assert.equal(newsTag({ headlines: [], filings }, Date.parse('2026-11-25T15:00:00Z')).earn, 'no');
  assert.equal(tickerOf('NVDAUSDT'), 'NVDA');
  assert.equal(tickerOf('SKHYNIXUSDT'), null);
});
