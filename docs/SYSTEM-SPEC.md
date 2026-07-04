# MenuBot 系統需求與規格架構

> 本文件由開發全程的 18 份 design specs、16 份 implementation plans、SDD ledger、
> 專案記憶與 as-built 程式碼**反向整理**而成,是系統的單一綜覽文件。
> 個別功能的完整設計細節仍以 `docs/superpowers/specs/` 為準。
> 基準版本:main `60e692f`(2026-07-04)。199 tests 全綠。

---

## 1. 產品願景與核心需求

**MenuBot**:把餐廳菜單(照片/PDF,透過 Telegram 傳送)自動數位化為**英中對照、
可分享的手機版菜單網頁**,服務看不懂外語菜單的旅客(以台灣使用者為第一優先)。

核心需求(由各 spec 的 user requirement 歸納):

| # | 需求 | 落地 |
|---|---|---|
| R1 | 一份實體菜單(不限張數/PDF)→ 恰好一個發佈連結 | 使用者按鈕驅動批次(P1) |
| R2 | 連結揭露瞬間必須已 live,零等待零 404 | Cloudflare Worker + R2 |
| R3 | 翻譯採台灣最佳用語,且**同詞永遠同譯**(deterministic) | B1 regional + B2 lexicon |
| R4 | 看不懂的品項要有濃縮雙語美食文化解說(💡),同詞只解釋一次 | SQLite glossary cache |
| R5 | 大菜單要有二層分類導覽(大類 → 子類,含品項數) | L1 chips + L2 popup |
| R6 | 價格正確性 > 一切(寧可誠實失敗,不可錯價誤導) | complex→single 路由鐵律 |
| R7 | 可過濾:飲食/過敏原/招牌⭐/人氣🔥/特色💡 | 動態 tag 系統 |
| R8 | 事後可取回原始檔比對(單人私用) | VPS archive + 隱藏 /vault |
| R9 | 成本透明、計費呼叫有紀律 | token/成本顯示、WEB_ENRICH 預設關 |

---

## 2. 系統架構總覽

```
Telegram 使用者
   │ 照片/PDF + hint(店名/Google Maps 連結)
   ▼
┌─ VPS(Hetzner,systemd: menubot.service,grammy 長輪詢)─────────────┐
│  bot.ts 收批狀態機 → processBatch 管線                              │
│    ├─ Claude API(claude-sonnet-5):extract / explain / web-tools   │
│    ├─ SQLite(node:sqlite,data/glossary.db):                      │
│    │    glossary(💡快取)· alias · regional_variant(B1)· lexicon(B2)│
│    ├─ 檔案系統:data/originals(原始檔封存,git-ignored)             │
│    └─ templates/menu.html → 自含 HTML                               │
│         │ PUT (Bearer PUBLISH_SECRET)                               │
└─────────┼───────────────────────────────────────────────────────────┘
          ▼
   Cloudflare Worker(menubot-menus)+ R2 bucket
   GET 公開 · 強一致 · immutable cache
   https://menubot-menus.brianforest.workers.dev/m/<slug>/
```

- 每次發佈產生新 slug(`slugify(名稱)-<時間戳36進位>`),**永不覆蓋舊菜單**;
  舊 github.io 連結由 GitHub Pages 繼續服務(不 migration)。
- 模型:`claude-sonnet-5`(2026-07-02 起;經最壞案例 A/B 驗證後由 4.6 升級)。

---

## 3. 使用者旅程

1. `/start` → 說明:傳整本菜單(多張照片/PDF),**強烈建議**貼 Google Maps 連結
   (據此判斷菜系/地區/幣別/官方店名)。
2. 傳照片/PDF(可混批)→ bot 收批;傳文字 → 記為 hint。
3. 按 **✅ 完成並產生菜單** → 管線啟動(回報「約 2–5 分鐘」;複雜菜單另預警
   「版面較複雜…約需 3–4 分鐘」)。30 分鐘無活動僅過期提醒,**永不自動處理**。
4. 完成 → 回覆發佈連結(即時 live)+ 分類/品項/特色詞計數;
   (DEBUG_TIMING=on 時另附 ⏱️ 逐階段耗時 + `N tokens (模型名)` + `$成本`)。
5. 事後驗證:`/vault <url|slug>` 取回原始檔(Telegram document 原檔畫質)。

**發佈頁功能**(自含 HTML,無外部依賴):雙語/中文/EN 切換 · L1 分類 chip(置頂
橫滑)· L2 彈出選單(含品項數,選後跳段)· 鹹食小類直達 chip · 飲食/招牌/人氣/
特色 AND 過濾 · 💡 解說彈窗(含羅馬拼音)· 幣別前綴價格 · 選項群組(選一/內含/
加點)· 菜品縮圖(WEB_ENRICH 時)· 跳轉錨點自動避開置頂列 · 回頂按鈕。

---

## 4. 處理管線規格(as-built)

`processBatch` 精確順序(`[timing]` 記錄重量級階段;標 ⓑ 者為 best-effort,
失敗只 log、絕不阻擋發佈):

```
resetUsage
→ download(並行;任一失敗→中止要求重傳,不發佈殘缺菜單;總量 >20MB 中止)
→ buildContext ⓑ(hint → Google Maps 短連結 HTTP redirect 解析官方店名/地址)
→ extract(adaptive 路由,見 §5;含 L1/tier/L2 分類;onRoute 複雜預警)
→ pre-enrich 正規化 ⓑ(B1 regional → B2 lexicon;讓解說生成看到 canonical 名)
→ enrich ⓑ(glossary-first 💡:cache hit 零成本,miss 才呼叫 LLM 並回存)
→ tagNotable(💡 品項 → notable 標籤;純函式)
→ [WEB_ENRICH=on 才跑] tagPopular ⓑ(一次 web_search → 🔥)→ addImages ⓑ(菜品圖)
→ post-enrich 正規化 ⓑ(B1 → B2 再跑一次;連快取解說文字也正規化)
→ renderMenu(注入 MENU/TAGS/NAV/CUR JSON → 自含 HTML)
→ saveOriginals ⓑ(VPS 封存)
→ publishMenu(PUT Worker → 即時 live)
→ 回覆連結 + [timing] log(含 token/成本)
```

正規化前後各跑一次的原因:前跑使 explain 生成拿到 canonical 名稱(解說「天生
一致」);後跑修補快取解說內的變體拼法。B1/B2 為純函式、零 API、冪等,重複執行免費。

---

## 5. Extract 路由規格

**鐵律:複雜版面 → single(整本一次讀,價格對齊靠全域脈絡);簡單版面 → parallel
(省時)。** 起源:Terrace 菜單的浮動價格欄在 per-section workers 下錯位/生幻影
品項 → 明文否決三種變形(大菜單強制 parallel、截斷後 reactive fallback parallel、
section 數門檻)。

```
EXTRACT_MODE(預設 single;production 用 adaptive)
├ single    → extractMenuSingle(整本)
├ parallel  → 兩階段;任何錯誤 fallback single
└ adaptive  → outline 先行:
    complex !== false(true/缺失/模糊)→ single(fail-safe)
    complex === false → 重用 outline 跑 workers
                        → mergeExtract + 完整性守衛(section 數必等 outline spine)
                        → 任何失敗 fallback single
```

| 呼叫 | max_tokens | timeout | retries | thinking |
|---|---|---|---|---|
| single(整本)| 100,000 | 900s | 0 | disabled |
| outline | 6,000 | 60s | 0 | disabled |
| sections worker(≤8 sections/組,≤6 組;每組看全部影像)| 48,000 | 300s | 0 | disabled |
| explain | 16,000 | 120s | 0 | — |

- `maxRetries: 0` 全面適用(長串流計費呼叫絕不重跑);硬牆逾時由
  `finalMessageWithDeadline` 保證(串流卡死也不會懸掛)。
- `thinking: disabled`:Sonnet 5 預設開 adaptive thinking 會吃 max_tokens 預算;
  抽取是確定性 JSON 任務。
- JSON 解析統一 parse-salvage:字串內控制字元跳脫 + 取第一個平衡物件。
- single 截斷 → 誠實報錯「請分批」,原始輸出落 `/tmp/menubot-last-extract.txt`。

---

## 6. 資料模型

**Menu 結構**(`src/types.ts`):
- `Menu`:restaurant{en,zh} · currency · kind(food/spa/service/other)· tags[] · sections[]
- `MenuSection`:en · zh · id · note · **l1{en,zh} · tier · l2{en,zh}**(二層導覽分類,optional → 缺失退「其他」)· items[]
- `MenuItem`:en · zh · p(原文價格字串)· tags[] · den(英描述)· dzh(中描述)· xterm(解說 slug)· explain{en,zh} · options[] · img
- `TagDef`:id · en · zh · icon · group(diet/allergen/protein/highlight/other)
- `OptionGroup`:en · zh · kind(one=選一/list=內含/any=加點)· choices[{en,zh,p}]

**SQLite**(`data/glossary.db`,啟動時冪等建表+seed):

| 表 | 用途 | Seed 策略 |
|---|---|---|
| `glossary` | 💡 解說快取(term 為 PK,含 version)| 無 seed;version=hash(SYSTEM+model),prompt/模型一變即自動失效重生 |
| `alias` | 詞彙別名(預留手動策展)| 無 |
| `regional_variant` | B1:港/陸變體 → 台灣用字 | code seed,INSERT OR IGNORE(手改永不被覆蓋)|
| `lexicon` | B2:(en_term,locale) → canonical + variants | canonical no-clobber;**variants 聯集合併**(code 追加的變體會進 live db —— 養詞庫迴路)|

---

## 7. 全域鐵律(Invariants)

**正確性與翻譯**
1. **錯誤資訊比誠實失敗更糟**——寧可截斷報錯/漏標,絕不冒錯價/錯譯風險。
2. **策展寧漏勿錯**(curation errs toward omission)。
3. **台灣用語為 canonical**;繁體中文;中文訊息全形標點。
4. **同詞同譯**:B1(zh 變體→台灣字,substring 最長優先)+ B2(英文詞 en-gate →
   locale 最佳譯);解說 prompt 禁談「中文譯名由來」;策展迴路 = seed +
   `[lexicon-miss]` log。
5. **den 一律英文、dzh 一律中文**,絕不同語言重複。
6. **餐廳名 zh 格式**:`地點+酒店中文譯名 空格 品牌音譯 (原文) 場所類型`,
   如 `蘭卡威達那酒店 普蘭特 (Planter's) 餐廳`;禁照抄英文、禁「A 的 B」直譯。
7. **半形括號規範(全域)**:所有中文文字(UI/bot 訊息/模型輸出)一律
   `半形空白 + ( + 內容 + ) + 半形空白`;後接標點不加空白;**禁全形（）**。
8. **♦️ 特色標記**:模型自加的名菜趣聞必以 ♦️ 開頭(唯一硬規則,位置形式自由);
   不確定就不加。

**管線與可靠性**
9. **Enrichment 絕不阻擋發佈**:所有加值階段 best-effort。
10. **Fail-safe 路由**:任何路由訊號缺失/守衛不符 → 回退 single。
11. **Reserved-tag 所有權**:popular🔥/notable💡 各有唯一合法產生階段,
    該階段先 strip 再 apply;extract 禁止輸出 popular。
12. **不 migration 已發佈頁**:自含 HTML,變更只影響新抽取。
13. **Graceful degradation**:新 schema 欄位一律 optional,缺失退回舊行為,無 flag。

**成本與外部呼叫**
14. **計費紀律**:ROI 未證的計費功能預設 opt-in OFF(WEB_ENRICH);per-call
    timeout + maxRetries 0 + max_uses 上限;無餐廳身分不呼叫 LLM。
15. **Measure-first**:先儀表化([timing])再優化,一次一個假設。
16. **Spike-before-invest**:大投入前用**最壞案例**跑可行性(常備基準:
    Terrace 39-sec、in-room dining 53-sec/204-item)。

**工程慣例**
17. 零 native dependency(node:sqlite/node:test/原生 fetch)。
18. Pure + DI:正確性邏輯為純函式全測;LLM/網路 wrapper 薄、不單測;
    pure 模組絕不 import 會 `process.exit(1)` 的 config singleton。
19. 安全:SSRF 允許清單(只 fetch Google Maps 網域)、publish secret 不落 log、
    slug/檔名白名單防 path traversal、圖片 vision 驗證 fail-closed。
20. TypeScript ESM(import 帶 .js)· node:test · 註解/commit 英文 ·
    新 env 一律 optional 帶安全預設 · 驗證指令不 pipe 遮蔽退出碼。
21. **驗收 = Brian 以真實 Telegram 上傳在 production 實測**;逐 milestone
    merge + 部署 + 驗收後才進下一個。

---

## 8. 設定面(環境變數)

| 變數 | 必填 | 預設 | 作用 |
|---|---|---|---|
| TELEGRAM_BOT_TOKEN | ✅ | — | Bot 認證 |
| ANTHROPIC_API_KEY | ✅ | — | Claude API |
| PUBLISH_BASE_URL | ✅ | — | Worker base URL(自動去尾斜線)|
| PUBLISH_SECRET | ✅ | — | 發佈 Bearer token(須與 Worker 端一致)|
| ALLOWED_USER_IDS | | ""(所有人)| Telegram 白名單 |
| ANTHROPIC_MODEL | | claude-sonnet-5 | 全部呼叫的模型 |
| EXTRACT_MODE | | single | single/parallel/adaptive(prod 用 adaptive)|
| WEB_ENRICH | | **off** | 🔥人氣 + 菜品圖(計費 opt-in)|
| REGION_NORMALIZE | | on | B1 開關 |
| LEXICON_NORMALIZE | | on | B2 開關 |
| TARGET_LOCALE | | zh-TW | B2 目標 locale |
| GLOSSARY_DB | | data/glossary.db | SQLite 路徑 |
| ARCHIVE_DIR | | data/originals | 原始檔封存目錄 |
| DEBUG_TIMING | | off | ⏱️+token/成本附加於 Telegram 回覆 |

---

## 9. 功能演進與決策記錄(ADR 摘要)

| 日期 | 功能 | 關鍵決策 / 否決 |
|---|---|---|
| 06-27 | P1 輸入相容(多圖+PDF) | 按鈕驅動批次;**否決** timer 自動 flush(會發佈半份菜單) |
| 06-27 | P2a 動態標籤+⭐ | 開放式 tag 系統;確立「不 migration 舊頁」 |
| 06-27 | P2b 💡解說+glossary | glossary-first 快取;「解說絕不阻擋發佈」 |
| 06-27 | P3 選項群組 | one/list/any 三型;**否決**互動點餐 |
| 06-28 | P4a 🔥人氣 | 一次 web_search;strip-then-apply;**否決**爬 Google Maps/Yelp(spike 證實不可行) |
| 06-28 | P4b 菜品圖 | vision 驗證 fail-closed(spike:官網 og:image 是橫幅仍評 high);**否決**圖片重壓縮 |
| 06-28 | P5 原檔封存+/vault | 發佈 URL 即查詢 key;**否決** web serving 原檔 |
| 06-29 | 💡特色 filter + Phase A | notable 獨立軸;💡升級 mini-guide(羅馬拼音) |
| 06-30 | Timing 儀表 | measure-first(Brian 選 Strategy A) |
| 06-30 | 兩階段平行抽取 | outline→workers→merge;fallback single;**否決** blind page-batching |
| 07-01 | B1 區域正規化 | 零 API substring 正規化;**排除**歧義詞(土豆);false-positive guards(芝麻/沙田) |
| 07-01 | Adaptive 路由 | complex 旗標 binary gate(spike 3/3+3/3);缺失視為 complex(fail-safe) |
| 07-01 | 餐廳 context+預警 | Maps 短連結 redirect 解析(SSRF 允許清單);**否決**截圖 context/Computer Use |
| 07-01 | Cloudflare 發佈 | Worker+R2 即時 live;刪 waitUntilLive;**否決**搬遷舊連結 |
| 07-02 | B2 在地最佳譯 | en-gate+變體替換;locale-ready 只出 zh-TW;seed+miss-logger 養詞庫 |
| 07-02 | single max_tokens 64K | **否決**三種 parallel 變形(Terrace 教訓成文) |
| 07-02 | **Sonnet 5 升級** | 最壞案例 A/B:快 1.5-1.9×、圖片詞彙+70%(2576px)、價格網格零錯位、~$0.5/菜單;thinking disabled+tokenizer 餘裕 |
| 07-02 | 二層分類導覽 | 3 內容層/2 導覽層;分類進兩條 extract 路徑;**手機驗收後修訂**:L2 改彈窗、飲料/酒類拆 L1、scroll offset |
| 07-04 | 鹹食直達 chip | savory L2<5 → L2 升格直達 chip(重現扁平 nav 一點即達) |
| 07-04 | 翻譯一致性三重根治 | 解說禁談譯名由來+B1/B2 前置+variants 聯集合併(修好養詞庫迴路) |
| 07-04 | den/dzh 語言鐵律+♦️ | 修雙語重複中文 bug;自加趣聞須 ♦️ 標記 |
| 07-04 | 餐廳名命名規格 | 融合式 `蘭卡威達那酒店 普蘭特 (Planter's) 餐廳` |
| 07-04 | 半形括號全域化 | 幣別/bot 訊息/三個 prompt 全面半形+外側空白 |

模型沿革:`claude-sonnet-4-6`(鎖定至 07-02)→ `claude-sonnet-5`(A/B 驗證後升級;
單次 extract 提速使「為省時冒 parallel 風險」的動機消失)。
單一 extract max_tokens 沿革:8K(截斷)→ 32K → 64K(4.6)→ 100K(Sonnet 5 tokenizer +30%)。

---

## 10. 營運手冊

**部署**:本機 merge main → `ssh mybani-prod` → `cd ~/menubot && git pull &&
npm install && npm run build && sudo systemctl restart menubot`。
Worker 變更另需 `cd worker && npx wrangler deploy`。
**急停**:`sudo systemctl stop menubot`。**回滾**:`git checkout <上一個好 commit>`
→ build → restart(07-04 實戰驗證,分鐘級恢復)。

**驗證節奏**:改動後由 Brian 重送真實菜單;`journalctl -u menubot` 看
`[extract] adaptive → …` 路由、`[timing]`(含 token/成本)、`[lexicon-miss]`
(詞庫策展候選)。

**成本基準**(Sonnet 5,53-sec/~200-item 最壞案例):PDF ~$0.47、17 圖 ~$0.53,
總耗時 ~5 分鐘。intro 價 $2/$10 至 2026-08-31,之後 $3/$15(usage.ts 屆時需更新)。

**詞庫養護**:看到 `[lexicon-miss] <詞> ≠ <未知拼法>` → 確認後把拼法加進
`lexicon-seed.ts` variants(部署後自動聯集進 live db)。

---

## 11. 已知債務與待辦

- **README.md 與 .env.example 過時**:仍寫 GitHub Pages/PAT 流程(現為 Worker+R2)。
- deferred:`</script>` JSON-breakout 硬化(MENU/TAGS/NAV 注入,既有樣式)·
  互動元件 aria · config.test.ts 依賴本機 .env(CI 無 .env 會整檔失敗)·
  onRoute 在 outline-失敗 fallback 時不觸發(無時間預警縫隙)。
- 未來 slice:B3 多 locale 輸出(lexicon schema 已 locale-ready)· zh-HK/CN/SG/MY
  策展 · per-section 混合路由 · B1+B2 收斂為統一 locale 正規化模型。
