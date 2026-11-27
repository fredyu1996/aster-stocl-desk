// News / earnings tags (Fred, 2026-11-27). Idea from Jakeschincariol/day-trader-skill `trader-news` (MIT): Yahoo Finance
// headlines per ticker plus the company's 8-K filings on SEC EDGAR (item 2.02 = results of operations = earnings).
// Record only: each PMR proposal gets `plan.news` = { tag, earn, items } for the Reviewer to learn from.
//   tag  'earnings' (an earnings headline or 8-K 2.02 in the 24 h before the signal) | 'news' (other headlines) | 'quiet' | 'unknown'
//   earn 'yes' | 'no' (from SEC filings, history available) | 'unknown' (no SEC User-Agent set, or not a US ticker)
// SEC asks automated clients to identify themselves: the User-Agent comes from cfg.secUserAgent (Fred fills it in
// Settings) or the SEC_USER_AGENT env var. Without it SEC is skipped. Aster symbols map to US tickers by dropping USDT;
// non-US underlyings (SKHYNIX, SAMSUNG, TENCENT…) return 'unknown'.

const HOUR = 3600_000;
export const tickerOf = symbol => { const t = String(symbol).replace(/USDT$/, ''); return /^[A-Z]{1,5}$/.test(t) ? t : null; };
const EARN = /\b(earnings|results|quarter(ly)?|q[1-4]\b|guidance|eps|revenue|profit|outlook)\b/i;

// Yahoo RSS → [{ t, title }]
export function parseRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = (m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) ?? [])[1]?.trim();
    const date = Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1] ?? '');
    if (title && Number.isFinite(date)) out.push({ t: date, title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') });
  }
  return out;
}
// SEC submissions JSON → 8-K filings [{ t, items }]
export function parseFilings(json) {
  const r = json?.filings?.recent;
  if (!r?.form) return [];
  return r.form.map((f, i) => ({ form: f, t: Date.parse(r.acceptanceDateTime?.[i] ?? r.filingDate?.[i]), items: String(r.items?.[i] ?? '') }))
    .filter(x => x.form === '8-K' && Number.isFinite(x.t)).map(({ t, items }) => ({ t, items }));
}

// Tag one signal time from what was loaded for its symbol. Only items at or before the signal count.
export function newsTag(src, at) {
  if (!src) return { tag: 'unknown', earn: 'unknown', items: [] };
  const win = x => x.t <= at && x.t > at - 24 * HOUR;
  const heads = (src.headlines ?? []).filter(win);
  const filings = src.filings ? src.filings.filter(x => x.t <= at && x.t > at - 36 * HOUR) : null;
  const earnFiling = filings?.some(f => f.items.split(',').map(s => s.trim()).includes('2.02'));
  const earnHead = heads.some(h => EARN.test(h.title));
  const tag = !src.headlines && !src.filings ? 'unknown' : earnFiling || earnHead ? 'earnings' : heads.length ? 'news' : 'quiet';
  return { tag, earn: filings ? (earnFiling ? 'yes' : 'no') : 'unknown', items: heads.slice(0, 5).map(h => ({ t: h.t, title: h.title.slice(0, 140) })) };
}

// Load headlines (and filings when a User-Agent is set) for one Aster symbol. Never throws; errors come back in `err`.
const cikCache = { at: 0, map: null };
export async function loadNews(symbol, { userAgent = '', fetchFn = fetch, now = Date.now() } = {}) {
  const ticker = tickerOf(symbol);
  if (!ticker) return null;
  const out = { at: now, ticker, headlines: null, filings: null, err: [] };
  try {
    const r = await fetchFn(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Yahoo ${r.status}`);
    out.headlines = parseRss(await r.text());
  } catch (e) { out.err.push(e.message); }
  if (userAgent) {
    try {
      const h = { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(20_000) };
      if (!cikCache.map || now - cikCache.at > 24 * HOUR) {
        const r = await fetchFn('https://www.sec.gov/files/company_tickers.json', h);
        if (!r.ok) throw new Error(`SEC tickers ${r.status}`);
        cikCache.map = Object.fromEntries(Object.values(await r.json()).map(x => [x.ticker, x.cik_str])); cikCache.at = now;
      }
      const cik = cikCache.map[ticker];
      if (cik) {
        const r = await fetchFn(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, h);
        if (!r.ok) throw new Error(`SEC ${r.status}`);
        out.filings = parseFilings(await r.json());
      }
    } catch (e) { out.err.push(e.message); }
  }
  return out;
}
