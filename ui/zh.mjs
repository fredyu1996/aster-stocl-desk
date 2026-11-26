// 中文 labels for the desk (Fred, 2026-11-26: 成個板面變做中文). Core state keeps its English codes; the UI translates
// them here at display time. Trading terms (OB, FVG, MSS, POI, R, long / short, stop, target) stay in English.

export const STATUS = {
  WAIT: '等緊', PATTERN_CONFIRMED: '1H 形態確認', WAIT_POI: '搵緊 15m POI', WAIT_RETEST: '等回測', POI_TOUCHED: '回測咗 POI',
  LTF_CONFIRMED: '5m MSS 確認', QUALIFIED: '有 proposal', SKIPPED: '跳過', EXPIRED: '過期', CANCELLED: '取消',
};
export const st = s => STATUS[s] ?? String(s ?? '').replaceAll('_', ' ');

export const PATTERN = { FLAG: 'Flag 旗形', TRIANGLE: '三角形', DOUBLE_TOP: '雙頂', DOUBLE_BOTTOM: '雙底', HNS: '頭肩頂', INVERSE_HNS: '倒頭肩' };
export const pat = p => PATTERN[p] ?? String(p ?? '').replaceAll('_', ' ');

const REASON = {
  ENTRY_WINDOW_PASSED: '入場時間窗已過', '1H_CLOSE_BACK_INSIDE': '1H 收返入 boundary', PARENT_POI_INVALIDATED: '15m POI 被打穿',
  CONFIRMED_1H_BREAKOUT: '1H 突破確認', SEARCH_CAUSAL_15M_ZONE: '搵緊突破帶出嘅 15m zone', NO_FRESH_CAUSAL_POI: '時限內冇新鮮 15m POI',
  EXPIRED_NO_TOUCH: '時限內冇回測', FIRST_PARENT_RETEST: '第一次回測 POI', NO_LTF_CONFIRMATION: '時限內冇 5m MSS',
  NO_ASSOCIATED_FVG: 'displacement 冇留低 FVG', FRESH_CAUSAL_15M_POI: '新鮮 15m POI', '5M_MSS_DISPLACEMENT': '5m MSS + displacement',
  INVALID_PERPETUAL_PLAN: 'entry / stop / target 唔成立', PROPOSAL: 'Proposal', TRADING_OFF: '交易已關', NOT_IN_PICKS: '唔喺 picks',
  ALREADY_IN_SYMBOL: '呢隻已經有倉', MAX_OPEN_POSITIONS: '到咗持倉上限', SIZE_BELOW_EXCHANGE_MINIMUM: 'size 低過交易所下限', APPROVED: '批准',
  NO_DATA: '冇數據',
};
// A decline / scanner reason: exact codes first, then the coded prefixes core writes (NET_RR, SPREAD, RULE, MARK).
export function rsn(r) {
  const s = String(r ?? '');
  if (REASON[s]) return REASON[s];
  if (s.startsWith('SPREAD')) return s.replace('SPREAD', '點差');
  if (s.startsWith('RULE · ')) return `規則 · ${s.slice(7)}`;
  if (s.startsWith('MARK · your')) return `你嘅標記 · ${s.slice(12).replace(/ is against this (long|short)/, ' 同呢單 $1 對頭')}`;
  if (s.startsWith('MARK · entry')) return `你嘅標記 · entry ${s.slice(13).replace(/ is inside your /, ' 喺你嘅 ').replace(/$/, ' 入面')}`;
  return s.replaceAll('_', ' ');
}

export const EXIT = { Stop: '止蝕', Target: '止賺', 'Time exit': '時間離場', 'No fill': '冇成交' };
export const ex = r => EXIT[r] ?? r ?? '';
export const DECISION = { Approved: '批准', Declined: '拒絕', Entered: '入咗' };
export const dec = s => DECISION[s] ?? s ?? '';
export const EVENT = { CLOSED: '平倉', 'NO FILL': '冇成交', FILLED: '成交', PROPOSAL: 'Proposal', DECLINED: '拒絕', APPROVED: '批准', VOLUME: '成交量', FLOW: '資金流' };
export const evt = s => EVENT[s] ?? String(s ?? '').replace(/^GRADE /, '評分 ');
export const side = d => (d === 1 || d === 'L' ? 'Long' : 'Short');

export const REC = { NEW_ENTRY_ALLOWED: '可以開新倉', REDUCE_ONLY: '只減唔加', CASH_PRIORITY: '現金優先' };
export const rec = r => REC[r] ?? String(r ?? '—').replaceAll('_', ' ');
export const ZONE = { Strong: '強', Healthy: '健康', Neutral: '中性', Weakening: '轉弱', Critical: '危險', 'Strong Bull': '強牛', Bull: '牛', Bear: '熊', 'Strong Bear': '強熊' };
export const zone = z => ZONE[z] ?? z ?? '';
export const LEVEL = { BROAD: '廣泛', MODERATE: '一般', NARROW: '狹窄', HIGH: '高', MEDIUM: '中', LOW: '低' };
export const lvl = v => LEVEL[v] ?? v ?? '—';
export const VERDICT = { NO_TRADES: '未有交易', COOL_DOWN: '冷靜期', REVIEW_REQUIRED: '要覆盤', WARN: '留意', OK: 'OK' };
export const verdict = v => VERDICT[v] ?? String(v ?? '').replaceAll('_', ' ');
export const OUTCOME = { MISSED_OPPORTUNITY: '錯過機會', GOOD_SKIP: '避得好', NEUTRAL: '中性', NO_DATA: '冇數據', FALSE_POSITIVE: '假訊號',
  FALSE_POSITIVE_SEVERE: '假訊號（嚴重）', REGIME_MISMATCH: '市況轉咗', TRUE_POSITIVE: '真訊號' };
export const outcome = o => OUTCOME[o] ?? (o ? String(o).replaceAll('_', ' ') : '等緊');
export const SEVERITY = { critical: '嚴重', warning: '警告', info: '提示' };
export const AXIS = { risk: '風險', execution: '執行', process: '流程', regime: '市況' };
export const ROOT = { risk_sizing: '風險 / 注碼', execution: '執行', market_environment: '市況', thesis_quality: '論點質素', randomness: '隨機' };
export const FIELD = { pattern: '1H 形態', side: '方向', poi: '15m POI', grade: 'Setup 級別', session: '時段', marks: '你嘅標記' };
export const FILTER = { 'Your MSS mark': '你嘅 MSS 標記', 'Your FVG / OB mark': '你嘅 FVG / OB 標記', 'Your marks': '你嘅標記', 'Approved rule': '你批咗嘅規則',
  'Net R:R < min': 'Net R:R 唔夠', Spread: '點差', 'Not in picks': '唔喺 picks', 'Max open': '持倉上限', 'Already in symbol': '已經有倉',
  'Size minimum': 'Size 下限', 'Trading off': '交易已關' };
export const filt = f => FILTER[f] ?? f;

// Grade items saved on trades before 2026-11-26 are English; newer ones come from core in Chinese.
const ITEM = [[/^Liquidity sweep at the retest$/, '回測時有 liquidity sweep'], [/^15m OB\/FVG confluence$/, '15m OB / FVG 重疊'],
  [/^Net R:R ([\d.-]+) \(≥ 3 is strong\)$/, 'Net R:R $1（≥ 3 算強）'], [/^Filled within 15 min of the signal$/, '訊號後 15 分鐘內成交'],
  [/^Signal during US regular hours$/, '訊號喺美股正常交易時段'], [/^Hit one of your same-direction FVG \/ OB marks$/, '中咗你同方向嘅 FVG / OB 標記'],
  [/^Time exit at a loss: no follow-through$/, '時間離場又蝕：冇 follow-through']];
export function item(t) { for (const [re, zh] of ITEM) if (re.test(t)) return t.replace(re, zh); return t; }

export const date = t => new Date(t).toLocaleDateString('en-CA');
