# 纳物 NaWu · AI 上手总览（项目结构 · 功能 · 常踩坑）

> 用途：让一个**完全不了解本项目**的 AI / 开发者，在 10 分钟内知道「这是什么、代码在哪、数据怎么流、哪里会炸」。
> 版本：**v1.6.5**（2026-11-10）· 服务端 / 网页 / App / 小程序 四端同源
> 配套文档：`AI接入-Muse.md`（AI 记账接口）· `踩坑与注意事项.md`（历史细节）· `部署记录-服务器.md`（服务器实录）· `变更日志.md`

---

## 0. 30 秒速览

**纳物**是一个「记账 + 物品生命周期账」应用：把一次性消费变成**日均成本**，回答「这东西买得值不值」。
核心心智模型只有三样：**生活流（花的每一笔）· 物品库（买的东西及其日均成本）· 订阅（周期性扣款）**。

四端形态：

| 端 | 目录 | 技术栈 | 产物 |
|---|---|---|---|
| 网页版 | `工程/app` | React 18 + Vite + Tailwind + TypeScript | `server/assets/*` + `server/app/spa-m.html` |
| Android App | `工程/app`（同一套代码）+ `app/android` | Capacitor 7 原生壳 | `nawu-vX.Y.Z.apk` |
| 微信小程序 | `工程/miniprogram` | Taro 4 + React + TS | `miniprogram/dist` |
| 服务端 | `工程/server` | **PHP 8.3 原生，无框架** | 站点根 `index.php` + `app/**` |

**关键架构事实（决定了 90% 的坑）**：
1. **本地优先**：所有业务数据存在客户端（Web: localStorage / App: Capacitor Preferences），不是从服务端读的。
2. **服务端只做四件事**：账号、云备份（整份快照，只留 3 份）、识别规则同步、在线更新分发。
3. 所以「服务端加个接口就能改数据」是**错的**——AI 写入必须走「待入账箱 + 客户端合并」（见 P6）。

---

## 1. 目录结构（带职责）

```
纳物NaWu-纯净包-v1.6.2-20261030/
├── 工程/
│   ├── app/                     ← 网页 + App 同一套前端（40.6k 行 TS/TSX）
│   │   ├── src/
│   │   │   ├── pages/           ← 路由页（见 §3.1）
│   │   │   ├── components/      ← 通用组件 + layout/（MainShell 底栏、抽屉）
│   │   │   ├── domain/          ← ★纯业务算法，禁止引 React/DOM
│   │   │   │   ├── goods.ts     ←   物品生命周期账：总投入/日均/达成率/净赚
│   │   │   │   ├── ledger.ts    ←   生活流聚合（按天分组、月汇总）
│   │   │   │   ├── stats.ts     ←   Top 分类、归需否、趋势
│   │   │   │   ├── subscription.ts ← 订阅摊销（月/季/年/周）
│   │   │   │   └── backupPolicy.ts ← 自动备份节流策略
│   │   │   ├── ai/              ← ★本地识别引擎（一句话记账），见 §3.3
│   │   │   ├── storage/         ← 存储层：keys(键名) / repo(集合读写) / snapshot(快照) / seed(种子)
│   │   │   ├── store/           ← zustand 状态（useDataStore 是数据主仓）
│   │   │   ├── api/             ← 服务端接口封装（endpoints.ts 是路径唯一事实源）
│   │   │   ├── net/             ← httpClient（超时/重试/401 处理）
│   │   │   ├── lib/             ← 工具（money/id/date/error/haptics/caretGuard/appVersion）
│   │   │   └── types/           ← entities.ts（12 集合类型）· api.ts（响应类型）
│   │   ├── android/             ← Capacitor 原生壳（MainActivity/NawuPatch 等）
│   │   ├── tests/               ← vitest（520+ 例；caret-guard 是光标回归）
│   │   └── .github/workflows/   ← 注意：仓库根的 workflows 才是真的（见 P9）
│   ├── server/                  ← PHP 服务端（9.1k 行）
│   │   ├── index.php            ← 入口（路由分发 → GF_Api::handle）
│   │   ├── app/
│   │   │   ├── Api.php          ← ★全部路由都在这里（裸 if/elseif，无框架）
│   │   │   ├── VERSION          ← 服务端版本号（必须与 App 同步）
│   │   │   ├── lib/
│   │   │   │   ├── Schema.php   ← 建表 + 默认设置键（新增设置要先加这里）
│   │   │   │   ├── Auth.php     ← 会话 / 用户 token / 设置读写
│   │   │   │   ├── Db.php       ← PDO 封装（q/one/rows/val）
│   │   │   │   ├── Update.php   ← 服务端在线更新
│   │   │   │   ├── NawuAI.php   ← ★v1.6.5 中文记账规则引擎 + 值不值
│   │   │   │   └── AiApi.php    ← ★v1.6.5 /api/ai/* 接入层
│   │   │   ├── assets/          ← 前端构建产物（**由构建同步生成，不要手改**）
│   │   │   └── spa-m.html       ← 网页入口（同样由同步工具重写）
│   │   ├── storage/             ← 运行时数据（**绝不入库/绝不清空**，见 P15）
│   │   │   ├── config.php       ← 数据库口令（600 权限，不在任何发布包里）
│   │   │   ├── asr/             ← 42MB 离线语音模型
│   │   │   └── app-release/     ← 老客户端回退更新通道
│   │   └── vosk/ tess/ tessdata/ brand-icons/  ← 静态运行时（大文件，不入库）
│   ├── miniprogram/             ← 小程序（Taro）
│   │   └── src/core/            ← 从 app/src **原样复制**的纯逻辑（domain/ai/lib/storage/types）
│   ├── tools/                   ← 发版与运维脚本（见 §6）
│   ├── 编译部署与迭代.md         ← 发版操作手册
│   └── 文件校验-sha256.txt       ← 源码包完整性校验
├── 项目文档/                     ← 本文档所在
├── 发布-最新/                    ← 历史发布产物（源码包 / APK / 服务端 zip）
├── dist-ota/                    ← 当前更新渠道的待发布内容（apk / patch / manifest / bin）
├── keys/                        ← 小程序代码上传私钥（**勿外传**）
└── site-backup/                 ← 站点误覆盖时的应急备份（外来项目文件）
```

**代码规模参考**：app/src 40,621 行 · server/app 9,127 行 · miniprogram/src 8,771 行。

---

## 2. 数据流（一次「记一笔」发生了什么）

```
用户在「对话记一笔」输入「昨天买了个耳机 899」
   │
   ├─ ai/split → colloquial → cnNumber → keywords → trade   （本地规则，不联网）
   │       ↓
   │   卡片预览（可改分类/金额/日期）→ 确认
   │       ↓
   │   useDataStore.addParsed()   ← 写 goods（物品）+ valueRecords（支出，refId 指回物品）
   │       ↓
   │   storage/repo.saveCollection()  → localStorage（Web）/ Preferences（App）
   │       ↓
   └─ 变更计数 changedSinceBackup++ → 满足阈值才自动备份（24h 节流）
           ↓
       POST /api/sync/push（整份快照 collections + settings）
           ↓
       服务端：normalize → **合并 AI 待入账事件** → 写 flyme_backups（保留最近 3 份）
```

**另一条链路（AI 记账，v1.6.5）**：

```
Muse/任意 AI ──POST /api/ai/commit──▶ 解析成 records
                                        ├─▶ 写 flyme_ai_events（pending）
                                        └─▶ 立刻合并进最新快照
客户端「我的 → AI 接入 → 合并」 ──GET /api/ai/inbox──▶ 合并进本地集合 ──▶ POST /api/ai/inbox/apply
（即使不合并也不会丢：客户端下次 push 时服务端会再合并一次）
```

---

## 3. 功能清单

### 3.1 网页端 / App（`app/src/pages`）

| 页面 | 文件 | 能力 |
|---|---|---|
| 首页 | `HomePage.tsx` | 今日/本月概览、物品摘要、天气（IP 定位）、快捷记账 |
| 生活流 | `LedgerPage.tsx` | 按天分组流水、月份切换、筛选、编辑/删除、撤销 |
| 报表 | `ReportPage.tsx` | Top 分类、归·需·否结构、近 6 月趋势、AI 点评 |
| 我的 | `MePage.tsx` | 账号卡、功能入口（置物墙/备份/分类/规则/**AI 接入**/服务器/设置） |
| 对话记一笔 | `ManualRecordSheet.tsx` + `components/layout/SmartRecordDock.tsx` | 一句话解析 → 确认卡片 → 落库 |
| 物品 | 并入首页 + `/record` | 入库/编辑/计数/转卖退役（自动生成净赚流水） |
| 订阅 | `SubListPage.tsx` | 周期订阅、摊销、下次扣款 |
| 置物墙 | `WallPage.tsx` | 在役物品一览、分享卡片 |
| 备份 | `BackupPage.tsx` | 手动/自动云备份、列表、覆盖恢复 |
| 分类 | `CategoryPage.tsx` | 自定义分类（id 规则见 §4.3） |
| 规则 | `RulePage.tsx` | 教识别引擎：关键词 → 分类（云端同步） |
| **AI 接入** | `AiAccessPage.tsx` | ★v1.6.5 复制 API 地址 / 生成撤销 Key / 合并云端待入账 |
| 服务器 | `ServerManagePage.tsx` / `ServerEditPage.tsx` | 多服务器切换（自建） |
| 设置 | `SettingsPage.tsx` | 主题、货币、AI、同步、检查更新 |
| 后台 | `AdminPage.tsx` | 管理端（用户/设置/在线更新/更新通道） |

### 3.2 服务端能力

- 账号：注册（邮箱验证码）/ 登录 / 微信一键登录（`/api/auth/wechat`，需 AppSecret）/ 改密 / 注销
- 云备份：`/api/sync/push|pull|list|delete` + `/api/user/backups`（保留 3 份，单包 ≤16MB）
- 规则同步：`/api/user/rules`
- 在线更新：App 通道（`app-manifest.json` + 增量补丁）、服务端自更新（`manifest.json` + `.bin`）
- **AI 记账**：`/api/ai/*`（parse / commit / ask / context / inbox / keys / openapi.json）
- 运维：`/api/health`、`/api/geo`、管理后台 `/api/admin/*`

### 3.3 本地识别引擎（`app/src/ai`，本项目最复杂也最值钱的部分）

| 文件 | 作用 |
|---|---|
| `split.ts` | 分句（中文标点 / 连接词） |
| `cnNumber.ts` | 中文数字（含口语省尾「两千五」=2500） |
| `colloquial.ts` | 口头语归一（「整了」「造了」→ 花） |
| `keywords.ts` | 分类关键词表（生活流 24 类 + 物品 13 类） |
| `trade.ts` | **二手买卖一体**（买入+卖出+手续费千分比），必须在分句之前 |
| `ruleBank.ts` | 自学习规则（用户改分类即沉淀） |
| `localParser.ts` | 主解析器（金额/日期/分类/名称/归需否） |
| `queryLocal.ts` | 本地问答（「这个月花了多少」「值不值」） |
| `parseService.ts` | 对外入口：本地优先，AI 直连增强（未配置不发请求） |
| `analyzeService.ts` | 报表页 AI 点评（本地洞察恒有，AI 只做增强） |

> 服务端 `NawuAI.php` 是这套规则的**PHP 移植子集**，供 AI 接口使用。改规则时两边都要动（见 P12）。

### 3.4 小程序（`miniprogram/src/pages`）

home / ledger / report / me / record / goods / goods-edit / subs / backup —— 4 Tab 与 App 一致。
`src/core/**` 是 app/src 的**复制品**（domain/ai/lib/storage/types），platform/ 层替换为 Taro API。
**已知不移植**：vosk 语音、tesseract OCR、桌面布局、置物墙照片、分享卡 canvas。

---

## 4. 数据协议（改这里最容易炸，务必先读）

### 4.1 存储键与集合

- 键前缀固定 **`flyme.`**（`storage/keys.ts`）：`flyme.goods`、`flyme.valueRecords`、`flyme.subscriptions`…
- **12 个集合**（`types/entities.ts` → `COLLECTIONS`）：
  `goods, subscriptions, bills, valueRecords, moods, times, wishlist, cooldowns, categories, usageRecords, reminders, walls`
- **铁律：键名/集合名/快照格式永远不许改名**——改了老用户的备份全部读不出来（P5）。

### 4.2 快照（云备份）

```json
{
  "collections": { "goods": [], "valueRecords": [], "...": [] },
  "settings": { ... },
  "count": 0,              // 只算 goods + subscriptions + valueRecords
  "app": "flyme-web",      // ★固定值，不能写成 flyme-android（否则与 Web 备份互斥）
  "version": 1,
  "exportedAt": "2026-11-10T02:00:00Z"
}
```
- 服务端**只保留最近 3 份**（`trimBackups(3)`）。
- 「恢复」= **整份覆盖本机**，会丢未备份的本地改动——UI 上必须有明确二次确认。

### 4.3 分类 id（不许乱造）

| 域 | id 规则 | 说明 |
|---|---|---|
| 物品 | `cg0`–`cg12` | 数码/衣物/家居/美妆/厨房/运动/交通/家电/工具/玩具/乐器/珠宝/日用 |
| 订阅 | `cs0`–`cs5` | 影音/效率/学习/云服务/游戏/生活 |
| 生活流 | `cl0`–`cl6`, `cl8`–`cl23`，**`cl7`=其他** | 注意 cl7 是「其他」且恒定垫底 |

**陷阱**：把物品分类 `cgX` 写进 `valueRecords.categoryId` 会导致生活流按分类统计时出现空分类（P12）。

### 4.4 服务端表

`flyme_users` / `flyme_sessions` / `flyme_admin_settings` / `flyme_admin_sessions` / `flyme_admins` /
`flyme_backups` / `flyme_profiles` / `flyme_user_rules` / `flyme_throttle` / `flyme_verify_codes` /
`flyme_directory` / **`flyme_ai_events`**（v1.6.5，AI 待入账）

- 新增**设置项**：必须在 `Schema::defaultSettings()` 加键，否则 `GF_Auth::set()` 会静默拒绝（P11）。
- 新增**表**：用 `CREATE TABLE IF NOT EXISTS`（参考 `AiApi::ensureTables()`），不要改既有表结构。

---

## 5. 服务端 API 全表

基址：`https://your.domain.com`。鉴权：`Authorization: Bearer <用户 token 或 nawu_sk_ Key>`。
路径唯一事实源：`app/src/api/endpoints.ts`（两端共用）。

| 分组 | 路径 |
|---|---|
| 系统 | `GET /api/health`（含 version/db）· `GET /api/geo` · `GET /api/settings` |
| 认证 | `POST /api/auth/login` · `register` · `send-code` · `reset` · `changepassword` · `wechat` · `GET /api/auth/me` · `POST /logout` |
| 用户 | `GET/POST /api/user/profile` · `GET/POST /api/user/rules` · `GET/POST /api/user/backups` |
| 备份同步 | `POST /api/sync/push` · `GET /api/sync/pull` · `GET /api/sync/list` · `POST /api/sync/delete` |
| **AI 接入** | `GET /api/ai/openapi.json` · `GET /api/ai/context` · `POST /api/ai/parse` · `POST /api/ai/commit` · `POST /api/ai/ask` · `GET /api/ai/inbox` · `POST /api/ai/inbox/apply` · `DELETE /api/ai/inbox` · `GET/POST/DELETE /api/ai/keys` · `POST /api/ai/keys/bootstrap`（一次性引导） |
| App 更新 | `GET /api/app/version` · `GET /api/app/download` |
| 管理 | `/api/admin/*`（登录/用户/设置/SMTP/在线更新/更新通道/数据库） |

**约定**：成功 `{"ok":true,...}`；失败 `{"ok":false,"error":"中文原因"}` + 4xx/5xx。
`Api.php` 里 `flyme_fail()` 会直接输出并退出——**不要在它后面写代码**。

---

## 6. 环境与发版

### 6.1 生产环境

| 项 | 值 |
|---|---|
| 站点 | `https://your.domain.com`（80 端口 301 → https） |
| FTP | `ftp://0.0.0.0:21`，账号 `genxin / genxin`，**站点根 = 更新渠道根目录** |
| 数据库 | MySQL，口令在 `storage/config.php`（权限 600，**任何发布包都不含它**） |
| 更新渠道 | 站点根：`app-manifest.json` / `manifest.json` / `nawu-*.apk` / `*.patch` / `nawu-server-*.bin` |
| 老客户端回退通道 | `storage/app-release/{nawu-vX.apk, manifest.json}` → `/api/app/version` |
| GitHub | `***/nawu`（App + server/ 源码）· `***/nawu-flyme`（脱敏公开归档） |
| 微信小程序 | AppID `wxf9b6e220006b920f`，上传私钥 `keys/private.wxf9b6e220006b920f.key` |

### 6.2 发版流程（照抄）

```bash
cd 工程

# ① 版本号五处同步（P20）：app/src/lib/appVersion.ts / app/package.json(+lock) /
#    app/android/app/build.gradle(versionCode+versionName) / server/app/VERSION
# ② 质量门
cd app && npx tsc --noEmit && npx vitest run && npm run build && cd ..
# ③ 前端产物同步到服务端目录
node tools/sync-web-to-server.mjs
# ④ 传网页（只传变化的即可）
#    assets/* → /assets/ ；app/spa-m.html → /app/spa-m.html ；app/VERSION → /app/VERSION
# ⑤ 出 APK（云端，本机没有 JDK/SDK/签名）
python tools/github-sync.py --local app --repo ***/nawu --push --include-from tools/nawu-push-files.txt
#    然后 dispatch .github/workflows/build-apk.yml，用 curl -L 下载 artifact（P21）
# ⑥ 增量包（可选但推荐）
python tools/make-app-patch.py dist-ota/nawu-v<旧>.apk dist-ota/nawu-v<新>.apk dist-ota/<旧>-to-<新>.patch
# ⑦ 生成清单 + 上传渠道
python tools/publish-ota.py --dir dist-ota --notes "本次更新"
# ⑧ 体检
python tools/verify-update-channel.py --current <旧版本> --download
# ⑨ 回退通道（老客户端唯一入口，容易漏）
#    上传 apk 到 storage/app-release/ 并改写其 manifest.json 的 version/fileSize
```

### 6.3 tools 速查

| 脚本 | 用途 |
|---|---|
| `sync-web-to-server.mjs` | 把 `app/dist` 同步进 `server/assets`，重写 `spa-m.html` 入口 |
| `publish-ota.py` | 扫目录生成 `app-manifest.json` / `manifest.json`（可 `--upload` 直传 FTP） |
| `verify-update-channel.py` | 按客户端判定链路体检（清单/大小/Range 206/sha256） |
| `make-app-patch.py` | 生成 `NAWU-PATCH1` 增量包并回放自校验 |
| `github-sync.py` | 走 Git Data API 推代码（本机 git push 常被拦），支持 `--include-from` 白名单、`--build-apk` |
| `test-nawu-ai.php` | 服务端解析器单测（改 NawuAI.php 后必跑） |
| `gen-mini-category-icons.py` | 从 app/src 生成小程序的 lucide→emoji 图标表 |

### 6.4 本机可用工具

- PHP：`C:\Users\Administrator\ego\php\php.exe`（用 `php -l` 做语法检查、`php tools/test-nawu-ai.php` 跑单测）
- Node/npm：已装；`miniprogram-ci` 在 `工程/miniprogram` 内
- Python 3.13：跑所有 tools 脚本

---

## 7. 常踩坑（按「会炸得多狠」排序）

> 每条格式：**症状 → 根因 → 正确做法 → 验证**。带 ★ 的是踩过真实线上事故的。

### ★P1 输入框「删一个字，光标飞到末尾」
- **症状**：光标点到中间改字，光标立刻跳到整句末尾；只在 Android App 复现。
- **根因（两层，只修一层必复发）**：
  ① `capacitor.config.ts` 的 `captureInput: true` 让 Capacitor 用自己的 `BaseInputConnection` 顶掉 Chromium 的输入连接，它不管输入法组合区，删字退化成「整段重设文本」；
  ② JS 层每次 `input` 都改 `textarea` 高度 → WebView 重排选区。
- **做法**：`captureInput: false`（默认值）+ `lib/caretGuard.ts`（存光标 → 改 DOM → 立即恢复 → `requestAnimationFrame` 再确认）；单行输入零样式变更；输入框保持非受控 `defaultValue`，**禁止加 `key`、禁止条件渲染替换 DOM**。
- **验证**：`tests/caret-guard.test.ts`（15 例，且**断言源码里有 rAF 二次恢复**，删掉即红）。

### ★P2 前端改完没同步，线上还是旧包
- **症状**：本地明明改了，线上行为没变；或线上 404 报缺 chunk。
- **根因**：网页版加载的是 `server/assets/*`，不是 `app/src`。
- **做法**：`npm run build` → `node tools/sync-web-to-server.mjs` → 上传 `assets/*` + `app/spa-m.html` + `app/VERSION`。
- **验证**：`curl -s https://your.domain.com/api/health` 看 version；再把线上入口 js 抓下来 grep 新逻辑特征串。

### ★P3 依赖方向被破坏
- **症状**：`domain/` 里出现 `useState`/`window`/`document`，测试或小程序构建挂掉。
- **做法**：`domain → lib → types` 只能向下；UI 状态只在 `store/` 与 `pages/`。小程序复用 `core/` 正是靠这条。

### ★P4 桌面端样式用了裸 `lg:`
- **症状**：桌面布局在平板/小屏错乱。
- **做法**：本项目桌面断点统一 `dt:` / `dtxl:` / `dt2xl:`，**禁裸 `lg:`**（Tailwind 配置里没这档）。

### ★P5 存储协议被改名
- **症状**：老用户升级后数据全空/备份恢复失败。
- **做法**：`flyme.*` 键名、12 集合名、快照 `app:'flyme-web'`、`count` 口径**一律不许动**。产品改名 ≠ 存储层改名。

### ★P6 AI 记的账「记了又没了」
- **症状**：让 AI 记完，用户打开 App 看不到；或看到后又消失。
- **根因**：纳物本地优先，客户端每次自动备份会**整份覆盖**服务端快照。
- **做法**：AI 记录先进 `flyme_ai_events`（pending）→ 立刻合并进最新快照 → **`/api/sync/push` 时服务端再合并一次** → 客户端可用 `/api/ai/inbox` 增量合并。
- **验证**：`commit` 后调 `/api/ai/ask` 必须能算到刚记的那笔（`withPending()` 已处理）。

### ★P7 服务端整包下载 404（`.zip` 被屏蔽）
- **症状**：站点根放 `xxx.zip`，浏览器/FTP 都在，HTTP 却 404；`.apk` 正常。
- **根因**：宝塔/Nginx 默认屏蔽 `.zip` 扩展名。
- **做法**：服务端包一律 `.bin`（内容仍是 zip，`ZipArchive` 按内容解包）；`manifest.packageUrl` 同步。
- **验证**：上传后立刻 `curl -I https://域名/文件名`。

### ★P8 推送 GitHub 卡死在 275/280
- **症状**：`github-sync.py` 长时间停在“已上传 N/M”，日志不再更新。
- **根因**：Git Data API 的 blob 是 base64 JSON，大文件（构建产物、wasm）会挂死。
- **做法**：**只推源码**，把 `assets/ vosk/ tess/ tessdata/ brand-icons/ storage/`、`*.zip/*.bin/dist` 排除；`--include-from` 白名单推 App 时也一样。

### ★P9 GitHub Actions 不触发
- **症状**：workflow 文件明明有，Actions 页面没有它。
- **根因**：GitHub 只认**仓库根** `.github/workflows/`。
- **做法**：本项目真实工作流在仓库根（`build-apk.yml`）；`工程/app/.github` 是历史副本，改了没用。

### ★P10 私有仓库被「脱敏占位」覆盖
- **症状**：`nawu` 仓库里的真实内网地址变成 `192.168.1.100` 之类。
- **根因**：纯净包/公开归档 `nawu-flyme` 是**脱敏版**（域名→`your.domain.com`、内网 IP→占位），整目录同步会冲掉真实值。
- **做法**：推 `nawu` 一律走 `tools/nawu-push-files.txt` 白名单；推 flyme 前先跑脱敏替换。

### ★P11 新增设置项写不进去
- **症状**：`GF_Auth::set('myKey', ...)` 返回 false 或值读不到。
- **根因**：`Auth::set()` 只允许 `Schema::defaultSettings()` 里声明过的键。
- **做法**：先在 `Schema.php` 加默认键，再 `set`；已有库靠 `INSERT IGNORE` 补行。

### ★P12 生活流出现「空分类」
- **症状**：报表 Top 分类里有一项没名字。
- **根因**：把物品分类 `cgX` 或订阅分类 `csX` 写进了 `valueRecords.categoryId`。
- **做法**：生活流只用 `clX`；买物品时「物品分类 cgX」与「支出分类 clX」是两套（服务端 `goodsToLedgerName()` 就是干这个）。

### ★P13 中文数字解析错（「两千五」变成 2005/10200）
- **做法**：`cnNumber` 已处理省尾（单位后最后一位按下一级算，万位特判）；改这块必须跑 `php tools/test-nawu-ai.php` 与 `app/tests`。

### ★P14 FTP 脚本把目录搞乱/删不掉文件
- **症状**：递归里出现 `views/assets/assets/...` 假路径；删除报 "No such file"。
- **根因**：FTP `cwd` 用了相对路径；递归返回后 cwd 漂移。
- **做法**：`cwd` 一律绝对路径；**每个删除动作前重新 `cwd` 到目标目录**。

### ★P15 站点被别的项目覆盖（已发生一次）
- **症状**：整站 500，`index.php` 变小/被换，多出陌生目录。
- **做法**：① 先 FTP 全站备份；② **只删白名单里的外来路径**（绝不「凡是不在包里就删」——会误删 `storage/config.php`、`.well-known/`）；③ 用发布包里的干净副本覆盖根文件；④ 按 §8 验证。
- **绝对不能删**：`storage/`（含 config.php、asr/、app-release/）、`.well-known/acme-challenge/`（SSL 续签）、`.user.ini`、`server/`、`vosk/ tess/ tessdata/ brand-icons/`。

### ★P16 小程序输入框文字被削顶削脚
- **根因**：微信原生 `Input` 是固定高度组件，**不吃上下 padding**（网页写法直接搬会坏）。
- **做法**：`height: 88rpx; line-height: 88rpx; padding: 0 24rpx;`。

### P17 小程序震动/反馈 API 用错枚举
- **症状**：`haptic('tap')` 不生效或类型报错。
- **做法**：App 侧 `lib/haptics.ts` 只认 `light|medium|heavy|select|success|warn|error`；小程序 `platform/haptic.ts` 只认 `light|medium|heavy`。

### P18 Windows 下的 shell 陷阱
- **症状**：heredoc 报 `unexpected EOF`；`tar -xzf C:/x` 被当远程主机。
- **做法**：含引号/中文的长脚本**写成文件再执行**（`python patch.py`）；路径写 `/c/Users/...` 或 `C:/...`（正斜杠）。

### P19 本机没有 PHP / 没有 JDK
- **做法**：PHP 用 `C:\Users\Administrator\ego\php\php.exe`；APK **只能**云端构建（本机无 JDK/Android SDK/签名密钥，换密钥库会导致老用户无法覆盖安装）。

### ★P20 版本号漏改一处
- **症状**：App 更新提示混乱 / 渠道判定「已是最新」。
- **五处必须同步**：`app/src/lib/appVersion.ts`、`app/package.json`（+`package-lock.json`）、`app/android/app/build.gradle`（versionCode 与 versionName）、`server/app/VERSION`。

### ★P21 下载 Actions 产物 401
- **症状**：用 urllib 下 artifact 报 Azure 拒绝。
- **根因**：Authorization 头被带进重定向。
- **做法**：用 `curl -sL`（跟随重定向时不带自定义头）。

### P22 小程序传完没变成体验版
- **事实**：`miniprogram-ci` 用 robot 上传后**会自动成为体验版**；改了代码要重新扫体验版二维码（先删掉手机上旧的小程序，避免缓存）。

### P23 Taro 里写 JSX 到 `.ts` 文件
- **症状**：`TS1005: '>' expected`。
- **做法**：含 JSX 的入口必须 `.tsx`（`app.ts` → `app.tsx`）。

### P24 公开接口被鉴权拦住
- **症状**：`/api/ai/keys/bootstrap`、`/api/ai/openapi.json` 一直返回 401。
- **根因**：`GF_Ai::handle()` 先调了 `owner()`。
- **做法**：**免鉴权分支必须写在 `owner()` 之前**（openapi、bootstrap 都是）。

### P25 语音/OCR 相关不要乱动
- **事实**：Web Speech 在 Android WebView 里实际是**云端识别**；端侧 vosk 需要 42MB 模型在 `storage/asr/`；OCR 依赖 `tess/`、`tessdata/`（11MB wasm + chi_sim）。这些在**小程序里不可用**，不要试图移植。

---

## 8. 每次改完必跑的验证清单

```bash
# 前端
cd 工程/app && npx tsc --noEmit && npx vitest run        # 期望：0 error / 520+ 例全绿
npm run build                                             # 期望：built in <15s

# 服务端（本机 PHP）
cd 工程/server && /c/Users/Administrator/ego/php/php.exe -l app/Api.php
/c/Users/Administrator/ego/php/php.exe -l app/lib/AiApi.php
cd 工程 && /c/Users/Administrator/ego/php/php.exe tools/test-nawu-ai.php

# 线上（改完部署后）
curl -s https://your.domain.com/api/health                   # ok:true + db:true + version:当前版本
curl -s -o /dev/null -w "%{http_code}\n" https://your.domain.com/          # 200
curl -s -o /dev/null -w "%{http_code}\n" https://your.domain.com/api/ai/openapi.json
python tools/verify-update-channel.py --current <上一版>   # 渠道体检全绿

# 小程序（如需）
cd 工程/miniprogram && npx taro build --type weapp && npx miniprogram-ci upload \
  --pp ./ --pkp ../../keys/private.wxf9b6e220006b920f.key --appid wxf9b6e220006b920f --uv <版本> --robot 1
```

**网页版上线后还要抽查依赖完整**：把首页引用的 `assets/*` 全部 HEAD 一遍，必须全 200（曾经出现过缺 chunk 白屏）。

---

## 9. 常见任务配方

| 想做什么 | 改哪里 | 别忘了 |
|---|---|---|
| 加一个生活流分类 | `app/src/storage/seed.ts`（id 顺延）+ `ai/keywords.ts` | `NawuAI::defaultCategories()` 同步；老用户靠迁移补 |
| 加一个页面 | `app/src/pages/X.tsx` + `router.tsx` + `MePage` 入口 | 移动端与 `dt:` 桌面布局都要看 |
| 加一个接口 | `app/src/api/endpoints.ts` + `server/app/Api.php` | 免鉴权路径要加进 `NO_AUTH_PATHS` |
| 改识别规则 | `app/src/ai/*` | 同步 `server/app/lib/NawuAI.php`，跑两边测试 |
| 改账单算法 | `app/src/domain/*` | 纯函数，补单测；小程序 `core/domain` 同步复制 |
| 改小程序 | `工程/miniprogram` | 只改 UI/平台层；`core/` 来自 app，改要双份 |
| 发版 | §6.2 | 版本号五处 + 渠道 + 回退通道 + Release |

---

## 10. 已知限制 / 待办

- 小程序未发布（**备案未完成**，是提审硬前置）；功能不等同 App（无语音/OCR/置顶墙照片）。
- 微信一键登录代码已就绪，但服务端缺 `AppSecret`（`/api/auth/wechat` 会返回 503 提示）。填法：`GF_Auth::set('wxAppSecret', ...)` 或 `storage/config.php` 里 `define('FLYME_WX_APPSECRET', '...')`。
- 备份额度 3 份、单包 16MB；图片只存引用不存二进制（避免备份膨胀）。
- 增量补丁需对应「上一版 APK」存在，跨版本要重新生成。
- `flyme_ai_events` 只保留最近 500 条 pending，超出丢最旧。
