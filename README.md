# Aster Stock Desk

喺 **Aster DEX 美股永續合約**（NVDA、TSLA、MU、CRCL、QQQ……）用 GMS PMR v1.4 做 paper trading 嘅可行走 3D 工作站。架構跟 Aster Desk：網頁 desk 由 GitHub Pages 提供，cloud trader 每 5 分鐘由 GitHub Actions 跑一次，共用 paper 帳戶存喺 private data repo。

**只係 paper trading。** 冇任何單會送去 Aster。冇 exchange key。

## 開啟

- **本機：** `node tools/serve.mjs`，開 http://127.0.0.1:4180 。冇設 sync 時，瀏覽器自己行 $1,000 嘅本機 paper 帳戶（存喺 localStorage）。
- **GitHub Pages：** repo Settings → Pages → Deploy from branch `main`、資料夾 `/`。開 `https://<user>.github.io/<repo>/`。部署後要 hard refresh。

| 操作 | 按鍵 |
| --- | --- |
| 行路 | W A S D／方向鍵，Shift 跑，滾輪向前 |
| 望 | 拖動滑鼠 |
| 4 個 desk | 1 Screener · 2 Trader · 3 Reviewer · 4 Market Intel |
| 牆 | B 北牆 picks wall · P 東牆持倉 · V 南牆 review wall · R 西牆規則同 agent comms |
| 設定 | 右上 ⚙ |

## 4 個 agent

| Agent | 工作 |
| --- | --- |
| Screener | 揀 24h 成交額最高嘅 10 隻股票永續（最少 300K USDT，`pre-launch` 除外，持倉中嘅一定保留）。等完整 1H 收線確認形態突破 → 新鮮、同突破有因果關係嘅 15m OB/FVG → 120 分鐘內首次回踩 → 45 分鐘內 5m MSS + displacement → FVG 中位入場（60 分鐘窗口）。 |
| Trader | 只接北牆 picks 入面嘅 proposal（⚙ 可以關）。收到批准就喺 FVG 中位掛 paper limit。只會用掛單之後先開始嘅 1m bar 成交。同一支 bar 同時掂止蝕同止賺先計止蝕。90 分鐘時間出場。 |
| Reviewer | 每個 proposal 核對：扣 taker fee、出場滑價同持倉期內 funding 之後 net R:R ≥ 2.0、spread、交易所最少數量／名義金額、持倉上限，同你批准咗嘅規則。平倉後評 A–F，列出 ✓/✗。 |
| Market Intel | Aster taker buy／sell 失衡同 5m 成交額異動（≥ 前 20 支 bar 平均 2.5 倍）。未有新聞來源。 |

## Picks wall（北牆，B）

Screener 每個 cycle 揀 6 隻心水（⚙ 可改）貼上北牆：持倉中嘅 → 你 pin 咗嘅 → PMR 行得最前嘅（QUALIFIED > LTF confirmed > POI touched > wait retest > wait POI > pattern confirmed）→ 24h 成交額。你 skip 咗嘅唔會上牆，除非仲有持倉。**Trader 只會接 picks 入面嘅 PMR proposal**，其他股出 proposal 會記做 `NOT_IN_PICKS`。

撳北牆（或者按 B）打開全螢幕 chart wall：

| 操作 | 方法 |
| --- | --- |
| 縮放／平移 | 滾輪縮放，拖動平移，Shift + 滾輪左右移，雙擊重設，＋／－ |
| 時框 | 每個圖 1m · 5m · 15m · 1h · 4h · 1d。拖到最左會自動載入更早嘅 K 線（最多 4,000 支） |
| 標記 | V 游標 · F FVG · O OB · M MSS · L Liquidity（BSL／SSL）· 1 HH · 2 HL · 3 LH · 4 LL · E 擦除 · B 轉 Bull／Bear · Ctrl+Z 復原 |
| 自動標 | A：喺揀咗嘅圖嘅可見範圍標 FVG 同 swing（淡色），再按一次清走 |
| PMR 層 | G：顯示／收埋 PMR 1H 突破線、目標、15m POI，同 Trader 嘅 limit／entry／SL／TP |
| 揀股 | 每個圖 ★ Pin／Skip；右邊可以 pin 其他掃描中或者打代號加 |

標記存喺 `state.marks`（有 sync 就寫返 data repo，所以 cloud 同其他瀏覽器都見到），北牆嘅縮圖都會畫出嚟。**標記只係你嘅筆記，唔會影響 Trader 落單。** Chart wall 嘅 K 線係直接攞 Aster klines，只用嚟睇；最後一支未收嘅 K 線會淡色顯示。Scanner 同 paper 成交照舊只用已完成嘅 1m bar。

## Reviewer 點樣學

- 某個 bucket（形態、方向、15m OB/FVG、A/A+、US 時段）有 ≥ 8 單、前後兩半都輸、總共 ≤ −3R，Reviewer 先會提出規則。
- 你喺南牆（V）撳交易卡寫 review：評級、同唔同意、「我會點做」chips、「邊part弱」chips、comment。有 3 份 review 講同一樣嘢（例如 skip + 15m OB/FVG），都會提出規則。
- **所有規則都只係 proposal。** 要你喺 Reviewer panel 撳 Approve 先生效，Reject 咗唔會再提。

## 帳戶規則（預設，⚙ 可改）

起始 $1,000。每單風險 1% equity。每單名義金額最多 1,000 USDT，總槓桿上限 10×。最多 3 個持倉＋掛單。Taker fee 0.04%／邊，出場滑價 0.05%。每個 symbol 同一時間得一單。冇每日虧損停機。

## Cloud trader

1. 開一個 **public** repo 放呢個 desk（Pages 同 Actions 免費），data 用 private repo（預設 `fredyu1996/aster-desk-data`，branch `stocks-state`，同 Aster Desk 嘅 `state` branch 分開）。
2. 喺 desk repo 加 secret `DATA_TOKEN`：fine-grained token，只限 data repo，Contents read/write。可以用 repo variable `DATA_REPO`、`DATA_BRANCH` 改位置。
3. GitHub 自己嘅 `*/5` cron 唔可靠。用 cron-job.org 每 5 分鐘 call `workflow_dispatch`（token 只需 Actions read/write，會過期）。workflow 內有 `*/10` 做後備。
4. 瀏覽器 ⚙ → Shared account 填同一個 data repo 同一個 token。之後 desk 會顯示 cloud 帳戶，review 同規則批准都寫返去 data repo。Token 只存喺嗰部瀏覽器。
5. Cloud 靜咗 30 分鐘以上，開住嘅瀏覽器會接手交易；最後一次瀏覽器 cycle 之後 30 分鐘，cloud 先會接返。

每次儲存係一個冇 parent 嘅 commit，force-update branch，所以 data repo 唔會越積越大。寫之前會重讀 ref，有衝突就重做。

## 指令

```bash
npm test                                                    # node --test，唔使網絡
STATE_OUT=/tmp/st.json node bot/run.mjs                     # 用真 Aster 價跑一次 cycle，唔使 token
STATE_IN=/tmp/st.json STATE_OUT=/tmp/st.json node bot/run.mjs
node tools/serve.mjs                                        # 本機 desk
```

喺有 HTTPS proxy 嘅環境，Node fetch 要加 `NODE_USE_ENV_PROXY=1`。

## 已知限制

- PMR v1.4 照寫好少出單。2026-11-23 掃 30 隻股票永續、100 小時：25 個 1H 形態確認，0 個完成入場。Aster Desk 喺 BTC/ETH 365 日回測都係得 2 單。冇樣本外驗證。
- 股票永續喺美股收市時都會交易，但流動性薄。Reviewer 有記錄每單係唔係 US 時段，數據夠先會提出「只做 US 時段」。
- Paper 成交用 1m OHLC，唔係逐筆，唔知道 bar 入面嘅次序。
- Funding 只係估計（開倉時嘅 rate × 跨過嘅 funding 時間）。
- 真倉執行未做。Market Floor 嘅 Binance executor 係 Binance 專用，未搬過嚟。
